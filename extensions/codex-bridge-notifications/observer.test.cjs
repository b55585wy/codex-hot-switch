const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createCodexObserver, safeSummary} = require('./observer.cjs');

const fixtureBase = path.resolve(__dirname, '../../work/notification-test-fixtures');
fs.mkdirSync(fixtureBase, {recursive:true});
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(fixtureBase, 'observer-'));
  let time = Date.parse('2026-10-30T06:00:00Z');
  let on = true;
  let rows = [];
  const sent = [], logs = [], instances = [];
  const statePath = path.join(dir, 'observer-state.json');
  function makeObserver(overrides = {}) {
    const observer = createCodexObserver({
      codexHome:dir, statePath, listThreads:async () => rows,
      deliver:async msg => { sent.push(msg); }, enabled:() => on,
      now:() => time, log:(event, fields) => logs.push({event, ...fields}),
      intervalMs:1000000000, settleMs:5000, ...extra, ...overrides
    });
    instances.push(observer);
    return observer;
  }
  const observer = makeObserver();
  function addRow(id = 'session-a', source = 'vscode', contents = '') {
    const row = {id, source, title:'模块 A', name:null, cwd:'E:\\', rollout_path:path.join(dir, id + '.jsonl')};
    fs.writeFileSync(row.rollout_path, contents);
    rows.push(row);
    return row;
  }
  function record(type, turn = 'turn-a', message = '已完成本轮工作。', at = time) {
    return {timestamp:new Date(at).toISOString(), type:'event_msg', payload:{type, turn_id:turn, last_agent_message:message}};
  }
  function append(row, value) {
    fs.appendFileSync(row.rollout_path, (typeof value === 'string' ? value : JSON.stringify(value)) + '\n');
  }
  async function settle(instance = observer, ms = 6000) { time += ms; await instance.tick(); }
  t.after(async () => {
    for (const item of instances) await item.stop();
    const target = path.resolve(dir);
    assert.ok(target.startsWith(fixtureBase + path.sep), 'Fixture cleanup must stay inside its workspace directory');
    fs.rmSync(target, {recursive:true, force:true});
  });
  return {dir, statePath, observer, makeObserver, addRow, record, append, settle, sent, logs,
    advance:ms => {time += ms;}, enabled:value => {on = value;}, rows:() => rows, replaceRows:value => {rows = value;}, now:() => time};
}

test('starting with existing completed history does not replay old notifications', async t => {
  const f = fixture(t), row = f.addRow();
  f.append(row, f.record('task_complete', 'historical', '旧任务完成', f.now() - 10000));
  const before = fs.readFileSync(row.rollout_path);
  await f.observer.start(); await f.settle();
  assert.equal(f.sent.length, 0);
  assert.deepEqual(fs.readFileSync(row.rollout_path), before, 'Observer must not write to native transcripts');
});

test('running tasks and intermediate output remain quiet', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start();
  f.append(row, f.record('task_started'));
  f.append(row, {timestamp:new Date(f.now()).toISOString(), type:'response_item', payload:{type:'message', role:'assistant', content:[{type:'output_text', text:'正在执行'}]}});
  f.append(row, f.record('token_count')); await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 0);
});

test('a new completion notifies once with its exact session and turn', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start();
  f.append(row, f.record('task_complete', 'turn-123', '后端接口已完成。'));
  await f.observer.tick(); assert.equal(f.sent.length, 0, 'Completion must settle first');
  await f.settle(); await f.settle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].sessionId, row.id); assert.equal(f.sent[0].turnId, 'turn-123');
  assert.match(f.sent[0].summary, /后端接口已完成/); assert.equal(f.sent[0].notificationOnly, true);
  assert.equal(f.sent[0].source, 'codex');
});

test('continuing immediately suppresses a completion while work is running', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start();
  f.append(row, f.record('task_complete', 'first')); await f.observer.tick();
  f.advance(1000); f.append(row, f.record('task_started', 'next')); await f.observer.tick();
  await f.settle(); assert.equal(f.sent.length, 0);
  f.append(row, f.record('task_complete', 'next', '整个模块已完成')); await f.observer.tick(); await f.settle();
  assert.deepEqual(f.sent.map(x => x.turnId), ['next']);
});

test('an intentional interrupt does not send a completion notification', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start();
  f.append(row, f.record('task_started')); f.append(row, f.record('turn_aborted'));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 0);
});

