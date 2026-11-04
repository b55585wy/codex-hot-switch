import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { FleetRuntime, FleetRuntimeOptions } from '../src/fleet/runtime';
import type { FleetEvent, FleetNode } from '../src/fleet/model';
import { installFleetHooks, stampFleetCard } from '../src/fleet/hooks';
import { createFleetBridge } from '../src/fleet';
import type { AppConfig } from '../src/config/schema';

const fleetBridgeState = vi.hoisted(() => ({ options: undefined as unknown }));
vi.mock('../src/fleet/runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/fleet/runtime')>();
  return { ...actual, FleetRuntime: class {
    constructor(readonly options: FleetRuntimeOptions) { fleetBridgeState.options = options; }
    get nodeId(): string { return this.options.config.nodeId; }
    get store(): FleetRuntimeOptions['store'] { return this.options.store; }
    receive = vi.fn(async (_event: FleetEvent) => {});
    ownMessage = vi.fn(async (_id: string) => {});
    bindRoute = vi.fn(async (_key: string) => {});
    stop = vi.fn();
    start = vi.fn(async () => {});
    shutdown = vi.fn(async () => {});
  } };
});

function context() {
  const runtime = { nodeId: 'mac', store: { proof: vi.fn(() => 'valid-proof') },
    ownMessage: vi.fn(async () => {}), bindRoute: vi.fn(async () => {}) };
  return runtime as unknown as FleetRuntime;
}
function channel() {
  const card = { create: vi.fn(async (..._args: unknown[]) => ({ data: { card_id: 'card' } })),
    update: vi.fn(async (..._args: unknown[]) => ({ code: 0 })) };
  const message = { create: vi.fn(async (..._args: unknown[]) => ({ data: { message_id: 'om_sent' } })),
    reply: vi.fn(async (..._args: unknown[]) => ({ data: { message_id: 'om_reply' } })),
    patch: vi.fn(async (..._args: unknown[]) => ({ code: 0 })) };
  const chat = { create: vi.fn(async (..._args: unknown[]) => ({ data: { chat_id: 'oc_created' } })) };
  return { rawClient: { cardkit: { v1: { card } }, im: { v1: { message, chat } } } };
}
function card() {
  return { schema: '2.0', body: { elements: [{ tag: 'button', text: { tag: 'plain_text', content: '停止' },
    behaviors: [{ type: 'callback', value: { a: 'stop', __r: 'render1' } }] }] } };
}
function enabledBridge(fake: ReturnType<typeof channel>, handlers: object = {}) {
  const cfg = { accounts: { app: { id: 'app', tenant: 'feishu', secret: 'test' } },
    fleet: { enabled: true, nodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Bridge', appToken: 'baseToken',
      tables: { nodes: 'tblNodes', routes: 'tblRoutes', commands: 'tblCommands' } } } as AppConfig;
  const bridge = createFleetBridge(fake as unknown as LarkChannel, cfg, 'test', handlers as never)!;
  return { bridge, options: fleetBridgeState.options as FleetRuntimeOptions };
}
function fleetNode(id: string, name: string, online = true): FleetNode {
  return { id, name, protocol: 1, seenAt: online ? Date.now() : 0, host: id };
}

beforeEach(() => { fleetBridgeState.options = undefined; });

