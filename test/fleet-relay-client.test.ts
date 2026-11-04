import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFleetRelayServer, type FleetRelayServer } from '../src/fleet/relay/server';
import {
  FleetRelayClient, RelayClientError, RelayUnknownMutationError,
  normalizeRelayUrl, sanitizeRelayUrl,
} from '../src/fleet/relay/client';
import type { FleetStorageNotice } from '../src/fleet/model';

const token = 'relay-client-test-token-0123456789abcdef';
const nodeA = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
const servers: FleetRelayServer[] = [];
const clients: FleetRelayClient[] = [];
const sockets: WebSocketServer[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) await client.close();
  for (const socket of sockets.splice(0)) await new Promise<void>(done => socket.close(() => done()));
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

async function startServer() {
  const root = await mkdtemp(join(tmpdir(), 'bridge-relay-client-'));
  roots.push(root);
  const server = await startFleetRelayServer({ appId: 'cli_test', token, dataDir: root, port: 0 });
  servers.push(server);
  return { server, root };
}

function worker(server: FleetRelayServer, overrides: Partial<ConstructorParameters<typeof FleetRelayClient>[0]> = {}) {
  const client = new FleetRelayClient({ url: server.url, token, appId: 'cli_test', role: 'worker',
    nodeId: nodeA, host: 'host-a', autoReconnect: false, ...overrides });
  clients.push(client);
  return client;
}

describe('relay URL and token validation', () => {
  it('accepts a bare wss origin or the fixed endpoint and rejects credentials, query tokens and paths', () => {
    expect(normalizeRelayUrl('wss://relay.example.com')).toBe('wss://relay.example.com/relay/v1');
    expect(normalizeRelayUrl('wss://relay.example.com/relay/v1')).toBe('wss://relay.example.com/relay/v1');
    for (const url of [
      'wss://user:pass@relay.example.com/relay/v1',
      'wss://relay.example.com/relay/v1?token=secret',
      'wss://relay.example.com/relay/v1#fragment',
      'wss://relay.example.com/other',
      'ws://relay.example.com/relay/v1',
    ]) expect(() => normalizeRelayUrl(url)).toThrow();
    // A token-like/invalid endpoint is never echoed; only a fixed marker.
    expect(sanitizeRelayUrl('wss://user:pass@relay.example.com/relay/v1?x=1'))
      .toBe('(invalid relay url)');
    expect(sanitizeRelayUrl('wss://relay.example.com/secret-token-path')).toBe('(invalid relay url)');
    expect(sanitizeRelayUrl('wss://relay.example.com')).toBe('wss://relay.example.com/relay/v1');
  });

  it('rejects malformed app ids, roles, hosts and timeouts before connecting', () => {
    const base = { url: 'ws://127.0.0.1:8787/relay/v1', token, appId: 'cli_test', nodeId: nodeA, host: 'h' };
    expect(() => new FleetRelayClient({ ...base, appId: '../evil' })).toThrow(/应用标识/);
    expect(() => new FleetRelayClient({ ...base, role: 'admin' as never })).toThrow(/角色/);
    expect(() => new FleetRelayClient({ ...base, host: 'x'.repeat(129) })).toThrow(/电脑标识/);
    expect(() => new FleetRelayClient({ ...base, connectTimeoutMs: -1 })).toThrow(/超时/);
    expect(() => new FleetRelayClient({ ...base, role: 'observer', nodeId: nodeA })).toThrow(/观察连接/);
  });
});