test('an interrupt cancels an already settling completion', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start();
  f.append(row, f.record('task_complete')); await f.observer.tick();
  f.append(row, f.record('turn_aborted')); await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 0);
});

test('partial UTF-8 records wait for a complete newline and keep Chinese text intact', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start();
  const bytes = Buffer.from(JSON.stringify(f.record('task_complete', 'utf8', '模块完成：研究平台 🚀')) + '\n');
  const boundary = bytes.indexOf(Buffer.from('研究')) + 1;
  fs.appendFileSync(row.rollout_path, bytes.subarray(0, boundary));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 0);
  fs.appendFileSync(row.rollout_path, bytes.subarray(boundary)); await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].summary, /研究平台 🚀/);
});

test('invalid JSON does not block the next valid completion', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start();
  f.append(row, '{malformed'); f.append(row, ''); f.append(row, f.record('task_complete'));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 1);
});

test('a truncated transcript can resume from its new beginning', async t => {
  const f = fixture(t), row = f.addRow('truncate', 'vscode', 'x'.repeat(5000) + '\n'); await f.observer.start();
  fs.writeFileSync(row.rollout_path, JSON.stringify(f.record('task_complete', 'after-truncate')) + '\n');
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].turnId, 'after-truncate');
});

test('a changed rollout page is read without replaying the old page', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start();
  const newFile = path.join(f.dir, 'new-page.jsonl');
  fs.writeFileSync(newFile, JSON.stringify(f.record('task_complete', 'new-page')) + '\n');
  row.rollout_path = newFile; await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].turnId, 'new-page');
});

test('newly created sessions are observed from their first new event', async t => {
  const f = fixture(t); await f.observer.start(); f.advance(1);
  const row = f.addRow('new-session'); f.append(row, f.record('task_started')); f.append(row, f.record('task_complete'));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 1);
});

test('subagent records do not produce noisy independent notifications', async t => {
  const f = fixture(t), row = f.addRow('child', JSON.stringify({subagent:{thread_spawn:{parent_thread_id:'parent'}}}));
  await f.observer.start(); f.append(row, f.record('task_complete')); await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 0);
});

test('turn IDs are scoped to their session', async t => {
  const f = fixture(t), first = f.addRow('a'), second = f.addRow('b'); await f.observer.start();
  f.append(first, f.record('task_complete', 'same-turn')); f.append(second, f.record('task_complete', 'same-turn'));
  await f.observer.tick(); await f.settle();
  assert.deepEqual(f.sent.map(x => x.sessionId).sort(), ['a', 'b']);
});

test('disabled notifications consume events without replaying them when enabled', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start(); f.enabled(false);
  f.append(row, f.record('task_complete', 'disabled')); await f.observer.tick(); await f.settle();
  f.enabled(true); await f.settle(); assert.equal(f.sent.length, 0);
  f.append(row, f.record('task_complete', 'enabled')); await f.observer.tick(); await f.settle();
  assert.deepEqual(f.sent.map(x => x.turnId), ['enabled']);
});

test('disabling while completion settles prevents delivery', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start();
  f.append(row, f.record('task_complete')); await f.observer.tick(); f.enabled(false); await f.settle();
  f.enabled(true); await f.settle(); assert.equal(f.sent.length, 0);
});

test('hook delivery suppresses the observer copy', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start();
  f.observer.markDelivered({sessionId:row.id, turnId:'hook-turn'});
  f.append(row, f.record('task_complete', 'hook-turn')); await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 0);
});

test('a successful Bridge group reminder suppresses the observer private-message copy', async t => {
  const f = fixture(t, {managedGraceMs:10000}), row = f.addRow(); await f.observer.start();
  const msg = {sessionId:row.id, turnId:'bridge-turn'};
  f.observer.markBridgeTurn(row.id, msg.turnId);
  assert.equal(f.observer.hasManagedTurn(msg), true);
  assert.equal(f.observer.hasDelivered(msg), false, 'Starting a managed turn is not proof of delivery');
  f.append(row, f.record('task_complete', msg.turnId)); await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 0, 'Existing group reminder gets a grace period');
  f.observer.markDelivered(msg); await f.settle(f.observer, 20000);
  assert.equal(f.sent.length, 0); assert.equal(f.observer.hasDelivered(msg), true);
});

