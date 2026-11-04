import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import type { Project } from '../src/project/registry';
import { FleetRuntime } from '../src/fleet/runtime';
import { FleetInbox } from '../src/fleet/inbox';
import { SignedFleetStore, commandId, COMMAND_TTL_MS, type FleetConfig, type FleetEvent, type FleetStorage,
  type FleetTable, type StoredValue, type FleetCommand, type FleetNode } from '../src/fleet/model';

class MemoryStorage implements FleetStorage {
  readonly rows = new Map<string, StoredValue>();
  async get(table: FleetTable, key: string) { return this.rows.get(`${table}:${key}`); }
  async put(table: FleetTable, row: StoredValue) { this.rows.set(`${table}:${row.key}`, structuredClone(row)); }
  async remove(table: FleetTable, key: string) { this.rows.delete(`${table}:${key}`); }
  async list(table: FleetTable, target?: string) {
    return [...this.rows].filter(([key, value]) => key.startsWith(`${table}:`) && (!target || value.target === target)).map(([, value]) => structuredClone(value));
  }
}
const winId = '11111111-1111-4111-8111-111111111111';
const macId = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
const runtimes: FleetRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
function event(content = 'run tests', overrides: Record<string, unknown> = {}): FleetEvent {
  return { kind: 'message', data: { messageId: 'om_1', chatId: 'oc_mac', senderId: 'ou_owner', chatType: 'group', mentionedBot: true, content, ...overrides } };
}
async function pair() {
  let now = 1_000_000;
  const storage = new MemoryStorage();
  const store = new SignedFleetStore(storage, 'app', 'test-fleet-secret');
  await store.put('routes', 'home', { nodeId: winId });
  const make = async (id: string, name: string, projects: Project[]) => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-fleet-route-')); roots.push(root);
    const config: FleetConfig = { enabled: true, nodeId: id, name, appToken: 'appToken12345',
      tables: { nodes: 'tblNodes', routes: 'tblRoutes', commands: 'tblCommands' } };
    const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } },
      preferences: { access: { ownerOpenId: 'ou_owner' } } };
    const dispatch = vi.fn(async (_event: FleetEvent) => {});
    const reply = vi.fn(async (_event: FleetEvent, _text: string) => {});
    const picker = vi.fn(async () => {});
    const errors: unknown[] = [];
    const runtime = new FleetRuntime({ config, cfg, host: name, store, inbox: new FleetInbox(root),
      projects: async () => projects, migrate: vi.fn(async () => {}), dispatch, reply, picker,
      onError: e => errors.push(e), now: () => now });
    runtimes.push(runtime); await runtime.start();
    return { runtime, dispatch, reply, picker, cfg, projects, errors, root, config };
  };
  const project = { name: 'Mac project', chatId: 'oc_mac', cwd: '/Users/wangyi/project', blank: false, createdAt: 1, ownerNodeId: macId };
  const windows = await make(winId, 'windows', []);
  const mac = await make(macId, 'wangyidemacbookair', [project]);
  return { windows, mac, storage, store, get now() { return now; }, advance(ms: number) { now += ms; } };
}

