import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import { FleetInbox } from '../src/fleet/inbox';
import { FleetRuntime } from '../src/fleet/runtime';
import { COMMAND_TTL_MS, FLEET_PROTOCOL, SignedFleetStore, commandId,
  type FleetCommand, type FleetConfig, type FleetEvent } from '../src/fleet/model';
import { startFleetRelayServer, type FleetRelayServer } from '../src/fleet/relay/server';
import { FleetRelayClient } from '../src/fleet/relay/client';
import { RelayWorker } from '../src/fleet/relay/worker';

const token = 'relay-integration-test-token-0123456789abcdef';
const appId = 'cli_test';
const secret = 'integration-secret';
const nodeA = '11111111-1111-4111-8111-111111111111';
const gatewayId = '33333333-3333-4333-8333-333333333333';
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

function config(url: string): FleetConfig {
  return { enabled: true, nodeId: nodeA, name: 'windows', appToken: '',
    tables: { nodes: '', routes: '', commands: '' }, transport: 'relay',
    relay: { url, tokenSecretId: 'relay-token' } };
}
function cfg(url: string): AppConfig {
  return { accounts: { app: { id: appId, secret, tenant: 'feishu' } },
    preferences: { access: { ownerOpenId: 'ou_owner' } }, fleet: config(url) } as AppConfig;
}
async function startServer(root?: string, port = 0) {
  const dir = root ?? await mkdtemp(join(tmpdir(), 'bridge-relay-integration-'));
  if (!root) roots.push(dir);
  const server = await startFleetRelayServer({ appId, token, dataDir: dir, port });
  servers.push(server);
  return { server, root: dir };
}
async function seed(server: FleetRelayServer) {
  const store = new SignedFleetStore(server.storage, appId, secret);
  await store.put('routes', 'home', { nodeId: nodeA });
  await store.put('nodes', gatewayId, { id: gatewayId, name: 'Relay Gateway', protocol: FLEET_PROTOCOL,
    seenAt: Date.now(), host: 'gateway-host', kind: 'gateway' });
  return store;
}
async function worker(server: FleetRelayServer, inboxDir: string,
  dispatch: (event: FleetEvent) => Promise<void>, reply = vi.fn(async (_event: FleetEvent, _text: string) => undefined)) {
  const client = new FleetRelayClient({ url: server.url, token, appId, role: 'worker', nodeId: nodeA,
    host: 'host-a', autoReconnect: true });
  const store = new SignedFleetStore(client, appId, secret);
  const runtime = new FleetRuntime({ config: config(server.url), cfg: cfg(server.url), host: 'host-a', store,
    inbox: new FleetInbox(inboxDir), projects: async () => [], migrate: async () => undefined,
    dispatch, reply, picker: async () => undefined, onError: () => undefined });
  const relay = new RelayWorker({ client, runtime, store, migrate: async () => undefined });
  const stop = async () => {
    relay.stop();
    await runtime.shutdown().catch(() => undefined);
    await client.close().catch(() => undefined);
  };
  cleanups.push(stop);
  return { client, store, runtime, relay, reply, stop };
}
function command(event: FleetEvent, id = commandId(event, nodeA)): FleetCommand {
  return { id, appId, source: gatewayId, target: nodeA, createdAt: Date.now(),
    expiresAt: Date.now() + COMMAND_TTL_MS, event };
}

