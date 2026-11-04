import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import type { Project } from '../src/project/registry';
import { FleetInbox } from '../src/fleet/inbox';
import { FleetRuntime } from '../src/fleet/runtime';
import {
  COMMAND_TTL_MS, FLEET_PROTOCOL, SignedFleetStore, commandId, validateFleetConfig,
  type FleetCommand, type FleetConfig, type FleetEvent, type FleetNode,
  type FleetStorage, type FleetStorageNotice, type FleetTable, type StoredValue,
} from '../src/fleet/model';

class RelayMemoryStorage implements FleetStorage {
  readonly rows = new Map<string, StoredValue>();
  readonly connected = new Set<string>();
  readonly listeners = new Set<(notice: FleetStorageNotice) => void>();
  /** One-shot hold for regressions that release a read after shutdown. */
  stallNodeGet?: () => Promise<void> | undefined;
  async get(table: FleetTable, key: string): Promise<StoredValue | undefined> {
    if (table === 'nodes') {
      const hold = this.stallNodeGet?.();
      if (hold) await hold;
    }
    const row = this.rows.get(`${table}:${key}`);
    return row && { ...row };
  }
  async put(table: FleetTable, row: StoredValue): Promise<void> {
    this.rows.set(`${table}:${row.key}`, { ...row });
    this.notify(table === 'commands' && row.target ? { type: 'commands', target: row.target } : { type: 'presence' });
  }
  async remove(table: FleetTable, key: string): Promise<void> { this.rows.delete(`${table}:${key}`); }
  async list(table: FleetTable, target?: string): Promise<StoredValue[]> {
    return [...this.rows].filter(([key, row]) => key.startsWith(`${table}:`) && (!target || row.target === target))
      .map(([, row]) => ({ ...row }));
  }
  async compareAndSwap(table: FleetTable, row: StoredValue, expectedValue: string | null): Promise<boolean> {
    const current = this.rows.get(`${table}:${row.key}`);
    if (expectedValue === null ? current !== undefined : current?.value !== expectedValue) return false;
    this.rows.set(`${table}:${row.key}`, { ...row });
    return true;
  }
  connect = async (): Promise<void> => undefined;
  subscribe = (listener: (notice: FleetStorageNotice) => void): (() => void) => {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  };
  isNodeConnected = (nodeId: string): boolean => this.connected.has(nodeId);
  notify(notice: FleetStorageNotice): void { for (const listener of this.listeners) listener(notice); }
}

