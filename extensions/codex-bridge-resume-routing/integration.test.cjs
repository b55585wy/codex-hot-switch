const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {topicLinkFromMessage, retryBeforeTlsEstablished} = require('./router.cjs');
const source = fs.readFileSync(process.env.BRIDGE_TEST_SOURCE || path.resolve(__dirname, '../../dist/cli.js'), 'utf8');
const ID = '00000000-0000-4000-8000-000000000001';
function between(start, end) {
  const begin = source.indexOf(start), finish = source.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && finish > begin, 'Expected staged implementation anchors: ' + start);
  return source.slice(begin, finish);
}
function loadFunction(name, end, deps) {
  return vm.runInNewContext('(function(){' + between('  async function ' + name + '(', end) + '; return ' + name + ';})()', deps);
}
function fixture(options = {}) {
  const active = new Map(), sessions = new Map(), lastUsage = new Map();
  const calls = {send:[], reply:[], upsert:[], getThreadId:[], native:[], get:[], list:[], warn:[]};
  const project = {name:'项目模块', cwd:'E:\\work', chatId:'oc_target_group', kind:options.single ? 'single' : 'multi'};
  const native = {id:ID, cwd:'\\\\?\\E:\\work\\module', name:'后端接口'};
  const msg = {chatId:'oc_private_dm', messageId:'om_private_command', senderId:'ou_owner', chatType:'p2p'};
  const key = 'flat:' + project.chatId;
  const nativeForbidden = () => { calls.native.push(true); throw new Error('Binding must not start or resume a native task'); };
  const channel = {
    send:async (...args) => {calls.send.push(args); return {messageId:'om_group_anchor'};},
    rawClient:{im:{v1:{message:{
      reply:async request => {calls.reply.push(request); return options.reply || {data:{message_id:'om_topic_reply', thread_id:'omt_created'}};},
      get:async request => {calls.get.push(request); if (options.getError) throw options.getError; return {data:{items:options.messageItems || []}};},
      list:async request => {calls.list.push(request); return {data:{items:options.messageItems || []}};}
    }}}}
  };
  const deps = {
    active, sessions, lastUsage, channel, paths:{sessionsFile:'test-sessions.json'},
    presentSession:() => ({moduleName:'后端接口'}), cardText:value => value,
    turnSession:() => ({sessionKey:key}),
    getThreadId:async (...args) => {calls.getThreadId.push(args); return options.fallbackThreadId;},
    upsertSession:async record => {if (options.onUpsert) await options.onUpsert(record, {active,key}); calls.upsert.push(record);},
    log:{info:() => {}, warn:(...args) => calls.warn.push(args)},
    backendFor:nativeForbidden, createThread:nativeForbidden, resumeThread:nativeForbidden, startTurn:nativeForbidden,
    openChatUrl:chatId => 'https://applink.feishu.cn/client/chat/open?openChatId=' + chatId,
    topicLinkFromMessage, retryBeforeTlsEstablished
  };
  const bind = loadFunction('bindExactSession', '  const exactResume', deps);
  const link = loadFunction('resumeTopicLink', '  async function bindExactSession', deps);
  return {bind, link, active, sessions, lastUsage, calls, project, native, msg, key};
}

test('private resume creates its anchor in the project group and replies to that anchor as a topic', async () => {
  const f = fixture(); const record = await f.bind(f.project, f.native, f.msg);
  assert.equal(f.calls.send[0][0], f.project.chatId); assert.notEqual(f.calls.send[0][0], f.msg.chatId);
  assert.equal(f.calls.reply[0].path.message_id, 'om_group_anchor'); assert.notEqual(f.calls.reply[0].path.message_id, f.msg.messageId);
  assert.equal(f.calls.reply[0].data.reply_in_thread, true);
  assert.equal(record.sessionId, ID); assert.equal(record.cwd, f.native.cwd); assert.equal(record.chatId, f.project.chatId);
  assert.equal(record.threadId, 'omt_created'); assert.equal(record.rootMessageId, 'om_group_anchor');
  assert.equal(record.topicMessageId, 'om_topic_reply'); assert.equal(f.calls.upsert.length, 1); assert.equal(f.calls.native.length, 0);
});