describe('two independent execution nodes behind one bot', () => {
  it('forwards a Mac project event received by Windows and executes only on Mac', async () => {
    const p = await pair();
    await p.windows.runtime.receive(event());
    expect(p.windows.dispatch).not.toHaveBeenCalled();
    await p.mac.runtime.tick();
    expect(p.mac.dispatch.mock.calls).toEqual([[event()]]);
    expect(await p.storage.list('commands', macId)).toHaveLength(0);
  });
  it('deduplicates redelivery through different receiving computers and after target restart', async () => {
    const p = await pair();
    await Promise.all([p.windows.runtime.receive(event()), p.mac.runtime.receive(event())]);
    await p.mac.runtime.tick();
    await p.windows.runtime.receive(event());
    await p.mac.runtime.tick();
    expect(p.mac.dispatch).toHaveBeenCalledTimes(1);
    expect(p.windows.dispatch).not.toHaveBeenCalled();
  });
  it('routes existing cards to their original computer after a DM device switch', async () => {
    const p = await pair();
    await p.store.put('routes', 'user:ou_owner', { nodeId: winId });
    const click: FleetEvent = { kind: 'cardAction', data: { messageId: 'om_card', chatId: 'oc_mac',
      operator: { openId: 'ou_owner' }, action: { tag: 'button', value: { a: 'stop',
        __fleetNode: macId, __fleetProof: p.store.proof({ cardNode: macId }), __r: 'one' } } } };
    await p.windows.runtime.receive(click); await p.mac.runtime.tick();
    expect(p.mac.dispatch.mock.calls).toEqual([[click]]);
    expect(p.windows.dispatch).not.toHaveBeenCalled();
  });
  it('refuses stale/incompatible destinations without falling back to Windows', async () => {
    const p = await pair();
    await p.store.put('nodes', macId, { id: macId, name: 'wangyidemacbookair', protocol: 2, seenAt: p.now, host: 'mac' });
    await p.windows.runtime.receive(event());
    expect(p.windows.reply.mock.calls.at(-1)?.[1]).toContain('离线或版本不兼容');
    expect(p.windows.dispatch).not.toHaveBeenCalled();
    expect(p.mac.dispatch).not.toHaveBeenCalled();
  });
  it('does not run unknown projects in the receiver fallback directory', async () => {
    const p = await pair();
    await p.windows.runtime.receive(event('run', { chatId: 'oc_unknown' }));
    expect(p.windows.reply.mock.calls.at(-1)?.[1]).toContain('尚未绑定');
    expect(p.windows.dispatch).not.toHaveBeenCalled();
  });
  it('silently ignores unmentioned ordinary messages in unbound groups', async () => {
    const p = await pair();
    await p.windows.runtime.receive(event('hello', { messageId: 'om_unbound', chatId: 'oc_unbound', mentionedBot: false }));
    await p.windows.runtime.tick();
    expect(p.windows.reply).not.toHaveBeenCalled();
    expect(p.windows.dispatch).not.toHaveBeenCalled();
  });
  it('honors noMention=false and only auto-responds in topics for multi groups', async () => {
    const p = await pair();
    p.mac.projects.push({ name: 'quiet', chatId: 'oc_quiet', cwd: '/quiet', blank: false, createdAt: 1,
      ownerNodeId: macId, noMention: false });
    p.mac.projects.push({ name: 'single', chatId: 'oc_single', cwd: '/single', blank: false, createdAt: 1,
      ownerNodeId: macId, kind: 'single' });
    await p.mac.runtime.syncProjects();
    await p.windows.runtime.receive(event('quiet', { messageId: 'om_quiet', chatId: 'oc_quiet', mentionedBot: false }));
    await p.windows.runtime.receive(event('no topic', { messageId: 'om_topicless', chatId: 'oc_mac', mentionedBot: false }));
    expect(p.windows.reply).not.toHaveBeenCalled();
    await p.windows.runtime.receive(event('topic', { messageId: 'om_topic', chatId: 'oc_mac',
      mentionedBot: false, threadId: 'omt_1' }));
    await p.windows.runtime.receive(event('single', { messageId: 'om_single', chatId: 'oc_single', mentionedBot: false }));
    await p.mac.runtime.tick();
    expect(p.mac.dispatch.mock.calls.map(call => call[0].data.messageId).sort())
      .toEqual(['om_single', 'om_topic']);
  });
  it('still routes explicitly mentioned messages when noMention is false', async () => {
    const p = await pair();
    p.mac.projects.push({ name: 'quiet', chatId: 'oc_quiet', cwd: '/quiet', blank: false, createdAt: 1,
      ownerNodeId: macId, noMention: false });
    await p.mac.runtime.syncProjects();
    const mentioned = event('explicit', { messageId: 'om_explicit', chatId: 'oc_quiet', mentionedBot: true });
    await p.windows.runtime.receive(mentioned);
    await p.mac.runtime.tick();
    expect(p.mac.dispatch.mock.calls).toEqual([[mentioned]]);
  });
  it('rechecks current destination admin permissions for account switching', async () => {
    const p = await pair();
    await p.store.put('routes', 'user:ou_owner', { nodeId: macId });
    await p.windows.runtime.receive(event('/runtime switch account-a', { chatType: 'p2p', chatId: 'oc_dm' }));
    p.mac.cfg.preferences!.access = { ownerOpenId: 'ou_other' };
    await p.mac.runtime.tick();
    expect(p.mac.dispatch).not.toHaveBeenCalled();
    expect(p.mac.reply.mock.calls.at(-1)?.[1]).toContain('不允许此用户');
  });
  it('switches only the selected computer account pool', async () => {
    const p = await pair();
    await p.windows.runtime.receive(event('/电脑 wangyidemacbookair', { chatType: 'p2p', chatId: 'oc_dm' }));
    const account = event('/runtime usage', { messageId: 'om_usage', chatType: 'p2p', chatId: 'oc_dm' });
    await p.windows.runtime.receive(account); await p.mac.runtime.tick();
    expect(p.mac.dispatch.mock.calls).toEqual([[account]]);
    expect(p.windows.dispatch).not.toHaveBeenCalled();
  });
  it('keeps owner private management available when allowedChats only lists project groups', async () => {
    const p = await pair();
    const access = { ownerOpenId: 'ou_owner', allowedChats: ['oc_mac'] };
    p.windows.cfg.preferences!.access = access;
    p.mac.cfg.preferences!.access = { ...access };
    await p.windows.runtime.receive(event('/电脑 wangyidemacbookair', { messageId: 'om_select',
      chatType: 'p2p', chatId: 'oc_dm' }));
    const usage = event('/runtime usage', { messageId: 'om_usage_dm', chatType: 'p2p', chatId: 'oc_dm' });
    await p.windows.runtime.receive(usage);
    await p.mac.runtime.tick();
    expect(p.mac.dispatch.mock.calls).toEqual([[usage]]);
    expect(p.windows.dispatch).not.toHaveBeenCalled();
  });
  it('rechecks destination group allowlists and project user permissions after handoff', async () => {
    const p = await pair();
    p.mac.cfg.preferences!.access = { ownerOpenId: 'ou_owner', allowedChats: ['oc_mac'] };
    p.mac.projects.push({ name: 'other', chatId: 'oc_other', cwd: '/other', blank: false,
      createdAt: 1, ownerNodeId: macId });
    await p.mac.runtime.syncProjects();
    await p.windows.runtime.receive(event('other', { messageId: 'om_other', chatId: 'oc_other', mentionedBot: true }));
    await p.mac.runtime.tick();
    expect(p.mac.dispatch).not.toHaveBeenCalled();
    expect(p.mac.reply.mock.calls.at(-1)?.[1]).toContain('不允许此会话');

    p.mac.cfg.preferences!.access = { ownerOpenId: 'ou_owner', allowedChats: ['oc_restricted'] };
    p.mac.projects.push({ name: 'restricted', chatId: 'oc_restricted', cwd: '/restricted', blank: false,
      createdAt: 2, ownerNodeId: macId, allowedUsers: ['ou_other'] });
    await p.mac.runtime.syncProjects();
    await p.windows.runtime.receive(event('restricted', { messageId: 'om_restricted', chatId: 'oc_restricted',
      senderId: 'ou_guest', mentionedBot: true }));
    await p.mac.runtime.tick();
    expect(p.mac.dispatch).not.toHaveBeenCalled();
    expect(p.mac.reply.mock.calls.at(-1)?.[1]).toContain('用户没有当前项目权限');
  });
  it('rejects non-admin selection and ambiguous device names', async () => {
    const p = await pair();
    await expect(p.windows.runtime.receive(event('/电脑', { senderId: 'ou_guest', chatType: 'p2p' }))).rejects.toThrow('管理员');
    await p.store.put('nodes', 'other', { id: 'other', name: 'wangyidemacbookair', protocol: 1, seenAt: p.now, host: 'other' });
    await expect(p.windows.runtime.receive(event('/电脑 wangyidemacbookair', { chatType: 'p2p' }))).rejects.toThrow('电脑名重复');
  });
  it('does not execute tampered queue data or a forged card target', async () => {
    const p = await pair();
    await p.windows.runtime.receive(event());
    const entry = [...p.storage.rows].find(([key]) => key.startsWith('commands:'))!;
    const value = JSON.parse(entry[1].value); value.value.event.data.senderId = 'ou_attacker';
    entry[1].value = JSON.stringify(value);
    await expect(p.store.list('commands', macId)).rejects.toThrow('来源校验');
    await p.mac.runtime.tick().catch(() => {});
    expect(p.mac.dispatch).not.toHaveBeenCalled();
    await expect(p.windows.runtime.receive({ kind: 'cardAction', data: { messageId: 'om', chatId: 'oc_mac',
      operator: { openId: 'ou_owner' }, action: { value: { a: 'stop', __fleetNode: macId, __fleetProof: 'bad' } } } })).rejects.toThrow('归属校验');
  });
  it('rejects expired commands and allows later valid commands through', async () => {
    const p = await pair();
    const expired = event('expired');
    const command: FleetCommand = { id: commandId(expired, macId), appId: 'app', source: winId,
      target: macId, createdAt: p.now - COMMAND_TTL_MS - 1, expiresAt: p.now - 1, event: expired };
    await p.store.put('commands', command.id, command, macId);
    await p.windows.runtime.receive(event('new', { messageId: 'om_new' })); await p.mac.runtime.tick();
    expect(p.mac.dispatch).toHaveBeenCalledTimes(1);
    expect(p.mac.dispatch.mock.calls[0]?.[0].data.content).toBe('new');
  });
  it('does not reclaim a long-running dispatched operation after two minutes', async () => {
    const p = await pair();
    let finish!: () => void;
    p.mac.dispatch.mockImplementationOnce(() => new Promise<void>(done => { finish = done; }));
    await p.windows.runtime.receive(event());
    const tick = p.mac.runtime.tick();
    await vi.waitFor(() => expect(p.mac.dispatch).toHaveBeenCalledTimes(1));
    p.advance(121_000);
    const secondTick = p.mac.runtime.tick();
    expect(secondTick).toBe(tick);
    expect(p.mac.dispatch).toHaveBeenCalledTimes(1);
    finish(); await tick;
    expect(p.mac.dispatch).toHaveBeenCalledTimes(1);
  });
  it('drains an accepted command before publishing offline during shutdown', async () => {
    const p = await pair();
    let finish!: () => void;
    p.mac.dispatch.mockImplementationOnce(() => new Promise<void>(done => { finish = done; }));
    await p.windows.runtime.receive(event());
    const tick = p.mac.runtime.tick();
    await vi.waitFor(() => expect(p.mac.dispatch).toHaveBeenCalledTimes(1));
    let shut = false;
    const shutdown = p.mac.runtime.shutdown().then(() => { shut = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(shut).toBe(false);
    finish();
    await Promise.all([tick, shutdown]);
    expect(shut).toBe(true);
    expect(await p.store.get<FleetNode>('nodes', macId)).toMatchObject({ seenAt: 0 });
  });
  it.each(['comment', 'reaction', 'botMenu', 'botAdded', 'botRemoved'] as const)('routes %s to its fixed owner', async kind => {
    const p = await pair();
    await p.store.put('routes', 'user:ou_owner', { nodeId: macId });
    await p.mac.runtime.bindRoute('message:om_target');
    await p.mac.runtime.bindRoute('document:docx:doc123');
    const data = { messageId: 'om_target', chatId: 'oc_mac', operator: { openId: 'ou_owner' },
      openId: 'ou_owner', fileToken: 'doc123', fileType: 'docx', commentId: 'c1', mentionedBot: true,
      emojiType: 'OK', action: 'added', eventKey: 'runtime.usage' };
    const incoming: FleetEvent = { kind, data };
    await p.windows.runtime.receive(incoming); await p.mac.runtime.tick();
    expect(p.mac.dispatch.mock.calls).toEqual([[incoming]]);
    expect(p.windows.dispatch).not.toHaveBeenCalled();
  });
  it('does not silently overwrite existing project ownership', async () => {
    const p = await pair();
    await expect(p.windows.runtime.bindRoute('project:oc_mac')).rejects.toThrow('另一台电脑');
  });
  it('reopens directory binding for the same computer without changing an assigned group', async () => {
    const p = await pair();
    const first = event('/电脑 绑定 wangyidemacbookair', { messageId: 'om_bind1', chatId: 'oc_new' });
    await p.windows.runtime.receive(first);
    await p.mac.runtime.tick();
    expect(await p.store.get('routes', 'project:oc_new')).toMatchObject({ nodeId: macId });
    expect(p.mac.dispatch).toHaveBeenCalledTimes(1);
    expect(p.mac.dispatch.mock.calls[0]?.[0].data.originMessageId).toBe('om_bind1');

    await p.windows.runtime.receive(first);
    await p.mac.runtime.tick();
    expect(p.mac.dispatch).toHaveBeenCalledTimes(1);

    const second = event('/电脑 绑定 wangyidemacbookair', { messageId: 'om_bind2', chatId: 'oc_new' });
    await p.windows.runtime.receive(second);
    await p.mac.runtime.tick();
    expect(p.mac.dispatch).toHaveBeenCalledTimes(2);
    expect(p.mac.dispatch.mock.calls[1]?.[0].data.originMessageId).toBe('om_bind2');
    expect(await p.store.get('routes', 'project:oc_new')).toMatchObject({ nodeId: macId });
  });
  it('refuses to rebind an assigned group to a different computer', async () => {
    const p = await pair();
    await p.windows.runtime.receive(event('/电脑 绑定 wangyidemacbookair', { messageId: 'om_bind',
      chatId: 'oc_new' }));
    await p.mac.runtime.tick();
    await expect(p.windows.runtime.receive(event('/电脑 绑定 windows', { messageId: 'om_rebind',
      chatId: 'oc_new' }))).rejects.toThrow('群已有电脑归属');
    expect(await p.store.get('routes', 'project:oc_new')).toMatchObject({ nodeId: macId });
    expect(p.mac.dispatch).toHaveBeenCalledTimes(1);
  });
  it('reports an uncertain delivery instead of falsely promising that nothing executed', async () => {
    const p = await pair();
    const original = p.storage.put.bind(p.storage);
    vi.spyOn(p.storage, 'put').mockImplementationOnce(async (table, row) => {
      await original(table, row); throw new Error('response lost after persistence');
    });
    await expect(p.windows.runtime.receive(event())).rejects.toThrow('回执未确认');
    await p.mac.runtime.tick();
    expect(p.mac.dispatch).toHaveBeenCalledTimes(1);
    expect(p.windows.dispatch).not.toHaveBeenCalled();
  });
  it('preserves uncertain execution receipts without retrying partial side effects', async () => {
    const p = await pair();
    p.mac.dispatch.mockRejectedValueOnce(new Error('reply lost after operation'));
    await p.windows.runtime.receive(event()); await p.mac.runtime.tick();
    expect(p.mac.reply.mock.calls.at(-1)?.[1]).toContain('执行回执未确认');
    await p.windows.runtime.receive(event()); await p.mac.runtime.tick();
    expect(p.mac.dispatch).toHaveBeenCalledTimes(1);
  });
  it('stops accepting events before draining shutdown', async () => {
    const p = await pair();
    p.mac.runtime.stop();
    await expect(p.mac.runtime.receive(event())).rejects.toThrow();
    expect(p.mac.dispatch).not.toHaveBeenCalled();
  });
  it('serializes messages per chat while allowing stop callbacks to bypass that queue', async () => {
    const p = await pair();
    let finish!: () => void;
    p.mac.dispatch.mockImplementationOnce(() => new Promise<void>(done => { finish = done; }));
    const first = p.mac.runtime.receive(event());
    await vi.waitFor(() => expect(p.mac.dispatch).toHaveBeenCalledTimes(1));
    const second = p.mac.runtime.receive(event('second', { messageId: 'om_second' }));
    const stop: FleetEvent = { kind: 'cardAction', data: { messageId: 'om_card', chatId: 'oc_mac',
      operator: { openId: 'ou_owner' }, action: { value: { a: 'stop', __fleetNode: macId,
        __fleetProof: p.store.proof({ cardNode: macId }) } } } };
    await p.mac.runtime.receive(stop);
    expect(p.mac.dispatch).toHaveBeenCalledTimes(2);
    expect(p.mac.dispatch.mock.calls[1]?.[0].kind).toBe('cardAction');
    finish(); await Promise.all([first, second]);
    expect(p.mac.dispatch).toHaveBeenCalledTimes(3);
  });
});
