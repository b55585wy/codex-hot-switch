import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import type { Project } from '../src/project/registry';
import { FleetInbox } from '../src/fleet/inbox';
import { FleetRuntime } from '../src/fleet/runtime';
import { COMMAND_TTL_MS, FLEET_PROTOCOL, SignedFleetStore, commandId,
  type FleetCommand, type FleetConfig, type FleetEvent, type StoredValue } from '../src/fleet/model';
import { startFleetRelayServer, type FleetRelayServer } from '../src/fleet/relay/server';
import { FleetRelayClient } from '../src/fleet/relay/client';
import { RelayWorker } from '../src/fleet/relay/worker';

const bridgeMock = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  channelConnect: vi.fn(async () => undefined),
  createChannel: vi.fn(),
  createFleetBridge: vi.fn(() => ({
    handle: vi.fn(), start: vi.fn(async () => undefined), stop: vi.fn(), shutdown: vi.fn(async () => undefined),
  })),
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 'feishu', Lark: 'lark' },
  createLarkChannel: (options: Record<string, unknown>) => {
    bridgeMock.options.push(options);
    return {
      on: vi.fn(() => () => undefined),
      connect: bridgeMock.channelConnect,
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      rawClient: {},
    };
  },
}));
vi.mock('../src/fleet', () => ({ createFleetBridge: bridgeMock.createFleetBridge }));
vi.mock('../src/bot/handle-message', () => ({
  createOrchestrator: () => ({
    onMessage: vi.fn(), onReaction: vi.fn(), onComment: vi.fn(),
    onBotAddedToChat: vi.fn(), onBotRemovedFromChat: vi.fn(), onBotMenu: vi.fn(),
    dispatcher: { handle: vi.fn() }, shutdown: vi.fn(async () => undefined), adminExecute: vi.fn(),
  }),
}));
vi.mock('../src/cli-bridge', () => ({
  createCliBridgeService: () => ({ start: vi.fn(async () => undefined), shutdown: vi.fn(async () => undefined) }),
  shouldStartCliBridge: () => false,
}));
vi.mock('../src/project/group-menu', () => ({ backfillGroupMenus: vi.fn(async () => ({ ok: true })) }));
vi.mock('../src/project/registry', () => ({ listProjects: vi.fn(async () => []) }));

import { startBridge } from '../src/bot/bridge';

const token = 'relay-worker-test-token-0123456789abcdef';
const nodeA = '11111111-1111-4111-8111-111111111111';
const gatewayId = '33333333-3333-4333-8333-333333333333';
const appId = 'cli_test';
const secret = 'fixture-secret';
const roots: string[] = [];
const servers: FleetRelayServer[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
  for (const server of servers.splice(0)) await server.close().catch(() => undefined);
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
beforeEach(() => { vi.clearAllMocks(); bridgeMock.options = []; });

function appConfig(fleet: FleetConfig): AppConfig {
  return { accounts: { app: { id: appId, secret, tenant: 'feishu' } },
    preferences: { access: { ownerOpenId: 'ou_owner' } }, fleet } as AppConfig;
}

function relayConfig(url: string): FleetConfig {
  return { enabled: true, nodeId: nodeA, name: 'windows', appToken: '',
    tables: { nodes: '', routes: '', commands: '' }, transport: 'relay',
    relay: { url, tokenSecretId: 'relay-token' } };
}

async function startServer(root?: string, port = 0) {
  const dir = root ?? await mkdtemp(join(tmpdir(), 'bridge-relay-worker-'));
  if (!root) roots.push(dir);
  const server = await startFleetRelayServer({ appId, token, dataDir: dir, port });
  servers.push(server);
  return { server, root: dir };
}

async function context(server: FleetRelayServer, dispatch = vi.fn(async (_event: FleetEvent) => undefined)) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-relay-worker-inbox-'));
  roots.push(root);
  const client = new FleetRelayClient({ url: server.url, token, appId, role: 'worker',
    nodeId: nodeA, host: 'host-a', autoReconnect: true });
  const store = new SignedFleetStore(client, appId, secret);
  const reply = vi.fn(async (_event: FleetEvent, _text: string) => undefined);
  const runtime = new FleetRuntime({ config: relayConfig(server.url), cfg: appConfig(relayConfig(server.url)),
    host: 'host-a', store, inbox: new FleetInbox(join(root, 'inbox')), projects: async () => [] as Project[],
    migrate: async () => undefined, dispatch, reply, picker: async () => undefined, onError: () => undefined });
  const worker = new RelayWorker({ client, runtime, store, migrate: async () => undefined });
  cleanups.push(async () => {
    worker.stop();
    await runtime.shutdown().catch(() => undefined);
    await client.close().catch(() => undefined);
  });
  return { client, store, runtime, worker, reply, dispatch };
}

