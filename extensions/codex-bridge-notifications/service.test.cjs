const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {sendObservedCompletion} = require('../codex-bridge-topic-notifications/delivery.cjs');
const source = fs.readFileSync(process.env.BRIDGE_TEST_SOURCE || require('node:path').resolve(__dirname, '../../dist/cli.js'), 'utf8');
function slice(begin, end) {
  const first = source.indexOf(begin), last = source.indexOf(end, first);
  if (first < 0 || last < 0) throw new Error('Missing test source: ' + begin);
  return source.slice(first, last);
}
const prefs = vm.runInNewContext('(' + slice('function getCliBridgePreferences(', '\nfunction resolveCliBridgeTarget(') + ')', {
  boolOr:(value, fallback) => typeof value === 'boolean' ? value : fallback,
  secondsOr:(value, fallback) => typeof value === 'number' ? value : fallback
});
function setup(extra = {}, deps = {}) {
  const sends = [], logs = [], marked = [];
  const make = vm.runInNewContext('(' + slice('function createCliBridgeService(', '\nfunction shouldStartCliBridge(') + ')', {
    Map, Set, Date, String, Boolean, Promise, clearInterval, setInterval,
    getCliBridgePreferences:prefs,
    resolveCliBridgeTarget:() => ({receiveIdType:'open_id', receiveId:'owner'}),
    sendManagedCard:async (...args) => { sends.push(args); return {messageId:'sent-message'}; },
    buildCliBridgeTaskCompletionCard:input => input,
    sendObservedCompletion,
    log:{info:(...args) => logs.push(args), fail:(...args) => logs.push(args)}, ...deps
  });
  const cfg = {preferences:{cliBridge:{enabled:true, agents:{codex:true}, delivery:'always', taskCompletion:{enabled:true, replyEnabled:true}}}};
  const channel = {rawClient:{im:{v1:{message:{create:async input => {
    sends.push(input);
    const result = deps.sendManagedCard ? await deps.sendManagedCard() : {messageId:'sent-message'};
    return {code:0, data:{message_id:result.messageId}};
  }}}}}};
  const service = make({cfg, channel, presence:async () => ({routeToFeishu:false, reason:'local_active'}),
    localActivity:async () => true, keepAwake:{acquire(){}, release(){}, shutdown(){}},
    onCompletionSent:msg => marked.push(msg), ...extra});
  return {service, cfg, sends, logs, marked};
}
const complete = (extra = {}) => ({type:'task_complete', source:'codex', sessionId:'native-session', turnId:'native-turn',
  cwd:'E:\\', hookEventName:'DesktopObserver', notificationOnly:true, summary:'工作完成', ...extra});

test('explicit always delivery sends a new message even while the user is locally active', async () => {
  const f = setup(); const result = await f.service.handleMessage(complete());
  assert.equal(f.sends.length, 1); assert.equal(result.messageId, 'sent-message');
  assert.equal(f.marked[0].turnId, 'native-turn');
  assert.equal(f.sends[0].data.receive_id, 'owner'); assert.equal(f.sends[0].params.receive_id_type, 'open_id');
  assert.equal(f.sends[0].data.msg_type, 'text');
  assert.match(JSON.parse(f.sends[0].data.content).text, /工作完成/);
});
test('away-only settings preserve local-active suppression', async () => {
  const f = setup(); delete f.cfg.preferences.cliBridge.delivery;
  const result = await f.service.handleMessage(complete());
  assert.equal(result.reason, 'local_active'); assert.equal(f.sends.length, 0);
});
test('completion delivery does not approve or reroute a permission request while locally active', async () => {
  const f = setup(); const result = await f.service.handleMessage(complete({type:'permission_request', toolInput:{}}));
  assert.equal(result.decision, 'fallback_local'); assert.equal(f.sends.length, 0);
});
test('notification-only completion never opens a hook reply waiter even when away', async () => {
  const f = setup({localActivity:async () => false});
  await f.service.handleMessage(complete());
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].data.msg_type, 'text');
});
test('disabled, scope-none, already-delivered and active-goal events do not send', async () => {
  const off = setup(); off.cfg.preferences.cliBridge.enabled = false;
  assert.equal((await off.service.handleMessage(complete())).reason, 'disabled');
  const scope = setup(); scope.cfg.preferences.cliBridge.notifyScope = 'none';
  assert.equal((await scope.service.handleMessage(complete())).reason, 'notify_scope');
  const done = setup({completionAlreadySent:() => true});
  assert.equal((await done.service.handleMessage(complete())).reason, 'already_notified');
  const goal = setup({deferCompletion:() => true});
  assert.equal((await goal.service.handleMessage(complete())).reason, 'goal_active');
  for (const f of [off, scope, done, goal]) assert.equal(f.sends.length, 0);
});

test('an observed terminal failure is sent even while the goal database still says active', async () => {
  let goalReads=0;
  const f = setup({deferCompletion:() => {goalReads++; return true;}});
  const result = await f.service.handleMessage(complete({taskStatus:'failed', summary:'任务受阻：模型容量不足'}));
  assert.equal(f.sends.length, 1); assert.equal(goalReads, 0); assert.equal(result.messageId, 'sent-message');
  assert.equal(f.marked[0].taskStatus, 'failed');
});

