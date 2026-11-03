import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import { serializeRuntimeCard } from './runtime-card-icons';

/**
 * Button-driven cards must be **CardKit 2.0 entities**, not raw interactive
 * JSON. `im.v1.message.patch` (what `channel.updateCard` does) silently no-ops
 * on a card sent as plain JSON via `channel.send({ card })` — the click just
 * flashes and reverts. So any card a user clicks to mutate in place goes
 * through here: create an entity → send a message that references it by
 * `card_id` → update the entity via `cardkit.v1.card.update` (monotonic
 * `sequence` so the server can't reorder/drop updates).
 */

interface ManagedEntry {
  cardId: string;
  sequence: number;
}

/**
 * CardKit's whole-card `card.update` sequence is an int32 in [1, 2147483647]
 * and must be strictly increasing for one card entity. Never wrap (or derive it
 * from a timestamp — `Date.now()` is already far outside int32).
 */
export const MAX_MANAGED_CARD_SEQUENCE = 2_147_483_647;

function isPositiveSequence(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_MANAGED_CARD_SEQUENCE
  );
}

function restoredSequence(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_MANAGED_CARD_SEQUENCE
    ? value
    : 0;
}

// Per-process; lost on restart, which is fine — a stale card just stops being
// updatable and the user re-triggers the flow to mint a fresh one. Persistent
// entry cards restore the persisted high-water mark through `adoptManagedCard`.
const byMessageId = new Map<string, ManagedEntry>();

// The node-sdk dedups card-action callbacks for 12h keyed on
// `card:${messageId}:${openId}:${tag|name|option|value}` (SafetyPipeline /
// cardActionId), to swallow Feishu's re-deliveries of one click. But a console
// that updates ONE message in place reuses its messageId across every view, so
// a *second* click of any button whose value is unchanged (a cycle toggle, or
// 返回/设置 revisited) hashes to the same key and gets dropped — the click does
// nothing. We defeat that by stamping a fresh per-render token into every
// callback value: each (re)render gives its buttons new values, so a re-click
// after the card re-renders is a new key (fires), while a true re-delivery of
// the *same* rendered click keeps the same token (still deduped). Picked a
// `__r` key with sigils so it can't collide with real payload fields, and it
// stays well within cardActionId's 128-char value window.
//
// The counter is seeded with a per-process nonce: the SDK dedupe cache is
// in-memory, so after a restart the same persisted card is clickable again —
// and a counter restarting at 1 would immediately re-render the exact value the
// first post-restart click used, making the second click hash to the key that
// was just recorded. A process-unique prefix keeps every rotated value new.
let renderToken = 0;
const renderNonce = Math.random().toString(36).slice(2, 8);
function stampRenderToken(card: object): void {
  const token = `${renderNonce}${(++renderToken).toString(36)}`;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const behaviors = obj.behaviors;
    if (Array.isArray(behaviors)) {
      for (const b of behaviors) {
        if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'callback') {
          const v = (b as { value?: unknown }).value;
          if (v && typeof v === 'object') (v as Record<string, unknown>).__r = token;
        }
      }
    }
    for (const k of Object.keys(obj)) visit(obj[k]);
  };
  visit(card);
}

export interface ManagedCardSendResult {
  messageId: string;
  cardId: string;
}

export interface ManagedCardSendOptions {
  /**
   * Feishu message-create idempotency token (server window ≈ 1h). Callers that
   * must survive "sent, then crashed before persisting the message id" persist a
   * stable token BEFORE sending and reuse it on the retry so the platform
   * returns the original message instead of creating a duplicate. Feishu's
   * idempotent replay returns the ORIGINAL message (and its original card_id),
   * so callers must re-inspect the message rather than trust a freshly created
   * entity. Never set this from (or as) a message id.
   */
  uuid?: string;
}

/**
 * Create a CardKit entity and send a message referencing it. With `replyTo`
 * the card threads under the triggering message (im.v1.message.reply);
 * otherwise it posts top-level to `to`. Pass `replyInThread` when the
 * triggering message lives in a topic and the card should stay in it. Set
 * `receiveIdType: 'open_id'` (and pass an open_id as `to`) to DM a user
 * directly — Feishu opens/uses the p2p chat — used to send the bind card to the
 * admin who added the bot to a group. Ignored when `replyTo` is set.
 */
