import { createServer, type IncomingMessage, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { FleetStorage, FleetTable, StoredValue } from '../model';
import { RelayFileStore } from './file-store';
import {
  RELAY_FRAME_BYTES, RELAY_HELLO_TIMEOUT_MS, RELAY_LIST_MAX, RELAY_MAX_OBSERVERS,
  RELAY_MAX_PENDING_RPC, RELAY_MAX_WORKERS, RELAY_PATH, RELAY_PING_INTERVAL_MS,
  RELAY_PROTOCOL_VERSION, RELAY_SEND_BUFFER_BYTES, RELAY_TOKEN_MIN_BYTES, RelayProtocolError,
  pageRows, parseHello, parseRequest, sanitizeCode, sanitizeMessage,
  type RelayHello, type RelayRequest, type RelayServerMessage,
} from './protocol';

export type GatewayState = 'disabled' | 'connecting' | 'connected' | 'error';
export interface FleetRelayServerOptions {
  appId: string;
  token: string;
  dataDir: string;
  host?: string;
  port?: number;
}
export interface FleetRelayServer {
  url: string;
  port: number;
  storage: FleetStorage;
  setGatewayState(state: GatewayState): void;
  close(): Promise<void>;
}

interface Session {
  id: string;
  ws: WebSocket;
  role: 'worker' | 'observer';
  nodeId?: string;
  host?: string;
  hello: boolean;
  activated: boolean;
  alive: boolean;
  pending: number;
  helloTimer?: ReturnType<typeof setTimeout>;
}

function validToken(authorization: string | undefined, token: string): boolean {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  const supplied = authorization.slice('Bearer '.length);
  if (!supplied || supplied.length !== token.length) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}
function jsonFrame(value: unknown): string { return JSON.stringify(value); }

/**
 * Standalone relay: authenticated WebSocket directory/queue with durable
 * single-writer storage. It never invokes a model, shell or project tool.
 */
export async function startFleetRelayServer(options: FleetRelayServerOptions): Promise<FleetRelayServer> {
  if (!options || typeof options.appId !== 'string' || !options.appId.trim()) throw new Error('中继服务缺少应用 ID');
  if (typeof options.token !== 'string' || Buffer.byteLength(options.token, 'utf8') < RELAY_TOKEN_MIN_BYTES
    || options.token.length > 512 || /[\u0000-\u0020\u007f]/.test(options.token)) {
    throw new Error(`中继服务令牌无效：需要至少 ${RELAY_TOKEN_MIN_BYTES} 字节的高熵令牌且不含空白`);
  }
  if (typeof options.dataDir !== 'string' || !options.dataDir) throw new Error('中继服务缺少数据目录');
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('中继服务端口无效');

  const store = await RelayFileStore.open(options.dataDir, options.appId);
  const workers = new Map<string, Session>();
  const observers = new Set<Session>();
  const sessions = new Set<Session>();
  let gatewayState: GatewayState = 'disabled';
  let closed = false;

  // Presence means an authenticated worker that explicitly activated and is
  // still OPEN. Mere setup/handshake connections are never visible.
  const isActive = (session: Session | undefined): boolean =>
    !!session && session.activated && session.ws.readyState === WebSocket.OPEN;
  const inspectPresence = (nodeId: string): boolean => isActive(workers.get(nodeId));
  store.setConnectionInspector(inspectPresence);

  const wss = new WebSocketServer({ noServer: true, maxPayload: RELAY_FRAME_BYTES, perMessageDeflate: false });
  const httpServer: Server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://relay.local');
    } catch {
      // A malformed absolute request-target must not throw before WS auth.
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'content-length': 11 });
      res.end('bad request');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const ok = store.health?.().ok !== false;
      const body = JSON.stringify({ ok, version: RELAY_PROTOCOL_VERSION, gateway: gatewayState });
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'content-length': 9 });
    res.end('not found');
  });

  const send = (session: Session, message: RelayServerMessage): boolean => {
    if (session.ws.readyState !== WebSocket.OPEN) return false;
    if (session.ws.bufferedAmount > RELAY_SEND_BUFFER_BYTES) {
      session.ws.terminate();
      return false;
    }
    try {
      session.ws.send(jsonFrame(message), error => { if (error) session.ws.terminate(); });
      return true;
    } catch { session.ws.terminate(); return false; }
  };
  const sendError = (session: Session, id: string | undefined, error: unknown): void => {
    if (!id) { session.ws.close(4002, 'bad request'); return; }
    send(session, { type: 'response', id, ok: false,
      error: { code: sanitizeCode(error), message: sanitizeMessage(error) } });
  };
  const activeNodeIds = (): string[] => [...workers.entries()]
    .filter(([, session]) => isActive(session)).map(([nodeId]) => nodeId).sort();
  const authenticated = (): Session[] => [...sessions].filter(session => session.hello && session.ws.readyState === WebSocket.OPEN);
  const broadcastPresence = (): void => {
    const nodes = activeNodeIds();
    for (const session of authenticated()) send(session, { type: 'notice', kind: 'presence', nodes });
  };
  const notifyCommands = (target: string): void => {
    const session = workers.get(target);
    if (isActive(session)) send(session!, { type: 'notice', kind: 'commands', target });
  };
  // Central gateway writes go directly to server.storage (not through RPC).
  // Bridge every committed storage mutation to the activated target socket so
  // delivery never depends on fallback polling.
  const unsubscribeStore = store.subscribe(notice => {
    if (closed) return;
    if (notice.type === 'commands') notifyCommands(notice.target);
    else if (notice.type === 'presence') broadcastPresence();
    // 'reconnected' is a worker-side hint, not a server push.
  });
  const hasPendingCommands = async (target: string): Promise<boolean> => {
    try { return (await store.list('commands', target)).length > 0; } catch { return false; }
  };

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://relay.local'); } catch { socket.destroy(); return; }
    if (url.pathname !== RELAY_PATH) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    // A token is never accepted from the URL, even alongside a valid header.
    if (url.search || url.hash || !validToken(req.headers.authorization, options.token)
      || sessions.size >= RELAY_MAX_WORKERS + RELAY_MAX_OBSERVERS + 8) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => { wss.emit('connection', ws, req); });
  };

  const handleRequest = async (session: Session, request: RelayRequest): Promise<void> => {
    if (session.pending >= RELAY_MAX_PENDING_RPC) {
      session.ws.close(1013, 'rpc overloaded');
      throw new RelayProtocolError('overloaded', '请求过多');
    }
    session.pending += 1;
    try {
      if (request.op === 'activate') {
        if (session.role !== 'worker' || !session.nodeId) throw new RelayProtocolError('forbidden', '仅工作连接可激活');
        session.activated = true;
        send(session, { type: 'response', id: request.id, ok: true, result: null });
        broadcastPresence();
        if (await hasPendingCommands(session.nodeId)) notifyCommands(session.nodeId);
        return;
      }
      const table = request.table as FleetTable;
      let result: unknown;
      switch (request.op) {
        case 'get':
          result = await store.get(table, request.key!) ?? null;
          break;
        case 'list': {
          const rows = await store.list(table, request.target);
          result = pageRows(rows, table, request.cursor);
          break;
        }
        case 'put':
        case 'remove':
        case 'cas':
          if (session.role !== 'worker') throw new RelayProtocolError('forbidden', '观察连接只读');
          if (request.op === 'put') {
            await store.put(table, request.row!);
            result = null;
          } else if (request.op === 'remove') {
            await store.remove(table, request.key!);
            result = null;
          } else {
            const changed = store.compareAndSwap
              ? await store.compareAndSwap(table, request.row!, request.expectedValue ?? null)
              : false;
            result = changed;
          }
          break;
        default: throw new RelayProtocolError('bad_request', '操作无效');
      }
      send(session, { type: 'response', id: request.id, ok: true, result });
      // Notices are emitted by the store subscription after the durable commit.
    } finally {
      session.pending -= 1;
    }
  };

  const register = (session: Session, hello: RelayHello): boolean => {
    if (hello.role === 'observer') {
      if (observers.size >= RELAY_MAX_OBSERVERS) { session.ws.close(1013, 'observer pool full'); return false; }
      session.role = 'observer'; session.hello = true;
      observers.add(session);
      send(session, { type: 'ready', version: 1, nodes: activeNodeIds() });
      return true;
    }
    const existing = workers.get(hello.nodeId);
    const existingWasActive = isActive(existing);
    if (existing && existing.host !== hello.host) {
      // A different host can never displace the current owner of a stable identity.
      session.ws.close(4003, 'device identity in use');
      return false;
    }
    if (!existing && workers.size >= RELAY_MAX_WORKERS) { session.ws.close(1013, 'worker pool full'); return false; }
    session.role = 'worker'; session.nodeId = hello.nodeId; session.host = hello.host; session.hello = true;
    // Activation is always explicit. A reconnect or a fresh same-host setup
    // never inherits activation from connection history; the caller activates.
    session.activated = false;
    workers.set(hello.nodeId, session);
    if (existing && existing !== session) {
      existing.ws.close(4006, 'replaced by same-host reconnect');
      if (existing.helloTimer) clearTimeout(existing.helloTimer);
    }
    send(session, { type: 'ready', version: 1, nodes: activeNodeIds() });
    if (existingWasActive) broadcastPresence();
    return true;
  };

  wss.on('connection', (ws: WebSocket) => {
    const session: Session = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, ws,
      role: 'observer', hello: false, activated: false, alive: true, pending: 0 };
    sessions.add(session);
    session.helloTimer = setTimeout(() => {
      if (!session.hello) ws.close(4004, 'hello timeout');
    }, RELAY_HELLO_TIMEOUT_MS);
    session.helloTimer.unref();

    ws.on('pong', () => { session.alive = true; });
    ws.on('message', (data, isBinary) => {
      if (closed) return;
      if (isBinary) { ws.close(1003, 'text frames only'); return; }
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (buffer.byteLength > RELAY_FRAME_BYTES) { ws.close(1009, 'frame too large'); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(buffer.toString('utf8')); }
      catch {
        const id = undefined;
        sendError(session, id, new RelayProtocolError('bad_request', '消息不是有效 JSON'));
        return;
      }
      if (!session.hello) {
        try {
          const hello = parseHello(parsed, options.appId);
          if (!register(session, hello)) return;
          if (session.helloTimer) clearTimeout(session.helloTimer);
        } catch {
          ws.close(4001, 'hello rejected');
        }
        return;
      }
      let request: RelayRequest;
      try { request = parseRequest(parsed); }
      catch (error) {
        sendError(session, safeId((parsed as { id?: unknown })?.id), error);
        return;
      }
      void handleRequest(session, request).catch(error => {
        sendError(session, request.id, error);
      });
    });

    ws.on('close', () => {
      sessions.delete(session);
      if (session.helloTimer) clearTimeout(session.helloTimer);
      if (!session.hello) return;
      if (session.role === 'observer') { observers.delete(session); return; }
      if (session.nodeId && workers.get(session.nodeId) === session) {
        const wasActive = session.activated;
        workers.delete(session.nodeId);
        if (wasActive) broadcastPresence();
      }
    });
    ws.on('error', () => { try { ws.terminate(); } catch { /* already closed */ } });
  });

  const pingTimer = setInterval(() => {
    for (const session of sessions) {
      if (!session.alive) { session.ws.terminate(); continue; }
      session.alive = false;
      try { session.ws.ping(); } catch { session.ws.terminate(); }
    }
  }, RELAY_PING_INTERVAL_MS);
  pingTimer.unref();

  httpServer.on('upgrade', upgrade);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { httpServer.off('listening', onListening); reject(error); };
      const onListening = (): void => { httpServer.off('error', onError); resolve(); };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(port, host);
    });
  } catch (error) {
    clearInterval(pingTimer);
    httpServer.off('upgrade', upgrade);
    await store.close();
    throw error;
  }

  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;

  return {
    url: `ws://${urlHost}:${boundPort}${RELAY_PATH}`,
    port: boundPort,
    storage: store,
    setGatewayState(state: GatewayState): void {
      if (!['disabled', 'connecting', 'connected', 'error'].includes(state)) return;
      gatewayState = state;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(pingTimer);
      httpServer.off('upgrade', upgrade);
      unsubscribeStore();
      const terminateAll = (): void => {
        for (const session of sessions) { try { session.ws.terminate(); } catch { /* already closed */ } }
      };
      for (const session of sessions) {
        try { session.ws.close(1001, 'server shutting down'); } catch { session.ws.terminate(); }
      }
      // A peer that never answers the closing handshake must not hold shutdown.
      const force = setTimeout(terminateAll, 1_000);
      force.unref();
      await Promise.race([
        new Promise<void>(resolve => wss.close(() => resolve())),
        new Promise<void>(resolve => { const timer = setTimeout(resolve, 1_500); timer.unref(); }),
      ]);
      clearTimeout(force);
      terminateAll();
      httpServer.closeAllConnections?.();
      await Promise.race([
        new Promise<void>(resolve => httpServer.close(() => resolve())),
        new Promise<void>(resolve => { const timer = setTimeout(resolve, 1_500); timer.unref(); }),
      ]);
      sessions.clear(); workers.clear(); observers.clear();
      await store.close();
    },
  };
}

export { RELAY_LIST_MAX };
