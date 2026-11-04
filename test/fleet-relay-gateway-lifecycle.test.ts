import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel, LarkChannelOptions, Logger } from '@larksuiteoapi/node-sdk';
import { createLarkChannel } from '@larksuiteoapi/node-sdk';
import { startFleetRelayGateway, relayGatewayIdentity } from '../src/fleet/relay/gateway';
import type { GatewayState } from '../src/fleet/relay/server';
import { FLEET_PROTOCOL, SignedFleetStore, type FleetStorage, type FleetStorageNotice,
  type FleetTable, type StoredValue } from '../src/fleet/model';

const sdk = vi.hoisted(() => ({ createLarkChannel: vi.fn() }));
vi.mock('@larksuiteoapi/node-sdk', async importOriginal => {
  const actual = await importOriginal<typeof import('@larksuiteoapi/node-sdk')>();
  return { ...actual, createLarkChannel: sdk.createLarkChannel };
});

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

interface FakeOwnedOptions {
  connect?: () => Promise<void>;
  disconnect?: () => Promise<void>;
  pendingReconnect?: boolean;
}

function fakeOwnedChannel(options: FakeOwnedOptions = {}) {
  const handlers = new Map<string, (event: unknown) => void>();
  const taps: Record<string, (raw: unknown) => void> = {};
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const rawWsClient = {
    close: vi.fn(() => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
    }),
  };
  if (options.pendingReconnect) reconnectTimer = setTimeout(() => undefined, 60_000);
  const channel = {
    on: vi.fn((name: string, handler: (event: unknown) => void) => {
      handlers.set(name, handler);
      return () => { handlers.delete(name); };
    }),
    connect: vi.fn(options.connect ?? (async () => undefined)),
    disconnect: vi.fn(options.disconnect ?? (async () => undefined)),
    send: vi.fn(async (_to: string, _input: { markdown?: string }) => ({ messageId: 'om_reply' })),
    rawWsClient,
    rawClient: { im: { v1: { message: { create: vi.fn(async () => ({ data: { message_id: 'om_dm' } })) } } } },
    dispatcher: { register: vi.fn((next: Record<string, (raw: unknown) => void>) => {
      Object.assign(taps, next); return next;
    }) },
  };
  return { channel: channel as unknown as LarkChannel, raw: channel, handlers, taps, rawWsClient };
}

const roots: string[] = [];
const gateways: Array<{ shutdown(): Promise<void> }> = [];

beforeEach(() => {
  vi.mocked(createLarkChannel).mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const gateway of gateways.splice(0)) await gateway.shutdown().catch(() => undefined);
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(tmpdir() + sep)) throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-relay-gateway-lifecycle-'));
  roots.push(root);
  return root;
}

function baseOptions(storage: FleetStorage, root: string, onState: (state: GatewayState) => void,
  onError: (error: unknown) => void) {
  return {
    appId: 'cli_test', appSecret: 'app-secret', tenant: 'feishu' as const,
    ownerOpenId: 'ou_owner', storage, dataDir: root, onState, onError,
  };
}

function rendered(errors: unknown[]): string {
  return errors.map(error => error instanceof Error
    ? `${error.name}\n${error.message}\n${error.stack ?? ''}`
    : JSON.stringify(error)).join('\n');
}