test('a failed or missing Bridge group reminder falls back to a private notification after its grace period', async t => {
  const f = fixture(t, {managedGraceMs:10000}), row = f.addRow(); await f.observer.start();
  const msg = {sessionId:row.id, turnId:'bridge-failed'};
  f.observer.markBridgeTurn(row.id, msg.turnId); f.append(row, f.record('task_complete', msg.turnId));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 0);
  await f.settle(f.observer, 5000); await f.settle();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].turnId, msg.turnId);
  assert.equal(f.observer.hasDelivered(msg), true);
});

test('hook completion also cancels an observer delivery that was already settling', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start(); f.append(row, f.record('task_complete', 'raced'));
  await f.observer.tick(); f.observer.markDelivered({sessionId:row.id, turnId:'raced'}); await f.settle();
  assert.equal(f.sent.length, 0);
});

test('a transient delivery failure retries once and then succeeds', async t => {
  let attempts = 0;
  const f = fixture(t, {intervalMs:10000, deliver:async () => { if (++attempts === 1) throw new Error('temporary connection reset'); }});
  const row = f.addRow(); await f.observer.start(); f.append(row, f.record('task_complete')); await f.observer.tick(); await f.settle();
  assert.equal(attempts, 1); await f.settle(f.observer, 11000); await f.settle(f.observer, 11000);
  assert.equal(attempts, 2); assert.equal(f.logs.filter(x => x.event === 'notification-sent').length, 1);
});

test('repeated delivery failure remains queued and waits for backoff without logging every poll', async t => {
  let attempts = 0;
  const f = fixture(t, {intervalMs:10000, deliver:async () => { attempts++; throw new Error('permission denied'); }});
  const row = f.addRow(); await f.observer.start(); f.append(row, f.record('task_complete')); await f.observer.tick(); await f.settle();
  await f.settle(f.observer, 11000); await f.settle(f.observer, 11000); await f.settle(f.observer, 11000);
  assert.equal(attempts, 2); assert.equal(f.logs.filter(x => x.event === 'notification-failed').length, 2);
  const state = JSON.parse(fs.readFileSync(f.statePath, 'utf8')), key = row.id + ':turn-a';
  assert.equal(state.pending[key].attempts, 2); assert.equal(state.seen[key], undefined);
  assert.equal(f.observer.hasDelivered({sessionId:row.id, turnId:'turn-a'}), false);
  assert.equal(f.logs.filter(x => x.event === 'notification-failed')[1].retryAfterMs, 60000);
  await f.settle(f.observer, 39000); assert.equal(attempts, 3);
  assert.equal(f.logs.filter(x => x.event === 'notification-failed').length, 3);
});

test('repeated failures use bounded exponential backoff capped at five minutes', async t => {
  let attempts = 0;
  const f = fixture(t, {intervalMs:1000, deliver:async () => {attempts++; throw new Error('network unavailable');}});
  const row = f.addRow(); await f.observer.start(); f.append(row, f.record('task_complete'));
  await f.observer.tick(); await f.settle(); await f.settle(f.observer, 1000);
  for (const wait of [60000, 120000, 240000, 300000, 300000]) await f.settle(f.observer, wait);
  assert.equal(attempts, 7);
  assert.deepEqual(f.logs.filter(x => x.event === 'notification-failed').map(x => x.retryAfterMs), [1000,60000,120000,240000,300000,300000,300000]);
  const state = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
  assert.equal(state.pending[row.id + ':turn-a'].attempts, 7); assert.equal(state.seen[row.id + ':turn-a'], undefined);
});

test('custom retry backoff is honored while retaining the immediate first retry', async t => {
  let attempts = 0;
  const f = fixture(t, {intervalMs:1000, retryBackoffMs:2000, deliver:async () => {attempts++; throw new Error('still disconnected');}});
  const row = f.addRow(); await f.observer.start(); f.append(row, f.record('task_complete'));
  await f.observer.tick(); await f.settle(); await f.settle(f.observer, 1000);
  await f.settle(f.observer, 1000); assert.equal(attempts, 2);
  await f.settle(f.observer, 1000); assert.equal(attempts, 3);
  assert.deepEqual(f.logs.filter(x => x.event === 'notification-failed').map(x => x.retryAfterMs), [1000,2000,4000]);
});