const workerA = '11111111-1111-4111-8111-111111111111';
const workerB = '22222222-2222-4222-8222-222222222222';
const gatewayId = '33333333-3333-4333-8333-333333333333';
const roots: string[] = [];
const runtimes: FleetRuntime[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
function relayConfig(nodeId: string, name: string): FleetConfig {
  return { enabled: true, nodeId, name, appToken: '', tables: { nodes: '', routes: '', commands: '' },
    transport: 'relay', relay: { url: 'ws://127.0.0.1:8787/relay/v1', tokenSecretId: 'relay-token' } };
}
function cfg(): AppConfig {
  return { accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
    preferences: { access: { ownerOpenId: 'ou_owner' } } } as AppConfig;
}
function legacyConfig(nodeId: string): FleetConfig {
  return { enabled: true, nodeId, name: 'legacy', appToken: 'apptoken',
    tables: { nodes: 'tblnodes', routes: 'tblroutes', commands: 'tblcommands' }, pollMs: 5_000 };
}
async function context(options: { nodeId: string; kind?: 'worker' | 'gateway'; projects?: Project[] | (() => Promise<Project[]>);
  dispatch?: (event: FleetEvent) => Promise<void>; now?: () => number; relay?: boolean;
  migrate?: (nodeId: string) => Promise<void>; onError?: (error: unknown) => void;
  onStorage?: (storage: RelayMemoryStorage) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-relay-runtime-')); roots.push(root);
  const storage = new RelayMemoryStorage();
  storage.connected.add(workerA); storage.connected.add(workerB); storage.connected.add(gatewayId);
  options.onStorage?.(storage);
  const store = new SignedFleetStore(storage, 'app', 'secret');
  const reply = vi.fn(async (_event: FleetEvent, _text: string) => {});
  const picker = vi.fn(async (_event: FleetEvent, _nodes: FleetNode[]) => {});
  const dispatch = vi.fn(options.dispatch ?? (async (_event: FleetEvent) => {}));
  const projects: () => Promise<Project[]> = typeof options.projects === 'function'
    ? options.projects : async () => (options.projects as Project[] | undefined) ?? [];
  const runtime = new FleetRuntime({
    config: options.relay === false ? legacyConfig(options.nodeId) : relayConfig(options.nodeId, options.kind === 'gateway' ? 'Relay Gateway' : 'worker'),
    cfg: cfg(), host: 'host', store, inbox: new FleetInbox(join(root, 'inbox')),
    projects, migrate: options.migrate ?? (async () => {}),
    dispatch, reply, picker, onError: options.onError ?? (() => undefined), kind: options.kind, now: options.now,
  });
  runtimes.push(runtime);
  return { runtime, storage, store, reply, picker, dispatch, root };
}
const message = (overrides: Record<string, unknown> = {}): FleetEvent => ({ kind: 'message',
  data: { messageId: 'om_1', chatId: 'oc_group', senderId: 'ou_owner', chatType: 'group',
    mentionedBot: true, content: 'run', ...overrides } });
function makeCommand(id: string, target: string, source = workerB): FleetCommand {
  const now = Date.now();
  const event = message({ messageId: id, chatId: `oc_${id}`, chatType: 'p2p', mentionedBot: false });
  return { id: commandId(event, target), appId: 'app', source, target, createdAt: now,
    expiresAt: now + COMMAND_TTL_MS, event };
}

describe('relay config compatibility', () => {
  it('accepts a relay-only config with legacy Bitable fields empty and rejects unsafe URLs', () => {
    const base = relayConfig(workerA, 'windows');
    expect(() => validateFleetConfig(base)).not.toThrow();
    expect(() => validateFleetConfig({ ...base, relay: { url: 'ws://relay.example.com/relay/v1', tokenSecretId: 't' } }))
      .toThrow(/wss/);
    expect(() => validateFleetConfig({ ...base, relay: { url: 'wss://relay.example.com/relay/v1', tokenSecretId: 't' } }))
      .not.toThrow();
    expect(() => validateFleetConfig({ ...base, relay: { url: 'wss://relay.example.com/relay/v1?token=x', tokenSecretId: 't' } }))
      .toThrow(/查询参数/);
    expect(() => validateFleetConfig({ ...base, transport: undefined })).toThrow(/app token/);
  });
});

describe('relay runtime hooks', () => {
  it('allows an empty gateway home but still requires initialization for a worker', async () => {
    const gateway = await context({ nodeId: gatewayId, kind: 'gateway' });
    await gateway.runtime.start();
    expect(await gateway.store.get<FleetNode>('nodes', gatewayId)).toMatchObject({ kind: 'gateway', seenAt: expect.any(Number) });
    const worker = await context({ nodeId: workerA });
    await expect(worker.runtime.start()).rejects.toThrow(/未初始化/);
  });

  it('filters gateway nodes from the picker, excludes them from execution and rejects self-target', async () => {
    const ctx = await context({ nodeId: gatewayId, kind: 'gateway' });
    await ctx.store.put('routes', 'home', { nodeId: gatewayId });
    await ctx.store.putIfUnchanged('nodes', gatewayId, undefined,
      { id: gatewayId, name: 'Relay Gateway', protocol: FLEET_PROTOCOL, seenAt: Date.now(), host: 'h', kind: 'gateway' });
    await ctx.store.putIfUnchanged('nodes', workerA, undefined,
      { id: workerA, name: 'windows', protocol: FLEET_PROTOCOL, seenAt: Date.now(), host: 'a' });
    await ctx.runtime.start();
    await ctx.runtime.receive({ kind: 'message', data: { messageId: 'om_menu', chatId: 'oc_dm',
      senderId: 'ou_owner', chatType: 'p2p', content: '/电脑' } });
    const nodes = ctx.picker.mock.calls[0]![1];
    expect(nodes.map(node => node.id)).toEqual([workerA]);
    await ctx.runtime.receive({ kind: 'message', data: { messageId: 'om_self', chatId: 'oc_dm',
      senderId: 'ou_owner', chatType: 'p2p', content: 'run' } });
    expect(ctx.reply).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining('中继网关不是执行电脑'));
    expect(await ctx.store.list('commands', gatewayId)).toHaveLength(0);
  });

  it('overlays a disconnected signed node offline without rewriting its signed row', async () => {
    const ctx = await context({ nodeId: gatewayId, kind: 'gateway' });
    await ctx.store.put('routes', 'home', { nodeId: workerA });
    await ctx.store.put('routes', 'project:oc_group', { nodeId: workerA });
    await ctx.store.put('nodes', workerA, { id: workerA, name: 'windows', protocol: FLEET_PROTOCOL, seenAt: Date.now(), host: 'a' });
    ctx.storage.connected.delete(workerA);
    await ctx.runtime.start();
    await ctx.runtime.receive(message());
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('离线'));
    expect(await ctx.store.get<FleetNode>('nodes', workerA)).toMatchObject({ seenAt: expect.any(Number) });
    expect((await ctx.store.get<FleetNode>('nodes', workerA))!.seenAt).toBeGreaterThan(0);
    expect(await ctx.store.list('commands', workerA)).toHaveLength(0);
  });

  it('uses observed-value CAS so concurrent ownership claims cannot overwrite', async () => {
    const first = await context({ nodeId: workerA });
    const second = await context({ nodeId: workerB });
    // Share one store, as both runtimes would for the same cloud directory.
    const shared = first.store;
    const sharedRuntime = new FleetRuntime({ config: relayConfig(workerB, 'mac'), cfg: cfg(), host: 'b',
      store: shared, inbox: new FleetInbox(join(second.root, 'inbox2')), projects: async () => [],
      migrate: async () => {}, dispatch: async () => {}, reply: async () => {}, picker: async () => {},
      onError: () => undefined, kind: 'worker' });
    runtimes.push(sharedRuntime);
    const claims = await Promise.allSettled([
      first.runtime.bindRoute('project:oc_shared'),
      sharedRuntime.bindRoute('project:oc_shared'),
    ]);
    expect(claims.filter(claim => claim.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter(claim => claim.status === 'rejected')).toHaveLength(1);
    const route = await shared.get<{ nodeId: string }>('routes', 'project:oc_shared');
    expect([workerA, workerB]).toContain(route!.nodeId);
    const winner = route!.nodeId;
    const winnerRuntime = winner === workerA ? first.runtime : sharedRuntime;
    const loserRuntime = winner === workerA ? sharedRuntime : first.runtime;
    await expect(loserRuntime.bindRoute('project:oc_shared')).rejects.toThrow(/属于另一台电脑/);
    await expect(winnerRuntime.bindRoute('project:oc_shared')).resolves.toBeUndefined();
  });

  it('accepts an established home without overwriting it', async () => {
    const ctx = await context({ nodeId: workerA });
    await ctx.runtime.initializeHome();
    await ctx.runtime.initializeHome();
    const joiner = new FleetRuntime({ config: relayConfig(workerB, 'mac'), cfg: cfg(), host: 'b',
      store: ctx.store, inbox: new FleetInbox(join(ctx.root, 'x')), projects: async () => [],
      migrate: async () => {}, dispatch: async () => {}, reply: async () => {}, picker: async () => {},
      onError: () => undefined });
    runtimes.push(joiner);
    // A new worker joining an established fleet accepts (does not overwrite).
    await expect(joiner.initializeHome()).resolves.toBeUndefined();
    expect(await ctx.store.get<{ nodeId: string }>('routes', 'home')).toMatchObject({ nodeId: workerA });
  });

  it('keeps control dispatch bounded and receipt-safe while handlers stay slow', async () => {
    let release!: () => void;
    const blocker = new Promise<void>(resolveBlocker => { release = resolveBlocker; });
    const calls: FleetEvent[] = [];
    const ctx = await context({ nodeId: workerA, dispatch: async event => {
      calls.push(event); if (event.data.messageId === 'om_slow') await blocker;
    } });
    await ctx.store.put('routes', 'home', { nodeId: workerA });
    await ctx.runtime.start();
    await ctx.store.put('nodes', workerB, { id: workerB, name: 'gateway', protocol: FLEET_PROTOCOL, seenAt: Date.now(), host: 'b', kind: 'gateway' });
    const now = Date.now();
    const makeCommand = (id: string, chatId: string): FleetCommand => {
      const event = message({ messageId: id, chatId, chatType: 'p2p', mentionedBot: false });
      return { id: commandId(event, workerA), appId: 'app', source: workerB, target: workerA,
        createdAt: now, expiresAt: now + COMMAND_TTL_MS, event };
    };
    const slow = makeCommand('om_slow', 'oc_slow');
    await ctx.store.put('commands', slow.id, slow, workerA, slow.expiresAt);
    // tick returns before the slow handler completes, so heartbeats/control stay free.
    await expect(ctx.runtime.tick()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = makeCommand('om_fast', 'oc_fast');
    await ctx.store.put('commands', second.id, second, workerA, second.expiresAt);
    await expect(ctx.runtime.tick()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]!.data.messageId).toBe('om_slow');
    // A subsequent pass must not replay the accepted slow receipt.
    await ctx.runtime.tick();
    await new Promise(resolveTick => setTimeout(resolveTick, 20));
    expect(calls.filter(call => call.data.messageId === 'om_slow')).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(ctx.store.list('commands', workerA)).resolves.toHaveLength(0));
  });

  it('validates local node ownership before consuming any pending command', async () => {
    const ctx = await context({ nodeId: workerA });
    const now = Date.now();
    await ctx.store.put('routes', 'home', { nodeId: workerA });
    await ctx.store.put('nodes', workerA, { id: workerA, name: 'stolen', protocol: FLEET_PROTOCOL,
      seenAt: now, host: 'different-host' });
    await ctx.store.put('nodes', workerB, { id: workerB, name: 'gateway', protocol: FLEET_PROTOCOL,
      seenAt: now, host: 'b', kind: 'gateway' });
    const event = message({ messageId: 'om_before_owner', chatId: 'oc_dm', chatType: 'p2p', mentionedBot: false });
    const command: FleetCommand = { id: commandId(event, workerA), appId: 'app', source: workerB,
      target: workerA, createdAt: now, expiresAt: now + COMMAND_TTL_MS, event };
    await ctx.store.put('commands', command.id, command, workerA, command.expiresAt);
    await expect(ctx.runtime.start()).rejects.toThrow(/另一台在线电脑/);
    expect(ctx.dispatch).not.toHaveBeenCalled();
    expect(await ctx.store.list('commands', workerA)).toHaveLength(1);
  });

  it('does not restart heartbeat or scheduling after a start/stop race', async () => {
    const ctx = await context({ nodeId: workerA });
    await ctx.store.put('routes', 'home', { nodeId: workerA });
    const starting = ctx.runtime.start();
    ctx.runtime.stop();
    await starting;
    const internals = ctx.runtime as unknown as { heartbeatTimer?: unknown; timer?: unknown; ticking?: unknown };
    expect(internals.heartbeatTimer).toBeUndefined();
    expect(internals.timer).toBeUndefined();
    expect(internals.ticking).toBeUndefined();
    await new Promise(resolveWait => setTimeout(resolveWait, 30));
    expect(internals.heartbeatTimer).toBeUndefined();
  });

  it('coalesces bursts of command notices without losing or duplicating work', async () => {
    const ids: string[] = [];
    const ctx = await context({ nodeId: workerA, dispatch: async event => {
      ids.push(String(event.data.messageId));
      await new Promise(resolveWait => setTimeout(resolveWait, 5));
    } });
    await ctx.store.put('routes', 'home', { nodeId: workerA });
    await ctx.runtime.start();
    const now = Date.now();
    await ctx.store.put('nodes', workerB, { id: workerB, name: 'gateway', protocol: FLEET_PROTOCOL,
      seenAt: now, host: 'b', kind: 'gateway' });
    for (let index = 0; index < 12; index += 1) {
      const event = message({ messageId: `om_burst_${index}`, chatId: 'oc_dm', chatType: 'p2p', mentionedBot: false });
      const command: FleetCommand = { id: commandId(event, workerA), appId: 'app', source: workerB,
        target: workerA, createdAt: now, expiresAt: now + COMMAND_TTL_MS, event };
      await ctx.store.put('commands', command.id, command, workerA, command.expiresAt);
    }
    await vi.waitFor(() => expect(ids).toHaveLength(12), { timeout: 5_000 });
    expect(new Set(ids).size).toBe(12);
    await vi.waitFor(() => expect(ctx.store.list('commands', workerA)).resolves.toHaveLength(0));
    expect((ctx.runtime as unknown as { pendingWake: boolean }).pendingWake).toBe(false);
  });

  it('publishes offline last after an in-flight handler and heartbeat', async () => {
    let release!: () => void;
    const blocker = new Promise<void>(resolveBlocker => { release = resolveBlocker; });
    const ctx = await context({ nodeId: workerA, dispatch: async event => {
      if (event.data.messageId === 'om_shutdown') await blocker;
    } });
    await ctx.store.put('routes', 'home', { nodeId: workerA });
    await ctx.runtime.start();
    const now = Date.now();
    await ctx.store.put('nodes', workerB, { id: workerB, name: 'gateway', protocol: FLEET_PROTOCOL,
      seenAt: now, host: 'b', kind: 'gateway' });
    const event = message({ messageId: 'om_shutdown', chatId: 'oc_dm', chatType: 'p2p', mentionedBot: false });
    const command: FleetCommand = { id: commandId(event, workerA), appId: 'app', source: workerB,
      target: workerA, createdAt: now, expiresAt: now + COMMAND_TTL_MS, event };
    await ctx.store.put('commands', command.id, command, workerA, command.expiresAt);
    await vi.waitFor(() => expect(ctx.dispatch).toHaveBeenCalledTimes(1));
    const shutdown = ctx.runtime.shutdown();
    setTimeout(release, 50);
    await shutdown;
    expect(await ctx.store.get<FleetNode>('nodes', workerA)).toMatchObject({ seenAt: 0 });
    expect(await ctx.store.list('commands', workerA)).toHaveLength(0);
  });

  it('wakes immediately on a targeted command notice and publishes heartbeat independently', async () => {
    let now = 1_000_000;
    const ctx = await context({ nodeId: workerA, now: () => now });
    await ctx.store.put('routes', 'home', { nodeId: workerA });
    await ctx.runtime.start();
    const before = (await ctx.store.get<FleetNode>('nodes', workerA))!.seenAt;
    now += 15_000;
    await ctx.runtime.publishNode();
    expect((await ctx.store.get<FleetNode>('nodes', workerA))!.seenAt).toBe(before + 15_000);
    // Push notice wakes consumption without waiting for the fallback timer.
    await ctx.store.put('nodes', workerB, { id: workerB, name: 'gateway', protocol: FLEET_PROTOCOL, seenAt: now, host: 'b', kind: 'gateway' });
    const event = message({ messageId: 'om_notice', chatId: 'oc_notice', chatType: 'p2p', mentionedBot: false });
    const command: FleetCommand = { id: commandId(event, workerA), appId: 'app', source: workerB, target: workerA,
      createdAt: now, expiresAt: now + COMMAND_TTL_MS, event };
    await ctx.store.put('commands', command.id, command, workerA, command.expiresAt);
    await vi.waitFor(() => expect(ctx.dispatch).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(ctx.dispatch.mock.calls[0]![0].data.messageId).toBe('om_notice');
  });

  it('retains external notices during startup and validates ownership before any claim', async () => {
    let releaseMigration!: () => void;
    const migrationGate = new Promise<void>(resolveGate => { releaseMigration = resolveGate; });
    let migrationStarted!: () => void;
    const entered = new Promise<void>(resolveEntered => { migrationStarted = resolveEntered; });
    const ctx = await context({ nodeId: workerA, migrate: async () => { migrationStarted(); await migrationGate; } });
    const now = Date.now();
    await ctx.store.put('routes', 'home', { nodeId: workerA });
    await ctx.store.put('nodes', workerA, { id: workerA, name: 'stolen', protocol: FLEET_PROTOCOL,
      seenAt: now, host: 'different-host' });
    const first = makeCommand('om_gated_1', workerA);
    const second = makeCommand('om_gated_2', workerA);
    await ctx.store.put('commands', first.id, first, workerA, first.expiresAt);
    const starting = ctx.runtime.start();
    await entered;
    // Storage notice arrives while migration is suspended: it must not tick or
    // consume anything before ownership validation.
    await ctx.store.put('commands', second.id, second, workerA, second.expiresAt);
    await new Promise(resolveWait => setTimeout(resolveWait, 30));
    expect(ctx.dispatch).not.toHaveBeenCalled();
    expect(await ctx.store.list('commands', workerA)).toHaveLength(2);
    releaseMigration();
    await expect(starting).rejects.toThrow(/另一台在线电脑/);
    expect(ctx.dispatch).not.toHaveBeenCalled();
    expect(await ctx.store.list('commands', workerA)).toHaveLength(2);
    expect((ctx.runtime as unknown as { ready: boolean }).ready).toBe(false);
  });

  it('does not publish online when stop happens during an async startup', async () => {
    let releaseMigration!: () => void;
    const migrationGate = new Promise<void>(resolveGate => { releaseMigration = resolveGate; });
    let migrationStarted!: () => void;
    const entered = new Promise<void>(resolveEntered => { migrationStarted = resolveEntered; });
    const ctx = await context({ nodeId: workerA, migrate: async () => { migrationStarted(); await migrationGate; } });
    await ctx.store.put('routes', 'home', { nodeId: workerA });
    const starting = ctx.runtime.start();
    await entered;
    ctx.runtime.stop();
    releaseMigration();
    await starting;
    expect(await ctx.store.get<FleetNode>('nodes', workerA)).toBeUndefined();
    const internals = ctx.runtime as unknown as { heartbeatTimer?: unknown; timer?: unknown };
    expect(internals.heartbeatTimer).toBeUndefined();
    expect(internals.timer).toBeUndefined();
  });

  it('bounds offline publication and never lets a stalled online publish overwrite it', async () => {
    const ctx = await context({ nodeId: workerA });
    await ctx.store.put('routes', 'home', { nodeId: workerA });
    await ctx.runtime.start();
    expect((await ctx.store.get<FleetNode>('nodes', workerA))!.seenAt).toBeGreaterThan(0);
    let release!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    let hold = true;
    ctx.storage.stallNodeGet = () => { if (!hold) return undefined; hold = false; return gate; };
    const stalled = ctx.runtime.publishNode();
    await vi.waitFor(() => expect(hold).toBe(false));
    // Shutdown's offline publication is bounded on the caller transport; the
    // stalled older online publish resumes only after the deadline.
    await ctx.runtime.shutdown();
    expect((await ctx.store.get<FleetNode>('nodes', workerA))!.seenAt).toBe(0);
    release();
    await stalled;
    expect((await ctx.store.get<FleetNode>('nodes', workerA))!.seenAt).toBe(0);
  });

  it('rejects a legacy startup project-ownership conflict without dispatching commands', async () => {
    const project = { name: 'legacy', chatId: 'oc_legacy', cwd: 'C:/legacy', blank: false, createdAt: 1 } as Project;
    const ctx = await context({ nodeId: workerA, relay: false, projects: [project] });
    await ctx.store.put('routes', 'home', { nodeId: workerA });
    await ctx.store.put('routes', 'project:oc_legacy', { nodeId: workerB });
    const command = makeCommand('om_legacy', workerA);
    await ctx.store.put('commands', command.id, command, workerA, command.expiresAt);
    await expect(ctx.runtime.start()).rejects.toThrow(/属于另一台电脑/);
    expect(ctx.dispatch).not.toHaveBeenCalled();
    expect(await ctx.store.list('commands', workerA)).toHaveLength(1);
  });

  it('handles a background poll failure once and reschedules without unhandled rejection', async () => {
    let now = 1_000_000;
    let explode = false;
    const onError = vi.fn();
    const ctx = await context({ nodeId: workerA, now: () => now, onError,
      projects: async () => { if (explode) throw new Error('background poll failed'); return []; } });
    await ctx.store.put('routes', 'home', { nodeId: workerA });
    await ctx.runtime.start();
    explode = true;
    now += 31_000;
    ctx.storage.notify({ type: 'presence' });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    const internals = ctx.runtime as unknown as { timer?: unknown; pendingWake: boolean };
    expect(internals.timer).toBeDefined();
    expect(internals.pendingWake).toBe(false);
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('relay startup readiness and lifecycle idempotence', () => {
  it('runs the readiness callback after publish/sync and before the first drain', async () => {
    const ctx = await context({ nodeId: workerA });
    const now = Date.now();
    await ctx.store.put('routes', 'home', { nodeId: workerA });
    await ctx.store.put('nodes', workerB, { id: workerB, name: 'gateway', protocol: FLEET_PROTOCOL,
      seenAt: now, host: 'b', kind: 'gateway' });
    const command = makeCommand('om_before_callback', workerA);
    await ctx.store.put('commands', command.id, command, workerA, command.expiresAt);
    const order: string[] = [];
    await ctx.runtime.start(async () => {
      order.push('callback');
      // Ownership row must already be published, and no command may have run.
      expect((await ctx.store.get<FleetNode>('nodes', workerA))?.host).toBe('host');
      expect(ctx.dispatch).not.toHaveBeenCalled();
    });
    order.push('started');
    await vi.waitFor(() => expect(ctx.dispatch).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['callback', 'started']);
  });

  it('shares one startup chain for concurrent/repeat start and retains the callback for reconnect', async () => {
    const ctx = await context({ nodeId: workerA });
    await ctx.store.put('routes', 'home', { nodeId: workerA });
    const readiness = vi.fn(async () => undefined);
    await Promise.all([ctx.runtime.start(readiness), ctx.runtime.start(readiness)]);
    expect(readiness).toHaveBeenCalledTimes(1);
    await ctx.runtime.start(readiness);
    expect(readiness).toHaveBeenCalledTimes(1);
    // Reconnect runs publish/sync -> retained callback -> wake.
    ctx.storage.notify({ type: 'reconnected' });
    await vi.waitFor(() => expect(readiness).toHaveBeenCalledTimes(2));
  });

  it('cleans a failed partial startup and permits a clean retry', async () => {
    let fail = true;
    const migrate = vi.fn(async () => { if (fail) throw new Error('migrate failed'); });
    const ctx = await context({ nodeId: workerA, migrate });
    await ctx.store.put('routes', 'home', { nodeId: workerA });
    await expect(ctx.runtime.start(async () => undefined)).rejects.toThrow('migrate failed');
    expect(ctx.storage.listeners.size).toBe(0);
    const internals = ctx.runtime as unknown as { timer?: unknown; heartbeatTimer?: unknown };
    expect(internals.timer).toBeUndefined();
    expect(internals.heartbeatTimer).toBeUndefined();
    fail = false;
    await ctx.runtime.start(async () => undefined);
    expect(migrate).toHaveBeenCalledTimes(2);
    await expect(ctx.runtime.start(async () => undefined)).resolves.toBeUndefined();
    expect(migrate).toHaveBeenCalledTimes(2);
  });
});