test('a topic ID omitted from the reply is resolved from its returned group message ID', async () => {
  const f = fixture({reply:{data:{message_id:'om_topic_reply'}}, fallbackThreadId:'omt_lookup'});
  const record = await f.bind(f.project, f.native, f.msg);
  assert.equal(record.threadId, 'omt_lookup'); assert.equal(f.calls.getThreadId.length, 1);
  assert.equal(f.calls.getThreadId[0][1], 'om_topic_reply'); assert.equal(f.calls.upsert.length, 1);
});

test('missing topic ID fails before writing a session mapping or starting native work', async () => {
  const f = fixture({reply:{data:{message_id:'om_topic_reply'}}});
  await assert.rejects(f.bind(f.project, f.native, f.msg), /话题 ID/);
  assert.equal(f.calls.upsert.length, 0); assert.equal(f.calls.native.length, 0);
});

test('missing reply message and topic IDs cannot create an invalid mapping', async () => {
  const f = fixture({reply:{data:{}}}); await assert.rejects(f.bind(f.project, f.native, f.msg), /话题 ID/);
  assert.equal(f.calls.upsert.length, 0); assert.equal(f.calls.getThreadId.length, 0);
});

test('an active single-session group is not rebound or interrupted', async () => {
  const f = fixture({single:true}), running = {queue:[], busy:true}; let closed = 0;
  f.active.set(f.key, running); f.sessions.set(f.key, {close:async () => {closed++;}});
  await assert.rejects(f.bind(f.project, f.native, f.msg), /正在执行/);
  assert.equal(f.calls.upsert.length, 0); assert.equal(closed, 0); assert.equal(f.active.get(f.key), running);
  assert.equal(f.calls.send.length, 0); assert.equal(f.calls.native.length, 0);
});

test('successful single-session rebind closes only its old client and clears its own cached state', async () => {
  const f = fixture({single:true}); let ownClosed = 0, otherClosed = 0;
  const old = {close:async () => {ownClosed++;}}, other = {close:async () => {otherClosed++;}};
  f.sessions.set(f.key, old); f.sessions.set('other-session', other); f.lastUsage.set(f.key, 20); f.lastUsage.set('other-session', 40);
  const record = await f.bind(f.project, f.native, f.msg);
  assert.equal(record.sessionId, ID); assert.equal(record.threadId, f.key); assert.equal(record.cwd, f.native.cwd);
  assert.equal(f.calls.upsert.length, 1); assert.equal(ownClosed, 1); assert.equal(otherClosed, 0);
  assert.equal(f.sessions.has(f.key), false); assert.equal(f.sessions.get('other-session'), other);
  assert.equal(f.lastUsage.has(f.key), false); assert.equal(f.lastUsage.get('other-session'), 40);
  assert.equal(f.active.has(f.key), false); assert.equal(f.calls.reply.length, 0); assert.equal(f.calls.native.length, 0);
});

test('a registry-write failure releases the single-session reservation and preserves its old client', async () => {
  const f = fixture({single:true, onUpsert:async () => {throw new Error('registry permission denied');}}); let closed = 0;
  const old = {close:async () => {closed++;}}; f.sessions.set(f.key, old); f.lastUsage.set(f.key, 12);
  await assert.rejects(f.bind(f.project, f.native, f.msg), /permission denied/);
  assert.equal(f.active.has(f.key), false); assert.equal(f.sessions.get(f.key), old); assert.equal(closed, 0);
  assert.equal(f.lastUsage.get(f.key), 12); assert.equal(f.calls.upsert.length, 0); assert.equal(f.calls.native.length, 0);
});