test('a failed notification survives restart and is sent exactly once after network recovery', async t => {
  let attempts = 0;
  const f = fixture(t, {intervalMs:1000, deliver:async () => {
    if (++attempts <= 2) throw new Error('Client network socket disconnected before secure TLS connection was established');
  }});
  const row = f.addRow(); await f.observer.start(); f.append(row, f.record('task_complete', 'recover-after-restart'));
  await f.observer.tick(); await f.settle(); await f.settle(f.observer, 1000); assert.equal(attempts, 2);
  await f.observer.stop(); const next = f.makeObserver(); await next.start(); await f.settle(next, 1000);
  assert.equal(attempts, 2, 'Restart must preserve the pending retry deadline');
  await f.settle(next, 60000); await f.settle(next, 300000); assert.equal(attempts, 3);
  const state = JSON.parse(fs.readFileSync(f.statePath, 'utf8')), key = row.id + ':recover-after-restart';
  assert.equal(state.pending[key], undefined); assert.ok(state.seen[key]);
  assert.equal(f.logs.filter(x => x.event === 'notification-sent').length, 1);
});

for (const event of ['task_started', 'turn_aborted']) {
  test('a failed notification is cancelled by a later ' + event + ' event', async t => {
    let attempts = 0;
    const f = fixture(t, {intervalMs:1000, deliver:async () => {attempts++; throw new Error('network unavailable');}});
    const row = f.addRow(); await f.observer.start(); f.append(row, f.record('task_complete', 'stale-completion'));
    await f.observer.tick(); await f.settle(); await f.settle(f.observer, 1000); assert.equal(attempts, 2);
    f.append(row, f.record(event, 'new-turn')); await f.observer.tick(); await f.settle(f.observer, 600000);
    assert.equal(attempts, 2); const state = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
    assert.equal(state.pending[row.id + ':stale-completion'], undefined);
  });
}

test('disabling notifications consumes a backed-off failure immediately and prevents later replay', async t => {
  let attempts = 0;
  const f = fixture(t, {intervalMs:1000, deliver:async () => {attempts++; throw new Error('network unavailable');}});
  const row = f.addRow(); await f.observer.start(); f.append(row, f.record('task_complete', 'disabled-during-backoff'));
  await f.observer.tick(); await f.settle(); await f.settle(f.observer, 1000); assert.equal(attempts, 2);
  f.enabled(false); await f.observer.tick();
  let state = JSON.parse(fs.readFileSync(f.statePath, 'utf8')); assert.equal(state.pending[row.id + ':disabled-during-backoff'], undefined);
  f.enabled(true); await f.settle(f.observer, 600000); assert.equal(attempts, 2);
  state = JSON.parse(fs.readFileSync(f.statePath, 'utf8')); assert.ok(state.seen[row.id + ':disabled-during-backoff']);
});

test('one backed-off notification does not delay an independent session’s successful notification', async t => {
  const attempted = [];
  const f = fixture(t, {intervalMs:1000, deliver:async msg => {
    attempted.push(msg.sessionId); if (msg.sessionId === 'offline-session') throw new Error('temporary channel error');
  }});
  const first = f.addRow('offline-session'), other = f.addRow('working-session'); await f.observer.start();
  f.append(first, f.record('task_complete')); await f.observer.tick(); await f.settle(); await f.settle(f.observer, 1000);
  f.append(other, f.record('task_complete')); await f.observer.tick(); await f.settle();
  assert.deepEqual(attempted, ['offline-session','offline-session','working-session']);
  assert.equal(f.observer.hasDelivered({sessionId:other.id, turnId:'turn-a'}), true);
  assert.equal(f.observer.hasDelivered({sessionId:first.id, turnId:'turn-a'}), false);
});

test('a missing transcript does not prevent another session from notifying', async t => {
  const f = fixture(t), missing = f.addRow('missing'), good = f.addRow('good'); await f.observer.start();
  fs.unlinkSync(missing.rollout_path); f.append(good, f.record('task_complete'));
  await f.observer.tick(); await f.settle(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].sessionId, good.id);
  assert.ok(f.logs.some(x => x.event === 'read-failed'));
});

test('restart preserves delivered-event deduplication', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start(); f.append(row, f.record('task_complete', 'delivered'));
  await f.observer.tick(); await f.settle(); await f.observer.stop();
  const next = f.makeObserver(); await next.start(); f.append(row, f.record('task_complete', 'delivered'));
  await next.tick(); await f.settle(next); assert.equal(f.sent.length, 1);
  f.append(row, f.record('task_complete', 'new-after-restart')); await next.tick(); await f.settle(next);
  assert.deepEqual(f.sent.map(x => x.turnId), ['delivered', 'new-after-restart']);
});