describe('real relay integration', () => {
  it('delivers promptly with original message/thread/card fields and no polling wait', async () => {
    const { server } = await startServer();
    const gateway = await seed(server);
    const calls: FleetEvent[] = [];
    const ctx = await worker(server, join(roots.at(-1)!, 'inbox'), async event => { calls.push(event); });
    await ctx.relay.start();

    const message: FleetEvent = { kind: 'message', data: {
      messageId: 'om_integration', chatId: 'oc_dm', senderId: 'ou_owner', chatType: 'p2p',
      content: 'run integration', mentionedBot: false, threadId: 'omt_thread_1',
      replyToMessageId: 'om_parent', eventId: 'evt_1', createTime: '1720000000000',
    } };
    const started = Date.now();
    await gateway.put('commands', command(message).id, command(message), nodeA, Date.now() + COMMAND_TTL_MS);
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 2_000 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls[0]).toEqual(message);

    await new SignedFleetStore(server.storage, appId, secret)
      .put('routes', 'message:om_card', { nodeId: nodeA });
    const card: FleetEvent = { kind: 'cardAction', data: {
      messageId: 'om_card', chatId: 'oc_dm', operator: { openId: 'ou_owner' },
      action: { tag: 'button', name: 'approve', value: { a: 'config.model', model: 'gpt-5', token: 'render-token' } },
      threadId: 'omt_thread_2', raw: { event_id: 'evt_card' },
    } };
    await gateway.put('commands', command(card).id, command(card), nodeA, Date.now() + COMMAND_TTL_MS);
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 2_000 });
    expect(calls[1]).toEqual(card);
  });

  it('reconnects after a server restart and drains new commands', async () => {
    const first = await startServer();
    const root = first.root; const port = first.server.port;
    await seed(first.server);
    const calls: FleetEvent[] = [];
    const ctx = await worker(first.server, join(roots.at(-1)!, 'inbox'), async event => { calls.push(event); });
    await ctx.relay.start();
    expect(first.server.storage.isNodeConnected?.(nodeA)).toBe(true);

    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    const restarted = await startServer(root, port);
    await vi.waitFor(() => expect(ctx.client.isReady).toBe(true), { timeout: 8_000 });
    await vi.waitFor(() => expect(restarted.server.storage.isNodeConnected?.(nodeA)).toBe(true), { timeout: 5_000 });

    const gateway = new SignedFleetStore(restarted.server.storage, appId, secret);
    const event: FleetEvent = { kind: 'message', data: { messageId: 'om_after_restart', chatId: 'oc_dm',
      senderId: 'ou_owner', chatType: 'p2p', content: 'after restart', mentionedBot: false } };
    await gateway.put('commands', command(event).id, command(event), nodeA, Date.now() + COMMAND_TTL_MS);
    await vi.waitFor(() => expect(calls.some(call => call.data.messageId === 'om_after_restart')).toBe(true), { timeout: 3_000 });
  });

  it('uses the durable inbox so a restarted target never repeats an accepted command', async () => {
    const { server } = await startServer();
    const gateway = await seed(server);
    const inboxDir = join(roots.at(-1)!, 'durable-inbox');
    const firstDispatch = vi.fn(async (_event: FleetEvent) => undefined);
    const first = await worker(server, inboxDir, firstDispatch);
    await first.relay.start();
    const event: FleetEvent = { kind: 'message', data: { messageId: 'om_once', chatId: 'oc_dm',
      senderId: 'ou_owner', chatType: 'p2p', content: 'only once', mentionedBot: false, threadId: 'omt_once' } };
    const entry = command(event);
    await gateway.put('commands', entry.id, entry, nodeA, entry.expiresAt);
    await vi.waitFor(() => expect(firstDispatch).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    await vi.waitFor(async () => expect(await gateway.get('commands', entry.id)).toBeUndefined());
    await first.stop();

    // Re-insert the same accepted receipt id, simulating an ambiguous replay
    // arriving after restart. The durable inbox must suppress execution.
    await gateway.put('commands', entry.id, entry, nodeA, entry.expiresAt);
    const secondDispatch = vi.fn(async (_event: FleetEvent) => undefined);
    const second = await worker(server, inboxDir, secondDispatch);
    await second.relay.start();
    await vi.waitFor(async () => expect(await gateway.get('commands', entry.id)).toBeUndefined(), { timeout: 3_000 });
    expect(secondDispatch).not.toHaveBeenCalled();
  });
});