/**
 * A just-created CardKit entity occasionally hasn't propagated when the message
 * that references it is sent — Feishu 400s with 230099 / ErrCode 11310 "cardid
 * is invalid", so the card silently fails to appear (intermittent). Only this
 * transient is safe to retry: Feishu rejected the message outright, so nothing
 * was created (no duplicate on resend). Genuine errors and network losses (where
 * a message MAY have been created) are NOT matched, so they never duplicate.
 */
export function isCardIdNotReady(err: unknown): boolean {
  const data = (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
  return data?.code === 230099 || /11310|cardid is invalid/i.test(data?.msg ?? '');
}

export async function sendManagedCard(
  channel: LarkChannel,
  to: string,
  card: object,
  replyTo?: string,
  replyInThread = false,
  receiveIdType: 'chat_id' | 'open_id' = 'chat_id',
  opts: ManagedCardSendOptions = {},
): Promise<ManagedCardSendResult> {
  stampRenderToken(card);
  const data = await serializeRuntimeCard(card, channel.rawClient);

  // One attempt = create the entity + send the message that references it.
  const attempt = async (): Promise<ManagedCardSendResult> => {
    const created = await channel.rawClient.cardkit.v1.card.create({ data: { type: 'card_json', data } });
    const cardId = (created as { data?: { card_id?: string } }).data?.card_id;
    if (!cardId) {
      throw new Error(`cardkit.card.create returned no card_id: ${JSON.stringify(created).slice(0, 200)}`);
    }
    const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
    let messageId: string | undefined;
    if (replyTo) {
      const sent = await channel.rawClient.im.v1.message.reply({
        path: { message_id: replyTo },
        data: { msg_type: 'interactive', content, reply_in_thread: replyInThread, ...(opts.uuid ? { uuid: opts.uuid } : {}) },
      });
      messageId = (sent as { data?: { message_id?: string } }).data?.message_id;
    } else {
      const sent = await channel.rawClient.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: to, msg_type: 'interactive', content, ...(opts.uuid ? { uuid: opts.uuid } : {}) },
      });
      messageId = (sent as { data?: { message_id?: string } }).data?.message_id;
    }
    if (!messageId) {
      throw new Error('send card-by-reference returned no message_id');
    }
    byMessageId.set(messageId, { cardId, sequence: 0 });
    return { messageId, cardId };
  };

  // Re-create + resend with a short backoff while the entity is still
  // propagating; bail to the real error on anything else.
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= 2 || !isCardIdNotReady(err)) throw err;
      log.fail('card', err, { phase: 'managed-send', attempt: i, retry: true });
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}

export interface ManagedCardUpdateOptions {
  /**
   * Reserve the next sequence before each API push (including the retry). A
   * persistent entry card is shared across processes, so its allocator must
   * atomically persist the new high-water mark before the update is sent; if
   * this rejects, no API call is made. Callers that omit it keep the old
   * per-process auto-increment behaviour.
   */
  reserveSequence?: () => Promise<number>;
}

type PushResult =
  | { ok: true }
  | { ok: false; stage: 'reserve' | 'update' | 'response'; err: unknown };

/**
 * Replace the whole card of a managed entity, keyed by the messageId that
 * carries it. Returns false (and logs) if we have no mapping — caller can fall
 * back to a fresh card.
 *
 * Sequence is always reserved (and validated as a positive int32) BEFORE the
 * API call. A reserve failure or an exhausted range fails closed without any
 * API call. A thrown transport error or a resolved response with a nonzero
 * `code` is a failure; it is retried once, and that retry reserves a fresh
 * sequence first.
 */