describe('fixed card ownership and native API compatibility', () => {
  it('stamps callback ownership while preserving original operation and render identity', () => {
    const value = card();
    stampFleetCard(value, context(), 'wangyidemacbookair');
    const callback = value.body.elements[0]!.behaviors[0]!.value;
    expect(callback).toMatchObject({ a: 'stop', __r: 'render1', __fleetNode: 'mac', __fleetProof: 'valid-proof' });
    expect(JSON.stringify(value)).toContain('执行电脑：wangyidemacbookair');
    stampFleetCard(value, context(), 'wangyidemacbookair');
    expect(JSON.stringify(value).match(/执行电脑：/g)).toHaveLength(1);
  });
  it('refreshes only the owned modern label across JSON roundtrips and node renames', () => {
    const modern = card();
    const business = [
      { tag: 'markdown', element_id: 'assistant_stream', content: '执行电脑：assistant answer' },
      { tag: 'markdown', content: '执行电脑：Mac' },
      { tag: 'markdown', element_id: 'unrelated_id', content: 'unrelated business content' },
    ];
    modern.body.elements.push(...(business as never[]));
    modern.body.elements.push({ tag: 'markdown', element_id: 'fleet_node_label', content: '执行电脑：旧电脑' } as never);
    stampFleetCard(modern, context(), 'Mac');
    const roundTripped = JSON.parse(JSON.stringify(modern)) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    stampFleetCard(roundTripped, context(), 'MacBook Air');
    stampFleetCard(roundTripped, context(), 'MacBook Air');
    expect(roundTripped.body.elements.slice(1, 4)).toEqual(business);
    expect(roundTripped.body.elements.filter(element => element.element_id === 'fleet_node_label')).toEqual([
      { tag: 'markdown', element_id: 'fleet_node_label', content: '执行电脑：MacBook Air' },
    ]);
    expect(JSON.stringify(roundTripped)).not.toContain('旧电脑');
  });
  it('preserves unowned legacy label-looking content and refreshes only its raw generated label', () => {
    const legacy = { elements: [
      { tag: 'button', text: { tag: 'plain_text', content: '批准' }, value: { a: 'approval', __r: 'legacy-render' } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '执行电脑：旧电脑' }] },
      { tag: 'markdown', content: '执行电脑：assistant answer' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '执行电脑：Windows' }] },
    ] };
    const business = JSON.stringify(legacy.elements.slice(1));
    stampFleetCard(legacy, context(), 'Windows');
    expect(legacy.elements[0]!.value).toMatchObject({ a: 'approval', __r: 'legacy-render', __fleetNode: 'mac' });
    expect(legacy.elements).toHaveLength(5);
    expect(JSON.stringify(legacy.elements.slice(1, 4))).toBe(business);
    expect(legacy.elements[4]).toEqual({ tag: 'note', elements: [{ tag: 'plain_text', content: '执行电脑：Windows' }] });
    stampFleetCard(legacy, context(), 'Windows renamed');
    expect(legacy.elements).toHaveLength(5);
    expect(JSON.stringify(legacy.elements.slice(1, 4))).toBe(business);
    expect(legacy.elements[4]).toEqual({ tag: 'note', elements: [{ tag: 'plain_text', content: '执行电脑：Windows renamed' }] });
  });
  it('preserves a serialized legacy label as unowned content when ownership cannot roundtrip', () => {
    const legacy = { elements: [{ tag: 'markdown', content: '执行电脑：business' }] };
    stampFleetCard(legacy, context(), 'Windows');
    const roundTripped = JSON.parse(JSON.stringify(legacy)) as {
      elements: Array<Record<string, unknown>>;
    };
    const beforeRestamp = JSON.stringify(roundTripped.elements);
    stampFleetCard(roundTripped, context(), 'Windows renamed');
    expect(JSON.stringify(roundTripped.elements.slice(0, -1))).toBe(JSON.stringify(JSON.parse(beforeRestamp)));
    expect(roundTripped.elements.at(-1)).toEqual({
      tag: 'note', elements: [{ tag: 'plain_text', content: '执行电脑：Windows renamed' }],
    });
  });
  it('stamps CardKit create/update and native message content while preserving requests and options', async () => {
    const fake = channel(); const runtime = context(); const errors = vi.fn();
    const originalCreate = fake.rawClient.cardkit.v1.card.create;
    const originalUpdate = fake.rawClient.cardkit.v1.card.update;
    const restore = installFleetHooks(fake as unknown as LarkChannel, runtime, 'Mac', errors);
    const controller = new AbortController();
    const date = new Date(); const buffer = Buffer.from('keep'); const callback = () => 'keep';
    const response = { data: { card_id: 'exact-response' } };
    originalCreate.mockResolvedValueOnce(response);
    const request = { data: { type: 'card_json', data: JSON.stringify(card()) }, date, buffer, callback };
    const options = { signal: controller.signal, date, buffer, callback };
    await expect(fake.rawClient.cardkit.v1.card.create(request, options)).resolves.toBe(response);
    expect(originalCreate.mock.calls[0]).toEqual([request, options]);
    expect(originalCreate.mock.calls[0]?.[0]).toBe(request);
    expect(originalCreate.mock.calls[0]?.[1]).toBe(options);
    expect(request.date).toBe(date); expect(request.buffer).toBe(buffer); expect(request.callback).toBe(callback);
    expect(options.signal).toBe(controller.signal);
    const created = JSON.parse(request.data.data);
    expect(created.body.elements[0].behaviors[0].value).toMatchObject({ a: 'stop', __r: 'render1', __fleetNode: 'mac' });

    const update = { path: { card_id: 'card' }, data: { card: { type: 'card_json', data: JSON.stringify(card()) },
      sequence: 7, uuid: 'render-request' }, signal: controller.signal, buffer };
    await fake.rawClient.cardkit.v1.card.update(update);
    expect(originalUpdate.mock.calls[0]?.[0]).toBe(update);
    expect(update.data.sequence).toBe(7); expect(update.data.uuid).toBe('render-request');
    expect(update.signal).toBe(controller.signal); expect(update.buffer).toBe(buffer);
    const updated = JSON.parse(update.data.card.data);
    expect(updated.body.elements[0].behaviors[0].value).toMatchObject({ a: 'stop', __r: 'render1',
      __fleetNode: 'mac', __fleetProof: 'valid-proof' });

    const text = JSON.stringify({ text: 'plain message' });
    const messageRequest = { data: { msg_type: 'text', content: text }, params: { receive_id_type: 'open_id' }, signal: controller.signal };
    await fake.rawClient.im.v1.message.create(messageRequest);
    expect(messageRequest.data.content).toBe(text);
    expect(messageRequest.signal).toBe(controller.signal);
    await fake.rawClient.im.v1.message.reply({ path: { message_id: 'om_original' },
      data: { msg_type: 'interactive', content: JSON.stringify(card()) } });
    await fake.rawClient.im.v1.message.patch({ path: { message_id: 'om_original' }, data: { content: JSON.stringify(card()) } });
    expect(runtime.ownMessage).toHaveBeenCalledWith('om_sent');
    expect(runtime.ownMessage).toHaveBeenCalledWith('om_reply');
    expect(errors).not.toHaveBeenCalled();
    restore();
    expect(fake.rawClient.cardkit.v1.card.create).toBe(originalCreate);
    expect(fake.rawClient.cardkit.v1.card.update).toBe(originalUpdate);
  });
  it('preserves the original native error without retrying', async () => {
    const fake = channel(); const originalCreate = fake.rawClient.cardkit.v1.card.create;
    const failure = new Error('native failure');
    originalCreate.mockRejectedValueOnce(failure);
    const restore = installFleetHooks(fake as unknown as LarkChannel, context(), 'Mac', vi.fn());
    await expect(fake.rawClient.cardkit.v1.card.create({ data: { data: JSON.stringify(card()) } })).rejects.toBe(failure);
    expect(originalCreate).toHaveBeenCalledTimes(1);
    restore();
  });
  it('records message/chat ownership after exact native responses', async () => {
    const fake = channel(); const runtime = context(); const errors = vi.fn();
    const restore = installFleetHooks(fake as unknown as LarkChannel, runtime, 'Mac', errors);
    await expect(fake.rawClient.im.v1.message.create({ data: {} })).resolves.toEqual({ data: { message_id: 'om_sent' } });
    expect(runtime.ownMessage).toHaveBeenCalledWith('om_sent');
    await fake.rawClient.im.v1.chat.create({ data: {} });
    expect(runtime.bindRoute).toHaveBeenCalledWith('project:oc_created');
    expect(errors).not.toHaveBeenCalled();
    restore();
  });
  it('does not retry or fail an already-sent message when routing metadata fails', async () => {
    const fake = channel(); const runtime = context(); const errors = vi.fn();
    vi.mocked(runtime.ownMessage).mockRejectedValueOnce(new Error('metadata unavailable'));
    const originalCreate = fake.rawClient.im.v1.message.create;
    const restore = installFleetHooks(fake as unknown as LarkChannel, runtime, 'Mac', errors);
    await expect(fake.rawClient.im.v1.message.create({ data: {} })).resolves.toEqual({ data: { message_id: 'om_sent' } });
    expect(originalCreate).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    restore();
  });
  it('leaves single-computer startup completely untouched when absent or disabled', () => {
    const cfg = { accounts: { app: { id: 'app', tenant: 'feishu', secret: 'test' } } } as AppConfig;
    expect(createFleetBridge({} as LarkChannel, cfg, 'test', {} as never)).toBeUndefined();
    expect(createFleetBridge({} as LarkChannel, { ...cfg, fleet: { enabled: false } as never }, 'test', {} as never)).toBeUndefined();
    expect(fleetBridgeState.options).toBeUndefined();
  });
});

