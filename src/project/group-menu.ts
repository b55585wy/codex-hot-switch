import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { catalogById } from '../agent/catalog';
import { buildGroupControlEntryCard } from '../card/group-control-card';
import {
  adoptManagedCard,
  isManaged,
  managedCardId,
  MAX_MANAGED_CARD_SEQUENCE,
  sendManagedCard,
  updateManagedCard,
} from '../card/managed';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { listProjects, type Project } from './registry';

/**
 * Native group-menu installation for Bridge-created groups.
 *
 * Feishu exposes get/create/delete/sort for im/v1/chats/:chat_id/menu_tree but
 * no in-place update. We therefore reconcile ONLY entries this bridge owns:
 * persisted ids from the versioned state file, our exact name+link signatures,
 * and the one legacy manual entry (`🤖 <backend>` + HELP_DOC_URL) created by
 * older onboarding versions. Anything else is preserved; when it leaves fewer
 * than three top-level slots we report a conflict and change nothing.
 */

export const GROUP_MENU_STATE_VERSION = 1;
export const HELP_DOC_URL = 'https://my.feishu.cn/wiki/PZ23wGr7JiKK5RkIG4rcZXzGn5g';

export const GROUP_MENU_NAMES = {
  sessions: '会话',
  actions: '操作',
  help: '帮助',
} as const;

export interface GroupMenuTopLevel {
  chat_menu_top_level_id?: string;
  chat_menu_item?: {
    action_type?: 'NONE' | 'REDIRECT_LINK';
    name?: string;
    redirect_link?: { common_url?: string; pc_url?: string; ios_url?: string; android_url?: string; web_url?: string };
    i18n_names?: { zh_cn?: string; en_us?: string; ja_jp?: string };
    image_key?: string;
  };
  children?: unknown[];
}

export interface GroupMenuRecord {
  version: number;
  chatId: string;
  entryMessageId?: string;
  entryMessageLink?: string;
  entryCardId?: string;
  /**
   * Highest CardKit sequence already reserved for `entryCardId`. It is written
   * (atomically, before the API call) so a restart continues ABOVE it — CardKit
   * requires a positive, strictly increasing int32 per card entity and does not
   * reset its counter for a new process. Cleared only when the entity truly
   * changes (a new card_id is created/adopted).
   */
  entrySequenceHighwater?: number;
  menuIds: string[];
  status: 'installed' | 'partial' | 'conflict' | 'skipped' | 'error';
  error?: string;
  requestId?: string;
  /** Persisted BEFORE `message.create` so a crash after the send but before the
   * id is stored is retried with the same platform idempotency token. */
  entrySend?: GroupMenuEntrySend;
  pending?: {
    requestId: string;
    createdAt: number;
    entryMessageId: string;
    entryLink: string;
    names: string[];
  };
  updatedAt: number;
}

/** Feishu's message-create idempotency window is ~1h; stay comfortably inside. */
export const ENTRY_SEND_IDEMPOTENCY_WINDOW_MS = 55 * 60_000;

export interface GroupMenuEntrySend {
  uuid: string;
  createdAt: number;
}

interface GroupMenuStoreFile {
  version: number;
  groups: Record<string, GroupMenuRecord>;
}

export type GroupMenuStatus = GroupMenuRecord['status'];

export interface GroupMenuInstallResult {
  status: GroupMenuStatus;
  chatId: string;
  entryMessageId?: string;
  entryLink?: string;
  menuIds: string[];
  reason?: string;
  createdEntryCard?: boolean;
}

export interface GroupMenuInstallOptions {
  /** Explicit admin repair may install in a joined (pre-existing) group. */
  allowJoined?: boolean;
  /** Force reconciliation even when the stored state says installed. */
  force?: boolean;
  /** Install the legacy single Help menu when the native tree cannot be built
   * (missing scope / no entry link). MUST default to false: a failed menu READ
   * means the tree is unknown, so writing a menu there could duplicate or
   * overflow an existing tree. Only a caller that KNOWS the group is empty
   * (fresh onboarding) may opt in. */
  fallbackLegacyMenu?: boolean;
  backendName?: string;
  /** Test/administration seam; defaults to the current bot's state file. */
  storeFile?: string;
  signal?: AbortSignal;
}

const EMPTY_STORE: GroupMenuStoreFile = { version: GROUP_MENU_STATE_VERSION, groups: {} };

let opChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function stateFile(opts?: GroupMenuInstallOptions): string {
  return opts?.storeFile ?? paths.groupMenusFile;
}

async function readStore(file: string): Promise<GroupMenuStoreFile> {
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text) as Partial<GroupMenuStoreFile>;
    return {
      version: GROUP_MENU_STATE_VERSION,
      groups: parsed && typeof parsed.groups === 'object' && parsed.groups ? parsed.groups : {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_STORE, groups: {} };
    throw err;
  }
}