export async function updateManagedCard(
  channel: LarkChannel,
  messageId: string,
  card: object,
  opts: ManagedCardUpdateOptions = {},
): Promise<boolean> {
  const entry = byMessageId.get(messageId);
  if (!entry) {
    // The silent failure that made "返回菜单又没用了" invisible: no mapping (e.g.
    // the card was sent before a restart — byMessageId is per-process). Log it
    // so the diagnosis isn't a black box; caller may fall back to a fresh card.
    log.info('card', 'managed-update-no-entry', { messageId, known: byMessageId.size });
    return false;
  }
  stampRenderToken(card);
  const data = await serializeRuntimeCard(card, channel.rawClient);

  const push = async (): Promise<PushResult> => {
    let sequence: number;
    try {
      if (opts.reserveSequence) {
        const allocated = await opts.reserveSequence();
        if (!isPositiveSequence(allocated)) {
          throw new RangeError(`managed-card sequence outside int32 range: ${String(allocated)}`);
        }
        // Never let an in-process mapping rewind, even if a stale allocator is
        // supplied. Sending a lower value would be rejected by CardKit anyway.
        if (allocated <= entry.sequence) {
          throw new RangeError(`managed-card sequence would rewind: ${allocated} <= ${entry.sequence}`);
        }
        sequence = allocated;
      } else {
        const next = entry.sequence + 1;
        if (!isPositiveSequence(next)) {
          throw new RangeError(`managed-card sequence exhausted: ${entry.sequence}`);
        }
        sequence = next;
      }
    } catch (err) {
      return { ok: false, stage: 'reserve', err };
    }

    // Advance the in-process high-water mark before I/O so a failed push can
    // never make a later push reuse the same sequence.
    entry.sequence = sequence;
    let response: unknown;
    try {
      response = await channel.rawClient.cardkit.v1.card.update({
        path: { card_id: entry.cardId },
        data: { card: { type: 'card_json', data }, sequence, uuid: `u_${entry.cardId}_${sequence}` },
      });
    } catch (err) {
      return { ok: false, stage: 'update', err };
    }
    // The node-sdk can RESOLVE with a nonzero business code. That is a failure,
    // not a successful update (callers must not treat the card as refreshed).
    const code = (response as { code?: unknown } | undefined)?.code;
    if (typeof code === 'number' && code !== 0) {
      const msg = (response as { msg?: unknown }).msg;
      return {
        ok: false,
        stage: 'response',
        err: new Error(`cardkit.card.update failed: code=${code}${msg !== undefined ? ` msg=${String(msg)}` : ''}`),
      };
    }
    return { ok: true };
  };

  const first = await push();
  if (first.ok) return true;
  if (first.stage === 'reserve') {
    // Persistence/validation failure: never fall through to an API call.
    log.fail('card', first.err, {
      phase: 'managed-update-reserve',
      cardId: entry.cardId,
      seq: entry.sequence,
    });
    return false;
  }
  // err 200810: the card is still in a previous click's interaction window.
  // Wait out the 3s callback window and retry once with the next sequence. A
  // resolved nonzero business code is also retried (with a fresh sequence),
  // never reported as a successful refresh.
  log.fail('card', first.err, {
    phase: first.stage === 'response' ? 'managed-update-response' : 'managed-update',
    cardId: entry.cardId,
    seq: entry.sequence,
    retry: true,
  });
  await new Promise((r) => setTimeout(r, 3200));
  const second = await push();
  if (second.ok) return true;
  log.fail('card', second.err, {
    phase:
      second.stage === 'reserve'
        ? 'managed-update-reserve'
        : second.stage === 'response'
          ? 'managed-update-response'
          : 'managed-update-retry',
    cardId: entry.cardId,
    seq: entry.sequence,
  });
  return false;
}

/** True iff we hold the card_id mapping for this messageId. */
export function isManaged(messageId: string): boolean {
  return byMessageId.has(messageId);
}

/** CardKit entity currently mapped to this message (diagnostics/tests). */
export function managedCardId(messageId: string): string | undefined {
  return byMessageId.get(messageId)?.cardId;
}

/**
 * Re-adopt a persistent CardKit entity after a process restart. Message-id
 * mappings are process-local, so a long-lived entry card (e.g. the group
 * control panel) must be registered again from its carrier message before any
 * in-place update can target it.
 *
 * CardKit does NOT accept a lower sequence just because the process restarted:
 * sequence must stay positive and strictly increasing for the entity. Callers
 * therefore pass the persisted high-water mark as `sequence` on restore. The
 * mapping itself never rewinds: re-adopting the same entity keeps the larger
 * in-process value, and only a genuinely different card_id resets it.
 */
export function adoptManagedCard(
  messageId: string,
  cardId: string,
  opts: { sequence?: number } = {},
): void {
  const current = byMessageId.get(messageId);
  if (current && current.cardId === cardId) {
    current.sequence = Math.max(current.sequence, restoredSequence(opts.sequence));
    return;
  }
  byMessageId.set(messageId, { cardId, sequence: restoredSequence(opts.sequence) });
}

/** Drop the mapping (card recalled / flow ended). */
export function forgetManagedCard(messageId: string): void {
  byMessageId.delete(messageId);
}
