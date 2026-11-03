const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createCodexObserver} = require('./observer.cjs');

const base = path.resolve(__dirname, '../../work/blocked-observer-fixtures');
fs.mkdirSync(base, {recursive:true});
const CAPACITY = 'Selected model is at capacity. Please try a different model.';
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'case-'));
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, '');
  const row = {id:'session-a', source:'vscode', cwd:'E:\\project', rollout_path:transcript};
  let time = Date.parse('2026-10-30T06:00:00Z');
  const sent = [], instances = [];
  function make(overrides = {}) {
    const observer = createCodexObserver({
      codexHome:dir, statePath:path.join(dir, 'observer.json'), listThreads:async () => [row],
      now:() => time, enabled:() => true, intervalMs:1000000000, settleMs:5000,
      deliver:async msg => {sent.push(msg);}, ...extra, ...overrides
    });
    instances.push(observer); return observer;
  }
  const observer = make();
  function event(type, payload = {}) {
    return {timestamp:new Date(time).toISOString(), type:'event_msg', payload:{type, ...payload}};
  }
  function append(value) { fs.appendFileSync(transcript, (typeof value === 'string' ? value : JSON.stringify(value)) + '\n'); }
  function failure(error = {message:CAPACITY, codex_error_info:'server_overloaded'}, turn = 'turn-a', extraPayload = {}) {
    return event('task_complete', {turn_id:turn, last_agent_message:null, error, ...extraPayload});
  }
  async function settle(item = observer, ms = 6000) {time += ms; await item.tick();}
  async function started(turn = 'turn-a', item = observer) {append(event('task_started', {turn_id:turn})); await item.tick();}
  t.after(async () => {
    for (const item of instances) await item.stop();
    const target = path.resolve(dir); assert.ok(target.startsWith(base + path.sep));
    fs.rmSync(target, {recursive:true, force:true});
  });
  return {observer, row, transcript, sent, make, event, append, failure, settle, started, advance:ms => {time += ms;}};
}

test('a terminal capacity error produces one explicit failed notification with its native turn identity', async t => {
  const f = fixture(t); await f.observer.start(); f.append(f.failure()); await f.observer.tick(); await f.settle(); await f.settle();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].taskStatus, 'failed'); assert.equal(f.sent[0].failureKind, 'capacity');
  assert.equal(f.sent[0].errorCode, 'server_overloaded'); assert.equal(f.sent[0].turnId, 'turn-a');
  assert.equal(f.sent[0].sessionId, f.row.id); assert.equal(f.sent[0].notificationOnly, true); assert.match(f.sent[0].summary, /at capacity/);
});

for (const [code, kind, normalized] of [
  [{responseTooManyFailedAttempts:{httpStatusCode:503}}, 'retry_exhausted', 'response_too_many_failed_attempts'],
  ['usageLimitExceeded', 'usage_limit', 'usage_limit_exceeded'],
  ['unauthorized', 'authentication', 'unauthorized'],
  ['contextWindowExceeded', 'context_limit', 'context_window_exceeded'],
  ['other', 'error', 'other']
]) {
  test('structured terminal code classifies ' + normalized + ' without requiring a message substring', async t => {
    const f = fixture(t); await f.observer.start(); f.append(f.failure({message:'本轮无法继续。', codex_error_info:code}));
    await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].taskStatus, 'failed'); assert.equal(f.sent[0].failureKind, kind); assert.equal(f.sent[0].errorCode, normalized);
  });
}

test('a terminal error wins over a partial assistant message in the same completion event', async t => {
  const f = fixture(t); await f.observer.start(); f.append(f.failure(undefined, 'turn-a', {last_agent_message:'阶段产物已经写入。'}));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].taskStatus, 'failed'); assert.match(f.sent[0].summary, /at capacity/);
});

test('an active goal does not hide a confirmed terminal failure', async t => {
  const f = fixture(t); f.row.goalStatus = 'active'; await f.observer.start(); f.append(f.failure());
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].taskStatus, 'failed');
});

