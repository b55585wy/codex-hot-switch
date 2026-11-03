const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {findBoundCompletionTopic, sendObservedCompletion, notificationUuid} = require('./delivery.cjs');
const {withinProject} = require('../codex-bridge-resume-routing/router.cjs');
const ID = '00000000-0000-4000-8000-000000000002';
const OTHER_ID = '00000000-0000-4000-8000-000000000001';
const fixtureBase = path.resolve(__dirname, '../../work/topic-notification-test-fixtures');

function fixture(t, options = {}) {
  fs.mkdirSync(fixtureBase, {recursive:true}); const dir = fs.mkdtempSync(path.join(fixtureBase, 'delivery-'));
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(fixtureBase + path.sep), 'Cleanup must stay inside the explicit workspace fixture directory');
    fs.rmSync(dir, {recursive:true, force:true});
  });
  const project = {name:'模块项目', cwd:'E:\\work', chatId:'oc_project', backend:'codex-appserver', kind:'multi', blank:false, ...options.project};
  const record = {sessionId:ID, chatId:project.chatId, threadId:'omt_module', backend:'codex-appserver', cwd:'E:\\work\\module',
    topicMessageId:'om_topic', rootMessageId:'om_root', updatedAt:100, ...options.record};
  const projects = options.projects || [project], records = options.records || [record];
  const sessionsFile = path.join(dir, 'sessions.json'), projectsFile = path.join(dir, 'projects.json');
  fs.writeFileSync(sessionsFile, JSON.stringify({version:3, sessions:records}));
  fs.writeFileSync(projectsFile, JSON.stringify({version:1, projects}));
  const calls = {get:[], list:[], reply:[], create:[]};
  const anchor = {message_id:'om_topic', chat_id:record.chatId, thread_id:record.threadId, ...options.anchor};
  const channel = {rawClient:{im:{v1:{message:{
    get:async request => {calls.get.push(request); if (options.getError) throw options.getError; return options.lookupResponse || {code:0,data:{items:[anchor]}};},
    list:async request => {calls.list.push(request); if (options.listError) throw options.listError; return options.lookupResponse || {code:0,data:{items:[anchor]}};},
    reply:async request => {calls.reply.push(request); if (options.sendError) throw options.sendError; return options.sendResponse || {code:0,data:{message_id:'om_notification',chat_id:record.chatId}};},
    create:async request => {calls.create.push(request); if (options.sendError) throw options.sendError; return options.sendResponse || {code:0,data:{message_id:'om_notification',chat_id:project.chatId}};}
  }}}}};
  const msg = {source:'codex', sessionId:ID, turnId:'turn-completed', cwd:'E:\\work\\module', summary:'后端接口的本轮检查已完成。', ...options.msg};
  const target = {receiveIdType:'open_id', receiveId:'ou_owner'};
  const opts = {sessionsFile, projectsFile, channel, withinProject, isChatAllowed:chatId => !(options.deniedChats || []).includes(chatId)};
  return {dir, sessionsFile, projectsFile, project, record, records, projects, channel, calls, msg, target, opts,
    find:() => findBoundCompletionTopic(msg, opts)};
}

test('a bound completion resolves its recorded topic message and retains its exact session’s project', async t => {
  const f = fixture(t); const topic = await f.find();
  assert.equal(topic.chatId, f.project.chatId); assert.equal(topic.threadId, f.record.threadId);
  assert.equal(topic.messageId, 'om_topic'); assert.equal(topic.projectName, f.project.name);
  assert.equal(f.calls.get[0].path.message_id, 'om_topic'); assert.equal(f.calls.list.length, 0);
});

test('a group root message is used when no topic message anchor was stored', async t => {
  const f = fixture(t, {record:{topicMessageId:undefined}, anchor:{message_id:'om_root'}}); const topic = await f.find();
  assert.equal(f.calls.get[0].path.message_id, 'om_root'); assert.equal(topic.messageId, 'om_root');
});

test('legacy records resolve the first real message from their own topic', async t => {
  const f = fixture(t, {record:{topicMessageId:undefined, rootMessageId:undefined}}); const topic = await f.find();
  assert.equal(f.calls.get.length, 0); assert.equal(f.calls.list.length, 1);
  assert.equal(f.calls.list[0].params.container_id_type, 'thread'); assert.equal(f.calls.list[0].params.container_id, 'omt_module');
  assert.equal(f.calls.list[0].params.page_size, 1); assert.equal(f.calls.list[0].params.sort_type, 'ByCreateTimeAsc');
  assert.equal(topic.messageId, 'om_topic');
});

