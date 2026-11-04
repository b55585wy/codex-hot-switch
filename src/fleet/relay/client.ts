import { randomBytes } from 'node:crypto';
import fleetCreateHttpsProxyAgent from 'https-proxy-agent';
import { WebSocket } from 'ws';
import type { FleetStorage, FleetStorageNotice, FleetTable, StoredValue } from '../model';
import { validateFleetApiProxyUrl, validateFleetRelayUrl } from '../model';
import {
  RELAY_DATA_BYTES, RELAY_FRAME_BYTES, RELAY_MAX_PENDING_RPC,
  RELAY_MAX_ROWS, RELAY_MAX_WORKERS, RELAY_PATH, RELAY_PROTOCOL_VERSION,
  RELAY_SEND_BUFFER_BYTES, RELAY_TOKEN_MIN_BYTES, encodedRowBytes, validateStoredValue,
} from './protocol';

export const RELAY_CLIENT_CONNECT_TIMEOUT_MS = 8_000;
export const RELAY_CLIENT_RPC_TIMEOUT_MS = 15_000;
export const RELAY_CLIENT_RECONNECT_MAX_MS = 30_000;

type WsConstructorOptions = {
  headers?: Record<string, string>;
  agent?: unknown;
  handshakeTimeout?: number;
  maxPayload?: number;
  perMessageDeflate?: boolean;
};
const WebSocketCtor = WebSocket as unknown as new (url: string, options?: WsConstructorOptions) => WebSocket;

export type RelayClientRole = 'worker' | 'observer';

export interface FleetRelayClientOptions {
  /** Public wss URL or loopback ws URL. It must not carry a token. */
  url: string;
  /** Resolved from the native keystore by the caller. Never logged or serialized. */
  token?: string;
  /** Lazy native-keystore lookup, for the long-lived worker path. */
  tokenProvider?: () => Promise<string | undefined>;
  appId: string;
  role?: RelayClientRole;
  nodeId?: string;
  host?: string;
  proxyUrl?: string;
  connectTimeoutMs?: number;
  rpcTimeoutMs?: number;
  /** Initial worker connections may be retried; setup/observer callers use one shot. */
  autoReconnect?: boolean;
  /**
   * Direct/library clients may restore a previously ACKNOWLEDGED activation on
   * reconnect. The worker selects caller-managed activation so the runtime can
   * publish/sync and then activate before draining commands.
   */
  autoActivate?: boolean;
  onFatal?: (error: Error) => void;
}

export class RelayClientError extends Error {
  constructor(message: string, readonly terminal = false, readonly code?: string) {
    super(message);
    this.name = 'RelayClientError';
  }
}
/** A mutation whose response was lost. It must never be replayed automatically. */
export class RelayUnknownMutationError extends RelayClientError {
  constructor(readonly op: string) {
    super('中继操作结果未知：连接中断或超时，未自动重试；请先核对目标电脑状态再决定是否重新提交。', false, 'unknown');
    this.name = 'RelayUnknownMutationError';
  }
}
export class RelayRemoteError extends RelayClientError {
  constructor(readonly remoteCode: string, message: string) {
    super(message, false, remoteCode);
    this.name = 'RelayRemoteError';
  }
}

interface PendingRpc {
  socket: WebSocket;
  generation: number;
  mutation: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const NODE_ID_RE = /^[a-f0-9-]{36}$/i;
const APP_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const REMOTE_ERROR_MESSAGES: Record<string, string> = {
  bad_request: '中继请求无效', unauthorized: '中继认证失败', forbidden: '中继权限不足',
  conflict: '中继数据冲突', not_found: '中继记录不存在', too_large: '中继记录或帧超过限制',
  overloaded: '中继繁忙，请稍后重试', expired: '中继记录已过期', internal: '中继内部错误',
};

function sanitizeToken(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new RelayClientError('中继令牌无效：不能为空或包含空白字符', true, 'auth');
  }
  if (Buffer.byteLength(value, 'utf8') < RELAY_TOKEN_MIN_BYTES || value.length > 512) {
    throw new RelayClientError(`中继令牌无效：至少需要 ${RELAY_TOKEN_MIN_BYTES} 字节且不超过 512 个字符`, true, 'auth');
  }
  return value;
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 300_000) {
    throw new RelayClientError('中继超时配置无效', true, 'config');
  }
  return Math.floor(value);
}

