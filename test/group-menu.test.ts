import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import {
  GROUP_MENU_NAMES,
  HELP_DOC_URL,
  backfillGroupMenus,
  installGroupMenus,
  readGroupMenuState,
  refreshGroupEntryCard,
  type GroupMenuTopLevel,
} from '../src/project/group-menu';
import { forgetManagedCard } from '../src/card/managed';
import type { Project } from '../src/project/registry';

const registry = vi.hoisted(() => ({ projects: [] as Project[] }));
vi.mock('../src/project/registry', async (original) => ({
  ...(await original<typeof import('../src/project/registry')>()),
  listProjects: async () => registry.projects,
}));

interface FakeMenu {
  id: string;
  name: string;
  url: string;
}

interface FakeMessage {
  id: string;
  position?: string;
  chatId: string;
  content: string;
}

interface FakeCalls {
  entryCreates: number;
  menuCreates: unknown[];
  menuDeletes: string[][];
  menuGets: number;
  messageGets: number;
  cardCreates: number;
  cardUpdates: Array<{ cardId: string; sequence: number; data: string }>;
  messageUuids: Array<string | undefined>;
}

interface FakeOptions {
  menus?: FakeMenu[];
  position?: string | undefined;
  getCode?: number;
  createCode?: number;
  messageGone?: (messageId: string) => boolean;
  /** Simulate the platform creating the message and then the process dying. */
  entryCreate?: 'never' | 'once-after-create' | 'always';
  /** Simulate a transient CardKit "card id not ready" on the first attempt. */
  cardIdNotReadyOnce?: boolean;
  /** Enforce CardKit's positive, strictly-increasing int32 per-card contract. */
  strictSequence?: boolean;
  /** Throw this many update calls before succeeding (transport failure). */
  updateFailures?: number;
  /** Resolve a business error code for every update instead of succeeding. */
  updateCode?: number;
}

function topLevels(menus: FakeMenu[]): GroupMenuTopLevel[] {
  return menus.map((menu) => ({
    chat_menu_top_level_id: menu.id,
    chat_menu_item: {
      action_type: 'REDIRECT_LINK',
      name: menu.name,
      redirect_link: { common_url: menu.url },
    },
  }));
}