test('stream_error is quiet even when its text mentions capacity or exhausted retries', async t => {
  const f = fixture(t); await f.observer.start(); await f.started();
  f.append(f.event('stream_error', {message:CAPACITY, codex_error_info:'server_overloaded', will_retry:false}));
  f.append(f.event('stream_error', {message:'retry exhausted', codex_error_info:{response_too_many_failed_attempts:{}}}));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 0);
});

for (const flags of [{}, {willRetry:true}, {will_retry:true}, {willRetry:false,will_retry:true}, {willRetry:true,will_retry:false}]) {
  test('a raw error stays quiet when retry status is unknown or still true: ' + JSON.stringify(flags), async t => {
    const f = fixture(t); await f.observer.start(); await f.started();
    f.append(f.event('error', {message:CAPACITY, codex_error_info:'server_overloaded', ...flags}));
    await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 0);
  });
}

for (const flag of ['willRetry', 'will_retry']) {
  test('an explicitly non-retryable raw error uses only its known current turn: ' + flag, async t => {
    const f = fixture(t); await f.observer.start(); await f.started('current-turn');
    f.append(f.event('error', {message:CAPACITY, codex_error_info:'server_overloaded', [flag]:false}));
    await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].turnId, 'current-turn'); assert.equal(f.sent[0].taskStatus, 'failed');
  });
}

test('a raw error without a known current turn cannot guess a session turn', async t => {
  const f = fixture(t); await f.observer.start();
  f.append(f.event('error', {message:CAPACITY, codex_error_info:'server_overloaded', willRetry:false}));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 0);
});

for (const mismatch of [{turn_id:'different-turn'}, {turnId:'different-turn'}, {thread_id:'different-session'}, {threadId:'different-session'}]) {
  test('explicit mismatched error identity is never attached to the current task: ' + JSON.stringify(mismatch), async t => {
    const f = fixture(t); await f.observer.start(); await f.started();
    f.append(f.event('error', {message:CAPACITY, codex_error_info:'server_overloaded', willRetry:false, ...mismatch}));
    await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 0);
  });
}

test('operation-only rollback and steering errors never claim that the running task has stopped', async t => {
  const f = fixture(t); await f.observer.start(); await f.started();
  for (const code of ['threadRollbackFailed','thread_rollback_failed',{threadRollbackFailed:{}},
    'activeTurnNotSteerable','active_turn_not_steerable',{active_turn_not_steerable:{turn_kind:'regular'}}]) {
    f.append(f.event('error', {message:'当前操作被拒绝。', codex_error_info:code, willRetry:false}));
  }
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 0);
});

test('an empty completion after a raw failure does not downgrade it into a successful notification', async t => {
  const f = fixture(t); await f.observer.start(); await f.started();
  f.append(f.event('error', {message:CAPACITY, codex_error_info:'server_overloaded', willRetry:false}));
  f.append(f.event('task_complete', {turn_id:'turn-a', last_agent_message:null}));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].taskStatus, 'failed');
});

test('a later genuine successful completion for the same turn can report recovery independently', async t => {
  const f = fixture(t); await f.observer.start(); f.append(f.failure()); await f.observer.tick(); await f.settle();
  f.append(f.event('task_complete', {turn_id:'turn-a', last_agent_message:'恢复后工作完成。'}));
  await f.observer.tick(); await f.settle(); assert.deepEqual(f.sent.map(msg => msg.taskStatus), ['failed','completed']);
  assert.match(f.sent[1].summary, /恢复后/);
});

test('success and failure delivery receipts remain isolated for one native turn', async t => {
  const f = fixture(t); await f.observer.start();
  f.observer.markDelivered({sessionId:f.row.id,turnId:'turn-a',taskStatus:'completed'});
  assert.equal(f.observer.hasDelivered({sessionId:f.row.id,turnId:'turn-a',taskStatus:'failed'}), false);
  f.append(f.failure()); await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].taskStatus, 'failed');
  assert.equal(f.observer.hasDelivered({sessionId:f.row.id,turnId:'turn-a',taskStatus:'failed'}), true);
});