describe('fleet computer picker and native handler integration', () => {
  it('renders a CardKit 2.0 picker with states, callback targets, and IDs only for duplicate names', async () => {
    const fake = channel();
    const originalCreate = fake.rawClient.cardkit.v1.card.create;
    const originalMessage = fake.rawClient.im.v1.message.create;
    const { bridge, options } = enabledBridge(fake);
    const uniqueId = '11111111-1111-4111-8111-111111111111';
    const duplicateOne = '22222222-2222-4222-8222-222222222222';
    const duplicateTwo = '33333333-3333-4333-8333-333333333333';
    const offlineId = '44444444-4444-4444-8444-444444444444';
    await options.picker({ kind: 'message', data: { chatId: 'oc_dm', senderId: 'ou_admin' } }, [
      fleetNode(uniqueId, 'Windows'), fleetNode(duplicateOne, 'Mac'), fleetNode(duplicateTwo, 'Mac'),
      fleetNode(offlineId, 'Offline', false),
    ]);
    const createRequest = originalCreate.mock.calls[0]?.[0] as { data: { data: string } };
    const rendered = JSON.parse(createRequest.data.data);
    expect(rendered.schema).toBe('2.0');
    expect(rendered.header.title.content).toBe('执行电脑');
    expect(rendered.body.elements.some((element: { tag?: string }) => element.tag === 'column_set')).toBe(true);
    const markdownLabels: string[] = [];
    const collectVisibleLabels = (item: unknown): void => {
      if (Array.isArray(item)) { item.forEach(collectVisibleLabels); return; }
      if (!item || typeof item !== 'object') return;
      const record = item as Record<string, unknown>;
      if (record.tag === 'markdown' && typeof record.content === 'string') markdownLabels.push(record.content);
      Object.values(record).forEach(collectVisibleLabels);
    };
    collectVisibleLabels(rendered.body.elements);
    const visibleLabels = markdownLabels.join('\n');
    expect(visibleLabels).toContain('Windows'); expect(visibleLabels).toContain('在线');
    expect(visibleLabels).toContain('离线或版本不兼容');
    expect(visibleLabels).not.toContain(uniqueId); expect(visibleLabels).not.toContain(offlineId);
    expect(visibleLabels).toContain(duplicateOne); expect(visibleLabels).toContain(duplicateTwo);
    const serialized = JSON.stringify(rendered);
    for (const id of [uniqueId, duplicateOne, duplicateTwo]) {
      expect(serialized).toContain(`"a":"fleet.select","targetNodeId":"${id}"`);
    }
    expect(serialized).not.toContain(`"a":"fleet.select","targetNodeId":"${offlineId}"`);
    expect(serialized).toContain('私聊：/电脑 电脑名');
    expect(serialized).toContain('未绑定项目群：/电脑 绑定 电脑名');
    expect(serialized).toContain('文档评论：/电脑 文档 文件类型 文件token');
    const messageRequest = originalMessage.mock.calls[0]?.[0] as { data: { content: string } };
    expect(JSON.parse(messageRequest.data.content)).toEqual({ type: 'card', data: { card_id: 'card' } });
    await bridge.shutdown();
  });
  it('delegates every supported delivery to the original native handler', async () => {
    const handlers = { onMessage: vi.fn(async () => {}), dispatcher: { handle: vi.fn(async () => {}) },
      onReaction: vi.fn(async () => {}), onComment: vi.fn(async () => {}), onBotAddedToChat: vi.fn(async () => {}),
      onBotRemovedFromChat: vi.fn(async () => {}), onBotMenu: vi.fn(async () => {}) };
    const { bridge, options } = enabledBridge(channel(), handlers);
    const deliveries: Array<[FleetEvent['kind'], Record<string, unknown>]> = [
      ['message', { content: 'native' }], ['cardAction', { action: { value: { a: 'stop' } } }],
      ['reaction', { emojiType: 'OK' }], ['comment', { commentId: 'comment' }],
      ['botAdded', { chatId: 'oc_added' }], ['botRemoved', { chatId: 'oc_removed' }], ['botMenu', { eventKey: 'runtime.usage' }],
    ];
    for (const [kind, data] of deliveries) await options.dispatch({ kind, data });
    expect(handlers.onMessage).toHaveBeenCalledWith(deliveries[0]![1]);
    expect(handlers.dispatcher.handle).toHaveBeenCalledWith(deliveries[1]![1]);
    expect(handlers.onReaction).toHaveBeenCalledWith(deliveries[2]![1]);
    expect(handlers.onComment).toHaveBeenCalledWith(deliveries[3]![1]);
    expect(handlers.onBotAddedToChat).toHaveBeenCalledWith(deliveries[4]![1]);
    expect(handlers.onBotRemovedFromChat).toHaveBeenCalledWith('oc_removed');
    expect(handlers.onBotMenu).toHaveBeenCalledWith(deliveries[6]![1]);
    await bridge.shutdown();
  });
});