test('terminal failures still honor notification disable and directory-scope preferences', async () => {
  const disabled = setup(); disabled.cfg.preferences.cliBridge.enabled = false;
  const scoped = setup(); scoped.cfg.preferences.cliBridge.notifyScope = 'none';
  await disabled.service.handleMessage(complete({taskStatus:'failed'}));
  await scoped.service.handleMessage(complete({taskStatus:'failed'}));
  assert.equal(disabled.sends.length, 0); assert.equal(scoped.sends.length, 0);
});

test('a failure and a success from the same native turn do not share an in-flight notification', async () => {
  const f = setup();
  await Promise.all([
    f.service.handleMessage(complete({taskStatus:'failed', summary:'原轮次失败'})),
    f.service.handleMessage(complete({taskStatus:'completed', summary:'原轮次已恢复完成'}))
  ]);
  assert.equal(f.sends.length, 2);
  assert.deepEqual(f.marked.map(msg => msg.taskStatus).sort(), ['completed','failed']);
});

test('duplicate terminal-failure events still share a single notification send', async () => {
  const f = setup(); const failure = complete({taskStatus:'failed'});
  await Promise.all([f.service.handleMessage(failure), f.service.handleMessage({...failure})]);
  assert.equal(f.sends.length, 1); assert.equal(f.marked.length, 1);
});
test('simultaneous hook and observer completion share one send', async () => {
  let finish; let count = 0;
  const f = setup({}, {sendManagedCard:() => {count++; return new Promise(resolve => {finish=resolve;});}});
  const first = f.service.handleMessage(complete()); const second = f.service.handleMessage(complete());
  await new Promise(resolve => setImmediate(resolve)); finish({messageId:'single'});
  const results = await Promise.all([first, second]);
  assert.equal(count, 1); assert.equal(results[0].messageId, results[1].messageId);
});
test('failed sends release the in-flight key so the observer retry can deliver', async () => {
  let count = 0;
  const f = setup({}, {sendManagedCard:async () => {if (++count === 1) throw new Error('temporary network failure'); return {messageId:'retry'};}});
  await assert.rejects(f.service.handleMessage(complete()), /temporary/);
  assert.equal((await f.service.handleMessage(complete())).messageId, 'retry');
  assert.equal(count, 2); assert.equal(f.marked.length, 1);
});
test('observer deduplication waits for card delivery without waiting for the user hook reply', async () => {
  let finishCard, finishReply;
  const f = setup({localActivity:async () => false}, {
    TASK_DONE_CLICKED:'done',
    sendManagedCard:() => new Promise(resolve => {finishCard=resolve;}),
    createPendingCliInteraction:input => ({...input, id:'pending'}),
    setPendingCliMessageId(){},
    waitForPendingCliInteraction:() => new Promise(resolve => {finishReply=resolve;})
  });
  const hook = f.service.handleMessage(complete({notificationOnly:false, hookEventName:'Stop'}));
  const observer = f.service.handleMessage(complete());
  await new Promise(resolve => setImmediate(resolve)); finishCard({messageId:'one-card'});
  let timeout;
  try {
    const result = await Promise.race([observer, new Promise((_,reject) => {timeout=setTimeout(() => reject(new Error('Observer waited for a user reply')), 1000);})]);
    assert.equal(result.messageId, 'one-card');
    assert.equal(typeof finishReply, 'function', 'The native hook must retain its own reply interaction');
  } finally {
    clearTimeout(timeout);
    finishReply?.({decision:'allow', reason:'done'});
    await hook;
  }
});
test('only sent native completion or terminal-error reminders register the matching outcome receipt', async () => {
  const code = slice('  async function sendCompletionReminder(input2)', '\n  async function acquireRunSlot(');
  for (const [sent, outcome] of [['sent','done'], ['failed','done'], ['skipped','done'], ['sent','idle_timeout'], ['sent','error'], ['sent','interrupted'], ['sent','cancelled']]) {
    const marked = [];
    const run = vm.runInNewContext('(function(){' + code + ';return sendCompletionReminder;})()', {
      channel:{}, cfg:{}, completionReminderSent:{},
      sendCompletionReminderReply:async () => sent,
      desktopCompletionObservers:new Set([{markDelivered:msg => marked.push(msg)}])
    });
    await run({sessionId:'original', turnId:'turn', outcome});
    const terminal = outcome === 'done' || outcome === 'error';
    assert.equal(marked.length, sent === 'sent' && terminal ? 1 : 0, sent + '/' + outcome);
    if (marked.length) assert.equal(marked[0].taskStatus, outcome === 'error' ? 'failed' : undefined);
  }
});