test('a completion appended during service downtime is caught from its persisted cursor', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start(); await f.observer.stop(); f.advance(1000);
  f.append(row, f.record('task_complete', 'while-off')); const next = f.makeObserver(); await next.start(); await f.settle(next);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].turnId, 'while-off');
});

test('corrupt state fails clearly and is not overwritten', async t => {
  const f = fixture(t); fs.writeFileSync(f.statePath, '{corrupt');
  await assert.rejects(f.observer.start(), /JSON|Unexpected|position/i);
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), '{corrupt');
});

test('concurrent ticks never send the same completion twice', async t => {
  let attempts = 0, unblock;
  const gate = new Promise(resolve => {unblock = resolve;});
  const f = fixture(t, {deliver:async () => { attempts++; await gate; }});
  const row = f.addRow(); await f.observer.start(); f.append(row, f.record('task_complete')); await f.observer.tick(); f.advance(6000);
  const active = f.observer.tick(); await new Promise(resolve => setImmediate(resolve)); await f.observer.tick();
  assert.equal(attempts, 1); unblock(); await active; await f.settle(); assert.equal(attempts, 1);
});

test('stopping waits for an in-flight notification to finish before closing', async t => {
  let unblock, attempted = false, closed = false;
  const gate = new Promise(resolve => {unblock = resolve;});
  const f = fixture(t, {deliver:async () => { attempted = true; await gate; }});
  const row = f.addRow(); await f.observer.start(); f.append(row, f.record('task_complete'));
  await f.observer.tick(); f.advance(6000); const active = f.observer.tick();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(attempted, true);
  const closing = f.observer.stop().then(() => {closed = true;});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  unblock(); await active; await closing; assert.equal(closed, true);
  const state = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
  assert.ok(state.seen[row.id + ':turn-a'], 'Successful in-flight delivery must be persisted on shutdown');
});

test('a continuation beyond multiple read batches prevents premature completion notification', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start();
  f.append(row, f.record('task_complete', 'earlier'));
  const intermediate = JSON.stringify(f.record('token_count', 'running', 'x'.repeat(1100))) + '\n';
  fs.appendFileSync(row.rollout_path, intermediate.repeat(11000));
  f.append(row, f.record('task_started', 'continuation'));
  await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 0, 'Unread backlog can contain a continuation, so completion is not yet established');
  for (let i = 0; i < 5; i++) await f.settle();
  assert.equal(f.sent.length, 0, 'Continuation after the backlog must cancel the old completion');
  f.append(row, f.record('task_complete', 'continuation', '后续任务完成')); await f.observer.tick(); await f.settle();
  assert.deepEqual(f.sent.map(x => x.turnId), ['continuation']);
});

test('an unfinished trailing record defers completion until a possible continuation is readable', async t => {
  const f = fixture(t), row = f.addRow(); await f.observer.start(); f.append(row, f.record('task_complete', 'earlier'));
  const continuation = JSON.stringify(f.record('task_started', 'later')) + '\n';
  fs.appendFileSync(row.rollout_path, continuation.slice(0, -10)); await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 0, 'Partial tail can contain a continuation, so do not deliver yet');
  fs.appendFileSync(row.rollout_path, continuation.slice(-10)); await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 0);
});

test('policy-filtered notifications are logged as skipped and consumed without retrying', async t => {
  let attempts = 0;
  const f = fixture(t, {deliver:async () => {attempts++; return {decision:'fallback_local', reason:'notify_scope'};}});
  const row = f.addRow(); await f.observer.start(); f.append(row, f.record('task_complete')); await f.observer.tick(); await f.settle(); await f.settle();
  assert.equal(attempts, 1);
  assert.equal(f.logs.filter(x => x.event === 'notification-sent').length, 0);
  assert.equal(f.logs.filter(x => x.event === 'notification-skipped' && x.reason === 'notify_scope').length, 1);
});

test('an active goal stays quiet even across an idle gap longer than the settling window', async t => {
  const f = fixture(t), row = f.addRow(); row.goalStatus = 'active'; await f.observer.start();
  f.append(row, f.record('task_complete', 'goal-progress', '阶段工作完成')); await f.observer.tick();
  await f.settle(f.observer, 120000); await f.settle(f.observer, 120000);
  assert.equal(f.sent.length, 0, 'A completed turn is not the end of an active goal');
  assert.equal(f.observer.hasDelivered({sessionId:row.id, turnId:'goal-progress'}), false);
});