test('a failure receipt does not suppress a later successful completion receipt', async t => {
  const f = fixture(t); await f.observer.start(); f.observer.markDelivered({sessionId:f.row.id,turnId:'turn-a',taskStatus:'failed'});
  assert.equal(f.observer.hasDelivered({sessionId:f.row.id,turnId:'turn-a',taskStatus:'completed'}), false);
  f.append(f.event('task_complete', {turn_id:'turn-a',last_agent_message:'完成。'})); await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].taskStatus, 'completed');
});

test('a managed failure waits for its group reminder and consumes only a successful failed-outcome receipt', async t => {
  const f = fixture(t, {managedGraceMs:10000}); await f.observer.start();
  const success = {sessionId:f.row.id,turnId:'turn-a',taskStatus:'completed'};
  const failed = {...success,taskStatus:'failed'};
  f.observer.markBridgeTurn(f.row.id, 'turn-a'); f.append(f.failure()); await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 0, 'A managed failed turn gets the same reminder grace as a successful turn');
  f.observer.markDelivered(failed); await f.settle(f.observer, 20000);
  assert.equal(f.sent.length, 0); assert.equal(f.observer.hasDelivered(failed), true);
  assert.equal(f.observer.hasDelivered(success), false, 'An error reminder is not a successful completion receipt');
  assert.equal(f.observer.hasManagedTurn(success), false); assert.equal(f.observer.hasManagedTurn(failed), false);
});

test('a managed failure falls back to one observer notification if the group error reminder is never delivered', async t => {
  const f = fixture(t, {managedGraceMs:10000}); await f.observer.start();
  f.observer.markBridgeTurn(f.row.id, 'turn-a'); f.append(f.failure()); await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 0); await f.settle(f.observer, 5000); await f.settle(f.observer, 20000);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].taskStatus, 'failed'); assert.equal(f.sent[0].failureKind, 'capacity');
});

test('a group failure receipt clears the managed reservation without suppressing later recovery of the same turn', async t => {
  const f = fixture(t, {managedGraceMs:10000}); await f.observer.start();
  f.observer.markBridgeTurn(f.row.id, 'turn-a');
  f.observer.markDelivered({sessionId:f.row.id,turnId:'turn-a',taskStatus:'failed'});
  assert.equal(f.observer.hasManagedTurn({sessionId:f.row.id,turnId:'turn-a'}), false);
  assert.equal(f.observer.hasManagedTurn({sessionId:f.row.id,turnId:'turn-a',taskStatus:'failed'}), false);
  f.append(f.failure()); await f.observer.tick(); await f.settle(f.observer, 20000); assert.equal(f.sent.length, 0);
  f.append(f.event('task_complete', {turn_id:'turn-a',last_agent_message:'恢复后工作已完成。'}));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].taskStatus, 'completed');
});

test('a new task cancels a settling failure instead of interrupting a task that is already running again', async t => {
  const f = fixture(t); await f.observer.start(); await f.started(); f.append(f.failure()); await f.observer.tick();
  await f.started('turn-b'); await f.settle(); assert.equal(f.sent.length, 0);
});

for (const status of ['failed', 'completed']) {
  test('a late old ' + status + ' terminal cannot notify or clear the newer running turn', async t => {
    const f = fixture(t); await f.observer.start(); await f.started('turn-b');
    f.append(status === 'failed' ? f.failure(undefined, 'turn-a')
      : f.event('task_complete', {turn_id:'turn-a', last_agent_message:'旧任务已结束。'}));
    await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 0);
    f.append(f.failure(undefined, 'turn-b'));
    await f.observer.tick(); await f.settle();
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].turnId, 'turn-b');
  });
}

test('a later retryable error cancels a settling raw failure false alarm', async t => {
  const f = fixture(t); await f.observer.start(); await f.started();
  f.append(f.event('error', {message:CAPACITY,codex_error_info:'server_overloaded',willRetry:false})); await f.observer.tick();
  f.append(f.event('error', {message:'恢复连接中。',codex_error_info:'server_overloaded',willRetry:true}));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 0);
});