test('a sent terminal-error reminder suppresses only its failed observer notification', async t => {
  const path = require('node:path');
  const {createCodexObserver} = require('./observer.cjs');
  const base = path.resolve('work/timeout-notification-fixtures');
  fs.mkdirSync(base, {recursive:true}); const dir = fs.mkdtempSync(path.join(base, 'failed-'));
  const observer = createCodexObserver({statePath:path.join(dir,'state.json'), listThreads:async () => [], deliver:async () => {}});
  t.after(async () => { await observer.stop(); assert.ok(path.resolve(dir).startsWith(base + path.sep)); fs.rmSync(dir, {recursive:true,force:true}); });
  await observer.start(); observer.markBridgeTurn('original','turn');
  const code = slice('  async function sendCompletionReminder(input2)', '\n  async function acquireRunSlot(');
  const reminder = vm.runInNewContext('(function(){' + code + ';return sendCompletionReminder;})()', {
    channel:{},cfg:{},completionReminderSent:{},sendCompletionReminderReply:async () => 'sent',desktopCompletionObservers:new Set([observer])
  });
  await reminder({sessionId:'original',turnId:'turn',outcome:'error'});
  assert.equal(observer.hasDelivered({sessionId:'original',turnId:'turn',taskStatus:'failed'}), true);
  assert.equal(observer.hasDelivered({sessionId:'original',turnId:'turn',taskStatus:'completed'}), false);
  assert.equal(observer.hasManagedTurn({sessionId:'original',turnId:'turn'}), false);
});
test('a watchdog reminder cannot suppress the eventual native completion notification', async t => {
  const path = require('node:path');
  const {createCodexObserver} = require('./observer.cjs');
  const base = path.resolve('work/timeout-notification-fixtures');
  fs.mkdirSync(base, {recursive:true});
  const dir = fs.mkdtempSync(path.join(base, 'completion-'));
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, '');
  const delivered = [];
  const now = Date.parse('2026-10-30T06:00:00Z');
  const observer = createCodexObserver({statePath:path.join(dir,'state.json'),
    listThreads:async () => [{id:'original', source:'vscode', cwd:'E:\\', rollout_path:transcript}],
    now:() => now, settleMs:0, managedGraceMs:0, intervalMs:1000000000,
    deliver:async msg => {delivered.push(msg);}});
  t.after(async () => {
    await observer.stop();
    assert.ok(path.resolve(dir).startsWith(base + path.sep));
    fs.rmSync(dir, {recursive:true, force:true});
  });
  await observer.start(); observer.markBridgeTurn('original','turn');
  const code = slice('  async function sendCompletionReminder(input2)', '\n  async function acquireRunSlot(');
  const reminder = vm.runInNewContext('(function(){' + code + ';return sendCompletionReminder;})()', {
    channel:{}, cfg:{}, completionReminderSent:{}, sendCompletionReminderReply:async () => 'sent',
    desktopCompletionObservers:new Set([observer])});
  await reminder({sessionId:'original', turnId:'turn', outcome:'idle_timeout'});
  assert.equal(observer.hasDelivered({sessionId:'original',turnId:'turn'}), false);
  fs.appendFileSync(transcript, JSON.stringify({timestamp:new Date(now).toISOString(), type:'event_msg',
    payload:{type:'task_complete', turn_id:'turn', last_agent_message:'原任务继续后已完成'}}) + '\n');
  await observer.tick(); await observer.tick();
  assert.equal(delivered.length, 1); assert.equal(delivered[0].turnId, 'turn');
});
test('a Feishu API rejection is an error and never marks the notification delivered', async () => {
  const f = setup({channel:{rawClient:{im:{v1:{message:{create:async () => ({code:999, data:{}})}}}}}});
  await assert.rejects(f.service.handleMessage(complete()), /Feishu notification rejected: 999/);
  assert.equal(f.marked.length, 0);
});
test('bound completions invoke the topic resolver and return their actual group destination', async () => {
  const replies = [];
  const topic = {chatId:'group', threadId:'topic', messageId:'topic-anchor'};
  const f = setup({resolveCompletionTopic:async () => topic, channel:{rawClient:{im:{v1:{message:{
    reply:async input => {replies.push(input); return {code:0, data:{message_id:'group-result', chat_id:'group'}};}
  }}}}}});
  const result = await f.service.handleMessage(complete());
  assert.equal(result.destination, 'bound_topic'); assert.equal(result.chatId, 'group');
  assert.equal(result.threadId, 'topic'); assert.equal(replies[0].path.message_id, 'topic-anchor');
  assert.equal(replies[0].data.reply_in_thread, true);
});
test('interactive coffee completions retain the owner card and do not invoke topic routing', async () => {
  const f = setup({resolveCompletionTopic:async () => {throw new Error('Must not resolve an interactive owner card');}});
  const result = await f.service.handleMessage(complete({notificationOnly:false}));
  assert.equal(result.destination, 'owner'); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0][1], 'owner');
});
test('a bound-topic lookup failure is retriable and is not reported as a successful private notification', async () => {
  const f = setup({resolveCompletionTopic:async () => {throw new Error('Temporary topic lookup failure');}});
  await assert.rejects(f.service.handleMessage(complete()), /Temporary topic lookup failure/);
  assert.equal(f.sends.length, 0); assert.equal(f.marked.length, 0);
});