function fakeChannel(opts: FakeOptions = {}): {
  channel: LarkChannel;
  calls: FakeCalls;
  menus: FakeMenu[];
  messages: Map<string, FakeMessage>;
  cards: Map<string, string>;
} {
  const menus = [...(opts.menus ?? [])];
  const messages = new Map<string, FakeMessage>();
  const cards = new Map<string, string>();
  const lastSequence = new Map<string, number>();
  const messageByUuid = new Map<string, string>();
  const calls: FakeCalls = {
    entryCreates: 0,
    menuCreates: [],
    menuDeletes: [],
    menuGets: 0,
    messageGets: 0,
    cardCreates: 0,
    cardUpdates: [],
    messageUuids: [],
  };
  let seq = 0;
  let messageSeq = 0;
  let cardSeq = 0;
  let entryAttempts = 0;

  const rawClient = {
    im: {
      v1: {
        chatMenuTree: {
          get: async () => {
            calls.menuGets += 1;
            if (opts.getCode !== undefined) return { code: opts.getCode, msg: 'denied' };
            return { code: 0, data: { menu_tree: { chat_menu_top_levels: topLevels(menus) } } };
          },
          create: async (payload: {
            path: { chat_id: string };
            data: { menu_tree: { chat_menu_top_levels: Array<{ chat_menu_item: { name: string; redirect_link: { common_url: string } } }> } };
          }) => {
            calls.menuCreates.push(payload);
            if (opts.createCode !== undefined) return { code: opts.createCode, msg: 'rejected' };
            for (const item of payload.data.menu_tree.chat_menu_top_levels) {
              seq += 1;
              menus.push({ id: `menu_${seq}`, name: item.chat_menu_item.name, url: item.chat_menu_item.redirect_link.common_url });
            }
            return { code: 0, data: { menu_tree: { chat_menu_top_levels: topLevels(menus) } } };
          },
          delete: async (payload: { data: { chat_menu_top_level_ids: string[] }; path: { chat_id: string } }) => {
            calls.menuDeletes.push(payload.data.chat_menu_top_level_ids);
            for (const id of payload.data.chat_menu_top_level_ids) {
              const index = menus.findIndex((menu) => menu.id === id);
              if (index !== -1) menus.splice(index, 1);
            }
            return { code: 0, data: { menu_tree: { chat_menu_top_levels: topLevels(menus) } } };
          },
        },
        message: {
          create: async (payload: { data: { content: string; uuid?: string } }) => {
            calls.entryCreates += 1;
            entryAttempts += 1;
            const uuid = payload.data.uuid;
            calls.messageUuids.push(uuid);
            const replay = uuid ? messageByUuid.get(uuid) : undefined;
            if (replay) {
              // Platform idempotency: the ORIGINAL message comes back.
              const original = messages.get(replay)!;
              return {
                code: 0,
                data: {
                  message_id: original.id,
                  ...(original.position ? { message_position: original.position } : {}),
                },
              };
            }
            const failure = opts.entryCreate;
            if (failure === 'always') throw new Error('network down');
            messageSeq += 1;
            const messageId = `om_${messageSeq}`;
            messages.set(messageId, {
              id: messageId,
              position: opts.position,
              chatId: 'oc_1',
              content: payload.data.content,
            });
            if (uuid) messageByUuid.set(uuid, messageId);
            if (failure === 'once-after-create' && entryAttempts === 1) throw new Error('connection reset');
            return { code: 0, data: { message_id: messageId, ...(opts.position ? { message_position: opts.position } : {}) } };
          },
          get: async (payload: { path: { message_id: string } }) => {
            calls.messageGets += 1;
            if (opts.messageGone?.(payload.path.message_id)) {
              const error = { response: { data: { code: 230002, msg: 'message not found' } } };
              throw error;
            }
            const message = messages.get(payload.path.message_id);
            if (!message) throw { response: { data: { code: 230002, msg: 'message not found' } } };
            return {
              code: 0,
              data: {
                items: [
                  {
                    message_id: payload.path.message_id,
                    chat_id: message.chatId,
                    body: { content: message.content },
                    ...(message.position ? { message_position: message.position } : {}),
                  },
                ],
              },
            };
          },
        },
      },
    },
    cardkit: {
      v1: {
        card: {
          create: async (payload: { data: { data: string } }) => {
            calls.cardCreates += 1;
            if (opts.cardIdNotReadyOnce && calls.cardCreates === 1) {
              throw { response: { data: { code: 230099, msg: 'ErrCode: 11310; cardid is invalid' } } };
            }
            cardSeq += 1;
            const cardId = `card_${cardSeq}`;
            cards.set(cardId, payload.data.data);
            return { code: 0, data: { card_id: cardId } };
          },
          update: async (payload: { path: { card_id: string }; data: { card: { data: string }; sequence: number } }) => {
            const cardId = payload.path.card_id;
            const sequence = payload.data.sequence;
            calls.cardUpdates.push({ cardId, sequence, data: payload.data.card.data });
            if (opts.strictSequence) {
              const previous = lastSequence.get(cardId) ?? 0;
              if (
                !Number.isInteger(sequence) ||
                sequence < 1 ||
                sequence > 2_147_483_647 ||
                sequence <= previous
              ) {
                return { code: 300317, msg: `sequence ${sequence} must be > ${previous}` };
              }
              lastSequence.set(cardId, sequence);
            }
            if (opts.updateFailures !== undefined && calls.cardUpdates.length <= opts.updateFailures) {
              throw new Error('network reset');
            }
            if (opts.updateCode !== undefined) return { code: opts.updateCode, msg: 'rejected' };
            cards.set(cardId, payload.data.card.data);
            return { code: 0, data: {} };
          },
        },
      },
    },
  };
  return { channel: { rawClient } as unknown as LarkChannel, calls, menus, messages, cards };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    name: 'p',
    chatId: 'oc_1',
    cwd: '/work/p',
    blank: false,
    createdAt: 0,
    origin: 'created',
    ...overrides,
  };
}

const dirs: string[] = [];
async function storeFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'group-menu-test-'));
  dirs.push(dir);
  return join(dir, 'group-menus.json');
}