test('the newest valid registered binding is selected instead of another native session or backend', async t => {
  const records = [
    {sessionId:ID,chatId:'oc_project',threadId:'omt_old',backend:'codex-appserver',topicMessageId:'om_old',updatedAt:10},
    {sessionId:ID,chatId:'oc_project',threadId:'omt_new',backend:'codex-appserver',topicMessageId:'om_new',updatedAt:20},
    {sessionId:OTHER_ID,chatId:'oc_project',threadId:'omt_other',backend:'codex-appserver',topicMessageId:'om_other',updatedAt:100},
    {sessionId:ID,chatId:'oc_project',threadId:'omt_claude',backend:'claude-code',topicMessageId:'om_claude',updatedAt:200}
  ];
  const f = fixture(t, {records, anchor:{message_id:'om_new',thread_id:'omt_new'}}); const topic = await f.find();
  assert.equal(topic.threadId, 'omt_new'); assert.equal(f.calls.get[0].path.message_id, 'om_new');
});

for (const reason of ['unregistered', 'denied', 'wrong-directory', 'wrong-backend', 'blank']) {
  test('a newer ' + reason + ' destination cannot displace an older valid registered topic', async t => {
    const extra = {name:'另一个项目',chatId:'oc_extra',cwd:'E:\\work',kind:'multi',backend:'codex-appserver'};
    if (reason === 'wrong-directory') extra.cwd = 'D:\\other';
    if (reason === 'wrong-backend') extra.backend = 'claude-code';
    if (reason === 'blank') extra.blank = true;
    const base = {name:'模块项目',chatId:'oc_project',cwd:'E:\\work',kind:'multi',backend:'codex-appserver'};
    const records = [
      {sessionId:ID,chatId:'oc_project',threadId:'omt_module',backend:'codex-appserver',topicMessageId:'om_topic',updatedAt:10},
      {sessionId:ID,chatId:'oc_extra',threadId:'omt_wrong',backend:'codex-appserver',topicMessageId:'om_wrong',updatedAt:100}
    ];
    const f = fixture(t, {records, projects:reason === 'unregistered' ? [base] : [base,extra], deniedChats:reason === 'denied' ? ['oc_extra'] : []});
    const topic = await f.find(); assert.equal(topic.chatId, 'oc_project'); assert.equal(topic.threadId, 'omt_module');
    assert.equal(f.calls.get[0].path.message_id, 'om_topic');
  });
}

test('a missing binding returns no topic without performing message API calls', async t => {
  const f = fixture(t, {records:[]}); assert.equal(await f.find(), undefined);
  assert.equal(f.calls.get.length + f.calls.list.length + f.calls.create.length + f.calls.reply.length, 0);
});

test('a non-Codex event does not reuse a Codex topic with the same session ID', async t => {
  const f = fixture(t, {msg:{source:'claude'}}); assert.equal(await f.find(), undefined);
  assert.equal(f.calls.get.length + f.calls.list.length, 0);
});

test('a record without an exact Codex backend is not silently treated as a native binding', async t => {
  const f = fixture(t, {record:{backend:undefined}}); assert.equal(await f.find(), undefined);
  assert.equal(f.calls.get.length + f.calls.list.length, 0);
});

test('a single-session project returns a flat destination without topic-anchor lookups', async t => {
  const f = fixture(t, {project:{kind:'single'}, record:{threadId:'oc_project'}}); const topic = await f.find();
  assert.equal(topic.flat, true); assert.equal(topic.chatId, 'oc_project'); assert.equal(topic.threadId, 'oc_project');
  assert.equal(f.calls.get.length + f.calls.list.length, 0);
});

for (const [description, anchor] of [
  ['different chat', {chat_id:'oc_wrong'}], ['different thread', {thread_id:'omt_wrong'}],
  ['missing message ID', {message_id:undefined}], ['deleted anchor', {deleted:true}]
]) {
  test('a stale bound destination with ' + description + ' fails for retry without silently sending a DM', async t => {
    const f = fixture(t, {anchor}); await assert.rejects(f.find());
    assert.equal(f.calls.create.length + f.calls.reply.length, 0);
  });
}