function messageEvent(id: string): FleetEvent {
  return { kind: 'message', data: { messageId: id, chatId: 'oc_dm', senderId: 'ou_owner',
    chatType: 'p2p', content: 'run', mentionedBot: false } };
}

describe('API-only bridge transport selection', () => {
  it('constructs a webhook lifecycle channel and never a Feishu event WebSocket in relay mode', async () => {
    const cfg = appConfig(relayConfig('ws://127.0.0.1:9/relay/v1'));
    const handle = await startBridge({ cfg, appSecret: secret, fallbackCwd: 'C:/tmp' });
    expect(bridgeMock.options).toHaveLength(1);
    expect(bridgeMock.options[0]).toMatchObject({ transport: 'webhook' });
    expect(bridgeMock.channelConnect).toHaveBeenCalledTimes(1);
    expect(bridgeMock.createFleetBridge).toHaveBeenCalledTimes(1);
    await handle.shutdown();
  });

  it('fails closed for a disabled relay configuration instead of opening a local event socket', async () => {
    const disabled = { ...relayConfig('ws://127.0.0.1:9/relay/v1'), enabled: false };
    await expect(startBridge({ cfg: appConfig(disabled), appSecret: secret, fallbackCwd: 'C:/tmp' }))
      .rejects.toThrow(/拒绝回退/);
    expect(bridgeMock.options).toHaveLength(0);
  });
});