test('finishing the goal releases its pending completion exactly once', async t => {
  const f = fixture(t), row = f.addRow(); row.goalStatus = 'active'; await f.observer.start();
  f.append(row, f.record('task_complete', 'goal-finished', '目标任务已完成')); await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 0); row.goalStatus = 'complete'; await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].turnId, 'goal-finished');
});

test('an automatic continuation cancels earlier goal progress before the goal ends', async t => {
  const f = fixture(t), row = f.addRow(); row.goalStatus = 'active'; await f.observer.start();
  f.append(row, f.record('task_complete', 'goal-stage-one')); await f.observer.tick(); await f.settle();
  f.append(row, f.record('task_started', 'goal-stage-two')); await f.observer.tick();
  row.goalStatus = 'complete'; await f.settle(); assert.equal(f.sent.length, 0, 'Old stage must stay cancelled');
  f.append(row, f.record('task_complete', 'goal-stage-two', '整个目标完成')); await f.observer.tick(); await f.settle();
  assert.deepEqual(f.sent.map(x => x.turnId), ['goal-stage-two']);
});

test('an active goal does not suppress completion of an unrelated session', async t => {
  const f = fixture(t), goal = f.addRow('goal-session'), plain = f.addRow('plain-session'); goal.goalStatus = 'active';
  await f.observer.start(); f.append(goal, f.record('task_complete')); f.append(plain, f.record('task_complete'));
  await f.observer.tick(); await f.settle(); assert.deepEqual(f.sent.map(x => x.sessionId), ['plain-session']);
});

test('an initial transient list failure self-heals while preserving the no-history baseline', async t => {
  let attempts = 0, f;
  f = fixture(t, {intervalMs:1000, listThreads:async () => {
    attempts++; if (attempts === 1) throw new Error('database temporarily busy'); return f.rows();
  }});
  const row = f.addRow(); f.append(row, f.record('task_complete', 'historical'));
  await f.observer.start(); assert.equal(attempts, 1); assert.ok(f.logs.some(x => x.event === 'scan-failed'));
  await f.observer.tick(); assert.equal(attempts, 1, 'Do not retry before the scheduled backoff');
  f.advance(10000); await f.observer.tick(); assert.equal(attempts, 2); await f.settle(); assert.equal(f.sent.length, 0);
  f.append(row, f.record('task_complete', 'after-recovery')); await f.observer.tick(); await f.settle();
  assert.deepEqual(f.sent.map(x => x.turnId), ['after-recovery']);
});

test('a later transient poll failure retries and catches the new completion', async t => {
  let fail = false, attempts = 0, f;
  f = fixture(t, {intervalMs:1000, listThreads:async () => {
    attempts++; if (fail) throw new Error('temporary read permission failure'); return f.rows();
  }});
  const row = f.addRow(); await f.observer.start(); fail = true; f.append(row, f.record('task_complete', 'during-read-failure'));
  await f.observer.tick(); const failedAttempts = attempts;
  fail = false; await f.observer.tick(); assert.equal(attempts, failedAttempts, 'Backoff prevents a busy loop');
  f.advance(10000); await f.observer.tick(); await f.settle(); await f.settle();
  assert.deepEqual(f.sent.map(x => x.turnId), ['during-read-failure']);
});

test('notification summaries are bounded and redact known credential fields', () => {
  const result = safeSummary('api_key=secret-value app_secret=another-value access_token=token-value sk-sensitiveabc ' + '研'.repeat(2000));
  assert.doesNotMatch(result, /secret-value|another-value|token-value|sk-sensitiveabc/);
  assert.ok(Array.from(result).length <= 1200);
});
test('missing old files retry once, back off quietly and recover when the file returns', async t => {
  const f = fixture(t), row = f.addRow(); fs.unlinkSync(row.rollout_path);
  await f.observer.start(); await f.observer.tick();
  assert.equal(f.logs.filter(x => x.event === 'read-failed').length, 1);
  f.advance(5000); await f.observer.tick();
  assert.equal(f.logs.filter(x => x.event === 'read-failed').length, 2);
  f.advance(10000); await f.observer.tick();
  assert.equal(f.logs.filter(x => x.event === 'read-failed').length, 2);
  fs.writeFileSync(row.rollout_path, JSON.stringify(f.record('task_complete', 'returned-file')) + '\n');
  f.advance(60000); await f.observer.tick(); await f.settle();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].turnId, 'returned-file');
});