test('message metadata may omit chat/thread fields when the requested anchor exists', async t => {
  const f = fixture(t, {anchor:{chat_id:undefined,thread_id:undefined}}); const topic = await f.find();
  assert.equal(topic.messageId, 'om_topic'); assert.equal(topic.threadId, 'omt_module');
});

test('an unavailable or denied anchor lookup propagates its failure for the durable retry queue', async t => {
  const error = new Error('Feishu permission denied'), f = fixture(t, {getError:error});
  await assert.rejects(f.find(), candidate => candidate === error); assert.equal(f.calls.create.length, 0);
});

test('a rejected anchor API response is not accepted as a usable topic', async t => {
  const f = fixture(t, {lookupResponse:{code:99991672,msg:'permission denied'}});
  await assert.rejects(f.find()); assert.equal(f.calls.create.length, 0);
});

test('invalid registry data fails explicitly rather than falling back to a different destination', async t => {
  const f = fixture(t); fs.writeFileSync(f.sessionsFile, JSON.stringify({sessions:{}}));
  await assert.rejects(f.find(), /registry/i); assert.equal(f.calls.create.length + f.calls.reply.length, 0);
});

test('a bound multi-topic notification replies in its exact topic and mentions the owner on the first post line', async t => {
  const f = fixture(t), topic = await f.find();
  const result = await sendObservedCompletion({msg:f.msg,target:f.target,topic,channel:f.channel});
  assert.equal(f.calls.reply.length, 1); assert.equal(f.calls.create.length, 0);
  const request = f.calls.reply[0]; assert.equal(request.path.message_id, topic.messageId);
  assert.equal(request.data.reply_in_thread, true); assert.equal(request.data.msg_type, 'post');
  const content = JSON.parse(request.data.content);
  assert.ok(content.zh_cn.content[0].some(item => item.tag === 'at' && item.user_id === f.target.receiveId));
  assert.ok(request.data.content.includes(f.msg.summary)); assert.ok(request.data.content.includes(ID), 'Original native ID must remain visible');
  assert.equal(result.destination, 'bound_topic'); assert.equal(result.messageId, 'om_notification');
  assert.equal(result.chatId, topic.chatId); assert.equal(result.threadId, topic.threadId);
});

test('an unbound completion sends only a text notification to the owner open ID', async t => {
  const f = fixture(t, {records:[]}); const topic = await f.find();
  const result = await sendObservedCompletion({msg:f.msg,target:f.target,topic,channel:f.channel});
  assert.equal(f.calls.reply.length, 0); assert.equal(f.calls.create.length, 1);
  const request = f.calls.create[0]; assert.equal(request.params.receive_id_type, 'open_id');
  assert.equal(request.data.receive_id, 'ou_owner'); assert.equal(request.data.msg_type, 'text');
  assert.match(JSON.parse(request.data.content).text, /后端接口的本轮检查已完成/);
  assert.ok(JSON.parse(request.data.content).text.includes(ID), 'Original native ID must remain visible');
  assert.equal(result.destination, 'owner'); assert.equal(result.messageId, 'om_notification');
});

test('a flat single-session destination creates an owner-mentioned post in the group', async t => {
  const f = fixture(t, {project:{kind:'single'},record:{threadId:'oc_project'}}), topic = await f.find();
  const result = await sendObservedCompletion({msg:f.msg,target:f.target,topic,channel:f.channel});
  assert.equal(f.calls.reply.length, 0); assert.equal(f.calls.create.length, 1);
  const request = f.calls.create[0]; assert.equal(request.params.receive_id_type, 'chat_id');
  assert.equal(request.data.receive_id, topic.chatId); assert.equal(request.data.msg_type, 'post');
  const content = JSON.parse(request.data.content);
  assert.ok(content.zh_cn.content[0].some(item => item.tag === 'at' && item.user_id === f.target.receiveId));
  assert.equal(result.destination, 'bound_topic'); assert.equal(result.chatId, topic.chatId);
});