describe('real WebSocket storage client', () => {
  it('connects inactive, activates, and supports CRUD, CAS, full pagination and notices', async () => {
    const { server } = await startServer();
    const client = worker(server);
    const notices: FleetStorageNotice[] = [];
    client.subscribe(notice => notices.push(notice));
    await client.connect();
    expect(client.isReady).toBe(true);
    // A mere connection is not presence in the relay contract.
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(false);
    await client.activate();
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(true);

    await client.put('routes', { key: 'home', value: 'signed-home' });
    expect(await client.get('routes', 'home')).toEqual({ key: 'home', value: 'signed-home' });
    expect(await client.compareAndSwap('routes', { key: 'home', value: 'next' }, 'signed-home')).toBe(true);
    expect(await client.compareAndSwap('routes', { key: 'home', value: 'lost' }, 'signed-home')).toBe(false);
    await client.remove('routes', 'home');
    expect(await client.get('routes', 'home')).toBeUndefined();

    for (let index = 0; index < 105; index += 1) {
      await client.put('routes', { key: `page-${String(index).padStart(3, '0')}`, value: `v${index}` });
    }
    const rows = await client.list('routes');
    expect(rows).toHaveLength(105);
    expect(rows[0]!.key).toBe('page-000');
    expect(new Set(rows.map(row => row.key)).size).toBe(105);

    await server.storage.put('commands', { key: 'cmd-1', value: 'signed', target: nodeA,
      expiresAt: Date.now() + 30_000 });
    await vi.waitFor(() => expect(notices.some(notice => notice.type === 'commands'
      && notice.target === nodeA)).toBe(true));
  });

  it('lets observers read but never write, activate or replace a worker', async () => {
    const { server } = await startServer();
    const owner = worker(server);
    await owner.connect();
    await owner.activate();
    await owner.put('nodes', { key: nodeA, value: 'worker-row' });
    const observer = new FleetRelayClient({ url: server.url, token, appId: 'cli_test', role: 'observer', autoReconnect: false });
    clients.push(observer);
    await observer.connect();
    expect(await observer.get('nodes', nodeA)).toMatchObject({ value: 'worker-row' });
    await expect(observer.put('nodes', { key: 'x', value: 'y' })).rejects.toMatchObject({ remoteCode: 'forbidden' });
    await expect(observer.activate()).rejects.toMatchObject({ remoteCode: 'forbidden' });
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(true);
  });

  it('treats bad auth as terminal and never retries', async () => {
    const { server } = await startServer();
    const client = worker(server, { token: 'wrong-token-0123456789abcdefghijklmnop' });
    await expect(client.connect()).rejects.toMatchObject({ terminal: true });
    expect(client.fatalError).toBeInstanceOf(RelayClientError);
    await expect(client.connect()).rejects.toBe(client.fatalError);
  });

  it('reconnects, re-activates and ignores the replaced socket without replaying writes', async () => {
    const { server } = await startServer();
    const client = worker(server, { autoReconnect: true });
    const notices: FleetStorageNotice[] = [];
    client.subscribe(notice => notices.push(notice));
    await client.connect();
    await client.activate();
    const raw = (client as unknown as { socket: { terminate(): void } }).socket;
    raw.terminate();
    await vi.waitFor(() => expect(notices.some(notice => notice.type === 'reconnected')).toBe(true), { timeout: 5_000 });
    await client.put('routes', { key: 'after', value: 'ok' });
    expect(await client.get('routes', 'after')).toMatchObject({ value: 'ok' });
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(true);
  });

  it('caller-managed activation reconnects INACTIVE and never auto-activates', async () => {
    const { server } = await startServer();
    const client = worker(server, { autoReconnect: true });
    client.manageActivation();
    const states: boolean[] = [];
    client.subscribe(notice => {
      if (notice.type === 'reconnected') states.push(Boolean(server.storage.isNodeConnected?.(nodeA)));
    });
    await client.connect();
    await client.activate();
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(true);
    const raw = (client as unknown as { socket: { terminate(): void } }).socket;
    raw.terminate();
    await vi.waitFor(() => expect(states).toHaveLength(1), { timeout: 5_000 });
    expect(states[0]).toBe(false);
    await new Promise(done => setTimeout(done, 150));
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(false);
    await client.activate();
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(true);
  });

  it('rejects an in-flight mutation as unknown on timeout and does not resend it', async () => {
    const raw = new (WebSocketServer as unknown as new (options: { port: number }) => WebSocketServer)({ port: 0 }) as unknown as {
      once(event: 'listening', listener: () => void): void;
      address(): { port: number };
      on(event: 'connection', listener: (socket: {
        on(event: 'message', listener: (data: Buffer) => void): void;
        send(data: string): void;
      }) => void): void;
    };
    sockets.push(raw as unknown as WebSocketServer);
    await new Promise<void>(done => raw.once('listening', () => done()));
    const port = raw.address().port;
    const requests: unknown[] = [];
    raw.on('connection', socket => {
      socket.on('message', data => {
        const message = JSON.parse(String(data)) as { type: string; id: string };
        if (message.type === 'hello') socket.send(JSON.stringify({ type: 'ready', version: 1, nodes: [] }));
        else requests.push(message);
      });
    });
    const client = new FleetRelayClient({ url: `ws://127.0.0.1:${port}/relay/v1`, token,
      appId: 'cli_test', role: 'worker', nodeId: nodeA, host: 'host-a', autoReconnect: false,
      rpcTimeoutMs: 120 });
    clients.push(client);
    await client.connect();
    await expect(client.put('routes', { key: 'uncertain', value: 'x' }))
      .rejects.toBeInstanceOf(RelayUnknownMutationError);
    expect(requests).toHaveLength(1);
    await new Promise(done => setTimeout(done, 250));
    expect(requests).toHaveLength(1);
  });

  it('accepts a raw 128 KiB row via the shared validator and paginates one-row pages beyond 101', async () => {
    const { server } = await startServer();
    const client = worker(server);
    await client.connect();
    await client.activate();
    // Raw value limit (128 KiB) is authoritative; escaped-envelope headroom is shared.
    const large = 'a'.repeat(128 * 1024);
    await client.put('routes', { key: 'large', value: large });
    expect((await client.get('routes', 'large'))!.value).toHaveLength(128 * 1024);

    // Each row exceeds the 128 KiB soft page target, so every page has one row.
    for (let index = 0; index < 102; index += 1) {
      await client.put('routes', { key: `big-${String(index).padStart(3, '0')}`,
        value: 'b'.repeat(128 * 1024) });
    }
    const rows = await client.list('routes');
    expect(rows).toHaveLength(103);
    expect(new Set(rows.map(row => row.key)).size).toBe(103);
    const keys = rows.map(row => row.key);
    expect([...keys].sort()).toEqual(keys);
  }, 60_000);

  it('cancels connect immediately while a token lookup is unresolved', async () => {
    let resolveToken!: (value: string) => void;
    const client = new FleetRelayClient({ url: 'ws://127.0.0.1:9/relay/v1', appId: 'cli_test',
      role: 'worker', nodeId: nodeA, host: 'h', autoReconnect: false,
      tokenProvider: () => new Promise<string>(resolve => { resolveToken = resolve; }),
      connectTimeoutMs: 10_000 });
    clients.push(client);
    const connecting = client.connect();
    await new Promise(done => setTimeout(done, 20));
    const started = Date.now();
    await client.close();
    await expect(connecting).rejects.toMatchObject({ code: 'closed' });
    expect(Date.now() - started).toBeLessThan(1_000);
    resolveToken(token);
  });

  it('cancels an unready CONNECTING socket and rejects quickly', async () => {
    const raw = new (WebSocketServer as unknown as new (options: { port: number }) => WebSocketServer)({ port: 0 }) as unknown as {
      once(event: 'listening', listener: () => void): void;
      address(): { port: number };
      close(cb?: () => void): void;
    };
    sockets.push(raw as unknown as WebSocketServer);
    await new Promise<void>(done => raw.once('listening', () => done()));
    const client = new FleetRelayClient({ url: `ws://127.0.0.1:${raw.address().port}/relay/v1`,
      token, appId: 'cli_test', role: 'worker', nodeId: nodeA, host: 'h', autoReconnect: false,
      connectTimeoutMs: 10_000 });
    clients.push(client);
    const connecting = client.connect();
    await new Promise(done => setTimeout(done, 100));
    const started = Date.now();
    await client.close();
    await expect(connecting).rejects.toBeInstanceOf(RelayClientError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('maps arbitrary remote errors to bounded safe text without echoing payload', async () => {
    const raw = new (WebSocketServer as unknown as new (options: { port: number }) => WebSocketServer)({ port: 0 }) as unknown as {
      once(event: 'listening', listener: () => void): void;
      address(): { port: number };
      on(event: 'connection', listener: (socket: {
        on(event: 'message', listener: (data: Buffer) => void): void;
        send(data: string): void;
      }) => void): void;
    };
    sockets.push(raw as unknown as WebSocketServer);
    await new Promise<void>(done => raw.once('listening', () => done()));
    raw.on('connection', socket => {
      socket.on('message', data => {
        const message = JSON.parse(String(data)) as { type: string; id: string };
        if (message.type === 'hello') socket.send(JSON.stringify({ type: 'ready', version: 1, nodes: [] }));
        else socket.send(JSON.stringify({ type: 'response', id: message.id, ok: false,
          error: { code: 'internal', message: 'token=super-secret-proxy-payload' } }));
      });
    });
    const client = new FleetRelayClient({ url: `ws://127.0.0.1:${raw.address().port}/relay/v1`,
      token, appId: 'cli_test', role: 'worker', nodeId: nodeA, host: 'h', autoReconnect: false });
    clients.push(client);
    await client.connect();
    const error = await client.get('routes', 'x').catch(caught => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('super-secret-proxy-payload');
    expect(String(error)).toContain('中继内部错误');
  });
});
