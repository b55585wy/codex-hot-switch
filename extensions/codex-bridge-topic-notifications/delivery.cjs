const fs = require('node:fs/promises');
const {createHash} = require('node:crypto');

function notificationUuid(msg, destination) {
  const identity = [msg.source, msg.sessionId, msg.turnId, destination].join(':');
  const hex = createHash('sha256').update(identity + (msg.taskStatus === 'failed' ? ':failed' : '')).digest('hex');
  return hex.slice(0,8) + '-' + hex.slice(8,12) + '-5' + hex.slice(13,16) + '-8' + hex.slice(17,20) + '-' + hex.slice(20,32);
}
async function readRows(file, field) {
  const store = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(store[field])) throw new Error('Invalid notification registry: ' + field);
  return store[field];
}
async function findBoundCompletionTopic(msg, opts) {
  if (msg.source !== 'codex' || !msg.sessionId) return undefined;
  const [records, projects] = await Promise.all([readRows(opts.sessionsFile, 'sessions'), readRows(opts.projectsFile, 'projects')]);
  const candidates = records.filter(record => record.sessionId === msg.sessionId && record.backend === 'codex-appserver')
    .map(record => ({record, project:projects.find(project => project.chatId === record.chatId && !project.blank &&
      (!project.backend || project.backend === 'codex-appserver') && opts.isChatAllowed(project.chatId) && opts.withinProject(msg.cwd, project.cwd))}))
    .filter(item => item.project).sort((a,b) => (b.record.updatedAt || 0) - (a.record.updatedAt || 0));
  if (!candidates.length) return undefined;
  const {record, project} = candidates[0];
  const topic = {chatId:record.chatId, threadId:record.threadId, projectName:project.name};
  if (project.kind === 'single') return {...topic, flat:true};
  const anchor = record.topicMessageId || record.rootMessageId;
  let item;
  if (anchor) {
    const result = await opts.channel.rawClient.im.v1.message.get({path:{message_id:anchor}});
    item = result.data?.items?.[0];
  } else {
    const result = await opts.channel.rawClient.im.v1.message.list({params:{container_id_type:'thread',
      container_id:record.threadId, sort_type:'ByCreateTimeAsc', page_size:1}});
    item = result.data?.items?.[0];
  }
  if (!item?.message_id || item.deleted) throw new Error('Bound topic anchor is unavailable');
  if (item.chat_id && item.chat_id !== record.chatId) throw new Error('Bound topic chat mismatch');
  if (item.thread_id && item.thread_id !== record.threadId) throw new Error('Bound topic thread mismatch');
  return {...topic, messageId:item.message_id};
}
async function sendObservedCompletion({msg, target, topic, channel}) {
  const messages = channel.rawClient.im.v1.message;
  const original = String(msg.summary || '请查看原会话。');
  const body = msg.sessionId && !original.includes(msg.sessionId) ? original + '\n\n会话：' + msg.sessionId : original;
  const failed = msg.taskStatus === 'failed';
  const headline = failed ? '⚠️ Codex 任务受阻，本轮未完成' : '✅ Codex 本轮工作已结束';
  const recovery = !failed ? '' : topic
    ? '\n\n原会话保留。可稍后在本话题回复“继续”，或更换可用模型后继续。'
    : '\n\n原会话保留。先发送 /resume ' + msg.sessionId + ' 关联模块话题，再到话题回复“继续”；也可更换可用模型后继续。';
  const text = headline + '\n\n' + body + recovery;
  const destination = topic ? 'bound_topic' : 'owner';
  const uuid = notificationUuid(msg, topic ? topic.chatId + ':' + topic.threadId : target.receiveId);
  let response;
  if (topic) {
    const footer = '\n后续指令请在已绑定的话题发送；也可直接私聊我 /resume ' + msg.sessionId;
    const summary = body.endsWith(footer) ? body.slice(0, -footer.length) : body;
    const content = JSON.stringify({zh_cn:{title:failed ? '模块任务受阻' : '模块任务已完成', content:[
      [{tag:'at', user_id:target.receiveId}, {tag:'text', text:failed ? ' ⚠️ 本轮未完成，需要处理' : ' ✅ 本轮工作已结束'}],
      [{tag:'text', text:(summary || '请查看原会话。') + recovery + '\n\n后续指令请直接回复本话题。'}]
    ]}});
    const data = {msg_type:'post', content, uuid};
    response = topic.flat
      ? await messages.create({params:{receive_id_type:'chat_id'}, data:{...data, receive_id:topic.chatId}})
      : await messages.reply({path:{message_id:topic.messageId}, data:{...data, reply_in_thread:true}});
  } else {
    response = await messages.create({params:{receive_id_type:target.receiveIdType},
      data:{receive_id:target.receiveId, msg_type:'text', content:JSON.stringify({text}), uuid}});
  }
  if (response.code && response.code !== 0 || !response.data?.message_id) throw new Error('Feishu notification rejected: ' + String(response.code ?? 'missing message id'));
  if (topic && response.data.chat_id && response.data.chat_id !== topic.chatId) throw new Error('Notification delivered to unexpected chat');
  return {messageId:response.data.message_id, destination, ...(topic ? {chatId:topic.chatId, threadId:topic.threadId} : {})};
}
module.exports = {findBoundCompletionTopic, sendObservedCompletion, notificationUuid};