test('an abort cancels a settling failure and clears the current-turn inference', async t => {
  const f = fixture(t); await f.observer.start(); await f.started();
  f.append(f.event('error', {message:CAPACITY,codex_error_info:'server_overloaded',willRetry:false})); await f.observer.tick();
  f.append(f.event('turn_aborted', {reason:'interrupted'}));
  f.append(f.event('error', {message:CAPACITY,codex_error_info:'server_overloaded',willRetry:false}));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 0);
});

test('a completed turn clears the inference context for later unrelated raw errors', async t => {
  const f = fixture(t); await f.observer.start(); await f.started();
  f.append(f.event('task_complete', {turn_id:'turn-a',last_agent_message:'完成。'})); await f.observer.tick(); await f.settle();
  f.append(f.event('error', {message:CAPACITY,codex_error_info:'server_overloaded',willRetry:false}));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].taskStatus, 'completed');
});

test('current-turn identity survives a service restart before a raw terminal error arrives', async t => {
  const f = fixture(t); await f.observer.start(); await f.started('persisted-turn'); await f.observer.stop();
  const next = f.make(); await next.start();
  f.append(f.event('error', {message:CAPACITY,codex_error_info:'server_overloaded',will_retry:false}));
  await next.tick(); await f.settle(next); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].turnId, 'persisted-turn');
});

test('malformed terminal error payloads never produce a false successful completion', async t => {
  const f = fixture(t); await f.observer.start();
  for (const error of [{}, 'not-an-error-object', 42, {message:''}]) {
    f.append(f.failure(error, 'malformed-' + String(error), {last_agent_message:'部分输出。'}));
  }
  await f.observer.tick(); await f.settle(); assert.ok(f.sent.every(msg => msg.taskStatus === 'failed'));
});

test('a terminal record without turn_id is ignored rather than inventing an identity', async t => {
  const f = fixture(t); await f.observer.start(); await f.started();
  f.append(f.event('task_complete', {error:{message:CAPACITY,codex_error_info:'server_overloaded'},last_agent_message:null}));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 0);
});

test('capacity text in a successful assistant answer is not itself an error event', async t => {
  const f = fixture(t); await f.observer.start(); f.append(f.event('task_complete', {turn_id:'turn-a',last_agent_message:'文档说明：' + CAPACITY}));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].taskStatus, 'completed');
});

test('starting observation does not replay historical failures', async t => {
  const f = fixture(t); f.append(f.failure()); await f.observer.start(); await f.settle(); assert.equal(f.sent.length, 0);
});

test('failed notifications retain durable retries and recover once after a restart', async t => {
  let attempts = 0; const delivered = [];
  const f = fixture(t, {intervalMs:1000,retryBackoffMs:1000,deliver:async msg => {
    if (++attempts <= 2) throw new Error('temporary notification transport error'); delivered.push(msg);
  }});
  await f.observer.start(); f.append(f.failure()); await f.observer.tick(); await f.settle(); await f.settle(f.observer,1000);
  assert.equal(attempts, 2); await f.observer.stop(); const next = f.make(); await next.start();
  await f.settle(next, 1000); await f.settle(next, 10000); assert.equal(attempts, 3);
  assert.equal(delivered.length, 1); assert.equal(delivered[0].taskStatus, 'failed'); assert.equal(delivered[0].failureKind, 'capacity');
});

test('a partial trailing continuation prevents a failed notification until the file catches up', async t => {
  const f = fixture(t); await f.observer.start(); f.append(f.failure());
  const continuation = JSON.stringify(f.event('task_started', {turn_id:'turn-b'})) + '\n';
  fs.appendFileSync(f.transcript, continuation.slice(0,-10)); await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 0);
  fs.appendFileSync(f.transcript, continuation.slice(-10)); await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 0);
});

test('a failed outcome beyond a read backlog is not notified before a later continuation is visible', async t => {
  const f = fixture(t); await f.observer.start(); f.append(f.failure());
  const noise = JSON.stringify(f.event('token_count', {info:'x'.repeat(1100)})) + '\n';
  fs.appendFileSync(f.transcript, noise.repeat(11000)); f.append(f.event('task_started', {turn_id:'turn-b'}));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 0);
  for (let i=0;i<5;i++) await f.settle(); assert.equal(f.sent.length, 0);
});
