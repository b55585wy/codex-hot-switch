import { describe, expect, it } from 'vitest';
import { mapNotification } from '../src/agent/codex-appserver/event-map';
import type { ServerNotification, Turn } from '../src/agent/codex-appserver/protocol';
import { RunRender } from '../src/card/run-render';

const capacityMessage = 'The service is at capacity. Please try again later.';

function completion(status: Turn['status'], message: string | null = null): ServerNotification {
  return {
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1', items: [], itemsView: 'full', status,
        error: message === null ? null : { message, codexErrorInfo: null, additionalDetails: null },
        startedAt: 1, completedAt: 2, durationMs: 1000,
      },
    },
  };
}

describe('Codex terminal turn outcomes', () => {
  it('keeps successful completion as done with the original turn ID', () => {
    expect(mapNotification(completion('completed'))).toEqual({ type: 'done', turnId: 'turn-1' });
  });

  it('surfaces capacity failure from the terminal turn without requiring an error notification', () => {
    expect(mapNotification(completion('failed', capacityMessage))).toEqual({
      type: 'error', message: capacityMessage, willRetry: false,
    });
  });

  it.each([null, '', ' \n '])('surfaces a failed turn with missing or blank error details (%j)', message => {
    expect(mapNotification(completion('failed', message))).toEqual({
      type: 'error', message: 'Codex 本轮执行失败，未返回错误详情。', willRetry: false,
    });
  });

  it('keeps failure details in the card state when the stream ends after earlier output', () => {
    const render = new RunRender();
    render.apply({ type: 'text_delta', itemId: 'progress', delta: '已完成部分修改。' });
    render.apply(mapNotification(completion('failed', capacityMessage))!);
    render.finalize();
    expect(render.snapshot()).toMatchObject({ terminal: 'error', errorMsg: capacityMessage });
    expect(render.snapshot().blocks).toContainEqual(expect.objectContaining({ content: '已完成部分修改。' }));
  });

  it('preserves interrupted stream termination and the existing user-stop rendering contract', () => {
    const event = mapNotification(completion('interrupted'));
    expect(event).toEqual({ type: 'done', turnId: 'turn-1' });
    const render = new RunRender();
    render.apply(event!);
    render.interrupt();
    expect(render.snapshot()).toMatchObject({ terminal: 'interrupted' });
    expect(render.snapshot().errorMsg).toBeUndefined();
  });

  it.each([true, false])('preserves an explicit error notification retry flag (%j)', willRetry => {
    const notification = {
      method: 'error', params: { error: { message: capacityMessage }, willRetry },
    } as ServerNotification;
    expect(mapNotification(notification)).toEqual({ type: 'error', message: capacityMessage, willRetry });
  });
});
