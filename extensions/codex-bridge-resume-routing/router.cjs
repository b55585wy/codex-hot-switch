const path = require('node:path');

function nativeCwd(value) {
  return String(value || '').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
}
function normalizeCwd(value) {
  const clean = nativeCwd(value);
  if (!clean || !path.win32.isAbsolute(clean)) return '';
  return path.win32.normalize(clean).replace(/[\\/]+$/, '').toLowerCase();
}
function withinProject(cwd, root) {
  const target = normalizeCwd(cwd), base = normalizeCwd(root);
  return Boolean(target && base && (target === base || target.startsWith(base + '\\')));
}
function findNativeThread(codexHome, id) {
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'), {readOnly:true});
  try {
    db.exec('PRAGMA busy_timeout=1000');
    const row = db.prepare('SELECT id,cwd,name,title,archived FROM threads WHERE id=?').get(id);
    return row ? {...row, cwd:nativeCwd(row.cwd)} : undefined;
  } finally { db.close(); }
}
function escape(value) { return String(value || '').replace(/[\\*_`\[\]<>]/g, '\\$&'); }
async function retryBeforeTlsEstablished(action) {
  try { return await action(); }
  catch (error) {
    if (!/disconnected before secure TLS connection was established/i.test(String(error?.message || error))) throw error;
    return action();
  }
}
function topicLinkFromMessage(message, chatId) {
  if (message?.message_app_link) return message.message_app_link;
  const position = message?.thread_message_position;
  if (message?.thread_id && position != null && /^\d+$/.test(String(position))) {
    const params = new URLSearchParams({openthreadid:message.thread_id, openchatid:chatId,
      open_thread_id:message.thread_id, open_chat_id:chatId, thread_position:String(position)});
    return 'https://applink.feishu.cn/client/thread/open?' + params;
  }
  if (message?.message_position != null && /^\d+$/.test(String(message.message_position))) {
    return 'https://applink.feishu.cn/client/chat/open?' + new URLSearchParams({openChatId:chatId, position:String(message.message_position)});
  }
}
function chooseProject(thread, projects, forcedProject) {
  const candidates = (forcedProject ? [forcedProject] : projects).filter(project =>
    project.chatId && !project.blank && (!project.backend || project.backend === 'codex-appserver') && withinProject(thread.cwd, project.cwd));
  if (!candidates.length) throw new Error('此会话位于 ' + thread.cwd + '，还没有匹配的 Codex 项目群。请先在管理台关联该目录的项目群。');
  const longest = Math.max(...candidates.map(project => normalizeCwd(project.cwd).length));
  const closest = candidates.filter(project => normalizeCwd(project.cwd).length === longest);
  if (closest.length !== 1) throw new Error('此目录匹配多个项目群，请进入希望使用的项目群发送同一条 /resume 命令。');
  return closest[0];
}
function createResumeRouter(deps) {
  const pending = new Map();
  async function bind(project, thread, msg) {
    const records = await deps.listSessions();
    const existing = records.filter(record => record.chatId === project.chatId && record.sessionId === thread.id &&
      (!record.backend || record.backend === 'codex-appserver')).sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (existing) return {record:existing, reused:true};
    const record = await deps.bindSession(project, thread, msg);
    if (!record?.threadId || record.sessionId !== thread.id || record.chatId !== project.chatId) throw new Error('未能确认原会话的话题绑定，请重试；未启动新会话。');
    return {record, reused:false};
  }
  return async (msg, forcedProject) => {
    if (!deps.isAdmin(msg)) {
      await deps.reply(msg, '⛔ 仅管理员可以关联已有会话。');
      return {ok:false};
    }
    try {
      const match = /^\s*\/resume\s+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\s*$/i.exec(msg.content || '');
      if (!match) throw new Error('请发送 /resume 后加完整会话 ID，例如：/resume 00000000-0000-4000-8000-000000000002。私聊和项目群都可以使用。');
      const thread = await deps.findThread(match[1].toLowerCase());
      if (!thread) throw new Error('本机没有找到会话 ' + match[1] + '，请核对完整 ID。');
      if (thread.archived) throw new Error('此会话已归档，请先在 Codex 中恢复后再关联。');
      const project = chooseProject(thread, await deps.listProjects(), forcedProject);
      if (!deps.isAllowedProject(msg, project)) throw new Error('你没有权限使用该项目群。');
      const key = project.chatId + ':' + thread.id;
      let task = pending.get(key);
      const concurrent = Boolean(task);
      if (!task) {
        task = bind(project, thread, msg).finally(() => pending.delete(key));
        pending.set(key, task);
      }
      const result = {...await task, ...(concurrent ? {reused:true} : {})};
      let url;
      try { url = await deps.linkFor(result.record, project); } catch {}
      url ||= 'https://applink.feishu.cn/client/chat/open?openChatId=' + encodeURIComponent(project.chatId);
      const name = deps.describe?.(thread) || thread.name || String(thread.title || '').split('\n')[0].slice(0, 60) || '未命名模块';
      const text = '✅ 已关联原会话：' + escape(name) + '\n项目：' + escape(project.name) + '\n会话：' + thread.id +
        '\n\n[进入模块话题](' + url + ')\n请在该话题发送下一步指令。';
      await deps.reply(msg, text);
      return {ok:true, ...result, project};
    } catch (error) {
      await deps.reply(msg, '❌ ' + (error instanceof Error ? error.message : String(error)));
      return {ok:false};
    }
  };
}
module.exports = {createResumeRouter, findNativeThread, normalizeCwd, nativeCwd, withinProject, chooseProject, topicLinkFromMessage, retryBeforeTlsEstablished};