/** Accepts the documented endpoint or a bare origin, never a token-bearing URL. */
export function normalizeRelayUrl(input: string): string {
  validateFleetRelayUrl(input);
  const parsed = new URL(input);
  if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = RELAY_PATH;
  if (parsed.pathname !== RELAY_PATH) {
    throw new RelayClientError(`中继地址必须使用固定路径 ${RELAY_PATH}`, true, 'config');
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

/**
 * Status/log output never includes userinfo, token, query or fragment. Only a
 * fully validated endpoint is printed; anything else becomes a fixed marker,
 * never an arbitrary path that could carry a token.
 */
export function sanitizeRelayUrl(input: string): string {
  try {
    return normalizeRelayUrl(input);
  } catch {
    return '(invalid relay url)';
  }
}

function rowValue(value: unknown): StoredValue {
  try {
    return validateStoredValue(value);
  } catch {
    throw new RelayClientError('中继返回了无效记录');
  }
}

function validateRow(row: StoredValue): StoredValue {
  try {
    return validateStoredValue(row);
  } catch {
    throw new RelayClientError('记录超过中继大小限制，无法发送');
  }
}

/**
 * Worker/observer WebSocket client for relay protocol v1.
 *
 * The client owns one socket at a time. Every handler captures its socket and
 * generation so a replaced socket can never resolve a newer request or publish
 * stale presence. Requests are correlated, bounded and time-limited; mutations
 * are never replayed after an unknown outcome.
 */
export class FleetRelayClient implements FleetStorage {
  readonly role: RelayClientRole;
  readonly nodeId?: string;
  readonly appId: string;
  readonly url: string;
  private readonly tokenProvider: () => Promise<string | undefined>;
  private readonly host?: string;
  private readonly proxyUrl?: string;
  private readonly connectTimeoutMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly autoReconnect: boolean;
  private autoActivate: boolean;
  private readonly onFatal?: (error: Error) => void;
  private readonly idPrefix = randomBytes(6).toString('hex');
  private counter = 0;
  private socket?: WebSocket;
  private generation = 0;
  private connecting?: Promise<void>;
  private cancelConnect?: () => void;
  private ready = false;
  private closed = false;
  private terminal?: Error;
  private desiredActivated = false;
  private everReady = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private nodes = new Set<string>();
  private readonly pending = new Map<string, PendingRpc>();
  private readonly listeners = new Set<(notice: FleetStorageNotice) => void>();

  constructor(options: FleetRelayClientOptions) {
    this.url = normalizeRelayUrl(options.url);
    if (typeof options.appId !== 'string' || !APP_ID_RE.test(options.appId)) {
      throw new RelayClientError('中继应用标识无效', true, 'config');
    }
    this.appId = options.appId;
    if (options.role !== undefined && options.role !== 'worker' && options.role !== 'observer') {
      throw new RelayClientError('中继连接角色无效', true, 'config');
    }
    this.role = options.role ?? 'worker';
    this.nodeId = options.nodeId;
    this.host = options.host;
    this.proxyUrl = options.proxyUrl;
    this.autoReconnect = options.autoReconnect !== false;
    this.autoActivate = options.autoActivate !== false;
    this.connectTimeoutMs = boundedTimeout(options.connectTimeoutMs, RELAY_CLIENT_CONNECT_TIMEOUT_MS);
    this.rpcTimeoutMs = boundedTimeout(options.rpcTimeoutMs, RELAY_CLIENT_RPC_TIMEOUT_MS);
    this.onFatal = options.onFatal;
    if (this.role === 'worker') {
      if (!this.nodeId || !NODE_ID_RE.test(this.nodeId)) {
        throw new RelayClientError('中继工作连接缺少有效设备 ID', true, 'config');
      }
      if (typeof this.host !== 'string' || !this.host || this.host.length > 128
        || /[\u0000-\u001f\u007f]/.test(this.host)) {
        throw new RelayClientError('中继工作连接缺少有效电脑标识', true, 'config');
      }
    } else if (this.nodeId !== undefined || this.host !== undefined) {
      throw new RelayClientError('中继观察连接不能声明设备身份', true, 'config');
    }
    if (this.proxyUrl !== undefined) validateFleetApiProxyUrl(this.proxyUrl);
    const direct = options.token === undefined ? undefined : sanitizeToken(options.token);
    if (!direct && !options.tokenProvider) {
      throw new RelayClientError('中继令牌未配置', true, 'auth');
    }
    this.tokenProvider = options.tokenProvider
      ?? (async () => direct);
  }

  get isReady(): boolean { return this.ready && this.socket?.readyState === 1; }
  get fatalError(): Error | undefined { return this.terminal; }
  get activeNodeIds(): string[] { return [...this.nodes].sort(); }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new RelayClientError('中继连接已关闭', true, 'closed'));
    if (this.terminal) return Promise.reject(this.terminal);
    if (this.isReady) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const attempt = this.openSocket(false).finally(() => {
      if (this.connecting === attempt) this.connecting = undefined;
    });
    this.connecting = attempt;
    return attempt;
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.closed || this.terminal || this.reconnectTimer) return;
    const base = Math.min(RELAY_CLIENT_RECONNECT_MAX_MS, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    const delay = base + Math.floor(Math.random() * 250);
    this.reconnectAttempt += 1;
    const timer = setTimeout(() => {
      if (this.reconnectTimer === timer) this.reconnectTimer = undefined;
      if (this.closed || this.terminal || this.isReady) return;
      if (!this.connecting) {
        const task = this.openSocket(true);
        this.connecting = task;
        void task.catch(() => undefined).finally(() => {
          if (this.connecting === task) this.connecting = undefined;
        });
      }
    }, delay);
    timer.unref();
    this.reconnectTimer = timer;
  }

  private failTerminal(error: Error): void {
    if (this.terminal) return;
    this.terminal = error;
    this.ready = false;
    this.nodes.clear();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.rejectPending();
    this.emit({ type: 'presence' });
    try { this.onFatal?.(error); } catch { /* caller callback must not break teardown */ }
  }

  private openSocket(reconnect: boolean): Promise<void> {
    return new Promise<void>((resolveConnect, rejectConnect) => {
      let settled = false;
      let helloDone = false;
      let socket: WebSocket | undefined;
      let cancel!: () => void;
      const fail = (error: Error, terminal = false): void => {
        if (settled) return;
        settled = true;
        if (this.cancelConnect === cancel) this.cancelConnect = undefined;
        clearTimeout(connectTimer);
        if (terminal) this.failTerminal(error);
        else if (!this.closed && !this.terminal && reconnect) this.scheduleReconnect();
        if (socket && this.socket === socket) {
          try { socket.terminate(); } catch { /* closed */ }
          this.socket = undefined;
          this.ready = false;
        }
        rejectConnect(error);
      };
      const succeed = async (): Promise<void> => {
        if (settled) return;
        settled = true;
        if (this.cancelConnect === cancel) this.cancelConnect = undefined;
        clearTimeout(connectTimer);
        this.reconnectAttempt = 0;
        this.everReady = true;
        try {
          // Only a previously ACKNOWLEDGED activation is auto-restored, and only
          // in library-managed mode. The worker uses caller-managed activation.
          if (this.autoActivate && this.desiredActivated && this.socket === socket) {
            await this.rpc('activate', {}, true);
          }
        } catch (error) {
          if (!this.closed && !this.terminal) this.scheduleReconnect();
          rejectConnect(error instanceof Error ? error : new RelayClientError('中继激活失败'));
          return;
        }
        // Caller-managed mode emits reconnected while still INACTIVE so the
        // runtime can republish/sync and activate before draining commands.
        if (reconnect && !this.closed) this.emit({ type: 'reconnected' });
        resolveConnect();
      };
      // A close (or replaced attempt) cancels token lookup and a CONNECTING
      // socket immediately instead of waiting for the connect timer.
      cancel = (): void => { fail(new RelayClientError('中继连接已关闭', false, 'closed')); };
      this.cancelConnect = cancel;

      let token: string | undefined;
      const connectTimer = setTimeout(() => {
        fail(new RelayClientError('中继连接超时（网络或代理不可达）', false, 'timeout'));
      }, this.connectTimeoutMs);
      connectTimer.unref();
      let tokenPromise: Promise<string | undefined>;
      try {
        tokenPromise = this.tokenProvider();
      } catch {
        fail(new RelayClientError('中继令牌读取失败', true, 'auth'));
        return;
      }

      void tokenPromise.then(value => {
        try { token = sanitizeToken(value); }
        catch (error) { fail(error as Error, true); return; }
        if (settled || this.closed) return;
        const headers = { Authorization: `Bearer ${token}` };
        const options: WsConstructorOptions = { headers, handshakeTimeout: this.connectTimeoutMs,
          maxPayload: RELAY_FRAME_BYTES, perMessageDeflate: false };
        if (this.proxyUrl) {
          try {
            // The proxy is scoped to this relay socket only; no global env proxy.
            options.agent = fleetCreateHttpsProxyAgent(this.proxyUrl);
          } catch {
            fail(new RelayClientError('中继代理配置无效', true, 'config'));
            return;
          }
        }
        try { socket = new WebSocketCtor(this.url, options); }
        catch { fail(new RelayClientError('中继连接无法建立（网络错误）')); return; }
        this.socket = socket;
        const ws = socket;
        const generation = ++this.generation;
        this.ready = false;

        const current = (): boolean => this.socket === ws && this.generation === generation;
        ws.on('open', () => {
          if (!current() || settled) return;
          const hello = this.role === 'observer'
            ? { type: 'hello', version: RELAY_PROTOCOL_VERSION, appId: this.appId, role: 'observer' as const }
            : { type: 'hello', version: RELAY_PROTOCOL_VERSION, appId: this.appId, role: 'worker' as const,
              nodeId: this.nodeId, host: this.host };
          if (!this.sendOn(ws, hello)) { fail(new RelayClientError('中继握手发送失败')); }
        });
        ws.on('message', (data, isBinary) => {
          if (!current()) return;
          if (isBinary) { fail(new RelayClientError('中继返回了不允许的二进制帧', true, 'protocol'), true); return; }
          const buffer = Buffer.isBuffer(data) ? data
            : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
          if (buffer.length > RELAY_FRAME_BYTES) {
            fail(new RelayClientError('中继返回帧超过 256 KiB 限制', true, 'protocol'), true);
            return;
          }
          if (helloDone) { this.onMessage(buffer); return; }
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>;
          } catch { fail(new RelayClientError('中继握手响应无效', true, 'protocol')); return; }
          if (parsed.type !== 'ready' || parsed.version !== RELAY_PROTOCOL_VERSION
            || !Array.isArray(parsed.nodes) || parsed.nodes.length > RELAY_MAX_WORKERS
            || parsed.nodes.some(node => typeof node !== 'string' || !NODE_ID_RE.test(node))) {
            fail(new RelayClientError('中继协议版本不兼容或握手响应无效', true, 'version'));
            return;
          }
          helloDone = true;
          this.ready = true;
          this.nodes = new Set((parsed.nodes as string[]).map(node => node.toLowerCase()));
          this.emit({ type: 'presence' });
          void succeed();
        });
        ws.on('unexpected-response', (_request, response) => {
          if (!current()) return;
          const status = response.statusCode ?? 0;
          const terminal = status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
          fail(new RelayClientError(`中继认证或地址无效（HTTP ${status || '未知'}）`, terminal,
            status === 401 || status === 403 ? 'auth' : 'http'), terminal);
        });
        ws.on('error', () => {
          if (!current()) return;
          fail(new RelayClientError(this.holderMessage()));
        });
        ws.on('close', (code) => {
          if (!current()) return;
          const wasReady = this.ready;
          this.ready = false;
          this.socket = undefined;
          this.nodes.clear();
          this.rejectPending();
          if (wasReady) this.emit({ type: 'presence' });
          if (settled) {
            if (!this.closed && !this.terminal) {
              if (code === 4001) this.failTerminal(new RelayClientError('中继认证失败或应用/协议不匹配', true, 'auth'));
              else if (code === 4003) this.failTerminal(new RelayClientError('设备身份正被另一台电脑使用', true, 'identity'));
              else if (code === 4006) this.failTerminal(new RelayClientError('中继连接已被同机的新会话替换', true, 'identity'));
              else if (this.everReady || reconnect) this.scheduleReconnect();
            }
            return;
          }
          if (code === 4001) fail(new RelayClientError('中继认证失败或应用/协议不匹配', true, 'auth'), true);
          else if (code === 4003) fail(new RelayClientError('设备身份正被另一台电脑使用', true, 'identity'), true);
          else if (code === 4006) fail(new RelayClientError('中继连接已被同机的新会话替换', true, 'identity'), true);
          else fail(new RelayClientError('中继连接在握手阶段关闭（网络错误）'));
        });
      }).catch(() => {
        fail(new RelayClientError('中继令牌读取失败', true, 'auth'));
      });
    });
  }

  private holderMessage(): string {
    return '中继连接失败（网络错误或代理不可达）';
  }

  private sendOn(socket: WebSocket, value: unknown): boolean {
    if (socket.readyState !== 1) return false;
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload, 'utf8') > RELAY_FRAME_BYTES) return false;
    if (socket.bufferedAmount > RELAY_SEND_BUFFER_BYTES) {
      try { socket.terminate(); } catch { /* already closed */ }
      return false;
    }
    try {
      socket.send(payload, error => {
        if (error && socket === this.socket) {
          try { socket.terminate(); } catch { /* already closed */ }
        }
      });
      return true;
    } catch { return false; }
  }

  private onMessage(data: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch { this.protocolViolation('中继返回了无效消息'); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.protocolViolation('中继返回了无效消息'); return;
    }
    const message = parsed as Record<string, unknown>;
    if (message.type === 'response') {
      const id = message.id;
      if (typeof id !== 'string' || !id || id.length > 128) { this.protocolViolation('中继响应 ID 无效'); return; }
      const pending = this.pending.get(id);
      if (!pending || pending.socket !== this.socket || pending.generation !== this.generation) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.ok === true) { pending.resolve(message.result); return; }
      if (message.ok !== false) { pending.reject(new RelayClientError('中继响应无效')); return; }
      const error = message.error as { code?: unknown } | undefined;
      const rawCode = typeof error?.code === 'string' ? error.code : 'internal';
      const code = Object.prototype.hasOwnProperty.call(REMOTE_ERROR_MESSAGES, rawCode) ? rawCode : 'internal';
      // Never surface an arbitrary server/proxy payload (it may echo a token).
      pending.reject(new RelayRemoteError(code, REMOTE_ERROR_MESSAGES[code]!));
      return;
    }
    if (message.type === 'notice') {
      if (message.kind === 'presence') {
        if (!Array.isArray(message.nodes) || message.nodes.length > RELAY_MAX_WORKERS
          || message.nodes.some(node => typeof node !== 'string' || !NODE_ID_RE.test(node))) {
          this.protocolViolation('中继在线状态通知无效');
          return;
        }
        this.nodes = new Set((message.nodes as string[]).map(node => node.toLowerCase()));
        this.emit({ type: 'presence' });
        return;
      }
      if (message.kind === 'commands') {
        if (typeof message.target !== 'string' || !NODE_ID_RE.test(message.target)) {
          this.protocolViolation('中继指令通知无效');
          return;
        }
        this.emit({ type: 'commands', target: message.target.toLowerCase() });
        return;
      }
      this.protocolViolation('中继通知类型无效');
    }
  }

  private protocolViolation(message: string): void {
    const error = new RelayClientError(message, true, 'protocol');
    this.failTerminal(error);
    try { this.socket?.terminate(); } catch { /* already closed */ }
  }

  private rejectPending(): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      // A lost read is not a task mutation; callers may safely retry it.
      entry.reject(entry.mutation
        ? new RelayUnknownMutationError('request')
        : new RelayClientError('中继读取未完成；可安全重试', false, 'offline'));
    }
  }

  private async rpc(op: string, extra: Record<string, unknown>, mutation: boolean): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || !this.ready) {
      throw new RelayClientError('中继尚未连接', false, 'offline');
    }
    if (this.pending.size >= RELAY_MAX_PENDING_RPC) {
      throw new RelayClientError('中继待处理请求过多', false, 'overloaded');
    }
    const id = `${this.idPrefix}-${++this.counter}`;
    const generation = this.generation;
    return new Promise<unknown>((resolve, reject) => {
      const timeoutError = (): Error => mutation
        ? new RelayUnknownMutationError(op)
        : new RelayClientError('中继读取超时；可安全重试', false, 'timeout');
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(timeoutError());
      }, this.rpcTimeoutMs);
      timer.unref();
      this.pending.set(id, { socket, generation, mutation, timer, resolve, reject });
      if (!this.sendOn(socket, { type: 'request', id, op, ...extra })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(timeoutError());
      }
    });
  }

  private emit(notice: FleetStorageNotice): void {
    for (const listener of this.listeners) {
      try { listener(notice); } catch { /* listener failures never break the socket */ }
    }
  }

  /**
   * Select caller-managed activation (worker). Reconnects emit `reconnected`
   * while INACTIVE; the caller must activate explicitly after publication/sync.
   */
  manageActivation(): void {
    this.autoActivate = false;
  }

  async activate(): Promise<void> {
    // Never mark the desired state before acknowledgement: an unknown outcome
    // must not be automatically replayed on the next reconnect.
    await this.rpc('activate', {}, true);
    this.desiredActivated = true;
  }

  async get(table: FleetTable, key: string): Promise<StoredValue | undefined> {
    const result = await this.rpc('get', { table, key }, false);
    return result == null ? undefined : rowValue(result);
  }

  /**
   * Full pagination by byte budget. Pages may legitimately contain one large
   * row, so the bound is total rows/data and cursor progress, not an assumed
   * page count. Every page must be strictly ordered, unique and non-empty when
   * it advertises a cursor; otherwise the result is rejected rather than
   * silently truncated.
   */
  async list(table: FleetTable, target?: string): Promise<StoredValue[]> {
    const items: StoredValue[] = [];
    const seenKeys = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let lastKey: string | undefined;
    let dataBytes = 0;
    for (let page = 0; page < RELAY_MAX_ROWS + 1; page += 1) {
      const result = await this.rpc('list', {
        table, ...(target ? { target } : {}), ...(cursor ? { cursor } : {}),
      }, false) as { items?: unknown; cursor?: unknown };
      if (!result || !Array.isArray(result.items)) throw new RelayClientError('中继返回了无效分页结果');
      const nextCursor = result.cursor;
      if (nextCursor !== undefined && (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 512)) {
        throw new RelayClientError('中继返回了无效分页游标');
      }
      if (nextCursor !== undefined && result.items.length === 0) {
        throw new RelayClientError('中继分页游标没有进展');
      }
      let previous = lastKey;
      for (const item of result.items) {
        const row = rowValue(item);
        if (seenKeys.has(row.key)) throw new RelayClientError('中继返回了重复记录');
        if (previous !== undefined && row.key <= previous) throw new RelayClientError('中继记录未按顺序返回');
        seenKeys.add(row.key);
        previous = row.key;
        items.push(row);
        dataBytes += encodedRowBytes(row) + 1;
        if (items.length > RELAY_MAX_ROWS) throw new RelayClientError('中继记录超过分页上限');
        if (dataBytes > RELAY_DATA_BYTES) throw new RelayClientError('中继记录超过总数据上限');
      }
      if (previous !== undefined) lastKey = previous;
      if (nextCursor === undefined) return items;
      if (seenCursors.has(nextCursor)) throw new RelayClientError('中继返回了重复分页游标');
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new RelayClientError('中继分页超过上限');
  }

  async put(table: FleetTable, row: StoredValue): Promise<void> {
    await this.rpc('put', { table, row: validateRow(row) }, true);
  }

  async remove(table: FleetTable, key: string): Promise<void> {
    await this.rpc('remove', { table, key }, true);
  }

  async compareAndSwap(table: FleetTable, row: StoredValue, expectedValue: string | null): Promise<boolean> {
    const result = await this.rpc('cas', { table, row: validateRow(row), expectedValue }, true);
    if (typeof result !== 'boolean') throw new RelayClientError('中继返回了无效 CAS 结果');
    return result;
  }

  subscribe(listener: (notice: FleetStorageNotice) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  isNodeConnected(nodeId: string): boolean {
    if (this.role === 'observer') return this.nodes.has(nodeId);
    return this.nodes.has(nodeId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    // Cancel a pending token lookup or CONNECTING socket immediately so the
    // connect promise rejects now instead of waiting for the 8s timer.
    const cancel = this.cancelConnect;
    this.cancelConnect = undefined;
    try { cancel?.(); } catch { /* already settled */ }
    this.rejectPending();
    const socket = this.socket;
    this.socket = undefined;
    this.nodes.clear();
    if (socket && socket.readyState === 1) {
      try { socket.close(1000, 'client closing'); } catch { /* already closed */ }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 500);
        timer.unref();
        socket.on('close', () => { clearTimeout(timer); resolve(); });
      });
    }
    try { socket?.terminate(); } catch { /* already closed */ }
  }
}