test('queued commands during a failed switch are reported for resubmission rather than executed', async () => {
  const f = fixture({single:true, onUpsert:async (record, {active,key}) => {
    active.get(key).queue.push({text:'下一步指令'}); throw new Error('registry failed');
  }});
  await assert.rejects(f.bind(f.project, f.native, f.msg), /registry failed/);
  assert.equal(f.active.has(f.key), false); assert.equal(f.calls.native.length, 0); assert.equal(f.calls.send.length, 1);
  assert.equal(f.calls.send[0][0], f.project.chatId); assert.match(f.calls.send[0][1].markdown, /1 条指令尚未执行/);
});

test('old-client close failure does not undo a successful single-session registry switch', async () => {
  const f = fixture({single:true}); f.sessions.set(f.key, {close:async () => {throw new Error('already detached');}});
  const record = await f.bind(f.project, f.native, f.msg);
  assert.equal(record.sessionId, ID); assert.equal(f.active.has(f.key), false); assert.equal(f.sessions.has(f.key), false);
});

test('topic links prefer Feishu’s exact message_app_link over inferred coordinates', () => {
  const exact = 'https://applink.feishu.cn/client/thread/open?verified=real';
  assert.equal(topicLinkFromMessage({message_app_link:exact, thread_id:'omt_t', thread_message_position:0, message_position:9}, 'oc_group'), exact);
});

test('thread_message_position zero produces a valid topic link for the correct group', () => {
  const url = new URL(topicLinkFromMessage({thread_id:'omt_t', thread_message_position:0}, 'oc_group'));
  assert.equal(url.pathname, '/client/thread/open'); assert.equal(url.searchParams.get('thread_position'), '0');
  assert.equal(url.searchParams.get('openthreadid'), 'omt_t'); assert.equal(url.searchParams.get('openchatid'), 'oc_group');
  assert.equal(url.searchParams.get('open_thread_id'), 'omt_t'); assert.equal(url.searchParams.get('open_chat_id'), 'oc_group');
});

test('chat message_position is a fallback when topic coordinates are unavailable', () => {
  const url = new URL(topicLinkFromMessage({thread_id:'omt_t', message_position:0}, 'oc_group'));
  assert.equal(url.pathname, '/client/chat/open'); assert.equal(url.searchParams.get('openChatId'), 'oc_group');
  assert.equal(url.searchParams.get('position'), '0');
});

test('unverified generic position fields and malformed coordinates are not invented into topic links', () => {
  assert.equal(topicLinkFromMessage({thread_id:'omt_t', position:0, thread_position:0}, 'oc_group'), undefined);
  for (const position of [-1, 'NaN', '', '1.5', 'x']) {
    assert.equal(topicLinkFromMessage({thread_id:'omt_t', thread_message_position:position}, 'oc_group'), undefined);
  }
  assert.equal(topicLinkFromMessage(undefined, 'oc_group'), undefined);
});

test('link lookup prefers the recorded topic message over the group anchor', async () => {
  const f = fixture({messageItems:[{thread_id:'omt_t', thread_message_position:0}]});
  const url = await f.link({threadId:'omt_t', topicMessageId:'om_topic', rootMessageId:'om_anchor'}, f.project);
  assert.equal(f.calls.get[0].path.message_id, 'om_topic'); assert.equal(f.calls.list.length, 0);
  assert.equal(new URL(url).searchParams.get('thread_position'), '0');
});

test('legacy mappings without message anchors query the first message of their own topic', async () => {
  const f = fixture({messageItems:[{message_app_link:'https://applink.feishu.cn/client/thread/open?legacy=1'}]});
  const url = await f.link({threadId:'omt_legacy'}, f.project);
  assert.equal(f.calls.get.length, 0); assert.equal(f.calls.list[0].params.container_id_type, 'thread');
  assert.equal(f.calls.list[0].params.container_id, 'omt_legacy'); assert.equal(f.calls.list[0].params.page_size, 1);
  assert.equal(f.calls.list[0].params.sort_type, 'ByCreateTimeAsc'); assert.match(url, /legacy=1/);
});