describe('owned relay gateway SDK lifecycle boundary', () => {
  it('closes an owned raw WS exactly once when connect rejects before connected', async () => {
    vi.useFakeTimers();
    const root = await newRoot();
    const storage = new GatewayMemoryStorage();
    const store = new SignedFleetStore(storage, 'cli_test', 'app-secret');
    const connectSecret = 'CONNECT_SECRET_SENTINEL';
    const logSecret = 'LOG_SECRET_SENTINEL';
    const token = 'TOKEN_SENTINEL';
    const fake = fakeOwnedChannel({
      connect: async () => { throw new Error(`connect rejected before ready ${connectSecret}`); },
      pendingReconnect: true,
    });
    let created: LarkChannelOptions | undefined;
    vi.mocked(createLarkChannel).mockImplementation(options => {
      created = options;
      return fake.channel;
    });
    const states: GatewayState[] = [];
    const errors: unknown[] = [];

    await expect(startFleetRelayGateway(baseOptions(storage, root,
      state => states.push(state), error => errors.push(error)))).rejects.toThrow('connect rejected before ready');

    // The SDK never set connected, so disconnect() alone would leak the
    // auto-reconnecting WSClient. The owned transport must be closed once.
    expect(createLarkChannel).toHaveBeenCalledTimes(1);
    expect(fake.raw.connect).toHaveBeenCalledTimes(1);
    expect(fake.rawWsClient.close).toHaveBeenCalledTimes(1);
    expect(fake.rawWsClient.close).toHaveBeenCalledWith({});
    expect(fake.raw.disconnect).toHaveBeenCalledTimes(1);
    expect(fake.handlers.size).toBe(0);
    expect(states).toEqual(['connecting', 'error']);

    // Runtime/offline cleanup happened; caller-owned storage stays open.
    const node = await store.get<{ seenAt: number }>('nodes', relayGatewayIdentity('cli_test').nodeId);
    expect(node?.seenAt).toBe(0);
    expect(storage.close).not.toHaveBeenCalled();
    // The fake reconnect timer is cleared by the explicit WS close.
    expect(vi.getTimerCount()).toBe(0);

    // The factory logger receives credential-bearing nested arguments but
    // only bounded static diagnostics may reach onError.
    const logger: Logger = created!.logger!;
    const payload = {
      appSecret: logSecret,
      headers: { authorization: `Bearer ${token}` },
      url: `https://open.feishu.cn/open-apis/bot/v3/info?token=${token}`,
      body: { nested: { secret: connectSecret } },
    };
    logger.error('raw logger argument', payload, new Error(token));
    logger.warn(payload);
    logger.info(payload);
    logger.debug(payload);
    logger.trace(payload);

    expect(errors).toHaveLength(1);
    expect(errors.every(error => error instanceof Error)).toBe(true);
    expect(rendered(errors)).toContain('已脱敏');
    expect(rendered(errors)).not.toContain(connectSecret);
    expect(rendered(errors)).not.toContain(logSecret);
    expect(rendered(errors)).not.toContain(token);
    expect(rendered(errors)).not.toContain('open.feishu.cn');
  });

  it('keeps successful shutdown idempotent when disconnect throws and freezes state after close', async () => {
    const root = await newRoot();
    const storage = new GatewayMemoryStorage();
    const secret = 'DISCONNECT_SECRET_SENTINEL';
    const fake = fakeOwnedChannel({
      disconnect: async () => { throw new Error(`disconnect failed ${secret}`); },
    });
    vi.mocked(createLarkChannel).mockImplementation(() => fake.channel);
    const states: GatewayState[] = [];
    const errors: unknown[] = [];
    const gateway = await startFleetRelayGateway(baseOptions(storage, root,
      state => states.push(state), error => errors.push(error)));
    gateways.push(gateway);
    expect(states).toEqual(['connecting', 'connected']);

    const reconnecting = fake.handlers.get('reconnecting')!;
    const reconnected = fake.handlers.get('reconnected')!;
    const onChannelError = fake.handlers.get('error')!;
    reconnecting(undefined);
    reconnected(undefined);
    expect(states).toEqual(['connecting', 'connected', 'connecting', 'connected']);

    // Generic outbound permission/rate errors are sanitized but must not
    // become a false permanent disconnected state.
    onChannelError({ code: 'permission_denied', message: `permission denied ${secret}`,
      context: { url: `https://example.invalid?token=${secret}` } });
    expect(states).toEqual(['connecting', 'connected', 'connecting', 'connected']);
    expect(rendered(errors)).toContain('permission_denied');
    expect(rendered(errors)).not.toContain(secret);

    await expect(gateway.close()).resolves.toBeUndefined();
    expect(states).toEqual(['connecting', 'connected', 'connecting', 'connected', 'disabled']);
    expect(fake.rawWsClient.close).toHaveBeenCalledTimes(1);
    expect(fake.raw.disconnect).toHaveBeenCalledTimes(1);
    // A throwing disconnect is reported as sanitized static text, not raw.
    expect(rendered(errors)).not.toContain(secret);
    expect(storage.close).not.toHaveBeenCalled();

    // Captured callbacks must not revive state after close, and a repeated
    // close must not touch the transport again.
    reconnecting(undefined);
    reconnected(undefined);
    onChannelError({ code: 'rate_limited', message: `rate limited ${secret}` });
    await gateway.close();
    expect(states).toEqual(['connecting', 'connected', 'connecting', 'connected', 'disabled']);
    expect(fake.rawWsClient.close).toHaveBeenCalledTimes(1);
    expect(fake.raw.disconnect).toHaveBeenCalledTimes(1);
  });

  it('never disconnects or raw-closes a caller-injected unowned channel', async () => {
    const root = await newRoot();
    const storage = new GatewayMemoryStorage();
    const fake = fakeOwnedChannel();
    const states: GatewayState[] = [];
    const errors: unknown[] = [];
    const gateway = await startFleetRelayGateway({
      ...baseOptions(storage, root, state => states.push(state), error => errors.push(error)),
      channel: fake.channel,
    });
    gateways.push(gateway);
    expect(createLarkChannel).not.toHaveBeenCalled();
    expect(states).toEqual(['connecting', 'connected']);
    await gateway.shutdown();
    expect(fake.rawWsClient.close).not.toHaveBeenCalled();
    expect(fake.raw.disconnect).not.toHaveBeenCalled();
    expect(states).toEqual(['connecting', 'connected', 'disabled']);
    expect(storage.close).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('retains the protocol node shape used by the relay directory', async () => {
    const root = await newRoot();
    const storage = new GatewayMemoryStorage();
    const store = new SignedFleetStore(storage, 'cli_test', 'app-secret');
    const fake = fakeOwnedChannel();
    vi.mocked(createLarkChannel).mockImplementation(() => fake.channel);
    const gateway = await startFleetRelayGateway(baseOptions(storage, root, () => undefined, () => undefined));
    gateways.push(gateway);
    expect((await store.get<Record<string, unknown>>('nodes', gateway.nodeId)))
      .toMatchObject({ kind: 'gateway', protocol: FLEET_PROTOCOL });
  });
});