async function writeStore(file: string, store: GroupMenuStoreFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const body: GroupMenuStoreFile = { version: GROUP_MENU_STATE_VERSION, groups: store.groups };
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

function emptyRecord(chatId: string): GroupMenuRecord {
  return { version: GROUP_MENU_STATE_VERSION, chatId, menuIds: [], status: 'partial', updatedAt: Date.now() };
}

/**
 * RFC-4122-shaped token for Feishu's `message.create` idempotency field.
 *
 * It is derived from stable inputs (group + send-attempt start) AND persisted
 * before the request, so a retry after a crash reuses the exact same token and
 * the platform returns the original message instead of a duplicate. This value
 * is a request token only — never a message id.
 */
export function stableEntrySendUuid(chatId: string, createdAt: number): string {
  const hex = createHash('sha256').update(`group-menu-entry:${chatId}:${createdAt}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(12, 15)}-a${hex.slice(15, 18)}-${hex.slice(18, 30)}`;
}

/** A persisted send marker that is still inside the platform idempotency window. */
export function liveEntrySend(
  record: GroupMenuRecord | undefined,
  at = Date.now(),
): GroupMenuEntrySend | undefined {
  const marker = record?.entrySend;
  if (!marker) return undefined;
  if (at - marker.createdAt >= ENTRY_SEND_IDEMPOTENCY_WINDOW_MS) return undefined;
  return marker;
}

/** Read one group's versioned installation metadata (diagnostics/tests). */
export async function readGroupMenuState(chatId: string, storeFile?: string): Promise<GroupMenuRecord | undefined> {
  return (await readStore(storeFile ?? paths.groupMenusFile)).groups[chatId];
}

async function saveRecord(record: GroupMenuRecord, opts?: GroupMenuInstallOptions): Promise<void> {
  const file = stateFile(opts);
  await withLock(async () => {
    const store = await readStore(file);
    const existing = store.groups[record.chatId];
    const next: GroupMenuRecord = { ...record, updatedAt: Date.now() };
    // Never let an ordinary metadata write lower the persisted high-water mark:
    // a concurrent reservation may already have advanced it.
    const highwater = Math.max(existing?.entrySequenceHighwater ?? 0, record.entrySequenceHighwater ?? 0);
    if (highwater > 0) next.entrySequenceHighwater = highwater;
    else delete next.entrySequenceHighwater;
    store.groups[record.chatId] = next;
    await writeStore(file, store);
  });
}

function validHighwater(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_MANAGED_CARD_SEQUENCE
  );
}

/**
 * Atomically reserve the next CardKit sequence for this group's persistent entry
 * card and persist it BEFORE the caller sends any update. Reservations are
 * serialized through the same store lock as every other record write, so two
 * concurrent clicks (or processes) cannot allocate the same value.
 *
 * Throws if the record is missing, corrupted, or exhausted — callers must treat
 * that as "do not send the update" rather than falling back to a timestamp or
 * wrapping the int32.
 */
export async function reserveGroupEntrySequence(chatId: string, storeFile?: string): Promise<number> {
  const file = storeFile ?? paths.groupMenusFile;
  return withLock(async () => {
    const store = await readStore(file);
    const record = store.groups[chatId];
    if (!record) throw new Error(`group-menu record missing for ${chatId}`);
    const current = record.entrySequenceHighwater;
    if (current !== undefined && !validHighwater(current)) {
      throw new RangeError(`group-menu entry sequence invalid: ${String(current)}`);
    }
    const next = (current ?? 0) + 1;
    if (!validHighwater(next) || next < 1) {
      throw new RangeError(`group-menu entry sequence exhausted: ${String(current)}`);
    }
    store.groups[chatId] = { ...record, entrySequenceHighwater: next, updatedAt: Date.now() };
    await writeStore(file, store);
    return next;
  });
}

/**
 * Persist a genuinely different entry card entity. This is the ONLY operation
 * allowed to clear the high-water mark: a new card_id has its own sequence
 * counter, whereas re-adopting the same entity must continue above the old one.
 */
async function adoptGroupEntryCardEntity(chatId: string, cardId: string, storeFile?: string): Promise<void> {
  const file = storeFile ?? paths.groupMenusFile;
  await withLock(async () => {
    const store = await readStore(file);
    const record = store.groups[chatId];
    if (!record || record.entryCardId === cardId) return;
    const next: GroupMenuRecord = { ...record, entryCardId: cardId, updatedAt: Date.now() };
    delete next.entrySequenceHighwater;
    store.groups[chatId] = next;
    await writeStore(file, store);
  });
}

export function groupBackendName(project: Pick<Project, 'backend'>): string {
  return (project.backend && catalogById(project.backend)?.displayName) || 'Codex';
}

export function legacyGroupMenuName(backendName: string): string {
  return `🤖 ${backendName}`;
}

function sidebarPcUrl(url: string): string {
  return `https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&url=${encodeURIComponent(url)}`;
}

function chatMessageLink(chatId: string, position: string): string {
  const query = new URLSearchParams({ openChatId: chatId, position });
  return `https://applink.feishu.cn/client/chat/open?${query}`;
}

function validPosition(value: unknown): string | undefined {
  return value != null && /^\d+$/.test(String(value)) ? String(value) : undefined;
}

/** Feishu's raw IM response carries `message_position`; higher-level clients may
 * add `message_app_link`. Never invent a messageId URL. */
function linkFromMessage(
  chatId: string,
  data: { message_app_link?: unknown; message_position?: unknown },
): string | undefined {
  if (typeof data.message_app_link === 'string' && data.message_app_link) return data.message_app_link;
  const position = validPosition(data.message_position);
  return position ? chatMessageLink(chatId, position) : undefined;
}

class GroupMenuApiError extends Error {
  constructor(
    readonly phase: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

function apiCode(payload: unknown): number | undefined {
  const code = (payload as { code?: unknown } | undefined)?.code;
  return typeof code === 'number' ? code : undefined;
}

function assertApiOk(payload: unknown, phase: string): void {
  const code = apiCode(payload);
  if (code !== undefined && code !== 0) {
    const msg =
      (payload as { msg?: unknown } | undefined)?.msg !== undefined
        ? String((payload as { msg?: unknown }).msg)
        : 'nonzero response code';
    throw new GroupMenuApiError(phase, code, `${phase} failed: code=${code} ${msg}`);
  }
}

function abortReason(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

const MESSAGE_GONE_CODES = new Set([230002, 230003, 230001]);

function isMessageGone(err: unknown): boolean {
  const data = (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
  const direct = (err as { code?: unknown })?.code;
  const code = typeof data?.code === 'number' ? data.code : typeof direct === 'number' ? direct : undefined;
  if (code !== undefined) return MESSAGE_GONE_CODES.has(code);
  return /not\s*found|deleted|不存在|已删除/i.test(data?.msg ?? (err instanceof Error ? err.message : ''));
}

async function getMenuTree(
  channel: LarkChannel,
  chatId: string,
  phase: string,
): Promise<GroupMenuTopLevel[]> {
  const res = await channel.rawClient.im.v1.chatMenuTree.get({ path: { chat_id: chatId } });
  assertApiOk(res, phase);
  return res.data?.menu_tree?.chat_menu_top_levels ?? [];
}

async function createLegacyHelpMenu(
  channel: LarkChannel,
  project: Project,
  backendName: string,
  opts: GroupMenuInstallOptions = {},
): Promise<GroupMenuInstallResult> {
  const name = legacyGroupMenuName(backendName);
  let ids: string[] = [];
  try {
    const res = await channel.rawClient.im.v1.chatMenuTree.create({
      path: { chat_id: project.chatId },
      data: {
        menu_tree: {
          chat_menu_top_levels: [
            {
              chat_menu_item: {
                action_type: 'REDIRECT_LINK',
                name,
                redirect_link: { common_url: HELP_DOC_URL, pc_url: sidebarPcUrl(HELP_DOC_URL) },
              },
            },
          ],
        },
      },
    });
    assertApiOk(res, 'legacy-menu-create');
    ids = extractIds(res.data?.menu_tree?.chat_menu_top_levels, [{ name, url: HELP_DOC_URL }]);
    log.info('project', 'legacy-help-menu', { chatId: project.chatId.slice(-6), name });
  } catch (err) {
    log.fail('project', err, { phase: 'legacy-help-menu' });
    return {
      status: 'partial',
      chatId: project.chatId,
      menuIds: [],
      reason: errorReason(err),
    };
  }
  // Persist the ids we just created. Without this marker a later pass that also
  // cannot read the tree would blindly create a second legacy menu.
  const store = await readStore(stateFile(opts)).catch(() => ({ ...EMPTY_STORE, groups: {} as GroupMenuStoreFile['groups'] }));
  const record = store.groups[project.chatId] ?? emptyRecord(project.chatId);
  await saveRecord(
    { ...record, status: 'partial', error: 'legacy-help-only', menuIds: ids },
    opts,
  ).catch((err) => log.fail('project', err, { phase: 'legacy-help-menu-save' }));
  return { status: 'partial', chatId: project.chatId, menuIds: ids, reason: 'legacy-help-only' };
}

function errorReason(err: unknown): string {
  if (err instanceof GroupMenuApiError) return `${err.phase}: ${err.code ?? 'nonzero'}`;
  return err instanceof Error ? err.message : String(err);
}

function cardIdFromContent(content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined;
  try {
    const parsed = JSON.parse(content) as { type?: string; data?: { card_id?: string } };
    return parsed?.type === 'card' && typeof parsed.data?.card_id === 'string' ? parsed.data.card_id : undefined;
  } catch {
    return undefined;
  }
}

async function inspectEntryMessage(
  channel: LarkChannel,
  chatId: string,
  messageId: string,
): Promise<{ state: 'exists' | 'gone' | 'unknown'; link?: string; cardId?: string }> {
  try {
    const res = await channel.rawClient.im.v1.message.get({ path: { message_id: messageId } });
    const code = apiCode(res);
    if (code !== undefined && code !== 0) {
      return { state: MESSAGE_GONE_CODES.has(code) ? 'gone' : 'unknown' };
    }
    const item = (res as {
      data?: {
        items?: Array<{
          message_app_link?: unknown;
          message_position?: unknown;
          chat_id?: string;
          body?: { content?: unknown };
        }>;
      };
    }).data?.items?.[0];
    if (!item) return { state: 'gone' };
    return {
      state: 'exists',
      link: linkFromMessage(item.chat_id ?? chatId, item),
      cardId: cardIdFromContent(item.body?.content),
    };
  } catch (err) {
    return { state: isMessageGone(err) ? 'gone' : 'unknown' };
  }
}

async function sendEntryCard(
  channel: LarkChannel,
  project: Project,
  backendName: string,
  opts: { uuid?: string } = {},
): Promise<{ messageId: string; link?: string; cardId?: string }> {
  const card = buildGroupControlEntryCard({ projectName: project.name, backendName });
  // Prefer a CardKit entity so the persistent entry card can be re-adopted after
  // a restart. If CardKit is unavailable, a plain interactive card still routes
  // its button callbacks by action id.
  try {
    const sent = await sendManagedCard(channel, project.chatId, card, undefined, false, 'chat_id', opts);
    const inspected = await inspectEntryMessage(channel, project.chatId, sent.messageId);
    // A platform-idempotent replay returns the ORIGINAL message, which still
    // references the card entity from the first attempt — not the one created
    // just now. Trust the message body over our fresh create result.
    const cardId = inspected.cardId ?? sent.cardId;
    if (inspected.cardId && inspected.cardId !== sent.cardId) {
      adoptManagedCard(sent.messageId, inspected.cardId);
    }
    return { messageId: sent.messageId, cardId, ...(inspected.link ? { link: inspected.link } : {}) };
  } catch (err) {
    log.fail('project', err, { phase: 'entry-card-managed', retry: true });
  }
  const res = await channel.rawClient.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: project.chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
      ...(opts.uuid ? { uuid: opts.uuid } : {}),
    },
  });
  assertApiOk(res, 'entry-card-create');
  const data = (res as { data?: { message_id?: string; message_app_link?: string; message_position?: string } }).data;
  const messageId = data?.message_id;
  if (!messageId) throw new GroupMenuApiError('entry-card-create', undefined, 'entry card returned no message_id');
  return { messageId, link: linkFromMessage(project.chatId, data ?? {}) };
}

/**
 * Re-render the persistent entry card IN PLACE so its buttons carry a fresh
 * `__r` callback token.
 *
 * The node-sdk SafetyPipeline dedupes a card action on
 * `messageId + openId + element + value` for 12h. A long-lived entry card whose
 * buttons never change therefore only works once per user per process; every
 * later click hashes to the key already recorded and is silently dropped. After
 * handling an entry-card click we push a new render of the same entity: the
 * next, genuinely new click presents a new value and fires, while a redelivery
 * of the click already handled keeps its original value and stays deduped.
 *
 * Returns false when the message is not our persisted entry card, or when no
 * CardKit entity can be resolved (plain-JSON fallback: callbacks still work, but
 * only the first click per value can be delivered).
 */
export async function refreshGroupEntryCard(
  channel: LarkChannel,
  project: Project,
  opts: { messageId: string; backendName?: string; storeFile?: string },
): Promise<boolean> {
  const record = await readGroupMenuState(project.chatId, opts.storeFile);
  if (!record?.entryMessageId || record.entryMessageId !== opts.messageId) return false;
  // Prefer the live in-process mapping (it may already hold a newer entity than
  // the last record write); on a fresh process inspect the message body.
  let cardId = managedCardId(opts.messageId) ?? record.entryCardId;
  if (!cardId || !isManaged(opts.messageId)) {
    const inspected = await inspectEntryMessage(channel, project.chatId, opts.messageId);
    if (inspected.cardId) cardId = inspected.cardId;
  }
  if (!cardId) {
    log.info('project', 'entry-card-rotate-unavailable', { chatId: project.chatId.slice(-6) });
    return false;
  }
  // Re-adopt from the persisted entity id: after a restart the in-process
  // message→card map is empty, but the entity (and its click surface) lives on.
  // Only a genuinely different card_id may reset the sequence; otherwise restore
  // the persisted high-water mark so the next push is strictly greater.
  const entityChanged = Boolean(record.entryCardId && record.entryCardId !== cardId);
  if (entityChanged) {
    await adoptGroupEntryCardEntity(project.chatId, cardId, opts.storeFile).catch((err) =>
      log.fail('project', err, { phase: 'group-entry-entity-save' }),
    );
    adoptManagedCard(opts.messageId, cardId);
  } else {
    adoptManagedCard(opts.messageId, cardId, { sequence: record.entrySequenceHighwater });
  }
  const card = buildGroupControlEntryCard({
    projectName: project.name,
    backendName: opts.backendName ?? groupBackendName(project),
  });
  // Persistent entry updates must reserve from the persisted record before each
  // API push (including retries); an allocator failure fails closed.
  const ok = await updateManagedCard(channel, opts.messageId, card, {
    reserveSequence: () => reserveGroupEntrySequence(project.chatId, opts.storeFile),
  });
  if (!ok) log.info('project', 'entry-card-rotate-failed', { chatId: project.chatId.slice(-6) });
  return ok;
}

interface ExpectedMenu {
  name: string;
  url: string;
}

function expectedMenus(entryLink: string): ExpectedMenu[] {
  return [
    { name: GROUP_MENU_NAMES.sessions, url: entryLink },
    { name: GROUP_MENU_NAMES.actions, url: entryLink },
    { name: GROUP_MENU_NAMES.help, url: HELP_DOC_URL },
  ];
}

function itemName(item: GroupMenuTopLevel['chat_menu_item']): string | undefined {
  return item?.name ?? item?.i18n_names?.zh_cn ?? item?.i18n_names?.en_us;
}

function matches(item: GroupMenuTopLevel['chat_menu_item'], expected: ExpectedMenu): boolean {
  return itemName(item) === expected.name && item?.redirect_link?.common_url === expected.url;
}

function topId(top: GroupMenuTopLevel): string | undefined {
  return top.chat_menu_top_level_id;
}

function extractIds(
  top: GroupMenuTopLevel[] | undefined,
  expected: ExpectedMenu[],
): string[] {
  if (!Array.isArray(top)) return [];
  const ids: string[] = [];
  for (const item of top) {
    if (expected.some((menu) => matches(item.chat_menu_item, menu))) {
      const id = topId(item);
      if (id) ids.push(id);
    }
  }
  return ids;
}

function menuPayload(expected: ExpectedMenu[]): {
  chat_menu_top_levels: Array<{
    chat_menu_item: {
      action_type: 'REDIRECT_LINK';
      name: string;
      redirect_link: { common_url: string; pc_url: string };
    };
  }>;
} {
  return {
    chat_menu_top_levels: expected.map((menu) => ({
      chat_menu_item: {
        action_type: 'REDIRECT_LINK',
        name: menu.name,
        redirect_link: {
          common_url: menu.url,
          pc_url: menu.url === HELP_DOC_URL ? sidebarPcUrl(HELP_DOC_URL) : menu.url,
        },
      },
    })),
  };
}

/**
 * Ownership of a top-level entry is proven by an EXACT name+link signature, not
 * by a stored id. A stored id whose menu the user renamed or replaced in the
 * Feishu UI no longer identifies our entry; deleting it would destroy user work.
 * References to previous links are kept because a repaired entry card may move
 * its message position, which changes the Sessions/Actions link.
 */
function ownedSignatures(record: GroupMenuRecord, backendName: string): ExpectedMenu[] {
  const signatures: ExpectedMenu[] = [];
  for (const link of [record.entryMessageLink, record.pending?.entryLink]) {
    if (link) signatures.push(...expectedMenus(link));
  }
  signatures.push({ name: legacyGroupMenuName(backendName), url: HELP_DOC_URL });
  return signatures;
}

/**
 * Install/repair the three native menus and the persistent entry card for one
 * group. Existing unrelated top-level menus are never deleted or overwritten.
 */
export async function installGroupMenus(
  channel: LarkChannel,
  project: Project,
  opts: GroupMenuInstallOptions = {},
): Promise<GroupMenuInstallResult> {
  const backendName = opts.backendName ?? groupBackendName(project);
  if ((project.origin ?? 'created') === 'joined' && !opts.allowJoined) {
    return { status: 'skipped', chatId: project.chatId, menuIds: [], reason: 'joined-origin' };
  }
  if (!project.chatId) {
    return { status: 'error', chatId: project.chatId, menuIds: [], reason: 'missing chatId' };
  }
  if (abortReason(opts.signal)) {
    return { status: 'skipped', chatId: project.chatId, menuIds: [], reason: 'aborted' };
  }

  const file = stateFile(opts);
  let record = (await readStore(file)).groups[project.chatId] ?? emptyRecord(project.chatId);

  let top: GroupMenuTopLevel[];
  try {
    top = await getMenuTree(channel, project.chatId, 'menu-get');
  } catch (err) {
    log.fail('project', err, { phase: 'group-menu-get', chatId: project.chatId.slice(-6) });
    // Never guess: a failed READ means the tree is unknown, so no write is safe
    // here (a blind legacy create could duplicate an existing menu or overflow
    // an existing tree). Fall back only when the caller explicitly attests that
    // the group is known-empty (fresh onboarding).
    if (opts.fallbackLegacyMenu === true) {
      if (record.entryMessageId || record.menuIds.length > 0 || record.status === 'installed') {
        return {
          status: 'partial',
          chatId: project.chatId,
          entryMessageId: record.entryMessageId,
          entryLink: record.entryMessageLink,
          menuIds: record.menuIds,
          reason: `menu-tree-unavailable: ${errorReason(err)}`,
        };
      }
      return createLegacyHelpMenu(channel, project, backendName, opts);
    }
    return {
      status: 'partial',
      chatId: project.chatId,
      entryMessageId: record.entryMessageId,
      entryLink: record.entryMessageLink,
      menuIds: record.menuIds,
      reason: `menu-tree-unavailable: ${errorReason(err)}`,
    };
  }
  if (abortReason(opts.signal)) {
    return { status: 'skipped', chatId: project.chatId, menuIds: [], reason: 'aborted' };
  }

  const ownedBefore = ownedSignatures(record, backendName);
  const uniqueOwned = new Set<string>();
  const renamedStored: string[] = [];
  for (const item of top) {
    const id = topId(item);
    if (!id) continue;
    if (ownedBefore.some((menu) => matches(item.chat_menu_item, menu))) {
      uniqueOwned.add(id);
      continue;
    }
    // A stored id that no longer carries our exact name+link signature means the
    // user renamed or replaced that menu. Never delete it; the capacity check
    // below reports a safe conflict instead.
    if (record.menuIds.includes(id)) renamedStored.push(id);
  }
  if (renamedStored.length > 0) {
    log.info('project', 'group-menu-id-signature-mismatch', {
      chatId: project.chatId.slice(-6),
      ids: renamedStored.length,
    });
  }
  const unrelated = top.filter((item) => {
    const id = topId(item);
    return !id || !uniqueOwned.has(id);
  });
  if (unrelated.length > 0) {
    const names = unrelated.map((item) => itemName(item.chat_menu_item) ?? topId(item) ?? '?').join('、');
    const result: GroupMenuInstallResult = {
      status: 'conflict',
      chatId: project.chatId,
      entryMessageId: record.entryMessageId,
      entryLink: record.entryMessageLink,
      menuIds: [...uniqueOwned],
      reason: `top-level menu capacity conflict; preserved unrelated menus: ${names}`,
    };
    await saveRecord({ ...record, status: 'conflict', error: result.reason, menuIds: [...uniqueOwned] }, opts).catch((err) =>
      log.fail('project', err, { phase: 'group-menu-save-conflict' }),
    );
    log.info('project', 'group-menu-conflict', { chatId: project.chatId.slice(-6), unrelated: unrelated.length });
    return result;
  }

  // Entry card: reuse the stable message id whenever it still exists. A deleted
  // entry is repaired by creating exactly one replacement (never by touching
  // unrelated group resources). Existing CardKit entities are re-adopted after
  // a process restart so callbacks/updates can target them again.
  let entryMessageId = record.entryMessageId;
  let entryLink = record.entryMessageLink;
  let entryCardId = record.entryCardId;
  let createdEntryCard = false;
  let entryInspected: Awaited<ReturnType<typeof inspectEntryMessage>> | undefined;
  /** A different card_id is the ONLY reason to reset the persisted high-water. */
  const adoptEntryEntity = async (messageId: string, cardId: string): Promise<void> => {
    const entityChanged = Boolean(record.entryCardId && record.entryCardId !== cardId);
    if (entityChanged) {
      record = { ...record, entryCardId: cardId, entrySequenceHighwater: undefined };
      await adoptGroupEntryCardEntity(project.chatId, cardId, opts.storeFile).catch((err) =>
        log.fail('project', err, { phase: 'group-entry-entity-save' }),
      );
      adoptManagedCard(messageId, cardId);
      return;
    }
    adoptManagedCard(messageId, cardId, { sequence: record.entrySequenceHighwater });
  };
  if (entryMessageId) {
    entryInspected = await inspectEntryMessage(channel, project.chatId, entryMessageId);
    if (entryInspected.state === 'gone') {
      entryMessageId = undefined;
      entryLink = undefined;
      entryCardId = undefined;
      entryInspected = undefined;
    } else {
      if (!entryLink && entryInspected.link) entryLink = entryInspected.link;
      if (entryInspected.cardId) {
        entryCardId = entryInspected.cardId;
        await adoptEntryEntity(entryMessageId, entryInspected.cardId);
      }
    }
  }
  if (!entryMessageId) {
    // Persist the platform idempotency token BEFORE the send: a crash after
    // Feishu created the message but before we stored its id would otherwise
    // produce a second persistent entry card on the next pass. A live token is
    // reused (the platform answers with the ORIGINAL message); past the ~1h
    // window a fresh token is minted.
    const live = liveEntrySend(record);
    const createdAt = Date.now();
    const entrySend: GroupMenuEntrySend = live ?? { uuid: stableEntrySendUuid(project.chatId, createdAt), createdAt };
    if (!live) {
      record = { ...record, entrySend };
      await saveRecord(record, opts);
    }
    try {
      const sent = await sendEntryCard(channel, project, backendName, { uuid: entrySend.uuid });
      entryMessageId = sent.messageId;
      entryLink = sent.link;
      entryCardId = sent.cardId;
      createdEntryCard = true;
      // A brand-new entity may start its sequence again; the previous card's
      // high-water mark must not leak into it (and must never be cleared for a
      // mere re-adoption of the same entity).
      record = { ...record, entrySequenceHighwater: undefined };
      if (entryCardId) {
        await adoptGroupEntryCardEntity(project.chatId, entryCardId, opts.storeFile).catch((err) =>
          log.fail('project', err, { phase: 'group-entry-entity-save' }),
        );
      }
      // Persist the id immediately so the next process re-adopts this exact
      // entity instead of sending another card.
      record = {
        ...record,
        entrySend: undefined,
        entryMessageId,
        entryMessageLink: entryLink,
        entryCardId,
      };
      await saveRecord(record, opts).catch((err) =>
        log.fail('project', err, { phase: 'group-menu-entry-save' }),
      );
    } catch (err) {
      const result: GroupMenuInstallResult = {
        status: 'partial',
        chatId: project.chatId,
        menuIds: [...uniqueOwned],
        reason: `entry-card-unavailable: ${errorReason(err)}`,
      };
      await saveRecord(
        {
          ...record,
          status: 'partial',
          error: result.reason,
          menuIds: [...uniqueOwned],
          entryMessageId: undefined,
          entryMessageLink: undefined,
          entryCardId: undefined,
        },
        opts,
      ).catch(() => undefined);
      if (opts.fallbackLegacyMenu === true && uniqueOwned.size === 0) {
        return createLegacyHelpMenu(channel, project, backendName, opts);
      }
      return result;
    }
  }
  if (!entryLink) {
    entryInspected = await inspectEntryMessage(channel, project.chatId, entryMessageId);
    entryLink = entryInspected.link;
    if (entryInspected.cardId && entryMessageId) {
      entryCardId = entryInspected.cardId;
      await adoptEntryEntity(entryMessageId, entryInspected.cardId);
    }
  }
  if (!entryLink) {
    const result: GroupMenuInstallResult = {
      status: 'partial',
      chatId: project.chatId,
      entryMessageId,
      menuIds: [...uniqueOwned],
      reason: 'entry-link-unavailable; use /controls fallback',
      createdEntryCard,
    };
    await saveRecord(
      {
        ...record,
        status: 'partial',
        error: result.reason,
        entryMessageId,
        entryMessageLink: undefined,
        entryCardId,
        menuIds: [...uniqueOwned],
      },
      opts,
    ).catch(() => undefined);
    if (opts.fallbackLegacyMenu === true && uniqueOwned.size === 0) {
      return createLegacyHelpMenu(channel, project, backendName, opts);
    }
    return result;
  }

  const expected = expectedMenus(entryLink);

  // Recovery: a previous process may have created the menus but crashed before
  // persisting their ids. Adopt them only when all three exact signatures match
  // the pending request's entry link; otherwise reinstall our own entries.
  const currentThree = top.filter((item) => expected.some((menu) => matches(item.chat_menu_item, menu)));
  if (
    currentThree.length === 3 &&
    top.every((item) => {
      const id = topId(item);
      return Boolean(id && uniqueOwned.has(id));
    })
  ) {
    const ids = currentThree.map(topId).filter((id): id is string => Boolean(id));
    const recordNext: GroupMenuRecord = {
      ...record,
      status: 'installed',
      error: undefined,
      entryMessageId,
      entryMessageLink: entryLink,
      entryCardId,
      menuIds: ids,
      pending: undefined,
      requestId: undefined,
    };
    if (!opts.force) {
      await saveRecord(recordNext, opts);
      if (createdEntryCard) log.info('project', 'group-menu-entry-repaired', { chatId: project.chatId.slice(-6) });
      return {
        status: 'installed',
        chatId: project.chatId,
        entryMessageId,
        entryLink,
        menuIds: ids,
        createdEntryCard,
      };
    }
  }

  // Remove only owned entries. No update API exists, so this is the "update"
  // path; unrelated menus were proven absent above.
  const ownedIds = [...uniqueOwned].filter((id) => top.some((item) => topId(item) === id));
  if (ownedIds.length > 0) {
    try {
      const res = await channel.rawClient.im.v1.chatMenuTree.delete({
        path: { chat_id: project.chatId },
        data: { chat_menu_top_level_ids: ownedIds },
      });
      assertApiOk(res, 'menu-delete');
    } catch (err) {
      const result: GroupMenuInstallResult = {
        status: 'partial',
        chatId: project.chatId,
        entryMessageId,
        entryLink,
        menuIds: ownedIds,
        reason: `menu-delete-failed: ${errorReason(err)}`,
        createdEntryCard,
      };
      await saveRecord(
        {
          ...record,
          status: 'partial',
          error: result.reason,
          entryMessageId,
          entryMessageLink: entryLink,
          entryCardId,
          menuIds: ownedIds,
        },
        opts,
      ).catch(() => undefined);
      return result;
    }
  }
  if (abortReason(opts.signal)) {
    return { status: 'skipped', chatId: project.chatId, menuIds: [], reason: 'aborted' };
  }

  const requestId = randomUUID();
  const pendingRecord: GroupMenuRecord = {
    ...record,
    status: 'partial',
    error: undefined,
    entryMessageId,
    entryMessageLink: entryLink,
    entryCardId,
    menuIds: [],
    requestId,
    pending: {
      requestId,
      createdAt: Date.now(),
      entryMessageId,
      entryLink,
      names: expected.map((menu) => menu.name),
    },
  };
  // Persist the request marker BEFORE the mutation so a crash after Feishu
  // applied the create can be adopted on the next startup by exact signature.
  await saveRecord(pendingRecord, opts);

  try {
    const res = await channel.rawClient.im.v1.chatMenuTree.create({
      path: { chat_id: project.chatId },
      data: { menu_tree: menuPayload(expected) },
    });
    assertApiOk(res, 'menu-create');
    let ids = extractIds(res.data?.menu_tree?.chat_menu_top_levels, expected);
    if (ids.length !== 3) {
      const after = await getMenuTree(channel, project.chatId, 'menu-get-after-create').catch(() => []);
      ids = extractIds(after, expected);
    }
    if (ids.length !== 3) {
      const result: GroupMenuInstallResult = {
        status: 'partial',
        chatId: project.chatId,
        entryMessageId,
        entryLink,
        menuIds: ids,
        reason: 'menu ids incomplete after create',
        createdEntryCard,
      };
      await saveRecord(
        { ...pendingRecord, status: 'partial', error: result.reason, menuIds: ids, pending: undefined },
        opts,
      ).catch(() => undefined);
      return result;
    }
    const recordNext: GroupMenuRecord = {
      ...pendingRecord,
      status: 'installed',
      error: undefined,
      menuIds: ids,
      pending: undefined,
      requestId: undefined,
    };
    await saveRecord(recordNext, opts);
    log.info('project', 'group-menu-installed', {
      chatId: project.chatId.slice(-6),
      menus: ids.length,
      repaired: createdEntryCard,
    });
    return { status: 'installed', chatId: project.chatId, entryMessageId, entryLink, menuIds: ids, createdEntryCard };
  } catch (err) {
    // Feishu may have applied the create even though the client saw an error;
    // adopt exact signatures instead of creating a duplicate next time.
    const after = await getMenuTree(channel, project.chatId, 'menu-get-after-error').catch(() => []);
    const adopted = extractIds(after, expected);
    if (adopted.length === 3) {
      const recordNext: GroupMenuRecord = {
        ...pendingRecord,
        status: 'installed',
        error: undefined,
        menuIds: adopted,
        pending: undefined,
        requestId: undefined,
      };
      await saveRecord(recordNext, opts).catch(() => undefined);
      return {
        status: 'installed',
        chatId: project.chatId,
        entryMessageId,
        entryLink,
        menuIds: adopted,
        createdEntryCard,
      };
    }
    const result: GroupMenuInstallResult = {
      status: 'partial',
      chatId: project.chatId,
      entryMessageId,
      entryLink,
      menuIds: adopted,
      reason: `menu-create-failed: ${errorReason(err)}`,
      createdEntryCard,
    };
    await saveRecord(
      { ...pendingRecord, status: 'partial', error: result.reason, menuIds: adopted },
      opts,
    ).catch(() => undefined);
    log.fail('project', err, { phase: 'group-menu-create', chatId: project.chatId.slice(-6) });
    return result;
  }
}

export interface GroupMenuBackfillResult {
  scanned: number;
  installed: number;
  partial: number;
  conflict: number;
  skipped: number;
}

/**
 * One bounded, sequential pass over existing Bridge-created projects after the
 * channel connects. Never resends welcome cards/pins; only the owned entry card
 * and native menus are repaired. Any failure is diagnostic and nonfatal.
 */
export async function backfillGroupMenus(
  channel: LarkChannel,
  opts: { signal?: AbortSignal; storeFile?: string; limit?: number; backendName?: (project: Project) => string } = {},
): Promise<GroupMenuBackfillResult> {
  const summary: GroupMenuBackfillResult = { scanned: 0, installed: 0, partial: 0, conflict: 0, skipped: 0 };
  const projects = await listProjects().catch((err) => {
    log.fail('project', err, { phase: 'group-menu-backfill-list' });
    return [] as Project[];
  });
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  for (const project of projects) {
    if (opts.signal?.aborted) break;
    if ((project.origin ?? 'created') === 'joined') continue;
    if (!project.chatId) continue;
    if (summary.scanned >= limit) break;
    summary.scanned += 1;
    try {
      const result = await installGroupMenus(channel, project, {
        signal: opts.signal,
        storeFile: opts.storeFile,
        fallbackLegacyMenu: false,
        backendName: opts.backendName?.(project),
      });
      if (result.status === 'installed') summary.installed += 1;
      else if (result.status === 'conflict') summary.conflict += 1;
      else if (result.status === 'skipped') summary.skipped += 1;
      else summary.partial += 1;
      log.info('project', 'group-menu-backfill', {
        chatId: project.chatId.slice(-6),
        status: result.status,
        reason: result.reason,
      });
    } catch (err) {
      summary.partial += 1;
      log.fail('project', err, { phase: 'group-menu-backfill', chatId: project.chatId.slice(-6) });
    }
  }
  return summary;
}
