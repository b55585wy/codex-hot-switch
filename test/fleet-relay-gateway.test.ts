import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { startFleetRelayGateway, relayGatewayIdentity } from '../src/fleet/relay/gateway';
import type { GatewayState } from '../src/fleet/relay/server';
import { FLEET_PROTOCOL, SignedFleetStore, type FleetStorage, type FleetStorageNotice,
  type FleetTable, type StoredValue } from '../src/fleet/model';

class GatewayMemoryStorage implements FleetStorage {
  readonly rows = new Map<string, StoredValue>();
  readonly listeners = new Set<(notice: FleetStorageNotice) => void>();
  close = vi.fn(async () => {});
  async get(table: FleetTable, key: string) { const row = this.rows.get(`${table}:${key}`); return row && { ...row }; }
  async list(table: FleetTable, target?: string) {
    return [...this.rows].filter(([key, row]) => key.startsWith(`${table}:`) && (!target || row.target === target))
      .map(([, row]) => ({ ...row }));
  }
  async put(table: FleetTable, row: StoredValue) {
    this.rows.set(`${table}:${row.key}`, { ...row });
    for (const listener of this.listeners) listener({ type: 'presence' });
  }
  async remove(table: FleetTable, key: string) { this.rows.delete(`${table}:${key}`); }
  async compareAndSwap(table: FleetTable, row: StoredValue, expected: string | null) {
    const current = this.rows.get(`${table}:${row.key}`);
    if (expected === null ? current !== undefined : current?.value !== expected) return false;
    this.rows.set(`${table}:${row.key}`, { ...row }); return true;
  }
  connect = async (): Promise<void> => undefined;
  subscribe = (listener: (notice: FleetStorageNotice) => void) => {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  };
  isNodeConnected = (): boolean => true;
}

const worker = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
const gateways: Array<{ shutdown(): Promise<void> }> = [];
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.shutdown().catch(() => undefined);
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(tmpdir() + sep)) throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

function fakeChannel() {
  const handlers = new Map<string, (event: unknown) => void>();
  const taps: Record<string, (raw: unknown) => void> = {};
  const channel = {
    on: vi.fn((name: string, handler: (event: unknown) => void) => {
      handlers.set(name, handler); return () => handlers.delete(name);
    }),
    send: vi.fn(async (_to: string, _input: { markdown?: string }) => ({ messageId: 'om_reply' })),
    disconnect: vi.fn(async () => undefined),
    rawClient: { im: { v1: { message: { create: vi.fn(async () => ({ data: { message_id: 'om_dm' } })) } } } },
    dispatcher: { register: vi.fn((next: Record<string, (raw: unknown) => void>) => {
      Object.assign(taps, next); return next;
    }) },
  };
  return { channel: channel as unknown as LarkChannel, handlers, taps, raw: channel };
}

async function setup(withHome = true) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-relay-gateway-')); roots.push(root);
  const storage = new GatewayMemoryStorage();
  const store = new SignedFleetStore(storage, 'cli_test', 'app-secret');
  await store.put('nodes', worker, { id: worker, name: 'windows', protocol: FLEET_PROTOCOL, seenAt: Date.now(), host: 'worker-host' });
  if (withHome) {
    await store.put('routes', 'home', { nodeId: worker });
    await store.put('routes', 'project:oc_group', { nodeId: worker });
    await store.put('routes', 'message:om_card', { nodeId: worker });
    await store.put('routes', 'document:docx:doc123', { nodeId: worker });
  }
  const fake = fakeChannel();
  const states: GatewayState[] = [];
  const errors: unknown[] = [];
  const gateway = await startFleetRelayGateway({
    appId: 'cli_test', appSecret: 'app-secret', tenant: 'feishu', ownerOpenId: 'ou_owner',
    storage, dataDir: root, channel: fake.channel, onState: state => states.push(state),
    onError: error => errors.push(error),
  });
  gateways.push(gateway);
  return { root, storage, store, fake, gateway, states, errors };
}

