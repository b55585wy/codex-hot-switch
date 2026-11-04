import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { startFleetRelayServer, type FleetRelayServer } from '../src/fleet/relay/server';
import { relayStateFileName } from '../src/fleet/relay/file-store';
import { startFleetRelayGateway } from '../src/fleet/relay/gateway';
import { loadRelayCliConfig, parseRelayCliArgs } from '../src/fleet/relay/cli';
import { FLEET_PROTOCOL, SignedFleetStore, type StoredValue } from '../src/fleet/model';
import { RELAY_FRAME_BYTES, decodeCursor } from '../src/fleet/relay/protocol';
import { readFile, mkdir } from 'node:fs/promises';

const roots: string[] = [];
const servers: FleetRelayServer[] = [];
const clients: RelayClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
const nodeA = '11111111-1111-4111-8111-111111111111';
const nodeB = '22222222-2222-4222-8222-222222222222';
const token = 'relay-test-token-0123456789-abcdef';
async function start(port = 0) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-relay-server-'));
  roots.push(root);
  const server = await startFleetRelayServer({ appId: 'cli_test', token, dataDir: root, port });
  servers.push(server);
  return { server, root };
}
class RelayClient {
  readonly messages: Array<Record<string, unknown>> = [];
  readonly waiters: Array<{ predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  /** Raw frame byte length keyed by response id, for frame-limit regressions. */
  readonly frameBytes = new Map<string, number>();
  ready?: Record<string, unknown>;
  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on('message', data => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const message = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>;
      if (typeof message.id === 'string') this.frameBytes.set(message.id, buffer.byteLength);
      const index = this.waiters.findIndex(waiter => waiter.predicate(message));
      if (index >= 0) { const [waiter] = this.waiters.splice(index, 1); clearTimeout(waiter!.timer); waiter!.resolve(message); }
      else this.messages.push(message);
    });
  }
  static async connect(url: string, authToken?: string, hello?: unknown): Promise<RelayClient> {
    const ws = new WebSocket(url, authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : undefined);
    await new Promise<void>((resolveOpen, reject) => {
      ws.on('open', resolveOpen); ws.on('error', reject);
    });
    const client = new RelayClient(ws);
    clients.push(client);
    if (hello) {
      client.send(hello);
      client.ready = await Promise.race([
        client.next(message => message.type === 'ready'),
        client.closed.then(() => undefined),
      ]);
    }
    return client;
  }
  send(value: unknown): void { this.ws.send(JSON.stringify(value)); }
  next(predicate: (message: Record<string, unknown>) => boolean, timeout = 3_000): Promise<Record<string, unknown>> {
    const found = this.messages.findIndex(predicate);
    if (found >= 0) return Promise.resolve(this.messages.splice(found, 1)[0]!);
    return new Promise((resolveNext, reject) => {
      const waiter = { predicate, resolve: resolveNext, reject,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`timed out; received ${JSON.stringify(this.messages)}`));
        }, timeout) };
      this.waiters.push(waiter);
    });
  }
  async request(id: string, op: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.send({ type: 'request', id, op, ...extra });
    return this.next(message => message.type === 'response' && message.id === id);
  }
  terminate(): void { try { this.ws.terminate(); } catch { /* closed */ } }
}
function helloWorker(nodeId = nodeA, host = 'host-a') {
  return { type: 'hello', version: 1, appId: 'cli_test', role: 'worker', nodeId, host };
}
async function activate(client: RelayClient, id = 'activate'): Promise<RelayClient> {
  expect((await client.request(id, 'activate')).ok).toBe(true);
  return client;
}
async function expectStatus(url: string, authToken?: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const ws = new WebSocket(url, authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : undefined);
    ws.on('open', () => { resolveStatus(200); ws.terminate(); });
    ws.on('unexpected-response', (_request, response) => { resolveStatus(response.statusCode ?? 0); ws.terminate(); });
    ws.on('error', reject);
  });
}

function fakeChannel() {
  const handlers = new Map<string, (event: unknown) => void>();
  const taps: Record<string, (raw: unknown) => void> = {};
  const channel = {
    on: (name: string, handler: (event: unknown) => void) => {
      handlers.set(name, handler); return () => handlers.delete(name);
    },
    send: async () => ({ messageId: 'om_reply' }),
    disconnect: async () => undefined,
    rawClient: { im: { v1: { message: { create: async () => ({ data: { message_id: 'om_dm' } }) } } } },
    dispatcher: { register: (next: Record<string, (raw: unknown) => void>) => {
      Object.assign(taps, next); return next;
    } },
  };
  return { channel: channel as unknown as LarkChannel, handlers, taps };
}

