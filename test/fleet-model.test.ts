import { describe, expect, it } from 'vitest';
import { canonical, commandId, isOnline, MAX_EVENT_BYTES, ONLINE_MS, SignedFleetStore, validEvent, validateFleetConfig,
  type FleetConfig, type FleetNode, type FleetStorage } from '../src/fleet/model';
import { parseBaseToken } from '../src/cli/commands/fleet';

const config: FleetConfig = { enabled: true, nodeId: '11111111-1111-4111-8111-111111111111',
  name: 'windows', appToken: 'appToken12345', tables: { nodes: 'tblNodes', routes: 'tblRoutes', commands: 'tblCommands' } };
const message = { kind: 'message' as const, data: { messageId: 'om_1', chatId: 'oc_1', senderId: 'ou_owner',
  chatType: 'group', content: 'run tests' } };

describe('fleet wire contract', () => {
  it('canonicalizes object key order without changing arrays or content', () => {
    expect(canonical({ b: 2, a: [1, 'hello world'] })).toBe(canonical({ a: [1, 'hello world'], b: 2 }));
    expect(commandId(message, 'a')).toBe(commandId({ data: { ...message.data }, kind: 'message' }, 'a'));
    expect(commandId(message, 'a')).not.toBe(commandId(message, 'b'));
  });
  it('distinguishes subsequent rendered clicks and selected options', () => {
    const click = { kind: 'cardAction' as const, data: { operator: { openId: 'ou_owner' }, messageId: 'om_card',
      chatId: 'oc_1', action: { value: { a: 'stop', __r: 'render1' } } } };
    const changed = structuredClone(click);
    changed.data.action.value.__r = 'render2';
    expect(commandId(click, 'a')).not.toBe(commandId(changed, 'a'));
  });
  it('rejects empty, malformed and oversized events before dispatch', () => {
    expect(validEvent(message)).toBe(true);
    expect(validEvent({ kind: 'message', data: {} })).toBe(false);
    expect(validEvent({ ...message, data: { ...message.data, content: 'x'.repeat(MAX_EVENT_BYTES) } })).toBe(false);
    expect(validEvent({ ...message, data: { ...message.data, chatType: 'unknown' } })).toBe(false);
  });
  it('requires valid identity, all table IDs, and bounded polling', () => {
    expect(() => validateFleetConfig(config)).not.toThrow();
    for (const broken of [{ nodeId: '' }, { name: '' }, { name: '   ' }, { name: 'a'.repeat(33) }, { appToken: '../secret' },
      { tables: {} }, { pollMs: 4999 }, { pollMs: 60001 }, { pollMs: NaN }]) {
      expect(() => validateFleetConfig({ ...config, ...broken } as FleetConfig)).toThrow();
    }
    expect(() => validateFleetConfig({ ...config, pollMs: 5000 })).not.toThrow();
    expect(() => validateFleetConfig({ ...config, pollMs: 60000 })).not.toThrow();
  });
  it('rejects offline, stale, future and incompatible node records', () => {
    const node: FleetNode = { id: 'n', name: 'mac', protocol: 1, host: 'h', seenAt: 100000 };
    expect(isOnline(node, 100000)).toBe(true);
    expect(isOnline(node, 100000 + ONLINE_MS)).toBe(true);
    expect(isOnline(node, 100001 + ONLINE_MS)).toBe(false);
    expect(isOnline({ ...node, protocol: 2 }, 100000)).toBe(false);
    expect(isOnline({ ...node, seenAt: 140000 }, 100000)).toBe(false);
    expect(isOnline({ ...node, seenAt: 100000 }, 100000 - 30_001)).toBe(false);
  });
  it('never treats seenAt=0 as online, including synthetic small clocks', () => {
    const node: FleetNode = { id: 'n', name: 'mac', protocol: 1, host: 'h', seenAt: 0 };
    for (const now of [0, 1, 30_000, 1_000_000, Date.now()]) expect(isOnline(node, now)).toBe(false);
    expect(isOnline({ ...node, seenAt: -1 }, 1_000_000)).toBe(false);
    expect(isOnline({ ...node, seenAt: 1 }, 1)).toBe(true);
  });
  it('fails safely on malformed node identity, clocks and names', () => {
    const node: FleetNode = { id: 'n', name: 'mac', protocol: 1, host: 'h', seenAt: 100000 };
    for (const broken of [
      { ...node, id: '' }, { ...node, name: '' }, { ...node, name: '   ' }, { ...node, name: 'a'.repeat(33) },
      { ...node, protocol: Number.NaN }, { ...node, seenAt: Number.NaN }, { ...node, seenAt: Infinity },
      { ...node, seenAt: '100000' as unknown as number },
    ]) expect(isOnline(broken, 100000)).toBe(false);
    expect(isOnline(node, Number.NaN)).toBe(false);
    expect(isOnline(node, Infinity)).toBe(false);
  });
  it('accepts only Base tokens and trusted HTTPS Base links', () => {
    expect(parseBaseToken('appToken12345')).toBe('appToken12345');
    expect(parseBaseToken('https://example.feishu.cn/base/appToken12345?table=tbl1')).toBe('appToken12345');
    expect(parseBaseToken('https://example.larksuite.com/base/appToken12345')).toBe('appToken12345');
    for (const value of ['http://example.feishu.cn/base/abc', 'https://feishu.cn.evil.test/base/abc', '../file', 'https://example.feishu.cn/wiki/abc']) {
      expect(() => parseBaseToken(value)).toThrow();
    }
  });
});

describe('authenticated shared records', () => {
  const storage = {} as FleetStorage;
  const store = new SignedFleetStore(storage, 'app', 'a-secret-that-never-appears-in-output');
  it('binds proofs to the app, table, record key and content', () => {
    const value = { nodeId: 'mac' };
    const proof = store.proof({ table: 'routes', key: 'project:one', value });
    const row = { key: 'project:one', value: JSON.stringify({ value, proof }) };
    expect(store.decode('routes', row)).toEqual(value);
    expect(() => store.decode('routes', { ...row, key: 'project:other' })).toThrow();
    expect(() => store.decode('commands', row)).toThrow();
    expect(() => new SignedFleetStore(storage, 'other-app', 'a-secret-that-never-appears-in-output').decode('routes', row)).toThrow();
    expect(() => store.decode('routes', { ...row, value: JSON.stringify({ value: { nodeId: 'windows' }, proof }) })).toThrow();
  });
  it('rejects missing, malformed and wrong-length proofs without timing errors', () => {
    for (const proof of [undefined, '', 'x', 'g'.repeat(64), 'a'.repeat(63)]) expect(store.matches({}, proof)).toBe(false);
  });
});