describe('cloud Feishu relay gateway', () => {
  it('starts without a home and registers a deterministic non-executable gateway node', async () => {
    const first = await setup(false);
    expect(first.gateway.nodeId).toBe(relayGatewayIdentity('cli_test').nodeId);
    expect(typeof first.gateway.close).toBe('function');
    expect(first.gateway.close).toBe(first.gateway.shutdown);
    expect((await first.store.get<Record<string, unknown>>('nodes', first.gateway.nodeId)))
      .toMatchObject({ kind: 'gateway', protocol: FLEET_PROTOCOL });
    expect(first.states).toEqual(['connecting', 'connected']);
    expect(first.errors).toEqual([]);
    expect(first.storage.close).not.toHaveBeenCalled();
  });

  it('forwards all seven native event shapes with original fields and no execution', async () => {
    const ctx = await setup();
    const message = { messageId: 'om_1', chatId: 'oc_group', senderId: 'ou_owner', chatType: 'group',
      mentionedBot: true, content: 'run', raw: { event_id: 'evt_1', tenant_key: 'tenant' }, threadId: 'omt_1' };
    expect(ctx.fake.handlers.get('message')!({ ...message })).toBeUndefined();
    ctx.fake.handlers.get('cardAction')!({ messageId: 'om_card', chatId: 'oc_group', operator: { openId: 'ou_owner' },
      action: { value: { a: 'stop', __r: 'render-1' }, tag: 'button' }, raw: { event_id: 'evt_2' } });
    ctx.fake.handlers.get('reaction')!({ messageId: 'om_card', operator: { openId: 'ou_owner' },
      emojiType: 'THUMBSUP', action: 'added', raw: { event_id: 'evt_3' } });
    ctx.fake.handlers.get('comment')!({ fileToken: 'doc123', fileType: 'docx', commentId: 'c1',
      operator: { openId: 'ou_owner' }, mentionedBot: true, timestamp: 1, raw: { event_id: 'evt_4' } });
    ctx.fake.handlers.get('botAdded')!({ chatId: 'oc_group', operator: { openId: 'ou_owner' }, raw: { event_id: 'evt_5' } });
    ctx.fake.taps['im.chat.member.bot.deleted_v1']!({ event: { chat_id: 'oc_group' } });
    ctx.fake.taps['application.bot.menu_v6']!({ event_id: 'evt_6', event_key: 'menu',
      event: { operator: { operator_id: { open_id: 'ou_owner' } } } });

    await vi.waitFor(async () => expect(await ctx.store.list('commands', worker)).toHaveLength(7), { timeout: 3_000 });
    const commands = await ctx.store.list<{ event: { kind: string; data: Record<string, unknown> }; source: string }>('commands', worker);
    expect(new Set(commands.map(command => command.event.kind))).toEqual(new Set([
      'message', 'cardAction', 'reaction', 'comment', 'botAdded', 'botRemoved', 'botMenu',
    ]));
    const delivered = commands.find(command => command.event.kind === 'message')!.event.data;
    expect(delivered).toMatchObject({ messageId: 'om_1', threadId: 'omt_1', raw: { event_id: 'evt_1' } });
    expect(commands.every(command => command.source === ctx.gateway.nodeId)).toBe(true);
    expect(commands.every(command => command.event.kind !== 'message'
      || (command.event.data as { senderId?: string }).senderId === 'ou_owner')).toBe(true);
    // Gateway itself is never a command target and never executes a handler.
    expect(commands.every(command => (command as unknown as { target: string }).target === worker)).toBe(true);
  });

  it('replies clearly when no home is bound and never self-executes', async () => {
    const ctx = await setup(false);
    ctx.fake.handlers.get('message')!({ messageId: 'om_unbound', chatId: 'oc_group', senderId: 'ou_owner',
      chatType: 'group', mentionedBot: true, content: 'run' });
    await vi.waitFor(() => expect(ctx.fake.raw.send).toHaveBeenCalled(), { timeout: 3_000 });
    expect(ctx.fake.raw.send.mock.calls[0]![1].markdown).toContain('尚未绑定执行电脑');
    await ctx.store.put('routes', 'home', { nodeId: ctx.gateway.nodeId });
    ctx.fake.handlers.get('message')!({ messageId: 'om_self', chatId: 'oc_dm', senderId: 'ou_owner',
      chatType: 'p2p', content: 'run' });
    await vi.waitFor(() => expect(ctx.fake.raw.send.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3_000 });
    expect(ctx.fake.raw.send.mock.calls[1]![1].markdown).toContain('中继网关不是执行电脑');
    expect(await ctx.store.list('commands', ctx.gateway.nodeId)).toHaveLength(0);
  });

  it('registers both raw SDK taps and cleans them up without closing server storage', async () => {
    const ctx = await setup();
    expect(ctx.fake.raw.dispatcher.register).toHaveBeenCalledTimes(1);
    expect(Object.keys(ctx.fake.taps)).toEqual([
      'im.chat.member.bot.deleted_v1', 'application.bot.menu_v6',
    ]);
    await ctx.gateway.shutdown();
    gateways.splice(gateways.indexOf(ctx.gateway), 1);
    expect(ctx.fake.handlers.size).toBe(0);
    expect(ctx.states).toEqual(['connecting', 'connected', 'disabled']);
    expect(ctx.storage.close).not.toHaveBeenCalled();
    expect(ctx.fake.raw.disconnect).not.toHaveBeenCalled();
  });
});