test('notification UUIDs are stable for the event and destination, and isolate other events and destinations', () => {
  const msg = {source:'codex',sessionId:ID,turnId:'turn-a'};
  const uuid = notificationUuid(msg, 'oc_group:omt_topic');
  assert.equal(notificationUuid({...msg,summary:'updated rendering'}, 'oc_group:omt_topic'), uuid);
  assert.notEqual(notificationUuid(msg, 'ou_owner'), uuid);
  assert.notEqual(notificationUuid({...msg,turnId:'turn-b'}, 'oc_group:omt_topic'), uuid);
  assert.notEqual(notificationUuid({...msg,source:'claude'}, 'oc_group:omt_topic'), uuid);
  assert.notEqual(notificationUuid({...msg,sessionId:OTHER_ID}, 'oc_group:omt_topic'), uuid);
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('retrying delivery uses the same Feishu idempotency UUID for its exact destination', async t => {
  const f = fixture(t), topic = await f.find();
  await sendObservedCompletion({msg:f.msg,target:f.target,topic,channel:f.channel});
  await sendObservedCompletion({msg:{...f.msg},target:f.target,topic,channel:f.channel});
  assert.equal(f.calls.reply[0].data.uuid, f.calls.reply[1].data.uuid);
  await sendObservedCompletion({msg:f.msg,target:f.target,channel:f.channel});
  assert.notEqual(f.calls.reply[0].data.uuid, f.calls.create[0].data.uuid);
});

for (const destination of ['topic', 'owner', 'flat']) {
  test('a capacity failure is actionable and never presented as success in ' + destination, async t => {
    const f = fixture(t, {msg:{taskStatus:'failed', summary:'Selected model is at capacity. Please try a different model.'},
      ...(destination === 'owner' ? {records:[]} : {}),
      ...(destination === 'flat' ? {project:{kind:'single'}, record:{threadId:'oc_project'}} : {})});
    const topic = await f.find();
    await sendObservedCompletion({msg:f.msg, target:f.target, topic, channel:f.channel});
    const request = [...f.calls.reply, ...f.calls.create][0];
    const content = JSON.parse(request.data.content);
    const rendered = request.data.content;
    assert.match(rendered, /Selected model is at capacity/);
    assert.match(rendered, /原会话保留/);
    assert.match(rendered, /继续/);
    assert.ok(rendered.includes(ID));
    assert.doesNotMatch(rendered, /✅|模块任务已完成/);
    if (topic) assert.equal(content.zh_cn.title, '模块任务受阻');
    else {
      assert.match(content.text, /任务受阻/);
      assert.ok(content.text.includes('/resume ' + ID));
      assert.match(content.text, /再到话题回复/);
    }
  });
}

test('failure retries are idempotent without suppressing a later successful result', () => {
  const msg = {source:'codex', sessionId:ID, turnId:'turn-failure', taskStatus:'failed'};
  const failed = notificationUuid(msg, 'oc_group:omt_topic');
  assert.equal(notificationUuid({...msg, summary:'new copy'}, 'oc_group:omt_topic'), failed);
  assert.notEqual(notificationUuid({...msg, taskStatus:'completed'}, 'oc_group:omt_topic'), failed);
});

for (const response of [{code:99991672,msg:'permission denied'}, {code:0,data:{}}, {code:100,data:{message_id:'om_invalid_success'}}]) {
  test('a rejected or missing-ID send response is never reported as successful: ' + JSON.stringify(response), async t => {
    const f = fixture(t, {sendResponse:response});
    await assert.rejects(sendObservedCompletion({msg:f.msg,target:f.target,channel:f.channel}));
    assert.equal(f.calls.create.length, 1);
  });
}

test('a network send failure propagates without switching from a bound topic to private delivery', async t => {
  const error = new Error('Client network socket disconnected before secure TLS connection was established');
  const f = fixture(t, {sendError:error}), topic = await f.find();
  await assert.rejects(sendObservedCompletion({msg:f.msg,target:f.target,topic,channel:f.channel}), candidate => candidate === error);
  assert.equal(f.calls.reply.length, 1); assert.equal(f.calls.create.length, 0);
});

test('a successful-looking response for a different chat is rejected', async t => {
  const f = fixture(t, {sendResponse:{code:0,data:{message_id:'om_wrong',chat_id:'oc_wrong'}}}), topic = await f.find();
  await assert.rejects(sendObservedCompletion({msg:f.msg,target:f.target,topic,channel:f.channel}), /unexpected chat/i);
});
