const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

function metadataPath(sessionsFile) {
  return path.join(path.dirname(sessionsFile), 'session-modules.json');
}
function keyFor(session) {
  if (!session.sessionId) throw new Error('尚未绑定会话，请先 /resume 选择会话。');
  return (session.backend || 'codex-appserver') + ':' + session.sessionId;
}
function readStore(sessionsFile, strict = false) {
  try {
    const store = JSON.parse(fs.readFileSync(metadataPath(sessionsFile), 'utf8'));
    if (!store.modules || typeof store.modules !== 'object' || Array.isArray(store.modules)) throw new Error('Invalid module metadata');
    return store;
  } catch (error) {
    if (error.code === 'ENOENT' || !strict) return {version:1, modules:{}};
    throw new Error('模块命名记录无法读取，已保留原文件，请先检查。');
  }
}
function saveEntry(sessionsFile, session, patch) {
  const store = readStore(sessionsFile, true);
  const key = keyFor(session);
  store.modules[key] = {...store.modules[key], ...patch};
  const file = metadataPath(sessionsFile);
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temp = file + '.tmp-' + randomUUID();
  fs.writeFileSync(temp, JSON.stringify(store, null, 2) + '\n', {mode:0o600});
  fs.renameSync(temp, file);
  return store.modules[key];
}
function setModuleName(sessionsFile, session, name) {
  const value = String(name || '').trim();
  if (!value || Array.from(value).length > 40 || /[\r\n\x00-\x1f\x7f]/.test(value)) {
    throw new Error('模块名请使用 1–40 个字符，不要换行。');
  }
  return saveEntry(sessionsFile, session, {moduleName:value});
}
function concise(value, max = 96) {
  let text = String(value || '').trim();
  if (!text || /^(YOU ARE|WRITE OWNERSHIP|# AGENTS|<environment_context>|<INSTRUCTIONS>)/i.test(text)) return '';
  if (text.length > 500 || text.split('\n').length > 4) return '';
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]+)\b/g, '[凭据已隐藏]');
  text = text.replace(/\b(api[_ -]?key|app[_ -]?secret|access[_ -]?token)\s*[:=]\s*\S+/gi, '$1=[凭据已隐藏]');
  text = text.replace(/\s+/g, ' ');
  return Array.from(text).slice(0, max).join('') + (Array.from(text).length > max ? '…' : '');
}
function recordRecentTask(sessionsFile, session, text, now = Date.now()) {
  const recentTask = concise(text);
  if (!recentTask || recentTask.startsWith('/')) return;
  if (/^(go\s*on|goon|继续(?:吧|执行)?|好的?|ok|收到|嗯|可以)[。.!！\s]*$/i.test(recentTask)) return;
  return saveEntry(sessionsFile, session, {recentTask, lastTaskAt:now});
}
function asMilliseconds(value) {
  const time = Number(value) || 0;
  return time && time < 1e12 ? time * 1000 : time;
}
function presentSession(session, sessionsFile) {
  const key = session.sessionId ? keyFor(session) : '';
  const entry = readStore(sessionsFile).modules[key] || {};
  const nativeName = concise(session.name || session.summary || session.preview, 40);
  return {
    ...session,
    moduleName:entry.moduleName || nativeName || '未命名模块',
    recentTask:entry.recentTask || '尚未记录最近任务',
    activityAt:Math.max(asMilliseconds(entry.lastTaskAt), asMilliseconds(session.updatedAt || session.createdAt)),
    shortId:session.sessionId ? session.sessionId.slice(0,8) + '…' + session.sessionId.slice(-4) : '尚未绑定'
  };
}
function groupSessions(sessions, sessionsFile) {
  const grouped = new Map();
  for (const session of sessions) {
    const key = (session.chatId || '') + ':' + (session.sessionId ? keyFor(session) : 'topic:' + session.threadId);
    const previous = grouped.get(key);
    const newer = !previous || asMilliseconds(session.updatedAt) > asMilliseconds(previous.updatedAt);
    grouped.set(key, {...(newer ? session : previous), topicCount:(previous?.topicCount || 0) + 1});
  }
  return [...grouped.values()].map(row => presentSession(row, sessionsFile)).sort((a,b) => b.activityAt - a.activityAt);
}
function cardText(value) {
  return String(value).replace(/[\\*_`\[\]<>]/g, '\\$&');
}

module.exports = {metadataPath,setModuleName,recordRecentTask,presentSession,groupSessions,cardText};
