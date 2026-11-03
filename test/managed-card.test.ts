import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import {
  MAX_MANAGED_CARD_SEQUENCE,
  adoptManagedCard,
  forgetManagedCard,
  updateManagedCard,
} from '../src/card/managed';

const CARD = { body: { elements: [] } };

interface Attempt {
  cardId: string;
  sequence: number;
}

/**
 * Minimal CardKit client. `strict` enforces the official contract: sequence is
 * an int32 in [1, 2147483647] and strictly greater than the last accepted value
 * for that card entity. A resolved nonzero `code` is a failure.
 */
function fakeChannel(
  opts: {
    strict?: boolean;
    failFirst?: boolean;
    code?: number;
    maxAccepted?: number;
  } = {},
): { channel: LarkChannel; attempts: Attempt[]; calls: () => number } {
  const attempts: Attempt[] = [];
  const last = new Map<string, number>();
  let callCount = 0;
  const update = async (payload: {
    path: { card_id: string };
    data: { sequence: number };
  }): Promise<unknown> => {
    callCount += 1;
    const { card_id: cardId } = payload.path;
    const sequence = payload.data.sequence;
    attempts.push({ cardId, sequence });
    if (opts.strict) {
      const previous = last.get(cardId) ?? 0;
      if (
        !Number.isInteger(sequence) ||
        sequence < 1 ||
        sequence > MAX_MANAGED_CARD_SEQUENCE ||
        sequence <= previous
      ) {
        return { code: 300317, msg: `sequence must be > ${previous}` };
      }
      last.set(cardId, sequence);
    }
    if (opts.maxAccepted !== undefined && sequence > opts.maxAccepted) {
      return { code: 300317, msg: 'sequence out of range' };
    }
    if (opts.failFirst && callCount === 1) throw new Error('network reset');
    if (opts.code !== undefined) return { code: opts.code, msg: 'rejected' };
    return {};
  };
  return {
    channel: { rawClient: { cardkit: { v1: { card: { update } } } } } as unknown as LarkChannel,
    attempts,
    calls: () => callCount,
  };
}

afterEach(() => {
  for (const id of ['om_default', 'om_strict', 'om_retry', 'om_code', 'om_max', 'om_reserve', 'om_persist']) {
    forgetManagedCard(id);
  }
  vi.useRealTimers();
});

describe('updateManagedCard sequence contract', () => {
  it('keeps the default per-process increment for existing callers', async () => {
    const { channel, attempts } = fakeChannel({ strict: true });
    adoptManagedCard('om_default', 'card_default');

    await expect(updateManagedCard(channel, 'om_default', CARD)).resolves.toBe(true);
    await expect(updateManagedCard(channel, 'om_default', CARD)).resolves.toBe(true);

    expect(attempts.map((attempt) => attempt.sequence)).toEqual([1, 2]);
  });

  it('uses the supplied allocator and never rewinds a re-adopted mapping', async () => {
    const { channel, attempts } = fakeChannel({ strict: true });
    adoptManagedCard('om_strict', 'card_strict', { sequence: 40 });
    let next = 40;
    const reserveSequence = async (): Promise<number> => {
      next += 1;
      return next;
    };

    await expect(updateManagedCard(channel, 'om_strict', CARD, { reserveSequence })).resolves.toBe(true);
    // Re-adoption of the SAME entity preserves the in-process high-water mark.
    adoptManagedCard('om_strict', 'card_strict');
    await expect(updateManagedCard(channel, 'om_strict', CARD, { reserveSequence })).resolves.toBe(true);

    expect(attempts.map((attempt) => attempt.sequence)).toEqual([41, 42]);
  });

  it('reserves a fresh sequence before retrying a failed update', async () => {
    const { channel, attempts } = fakeChannel({ strict: true, failFirst: true });
    adoptManagedCard('om_retry', 'card_retry');
    const reserved: number[] = [];
    const reserveSequence = async (): Promise<number> => {
      const sequence = reserved.length + 1;
      reserved.push(sequence);
      return sequence;
    };

    vi.useFakeTimers();
    const pending = updateManagedCard(channel, 'om_retry', CARD, { reserveSequence });
    await vi.advanceTimersByTimeAsync(3200);
    await expect(pending).resolves.toBe(true);

    expect(reserved).toEqual([1, 2]);
    expect(attempts.map((attempt) => attempt.sequence)).toEqual([1, 2]);
  });

  it('treats a resolved nonzero response code as failure, not success', async () => {
    const { channel, attempts, calls } = fakeChannel({ code: 300317 });
    adoptManagedCard('om_code', 'card_code');

    vi.useFakeTimers();
    const pending = updateManagedCard(channel, 'om_code', CARD);
    await vi.advanceTimersByTimeAsync(3200);
    await expect(pending).resolves.toBe(false);

    // The rejection is retried once with a fresh sequence, never reported ok.
    expect(calls()).toBe(2);
    expect(attempts.map((attempt) => attempt.sequence)).toEqual([1, 2]);
  });

  it('fails closed at the int32 maximum without wrapping or sending', async () => {
    const first = fakeChannel({ strict: true });
    adoptManagedCard('om_max', 'card_max', { sequence: MAX_MANAGED_CARD_SEQUENCE });
    await expect(updateManagedCard(first.channel, 'om_max', CARD)).resolves.toBe(false);
    expect(first.attempts).toHaveLength(0);

    const second = fakeChannel({ strict: true });
    forgetManagedCard('om_max');
    adoptManagedCard('om_max', 'card_max');
    await expect(
      updateManagedCard(second.channel, 'om_max', CARD, {
        reserveSequence: async () => MAX_MANAGED_CARD_SEQUENCE + 1,
      }),
    ).resolves.toBe(false);
    expect(second.attempts).toHaveLength(0);
  });

  it('does not send an update when sequence persistence fails', async () => {
    const { channel, calls } = fakeChannel({ strict: true });
    adoptManagedCard('om_persist', 'card_persist');

    await expect(
      updateManagedCard(channel, 'om_persist', CARD, {
        reserveSequence: async () => {
          throw new Error('group-menus.json is read-only');
        },
      }),
    ).resolves.toBe(false);
    expect(calls()).toBe(0);
  });
});