afterEach(async () => {
  registry.projects = [];
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Callback values embedded in a serialized card (buttons only). */
function callbackValues(cardJson: string): Array<{ tag: string; name: string; value: unknown }> {
  const out: Array<{ tag: string; name: string; value: unknown }> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const object = node as Record<string, unknown>;
    if (Array.isArray(object.behaviors)) {
      for (const behavior of object.behaviors) {
        if (behavior && typeof behavior === 'object' && (behavior as { type?: string }).type === 'callback') {
          const value = (behavior as { value?: unknown }).value;
          if (value && typeof value === 'object' && typeof (value as { a?: unknown }).a === 'string') {
            out.push({ tag: 'button', name: '', value });
          }
        }
      }
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(JSON.parse(cardJson));
  return out;
}

/**
 * Mirror of the node-sdk SafetyPipeline `cardActionId` (index.js):
 * `${tag}|${name}|${option}|${JSON.stringify(value)}` folded into
 * `card:${messageId}:${openId}:${actionId}`. The entry card keeps a stable
 * messageId + operator, so two clicks dedupe exactly when this action id repeats.
 */
function actionIds(cardJson: string): string[] {
  return callbackValues(cardJson).map(
    (entry) => `${entry.tag}|${entry.name}||${JSON.stringify(entry.value ?? '')}`,
  );
}

describe('installGroupMenus: new and repeated installation', () => {
  it('creates one CardKit entry card and three owned Chinese menus, then is idempotent', async () => {
    const file = await storeFile();
    const { channel, calls, menus, messages } = fakeChannel({ position: '42' });
    const first = await installGroupMenus(channel, project(), { storeFile: file });
    expect(first.status).toBe('installed');
    expect(first.menuIds).toHaveLength(3);
    expect(calls.entryCreates).toBe(1);
    expect(calls.menuCreates).toHaveLength(1);
    expect(messages.size).toBe(1);
    expect(menus.map((menu) => menu.name)).toEqual([
      GROUP_MENU_NAMES.sessions,
      GROUP_MENU_NAMES.actions,
      GROUP_MENU_NAMES.help,
    ]);
    // Approved Chinese labels — the native installer owns these names.
    expect(menus.map((menu) => menu.name)).toEqual(['会话', '操作', '帮助']);
    expect(menus[0]!.url).toBe(menus[1]!.url);
    expect(menus[0]!.url).toContain('openChatId=oc_1');
    expect(menus[0]!.url).toContain('position=42');
    expect(menus[2]!.url).toBe(HELP_DOC_URL);

    const state = await readGroupMenuState('oc_1', file);
    expect(state).toMatchObject({ status: 'installed', entryMessageId: 'om_1', entryCardId: 'card_1' });
    expect(state?.menuIds).toEqual(['menu_1', 'menu_2', 'menu_3']);

    const second = await installGroupMenus(channel, project(), { storeFile: file });
    expect(second.status).toBe('installed');
    expect(second.entryMessageId).toBe('om_1');
    expect(calls.entryCreates).toBe(1);
    expect(calls.menuCreates).toHaveLength(1);
    expect(calls.menuDeletes).toHaveLength(0);
    expect(menus).toHaveLength(3);
  });

  it('adopts the exact legacy help menu and replaces only that owned entry', async () => {
    const file = await storeFile();
    const legacy: FakeMenu = { id: 'legacy', name: '🤖 Codex', url: HELP_DOC_URL };
    const { channel, calls, menus } = fakeChannel({ menus: [legacy], position: '7' });
    const result = await installGroupMenus(channel, project(), { storeFile: file });
    expect(result.status).toBe('installed');
    expect(calls.menuDeletes).toEqual([['legacy']]);
    expect(menus.map((menu) => menu.name)).toEqual([
      GROUP_MENU_NAMES.sessions,
      GROUP_MENU_NAMES.actions,
      GROUP_MENU_NAMES.help,
    ]);
  });

  it('preserves unrelated menus and reports a conflict instead of deleting them', async () => {
    const file = await storeFile();
    const menus: FakeMenu[] = [
      { id: 'legacy', name: '🤖 Codex', url: HELP_DOC_URL },
      { id: 'user-1', name: '用户菜单一', url: 'https://example.com/a' },
      { id: 'user-2', name: '用户菜单二', url: 'https://example.com/b' },
    ];
    const { channel, calls, menus: after } = fakeChannel({ menus, position: '9' });
    const result = await installGroupMenus(channel, project(), { storeFile: file });
    expect(result.status).toBe('conflict');
    expect(result.reason).toContain('用户菜单一');
    expect(calls.entryCreates).toBe(0);
    expect(calls.menuCreates).toHaveLength(0);
    expect(calls.menuDeletes).toHaveLength(0);
    expect(after.map((menu) => menu.id)).toEqual(['legacy', 'user-1', 'user-2']);
    expect((await readGroupMenuState('oc_1', file))?.status).toBe('conflict');
  });

  it('never adopts a look-alike manual entry with a different URL', async () => {
    const file = await storeFile();
    const fake: FakeMenu = { id: 'fake', name: '🤖 Codex', url: 'https://example.com/manual' };
    const { channel, calls, menus } = fakeChannel({ menus: [fake], position: '3' });
    const result = await installGroupMenus(channel, project(), { storeFile: file });
    expect(result.status).toBe('conflict');
    expect(calls.menuDeletes).toHaveLength(0);
    expect(menus).toHaveLength(1);
  });

  it('does not delete a stored menu id the user renamed (signature wins over id)', async () => {
    const file = await storeFile();
    const { channel, calls, menus } = fakeChannel({ position: '17' });
    const first = await installGroupMenus(channel, project(), { storeFile: file });
    expect(first.status).toBe('installed');
    expect(menus).toHaveLength(3);

    // User renames one of our menus in the Feishu UI; the id is still "ours" in
    // the state file, but the exact name+link no longer matches.
    const renamed = menus[0]!;
    renamed.name = '我的会话';
    const second = await installGroupMenus(channel, project(), { storeFile: file, force: true });
    expect(second.status).toBe('conflict');
    expect(second.reason).toContain('我的会话');
    expect(calls.menuDeletes).toHaveLength(0);
    expect(menus.map((menu) => menu.name)).toContain('我的会话');
    expect(menus).toHaveLength(3);
  });
});

describe('installGroupMenus: entry card idempotency', () => {
  it('reuses the persisted idempotency uuid after a crash between send and save', async () => {
    const file = await storeFile();
    const { channel, calls, messages } = fakeChannel({ position: '5', entryCreate: 'once-after-create' });
    const result = await installGroupMenus(channel, project(), { storeFile: file });
    expect(result.status).toBe('installed');
    // The first attempt was answered with a connection error AFTER the platform
    // created the message; the retry reuses the token and gets the same message.
    expect(calls.messageUuids).toHaveLength(2);
    expect(calls.messageUuids[0]).toBeTruthy();
    expect(calls.messageUuids[1]).toBe(calls.messageUuids[0]);
    expect(messages.size).toBe(1);
    expect(result.entryMessageId).toBe('om_1');
    expect((await readGroupMenuState('oc_1', file))?.entryMessageId).toBe('om_1');
    expect((await readGroupMenuState('oc_1', file))?.entrySend).toBeUndefined();
  });

  it('persists the token before the send and reuses it on the next pass while live', async () => {
    const file = await storeFile();
    const { channel, calls } = fakeChannel({ position: '6', entryCreate: 'always' });
    const failed = await installGroupMenus(channel, project(), { storeFile: file });
    expect(failed.status).toBe('partial');
    const persisted = await readGroupMenuState('oc_1', file);
    expect(persisted?.entrySend?.uuid).toBeTruthy();
    expect(persisted?.entryMessageId).toBeUndefined();

    const retry = await installGroupMenus(channel, project(), { storeFile: file });
    expect(retry.status).toBe('partial');
    // Each attempt tries CardKit then the plain-card fallback with the SAME
    // persisted token, so both attempts are answered idempotently.
    expect(calls.messageUuids).toHaveLength(4);
    expect(calls.messageUuids[1]).toBe(calls.messageUuids[0]);
    expect(calls.messageUuids[3]).toBe(calls.messageUuids[2]);
    expect(calls.messageUuids[2]).toBe(calls.messageUuids[0]);
    // Never fabricate a message id from the request token.
    expect(retry.entryMessageId).toBeUndefined();
  });
});

describe('installGroupMenus: entry card click lifecycle', () => {
  it('rotates the persisted entity token so two real clicks differ while a redelivery repeats', async () => {
    const file = await storeFile();
    const { channel, calls, cards } = fakeChannel({ position: '8', strictSequence: true });
    const first = await installGroupMenus(channel, project(), { storeFile: file });
    expect(first.status).toBe('installed');
    const initial = cards.get('card_1')!;

    // Click 1 is handled → its rendered values are now the "already delivered"
    // action ids. The entry card is re-rendered in place.
    expect(await refreshGroupEntryCard(channel, project(), { messageId: 'om_1', storeFile: file })).toBe(true);
    const second = cards.get('card_1')!;
    // Click 2 after the re-render.
    expect(await refreshGroupEntryCard(channel, project(), { messageId: 'om_1', storeFile: file })).toBe(true);
    const third = cards.get('card_1')!;

    expect(calls.cardUpdates.map((update) => update.cardId)).toEqual(['card_1', 'card_1']);
    expect(calls.entryCreates).toBe(1); // in-place only: never a new message

    const ids1 = actionIds(initial);
    const ids2 = actionIds(second);
    const ids3 = actionIds(third);
    expect(ids1.length).toBeGreaterThan(0);
    // A second, genuinely new click has a fresh action id (the SDK will deliver it).
    expect(ids2.some((id) => ids1.includes(id))).toBe(false);
    expect(ids3.some((id) => ids2.includes(id))).toBe(false);
    // A redelivery of the click whose values are `initial` keeps those exact ids,
    // so the SDK's 12h dedupe still swallows it exactly once.
    expect(actionIds(initial)).toEqual(ids1);
    // Sequences are monotonic on the same entity.
    expect(calls.cardUpdates.map((update) => update.sequence)).toEqual([1, 2]);
  });

  it('re-adopts the persisted entity after a restart (no in-process mapping)', async () => {
    const file = await storeFile();
    const { channel, calls, cards } = fakeChannel({ position: '12' });
    const first = await installGroupMenus(channel, project(), { storeFile: file });
    expect(first.status).toBe('installed');
    expect((await readGroupMenuState('oc_1', file))?.entryCardId).toBe('card_1');

    forgetManagedCard('om_1');
    expect(await refreshGroupEntryCard(channel, project(), { messageId: 'om_1', storeFile: file })).toBe(true);
    expect(calls.cardUpdates.at(-1)?.cardId).toBe('card_1');
    expect(cards.get('card_1')).toBeTruthy();
    expect(calls.entryCreates).toBe(1);
  });

  it('ignores clicks on a message that is not this group entry card', async () => {
    const file = await storeFile();
    const { channel, calls } = fakeChannel({ position: '13' });
    await installGroupMenus(channel, project(), { storeFile: file });
    expect(await refreshGroupEntryCard(channel, project(), { messageId: 'om_other', storeFile: file })).toBe(false);
    expect(calls.cardUpdates).toHaveLength(0);
  });

  it('continues strictly above the persisted high-water mark after a module restart', async () => {
    const file = await storeFile();
    const { channel, calls } = fakeChannel({ position: '30', strictSequence: true });
    expect((await installGroupMenus(channel, project(), { storeFile: file })).status).toBe('installed');

    expect(await refreshGroupEntryCard(channel, project(), { messageId: 'om_1', storeFile: file })).toBe(true);
    expect(await refreshGroupEntryCard(channel, project(), { messageId: 'om_1', storeFile: file })).toBe(true);
    expect(calls.cardUpdates.map((update) => update.sequence)).toEqual([1, 2]);
    expect((await readGroupMenuState('oc_1', file))?.entrySequenceHighwater).toBe(2);

    // Simulate a process restart: the in-process message→card map is gone, but
    // the persisted high-water mark must make the next push strictly greater.
    vi.resetModules();
    const fresh = await import('../src/project/group-menu');
    expect(await fresh.refreshGroupEntryCard(channel, project(), { messageId: 'om_1', storeFile: file })).toBe(true);
    expect(calls.cardUpdates.map((update) => update.sequence)).toEqual([1, 2, 3]);
    expect((await fresh.readGroupMenuState('oc_1', file))?.entrySequenceHighwater).toBe(3);
  });

  it('reserves a fresh sequence before retrying a failed persistent-card update', async () => {
    const file = await storeFile();
    const { channel, calls } = fakeChannel({ position: '31', strictSequence: true, updateFailures: 1 });
    expect((await installGroupMenus(channel, project(), { storeFile: file })).status).toBe('installed');

    expect(await refreshGroupEntryCard(channel, project(), { messageId: 'om_1', storeFile: file })).toBe(true);
    // Both attempts are strictly increasing and both were persisted before the
    // API call, so a retry can never replay the sequence that just failed.
    expect(calls.cardUpdates.map((update) => update.sequence)).toEqual([1, 2]);
    expect((await readGroupMenuState('oc_1', file))?.entrySequenceHighwater).toBe(2);
  });

  it('does not treat a resolved nonzero update code as a successful refresh', async () => {
    const file = await storeFile();
    const { channel, calls } = fakeChannel({ position: '32', updateCode: 300317 });
    expect((await installGroupMenus(channel, project(), { storeFile: file })).status).toBe('installed');

    expect(await refreshGroupEntryCard(channel, project(), { messageId: 'om_1', storeFile: file })).toBe(false);
    // The rejected call is retried with a freshly reserved, strictly increasing
    // sequence, and the refresh is still reported as failed.
    expect(calls.cardUpdates.map((update) => update.sequence)).toEqual([1, 2]);
    expect((await readGroupMenuState('oc_1', file))?.entrySequenceHighwater).toBe(2);
  });
});

describe('installGroupMenus: degraded paths', () => {
  it('keeps /controls and falls back to the legacy help menu when the entry link is unavailable', async () => {
    const file = await storeFile();
    const { channel, calls, menus } = fakeChannel({ position: undefined });
    const result = await installGroupMenus(channel, project(), { storeFile: file, fallbackLegacyMenu: true });
    expect(result.status).toBe('partial');
    expect(result.reason).toContain('legacy-help-only');
    expect(calls.menuCreates).toHaveLength(1);
    expect(menus).toHaveLength(1);
    expect(menus[0]!.name).toBe('🤖 Codex');
    expect(menus[0]!.url).toBe(HELP_DOC_URL);

    // A repeated pass must not duplicate the entry card or the fallback menu.
    const again = await installGroupMenus(channel, project(), { storeFile: file, fallbackLegacyMenu: true });
    expect(again.status).toBe('partial');
    expect(calls.entryCreates).toBe(1);
    expect(calls.menuCreates).toHaveLength(1);
    expect(menus).toHaveLength(1);
  });

  it('performs NO writes when the menu tree read fails and fallback is not explicitly requested', async () => {
    const file = await storeFile();
    const { channel, calls, menus } = fakeChannel({ getCode: 99991672, position: '1' });
    const result = await installGroupMenus(channel, project(), { storeFile: file });
    expect(result.status).toBe('partial');
    expect(result.reason).toContain('menu-tree-unavailable');
    expect(calls.menuCreates).toHaveLength(0);
    expect(calls.menuDeletes).toHaveLength(0);
    expect(calls.entryCreates).toBe(0);
    expect(menus).toHaveLength(0);
    // No state written from an unknown tree.
    expect(await readGroupMenuState('oc_1', file)).toBeUndefined();
  });

  it('lets old-group backfill fall back to nothing on a failed read (default false)', async () => {
    const file = await storeFile();
    registry.projects = [project()];
    const { channel, calls, menus } = fakeChannel({ getCode: 99991672, position: '1' });
    const summary = await backfillGroupMenus(channel, { storeFile: file });
    expect(summary).toEqual({ scanned: 1, installed: 0, partial: 1, conflict: 0, skipped: 0 });
    expect(calls.menuCreates).toHaveLength(0);
    expect(calls.entryCreates).toBe(0);
    expect(menus).toHaveLength(0);
  });

  it('only creates the legacy fallback when onboarding explicitly opts in, and never twice', async () => {
    const file = await storeFile();
    const { channel, calls, menus } = fakeChannel({ getCode: 99991672, position: '1' });
    const result = await installGroupMenus(channel, project(), { storeFile: file, fallbackLegacyMenu: true });
    expect(result.status).toBe('partial');
    expect(calls.menuCreates).toHaveLength(1);
    expect(menus).toHaveLength(1);

    const again = await installGroupMenus(channel, project(), { storeFile: file, fallbackLegacyMenu: true });
    expect(again.status).toBe('partial');
    expect(calls.menuCreates).toHaveLength(1);
    expect(menus).toHaveLength(1);
  });

  it('checks a nonzero create response code and keeps diagnostics nonfatal', async () => {
    const file = await storeFile();
    const { channel, calls, menus } = fakeChannel({ position: '5', createCode: 99991672 });
    const result = await installGroupMenus(channel, project(), { storeFile: file });
    expect(result.status).toBe('partial');
    expect(result.reason).toContain('99991672');
    expect(calls.entryCreates).toBe(1);
    expect(menus).toHaveLength(0);
    expect((await readGroupMenuState('oc_1', file))?.status).toBe('partial');
  });

  it('repairs a deleted entry card and reinstalls only owned menus', async () => {
    const file = await storeFile();
    let deleted: string | undefined;
    const { channel, calls, menus } = fakeChannel({
      position: '11',
      messageGone: (messageId) => messageId === deleted,
    });
    const first = await installGroupMenus(channel, project(), { storeFile: file });
    expect(first.entryMessageId).toBe('om_1');
    expect(calls.entryCreates).toBe(1);
    expect(calls.menuCreates).toHaveLength(1);

    deleted = first.entryMessageId;
    const second = await installGroupMenus(channel, project(), { storeFile: file });
    expect(second.status).toBe('installed');
    expect(second.entryMessageId).not.toBe(first.entryMessageId);
    expect(calls.entryCreates).toBe(2);
    // Same message position -> the link is unchanged, so the existing owned
    // menus are adopted instead of being deleted and recreated.
    expect(calls.menuCreates).toHaveLength(1);
    expect(calls.menuDeletes).toHaveLength(0);
    expect(menus).toHaveLength(3);
    expect((await readGroupMenuState('oc_1', file))?.entryMessageId).toBe(second.entryMessageId);
  });

  it('retries the transient cardid-not-ready create exactly like run cards', async () => {
    const file = await storeFile();
    const { channel, calls } = fakeChannel({ position: '14', cardIdNotReadyOnce: true });
    const result = await installGroupMenus(channel, project(), { storeFile: file });
    expect(result.status).toBe('installed');
    expect(calls.cardCreates).toBe(2);
    expect(calls.entryCreates).toBe(1);
  });

  it('skips joined groups unless an explicit admin repair allows them', async () => {
    const file = await storeFile();
    const { channel, calls } = fakeChannel({ position: '2' });
    expect((await installGroupMenus(channel, project({ origin: 'joined' }), { storeFile: file })).status).toBe('skipped');
    expect(calls.menuGets).toBe(0);
    expect(calls.entryCreates).toBe(0);
    const allowed = await installGroupMenus(channel, project({ origin: 'joined' }), {
      storeFile: file,
      allowJoined: true,
    });
    expect(allowed.status).toBe('installed');
  });

  it('honors an abort signal before doing any API work', async () => {
    const file = await storeFile();
    const { channel, calls } = fakeChannel({ position: '2' });
    const controller = new AbortController();
    controller.abort();
    const result = await installGroupMenus(channel, project(), { storeFile: file, signal: controller.signal });
    expect(result.status).toBe('skipped');
    expect(calls.menuGets).toBe(0);
    expect(calls.entryCreates).toBe(0);
  });
});

describe('backfillGroupMenus', () => {
  it('never auto-installs joined origin groups', async () => {
    const file = await storeFile();
    registry.projects = [project({ origin: 'joined' })];
    const { channel, calls } = fakeChannel({ position: '4' });
    const summary = await backfillGroupMenus(channel, { storeFile: file });
    expect(summary).toEqual({ scanned: 0, installed: 0, partial: 0, conflict: 0, skipped: 0 });
    expect(calls.menuGets).toBe(0);
    expect(calls.entryCreates).toBe(0);
  });

  it('backfills created projects once and reports skipped on an already-aborted signal', async () => {
    const file = await storeFile();
    registry.projects = [project()];
    const { channel, calls } = fakeChannel({ position: '6' });
    const summary = await backfillGroupMenus(channel, { storeFile: file });
    expect(summary.scanned).toBe(1);
    expect(summary.installed).toBe(1);
    expect(calls.entryCreates).toBe(1);

    const controller = new AbortController();
    controller.abort();
    const aborted = await backfillGroupMenus(channel, { storeFile: file, signal: controller.signal });
    expect(aborted.scanned).toBe(0);
  });
});