describe('authenticated relay WebSocket server', () => {
  it('serves bounded health and rejects missing, empty, wrong and URL-supplied tokens', async () => {
    const { server } = await start();
    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`).then(response => response.json());
    expect(health).toMatchObject({ ok: true, version: 1, gateway: 'disabled' });
    expect(await expectStatus(server.url)).toBe(401);
    expect(await expectStatus(server.url, '')).toBe(401);
    expect(await expectStatus(server.url, 'wrong-token')).toBe(401);
    expect(await expectStatus(`${server.url}?token=${encodeURIComponent(token)}`, token)).toBe(401);
    server.setGatewayState('connected');
    expect(await fetch(`http://127.0.0.1:${server.port}/healthz`).then(response => response.json()))
      .toMatchObject({ gateway: 'connected' });
  });

  it('survives a malformed HTTP request-target and reports fail-closed storage health', async () => {
    const { server, root } = await start();
    const net = await import('node:net');
    const raw = await new Promise<string>((resolveRaw, reject) => {
      const socket = net.connect(server.port, '127.0.0.1');
      let data = '';
      socket.once('connect', () => socket.write(
        'GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
      socket.on('data', chunk => { data += chunk.toString('utf8'); });
      socket.once('end', () => resolveRaw(data));
      socket.once('error', reject);
      const timer = setTimeout(() => { socket.destroy(); resolveRaw(data); }, 2_000);
      timer.unref();
    });
    expect(raw).toMatch(/^HTTP\/1\.1 400/);
    expect((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status).toBe(200);

    // Make the atomic replace fail for real (no mocked config): the persisted
    // snapshot path is a directory, so a put cannot be acknowledged.
    await mkdir(join(root, relayStateFileName));
    const worker = await RelayClient.connect(server.url, token, helloWorker());
    const failed = await worker.request('fail-put', 'put', { table: 'routes', row: { key: 'k', value: 'v' } });
    expect(failed.ok).toBe(false);
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    const health = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(503);
    expect(health).toMatchObject({ ok: false, version: 1 });
    expect(JSON.stringify(health)).not.toContain(root);
  });

  it('registers workers and observers, enforces observer read-only and reports presence', async () => {
    const { server } = await start();
    const observer = await RelayClient.connect(server.url, token,
      { type: 'hello', version: 1, appId: 'cli_test', role: 'observer' });
    expect(observer.ready?.nodes).toEqual([]);
    const worker = await RelayClient.connect(server.url, token, helloWorker());
    // A handshake alone is not presence and must not appear in ready/presence.
    expect(worker.ready?.nodes).toEqual([]);
    expect((await observer.request('list-inactive', 'list', { table: 'nodes' })).ok).toBe(true);
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(false);
    await activate(worker, 'act-worker');
    expect((await observer.next(message => message.type === 'notice' && message.kind === 'presence'))
      .nodes).toEqual([nodeA]);
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(true);
    expect((await worker.request('put-1', 'put', { table: 'routes', row: { key: 'home', value: 'signed' } })).ok).toBe(true);
    expect((await observer.request('get-1', 'get', { table: 'routes', key: 'home' })).result)
      .toMatchObject({ key: 'home', value: 'signed' });
    expect((await observer.request('put-2', 'put', { table: 'routes', row: { key: 'x', value: 'y' } })).error)
      .toMatchObject({ code: 'forbidden' });
    expect((await observer.request('act-1', 'activate')).error).toMatchObject({ code: 'forbidden' });
    expect((await observer.request('cas-1', 'cas', { table: 'routes', row: { key: 'x', value: 'y' }, expectedValue: null })).error)
      .toMatchObject({ code: 'forbidden' });
  });

  it('supports paginated CRUD, CAS races and immediate command notices', async () => {
    const { server, root } = await start();
    const worker = await RelayClient.connect(server.url, token, helloWorker());
    expect((await worker.request('a-1', 'activate')).ok).toBe(true);
    for (let index = 0; index < 105; index += 1) {
      expect((await worker.request(`p-${index}`, 'put', { table: 'routes',
        row: { key: `key-${String(index).padStart(3, '0')}`, value: 'x'.repeat(64) } })).ok).toBe(true);
    }
    const first = await worker.request('l-1', 'list', { table: 'routes' });
    const page1 = first.result as { items: Array<{ key: string }>; cursor?: string };
    expect(page1.items).toHaveLength(100);
    expect(page1.cursor).toBeTruthy();
    const second = await worker.request('l-2', 'list', { table: 'routes', cursor: page1.cursor });
    expect((second.result as { items: unknown[] }).items).toHaveLength(5);
    const races = await Promise.all([
      worker.request('c-1', 'cas', { table: 'routes', row: { key: 'home', value: 'a' }, expectedValue: null }),
      worker.request('c-2', 'cas', { table: 'routes', row: { key: 'home', value: 'b' }, expectedValue: null }),
    ]);
    expect(races.map(response => response.result).filter(Boolean)).toHaveLength(1);
    await worker.request('cmd-1', 'put', { table: 'commands',
      row: { key: 'cmd-1', value: 'signed', target: nodeA, expiresAt: Date.now() + 60_000 } });
    expect((await worker.next(message => message.type === 'notice' && message.kind === 'commands')).target).toBe(nodeA);
    await worker.request('del-1', 'remove', { table: 'routes', key: 'key-000' });
    expect((await worker.request('get-del', 'get', { table: 'routes', key: 'key-000' })).result).toBeNull();
    const onDisk = JSON.parse(await readFile(join(root, relayStateFileName), 'utf8'));
    expect(onDisk.rows.routes.some((row: { key: string }) => row.key === 'key-000')).toBe(false);
  });

  it('rejects duplicate identity from another host and never autoactivates a same-host reconnect', async () => {
    const { server } = await start();
    const owner = await activate(await RelayClient.connect(server.url, token, helloWorker(nodeA, 'host-a')));
    const duplicate = await RelayClient.connect(server.url, token, helloWorker(nodeA, 'host-b'));
    expect((await duplicate.closed).code).toBe(4003);
    expect((await owner.request('owner-1', 'put', { table: 'routes', row: { key: 'owned', value: 'yes' } })).ok).toBe(true);
    const reconnect = await RelayClient.connect(server.url, token, helloWorker(nodeA, 'host-a'));
    expect((await owner.closed).code).toBe(4006);
    // The replacement socket is inactive until the caller explicitly reactivates.
    expect(reconnect.ready?.nodes).toEqual([]);
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(false);
    await activate(reconnect, 'reactivate');
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(true);
    expect((await reconnect.request('reconnect-1', 'get', { table: 'routes', key: 'owned' })).result)
      .toMatchObject({ value: 'yes' });
  });

  it('keeps an inactive same-host setup offline and out of presence after disconnect', async () => {
    const { server } = await start();
    const observer = await RelayClient.connect(server.url, token,
      { type: 'hello', version: 1, appId: 'cli_test', role: 'observer' });
    const worker = await activate(await RelayClient.connect(server.url, token, helloWorker()));
    expect((await observer.next(message => message.type === 'notice' && message.kind === 'presence'))
      .nodes).toEqual([nodeA]);
    worker.terminate();
    expect((await observer.next(message => message.type === 'notice' && message.kind === 'presence'))
      .nodes).toEqual([]);
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(false);
    const setup = await RelayClient.connect(server.url, token, helloWorker(nodeA, 'host-a'));
    expect(setup.ready?.nodes).toEqual([]);
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(false);
  });

  it('enforces row/frame limits and reports sanitized protocol errors', async () => {
    const { server } = await start();
    const worker = await RelayClient.connect(server.url, token, helloWorker());
    const oversized = await worker.request('big-1', 'put', { table: 'routes',
      row: { key: 'big', value: 'x'.repeat(128 * 1024 + 1) } });
    expect(oversized.error).toMatchObject({ code: 'too_large' });
    const shape = await worker.request('shape-1', 'put', { table: 'routes', row: { key: 'k' } });
    expect(shape.error).toMatchObject({ code: 'bad_request' });
    worker.send({ type: 'request', id: 'nope', op: 'explode' });
    expect((await worker.next(message => message.type === 'response' && message.id === 'nope')).error)
      .toMatchObject({ code: 'bad_request' });
    worker.ws.send('x'.repeat(256 * 1024 + 10));
    expect([1009, 1006]).toContain((await worker.closed).code);
  });

  it('safely rejects a CAS frame that cannot fit the 256 KiB frame limit', async () => {
    const { server } = await start();
    const worker = await RelayClient.connect(server.url, token, helloWorker());
    const value = 'a'.repeat(128 * 1024);
    worker.send({ type: 'request', id: 'cas-frame', op: 'cas', table: 'routes',
      row: { key: 'cas', value }, expectedValue: value });
    expect([1009, 1006]).toContain((await worker.closed).code);
    // An oversized frame is rejected without taking the server down.
    const observer = await RelayClient.connect(server.url, token,
      { type: 'hello', version: 1, appId: 'cli_test', role: 'observer' });
    expect((await observer.request('alive', 'get', { table: 'routes', key: 'cas' })).result).toBeNull();
  });

  it('paginates max plain and escaped/non-ASCII rows without dropping any accepted key', async () => {
    const { server } = await start();
    const worker = await activate(await RelayClient.connect(server.url, token, helloWorker()));
    // Raw value is under 128 KiB; escaped JSON stays under the hard frame
    // budget, but far above the 128 KiB soft page target by itself.
    const largeKey = '000-large';
    const largeValue = `${'"'.repeat(30_000)}${'文档中继'.repeat(5_000)}`;
    expect((await worker.request('large-put', 'put', { table: 'routes',
      row: { key: largeKey, value: largeValue } })).ok).toBe(true);
    // A plain 128 KiB value plus metadata must round-trip inside a 256 KiB frame.
    const maxPlain = { key: 'zzz-max-plain', value: 'a'.repeat(128 * 1024) };
    expect((await worker.request('max-plain-put', 'put', { table: 'routes', row: maxPlain })).ok).toBe(true);
    expect((await worker.request('max-plain-get', 'get', { table: 'routes', key: maxPlain.key })).result)
      .toMatchObject({ value: maxPlain.value });
    for (let index = 0; index < 120; index += 1) {
      expect((await worker.request(`small-${index}`, 'put', { table: 'routes',
        row: { key: `key-${String(index).padStart(3, '0')}`, value: `v${index}` } })).ok).toBe(true);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const id = `page-${pages}`;
      const response = await worker.request(id, 'list', { table: 'routes', ...(cursor ? { cursor } : {}) });
      const page = response.result as { items: Array<{ key: string }>; cursor?: string };
      expect(worker.frameBytes.get(id)!).toBeLessThanOrEqual(RELAY_FRAME_BYTES);
      expect(page.items.length).toBeGreaterThan(0);
      seen.push(...page.items.map(row => row.key));
      if (page.cursor) expect(decodeCursor(page.cursor, 'routes')).toBe(page.items[page.items.length - 1]!.key);
      cursor = page.cursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);
    expect(seen).toContain(largeKey);
    expect(seen).toContain(maxPlain.key);
    expect(seen).toHaveLength(122);
    expect(new Set(seen).size).toBe(122);
    expect(seen).toEqual([...seen].sort());
    // Escape-heavy rows are supported up to the hard encoded frame budget.
    const escaped = '"'.repeat(70_000);
    expect((await worker.request('escaped-ok-put', 'put', { table: 'routes',
      row: { key: 'escaped-ok', value: escaped } })).ok).toBe(true);
    expect((await worker.request('escaped-ok-get', 'get', { table: 'routes', key: 'escaped-ok' })).result)
      .toMatchObject({ value: escaped });
    // Only a row that cannot fit a frame after escaping is rejected.
    const rejected = await worker.request('escaped-too-large', 'put', { table: 'routes',
      row: { key: 'escaped-bad', value: '"'.repeat(130_000) } });
    expect(rejected.error).toMatchObject({ code: 'too_large' });
  });

  it('pushes direct server.storage command commits to an activated WS worker', async () => {
    const { server } = await start();
    const worker = await activate(await RelayClient.connect(server.url, token, helloWorker()));
    await server.storage.put('commands', { key: 'direct-cmd', value: 'signed-direct', target: nodeA,
      expiresAt: Date.now() + 60_000 });
    expect((await worker.next(message => message.type === 'notice' && message.kind === 'commands')).target)
      .toBe(nodeA);
    expect((await worker.request('direct-get', 'get', { table: 'commands', key: 'direct-cmd' })).result)
      .toMatchObject({ value: 'signed-direct', target: nodeA });
    // An inactive same-host setup must not receive work; activation flushes it.
    const setup = await RelayClient.connect(server.url, token, helloWorker(nodeB, 'host-b'));
    expect(setup.ready?.nodes).toEqual([nodeA]);
    await server.storage.put('commands', { key: 'direct-inactive', value: 'x', target: nodeB,
      expiresAt: Date.now() + 60_000 });
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    expect(setup.messages.filter(message => message.type === 'notice' && message.kind === 'commands'))
      .toHaveLength(0);
    expect(server.storage.isNodeConnected?.(nodeB)).toBe(false);
    await activate(setup, 'activate-b');
    expect((await setup.next(message => message.type === 'notice' && message.kind === 'commands')).target)
      .toBe(nodeB);
    expect((await worker.request('direct-list', 'list', { table: 'commands', target: nodeA })).result)
      .toMatchObject({ items: [expect.objectContaining({ key: 'direct-cmd' })] });
  });

  it('forwards a fake Feishu gateway event to a native activated WS worker', async () => {
    const { server, root } = await start();
    const store = new SignedFleetStore(server.storage, 'cli_test', 'app-secret');
    const now = Date.now();
    await store.put('nodes', nodeA, { id: nodeA, name: 'windows', protocol: FLEET_PROTOCOL, seenAt: now, host: 'host-a' });
    await store.put('routes', 'home', { nodeId: nodeA });
    await store.put('routes', 'project:oc_group', { nodeId: nodeA });
    await store.put('routes', 'message:om_card', { nodeId: nodeA });
    await store.put('routes', 'message:om_react', { nodeId: nodeA });
    await store.put('routes', 'document:docx:doc123', { nodeId: nodeA });
    const worker = await activate(await RelayClient.connect(server.url, token, helloWorker()));
    const fake = fakeChannel();
    const gateway = await startFleetRelayGateway({
      appId: 'cli_test', appSecret: 'app-secret', tenant: 'feishu', ownerOpenId: 'ou_owner',
      storage: server.storage, dataDir: root, channel: fake.channel,
    });
    try {
      fake.handlers.get('message')!({ messageId: 'om_gw', chatId: 'oc_group', senderId: 'ou_owner',
        chatType: 'group', mentionedBot: true, content: 'run', threadId: 'omt_gw',
        raw: { event_id: 'evt_gw' } });
      fake.handlers.get('cardAction')!({ messageId: 'om_card', chatId: 'oc_group', operator: { openId: 'ou_owner' },
        action: { value: { a: 'stop', __r: 'render-gw' }, tag: 'button' }, raw: { event_id: 'evt_card' } });
      fake.handlers.get('reaction')!({ messageId: 'om_react', operator: { openId: 'ou_owner' },
        emojiType: 'THUMBSUP', action: 'added', raw: { event_id: 'evt_react' } });
      fake.handlers.get('comment')!({ fileToken: 'doc123', fileType: 'docx', commentId: 'c1',
        operator: { openId: 'ou_owner' }, mentionedBot: true, timestamp: 1, raw: { event_id: 'evt_comment' } });
      fake.handlers.get('botAdded')!({ chatId: 'oc_group', operator: { openId: 'ou_owner' }, raw: { event_id: 'evt_added' } });
      fake.taps['im.chat.member.bot.deleted_v1']!({ event_id: 'evt_removed',
        event: { chat_id: 'oc_group', operator: { operator_id: { open_id: 'ou_owner' } } } });
      fake.taps['application.bot.menu_v6']!({ event_id: 'evt_menu', event_key: 'menu',
        event: { operator: { operator_id: { open_id: 'ou_owner' } } } });

      expect((await worker.next(message => message.type === 'notice' && message.kind === 'commands')).target)
        .toBe(nodeA);
      let items: StoredValue[] = [];
      await vi.waitFor(async () => {
        const list = await worker.request('gw-list', 'list', { table: 'commands', target: nodeA });
        items = (list.result as { items: StoredValue[] }).items;
        expect(items).toHaveLength(7);
      }, { timeout: 3_000 });
      const decoded = items.map(item => store.decode<{ event: { kind: string; data: Record<string, unknown> };
        source: string; target: string }>('commands', item));
      expect(new Set(decoded.map(command => command.event.kind))).toEqual(new Set([
        'message', 'cardAction', 'reaction', 'comment', 'botAdded', 'botRemoved', 'botMenu',
      ]));
      expect(decoded.every(command => command.source === gateway.nodeId && command.target === nodeA)).toBe(true);
      const byKind = new Map(decoded.map(command => [command.event.kind, command.event.data]));
      expect(byKind.get('message')).toMatchObject({ messageId: 'om_gw', threadId: 'omt_gw', raw: { event_id: 'evt_gw' } });
      expect(byKind.get('cardAction')).toMatchObject({ action: { value: { __r: 'render-gw' } }, raw: { event_id: 'evt_card' } });
      expect(byKind.get('reaction')).toMatchObject({ messageId: 'om_react', raw: { event_id: 'evt_react' } });
      expect(byKind.get('comment')).toMatchObject({ fileToken: 'doc123', raw: { event_id: 'evt_comment' } });
      expect(byKind.get('botAdded')).toMatchObject({ chatId: 'oc_group', raw: { event_id: 'evt_added' } });
      expect(byKind.get('botRemoved')).toMatchObject({ chatId: 'oc_group', eventId: 'evt_removed',
        raw: { event_id: 'evt_removed' } });
      expect(byKind.get('botMenu')).toMatchObject({ openId: 'ou_owner', eventKey: 'menu',
        eventId: 'evt_menu', raw: { event_id: 'evt_menu' } });
    } finally {
      await gateway.close();
    }
  });

  it('bounds shutdown when a peer ignores the close handshake', async () => {
    const { server } = await start();
    // Raw socket performs the WS upgrade but never answers a close frame.
    const net = await import('node:net');
    const socket = net.connect(server.port, '127.0.0.1');
    await new Promise<void>(resolve => socket.once('connect', resolve));
    socket.write([
      `GET /relay/v1 HTTP/1.1`, `Host: 127.0.0.1:${server.port}`,
      `Upgrade: websocket`, `Connection: Upgrade`,
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==`, `Sec-WebSocket-Version: 13`,
      `Authorization: Bearer ${token}`, '', '',
    ].join('\r\n'));
    await new Promise(resolve => socket.once('data', resolve));
    const started = Date.now();
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    expect(Date.now() - started).toBeLessThan(3_000);
    socket.destroy();
  });

  it('never echoes unknown argv or under-entropy tokens in errors', async () => {
    expect(() => parseRelayCliArgs(['--token=super-secret-value']))
      .toThrow(/未知参数/);
    try { parseRelayCliArgs(['--token=super-secret-value']); } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-value');
    }
    const root = await mkdtemp(join(tmpdir(), 'bridge-relay-cli-'));
    roots.push(root);
    const shortToken = join(root, 'token');
    await import('node:fs/promises').then(fs => fs.writeFile(shortToken, 'short-token', 'utf8'));
    await expect(loadRelayCliConfig([], { CODEX_RELAY_APP_ID: 'cli_test',
      CODEX_RELAY_TOKEN_FILE: shortToken, CODEX_RELAY_DATA_DIR: root })).rejects.toThrow(/至少需要 32 字节/);
    expect(await loadRelayCliConfig(['--help'], {})).toBeUndefined();
  });

  it('retains rows across restart and rejects a hostile hello', async () => {
    const { server, root } = await start();
    const worker = await RelayClient.connect(server.url, token, helloWorker());
    await worker.request('put', 'put', { table: 'routes', row: { key: 'persisted', value: 'yes' } });
    worker.terminate();
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const restarted = await startFleetRelayServer({ appId: 'cli_test', token, dataDir: root, port: 0 });
    servers.push(restarted);
    const next = await RelayClient.connect(restarted.url, token, helloWorker());
    expect((await next.request('get', 'get', { table: 'routes', key: 'persisted' })).result)
      .toMatchObject({ value: 'yes' });
    const bad = await RelayClient.connect(restarted.url, token,
      { type: 'hello', version: 1, appId: 'wrong', role: 'worker', nodeId: nodeB, host: 'h' });
    expect((await bad.closed).code).toBe(4001);
  });
});