describe('relay worker lifecycle', () => {
  it('publishes and activates only after readiness, then dispatches promptly without replay', async () => {
    const { server } = await startServer();
    const home = new SignedFleetStore(server.storage, appId, secret);
    await home.put('routes', 'home', { nodeId: nodeA });
    const ctx = await context(server);
    await ctx.worker.start();
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(true);
    expect(await ctx.store.get('nodes', nodeA)).toMatchObject({ id: nodeA, name: 'windows', protocol: FLEET_PROTOCOL });

    await home.put('nodes', gatewayId, { id: gatewayId, name: 'Relay Gateway', protocol: FLEET_PROTOCOL,
      seenAt: Date.now(), host: 'gw', kind: 'gateway' });
    const event = messageEvent('om_prompt');
    const command: FleetCommand = { id: commandId(event, nodeA), appId, source: gatewayId, target: nodeA,
      createdAt: Date.now(), expiresAt: Date.now() + COMMAND_TTL_MS, event };
    await home.put('commands', command.id, command, nodeA, command.expiresAt);
    await vi.waitFor(() => expect(ctx.dispatch).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(ctx.dispatch.mock.calls[0]![0]).toEqual(event);
    await vi.waitFor(async () => expect(await home.get('commands', command.id)).toBeUndefined());
    await ctx.runtime.tick();
    expect(ctx.dispatch).toHaveBeenCalledTimes(1);
  });

  it('stays reconnect-pending through an initial outage and starts after the server returns', async () => {
    const first = await startServer();
    const root = first.root;
    const port = first.server.port;
    const url = first.server.url;
    await new SignedFleetStore(first.server.storage, appId, secret).put('routes', 'home', { nodeId: nodeA });
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);

    const client = new FleetRelayClient({ url, token, appId, role: 'worker', nodeId: nodeA,
      host: 'host-a', autoReconnect: true, connectTimeoutMs: 300 });
    const store = new SignedFleetStore(client, appId, secret);
    const inboxRoot = await mkdtemp(join(tmpdir(), 'bridge-relay-outage-inbox-'));
    roots.push(inboxRoot);
    const runtime = new FleetRuntime({ config: relayConfig(url), cfg: appConfig(relayConfig(url)), host: 'host-a',
      store, inbox: new FleetInbox(join(inboxRoot, 'inbox')), projects: async () => [],
      migrate: async () => undefined, dispatch: async () => undefined, reply: async () => undefined,
      picker: async () => undefined, onError: () => undefined });
    const worker = new RelayWorker({ client, runtime, store, migrate: async () => undefined });
    cleanups.push(async () => { worker.stop(); await runtime.shutdown().catch(() => undefined); await client.close().catch(() => undefined); });

    await expect(worker.start()).resolves.toBeUndefined();
    expect(client.isReady).toBe(false);

    const restarted = await startServer(root, port);
    await vi.waitFor(() => expect(client.isReady).toBe(true), { timeout: 8_000 });
    expect(restarted.server.port).toBe(port);
    await vi.waitFor(() => expect(restarted.server.storage.isNodeConnected?.(nodeA)).toBe(true), { timeout: 5_000 });
  });

  it('emits reconnected while inactive, then republishes/syncs and activates before draining', async () => {
    const { server } = await startServer();
    const home = new SignedFleetStore(server.storage, appId, secret);
    await home.put('routes', 'home', { nodeId: nodeA });
    const ctx = await context(server);
    await ctx.worker.start();
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(true);
    const states: boolean[] = [];
    ctx.client.subscribe(notice => {
      if (notice.type === 'reconnected') states.push(Boolean(server.storage.isNodeConnected?.(nodeA)));
    });
    const raw = (ctx.client as unknown as { socket: { terminate(): void } }).socket;
    raw.terminate();
    await vi.waitFor(() => expect(states).toHaveLength(1), { timeout: 5_000 });
    expect(states[0]).toBe(false);
    await vi.waitFor(() => expect(server.storage.isNodeConnected?.(nodeA)).toBe(true), { timeout: 5_000 });
    // The retained runtime readiness callback reactivated before command drain.
    const event = messageEvent('om_after_reconnect');
    const command: FleetCommand = { id: commandId(event, nodeA), appId, source: gatewayId, target: nodeA,
      createdAt: Date.now(), expiresAt: Date.now() + COMMAND_TTL_MS, event };
    await home.put('nodes', gatewayId, { id: gatewayId, name: 'Relay Gateway', protocol: FLEET_PROTOCOL,
      seenAt: Date.now(), host: 'gw', kind: 'gateway' });
    await home.put('commands', command.id, command, nodeA, command.expiresAt);
    await vi.waitFor(() => expect(ctx.dispatch).toHaveBeenCalledTimes(1), { timeout: 3_000 });
  });

  it('cancels startup and never activates/claims after stop during an await', async () => {
    const { server } = await startServer();
    const home = new SignedFleetStore(server.storage, appId, secret);
    await home.put('routes', 'home', { nodeId: nodeA });
    let releaseHome!: () => void;
    const blocker = new Promise<void>(resolveBlocker => { releaseHome = resolveBlocker; });
    const ctx = await context(server);
    const originalGet = ctx.store.get.bind(ctx.store);
    let first = true;
    vi.spyOn(ctx.store, 'get').mockImplementation(async (table, key) => {
      if (table === 'routes' && key === 'home' && first) {
        first = false;
        await blocker;
      }
      return originalGet(table, key);
    });
    const starting = ctx.worker.start();
    await new Promise(done => setTimeout(done, 20));
    ctx.worker.stop();
    releaseHome();
    await starting.catch(() => undefined);
    await new Promise(done => setTimeout(done, 100));
    expect(server.storage.isNodeConnected?.(nodeA)).toBe(false);
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it('stops retrying and surfaces a terminal auth failure', async () => {
    const { server } = await startServer();
    const client = new FleetRelayClient({ url: server.url, token: 'wrong-token-0123456789abcdefghijklmnop',
      appId, role: 'worker', nodeId: nodeA, host: 'host-a', autoReconnect: true, connectTimeoutMs: 2_000 });
    const store = new SignedFleetStore(client, appId, secret);
    const inboxRoot = await mkdtemp(join(tmpdir(), 'bridge-relay-auth-inbox-'));
    roots.push(inboxRoot);
    const runtime = new FleetRuntime({ config: relayConfig(server.url), cfg: appConfig(relayConfig(server.url)),
      host: 'host-a', store, inbox: new FleetInbox(join(inboxRoot, 'inbox')), projects: async () => [],
      migrate: async () => undefined, dispatch: async () => undefined, reply: async () => undefined,
      picker: async () => undefined, onError: () => undefined });
    const worker = new RelayWorker({ client, runtime, store, migrate: async () => undefined });
    cleanups.push(async () => { worker.stop(); await runtime.shutdown().catch(() => undefined); await client.close().catch(() => undefined); });
    await expect(worker.start()).rejects.toMatchObject({ terminal: true });
    await new Promise(done => setTimeout(done, 250));
    expect(client.fatalError).toBeDefined();
  });
});