test('message lookup failure falls back to a group link without losing the binding', async () => {
  const f = fixture({getError:new Error('message unavailable')}); const url = await f.link({topicMessageId:'om_t', threadId:'omt_t'}, f.project);
  assert.equal(new URL(url).searchParams.get('openChatId'), f.project.chatId); assert.equal(f.calls.warn.length, 1);
});

test('single-session records without topic anchors use the group link without message API calls', async () => {
  const f = fixture({single:true}); const url = await f.link({threadId:f.project.chatId}, f.project);
  assert.equal(new URL(url).searchParams.get('openChatId'), f.project.chatId);
  assert.equal(f.calls.get.length + f.calls.list.length, 0);
});

test('private /resume is routed before coffee replies or generic private-chat commands', async () => {
  const calls = [];
  const fragment = between('    if (msg.chatType === "p2p") {', '    const project = await getProjectByChatId');
  const handle = vm.runInNewContext('(async function(msg){' + fragment + '})', {
    exactResume:async msg => calls.push('resume'), cliBridge:{onMessage:() => {calls.push('coffee'); return true;}},
    handleDmConsole:async () => calls.push('console'), channel:{}, cfg:{}
  });
  await handle({chatType:'p2p', content:'/resume ' + ID}); assert.deepEqual(calls, ['resume']);
});

test('other private messages retain their existing coffee interaction route', async () => {
  const calls = [], fragment = between('    if (msg.chatType === "p2p") {', '    const project = await getProjectByChatId');
  const handle = vm.runInNewContext('(async function(msg){' + fragment + '})', {
    exactResume:async () => calls.push('resume'), cliBridge:{onMessage:() => {calls.push('coffee'); return true;}},
    handleDmConsole:async () => calls.push('console'), channel:{}, cfg:{}
  });
  await handle({chatType:'p2p', content:'继续下一步'}); assert.deepEqual(calls, ['coffee']);
});

test('explicit group session IDs invoke the exact router with the current project', async () => {
  const calls = [], project = {chatId:'oc_group'}, fragment = '    const text = msg.content.trim();\n' + between('    const cmd = parseCommand(text);', '    const goalObjective = parseGoalTrigger(text);');
  const handle = vm.runInNewContext('(async function(msg,project){' + fragment + '})', {
    parseCommand:() => 'resume', exactResume:async (msg, target) => calls.push({msg,target})
  });
  await handle({content:'/resume ' + ID}, project); assert.equal(calls.length, 1); assert.equal(calls[0].target, project);
  await handle({content:'/resume'}, project); assert.equal(calls.length, 1, 'No-argument command remains available to the normal picker');
});

test('no-argument /resume retains the existing single-group and main-group pickers', () => {
  assert.ok(source.includes('if (cmd === "resume") {\n        postResumeCard(msg, ts.sessionKey);'));
  assert.ok(source.includes('if (cmd === "resume") {\n      postResumeCard(msg);'));
});

test('a socket failure before TLS is established retries once and returns the successful result', async () => {
  let attempts = 0;
  const result = await retryBeforeTlsEstablished(async () => {
    if (++attempts === 1) throw new Error('Client network socket disconnected before secure TLS connection was established');
    return {messageId:'om_success'};
  });
  assert.equal(attempts, 2); assert.equal(result.messageId, 'om_success');
});

test('a repeated pre-TLS failure propagates after exactly one retry', async () => {
  let attempts = 0;
  await assert.rejects(retryBeforeTlsEstablished(async () => {
    attempts++; throw new Error('Client network socket disconnected before secure TLS connection was established');
  }), /before secure TLS/);
  assert.equal(attempts, 2);
});

test('an ambiguous reset after sending is not retried because it could create a duplicate topic', async () => {
  let attempts = 0; const error = Object.assign(new Error('socket hang up after request was sent'), {code:'ECONNRESET'});
  await assert.rejects(retryBeforeTlsEstablished(async () => {attempts++; throw error;}), candidate => candidate === error);
  assert.equal(attempts, 1);
});
