const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = process.argv[2];
if (!root) throw new Error('Pass the installed Bridge package path');
const target = path.join(root, 'dist', 'cli.js');
let source = fs.readFileSync(target, 'utf8');
const original = source;
const marker = '// Local module-oriented session lists (2026-10-30).';
function replaceOnce(before, after) {
  if (source.split(before).length !== 2) throw new Error('Unexpected Bridge layout: ' + before.slice(0,80));
  source = source.replace(before, after);
}
function replaceFunction(name, nextName, content) {
  const begin = source.indexOf('function ' + name + '(');
  const end = source.indexOf('function ' + nextName + '(', begin);
  if (begin < 0 || end < 0) throw new Error('Function layout changed: ' + name);
  source = source.slice(0,begin) + content.trim() + '\n' + source.slice(end);
}
if (!source.includes(marker)) {
  source = marker + '\nimport { setModuleName, recordRecentTask, presentSession, groupSessions, cardText } from "./bridge-session-modules.cjs";\n' + source;
  replaceOnce('        sortKey: "created_at",', '        sortKey: "updated_at",');
  replaceOnce('return name === "resume" || name === "model"', 'return name === "module" || name === "resume" || name === "model"');
  replaceOnce('    const cmd = parseCommand(text);\n    const goalObjective = parseGoalTrigger(text);', `    const cmd = parseCommand(text);
    if (cmd === "module") {
      await handleModuleCommand(msg, project, text);
      return;
    }
    const goalObjective = parseGoalTrigger(text);`);
  replaceOnce('  function parseCommand(text) {', `  async function handleModuleCommand(msg, project, text) {
    if (!isAdmin(cfg, msg.senderId)) {
      await denyAdminCommand(msg, "module");
      return;
    }
    const flat = (project.kind ?? "multi") === "single";
    const reply = (markdown) => channel.send(msg.chatId, { markdown }, { replyTo: msg.messageId, replyInThread: !flat && Boolean(msg.threadId) });
    if (!flat && !msg.threadId) {
      await reply("请在负责该模块的话题里发送：\x60/module 科研平台 UI\x60。");
      return;
    }
    const ts = turnSession(flat ? msg.chatId : msg.threadId, project, msg.senderId);
    const rec = await getSession(ts.sessionKey);
    if (!rec?.sessionId) {
      await reply("此话题尚未绑定会话，请先 /resume 选择已有会话。");
      return;
    }
    const name = text.replace(/^\\/module\\b/i, "").trim();
    if (!name) {
      const view = presentSession(rec, paths.sessionsFile);
      await reply("负责模块：" + cardText(view.moduleName) + "\\n修改名称：\x60/module 模块名\x60（最多 40 字）。");
      return;
    }
    try {
      setModuleName(paths.sessionsFile, rec, name);
      await reply("✅ 已将本会话标为 **" + cardText(name) + "**。原会话和上下文保持不变。");
    } catch (err) {
      await reply("❌ " + (err instanceof Error ? err.message : String(err)));
    }
  }
  function parseCommand(text) {`);
  for (const signature of ['  async function launchRun(opts, reaction, onTopicCreated) {', '  async function launchGoalRun(opts) {']) {
    replaceOnce(signature, signature + `
    try {
      recordRecentTask(paths.sessionsFile, { sessionId: opts.thread.sessionId, backend: opts.backendId ?? opts.firstRec?.backend ?? "codex-appserver" }, opts.summary || opts.firstText);
    } catch (err) {
      log.warn("modules", "recent-task-save-failed", { err: String(err) });
    }`);
  }
  replaceOnce('  function handleTurn(msg, text, sessionKey, flat, project, perm) {', `  function rememberModuleTask(sessionKey, text) {
    void getSession(sessionKey).then((rec) => {
      if (rec?.sessionId) recordRecentTask(paths.sessionsFile, rec, text);
    }).catch((err) => log.warn("modules", "recent-task-save-failed", { err: String(err) }));
  }
  function handleTurn(msg, text, sessionKey, flat, project, perm) {
    rememberModuleTask(sessionKey, text);`);
  replaceOnce('        currentTurn = state.queue.shift();\n        activateQueuedTurn(state, currentTurn);', '        currentTurn = state.queue.shift();\n        rememberModuleTask(activeKey, currentTurn.summary || currentTurn.text);\n        activateQueuedTurn(state, currentTurn);');
  replaceOnce('  const elements = [];\n  if (scope === "single") {', '  const elements = [note("模块命名：在对应话题发送 /module 模块名；模块名固定保留，最近任务单独更新。")];\n  if (scope === "single") {');

  replaceFunction('buildResumeCard','buildResumeLaunchingCard', `function buildResumeCard(state) {
    const elements = [md("**选择负责模块的会话**"), note(metaNote(state)), note("按最近活动排序。模块职责可在对应话题用 /module 模块名 修改。"), hr()];
    const rows = groupSessions(state.threads.map(t => ({ ...t, backend: state.backend ?? t.backend })), paths.sessionsFile);
    if (!rows.length) elements.push(note("此目录还没有历史会话。"));
    for (const row of rows.slice(0, 15)) {
      elements.push(md("**" + cardText(row.moduleName) + "**"));
      elements.push(note("最近任务：" + cardText(row.recentTask) + "\\n最近更新：" + pickerTime(row.activityAt / 1000) + " · " + row.shortId));
      elements.push(actions([button("继续这个模块", { a: RES.pick, t: row.sessionId, ...state.backend ? { b: state.backend } : {} })]));
    }
    return card(elements, { summary: "按模块选择会话" });
  }`);
  const listBegin = source.indexOf('function buildProjectListCard(');
  const listEnd = source.indexOf('function buildProjectTopicsCard(', listBegin);
  let list = source.slice(listBegin,listEnd);
  list = list.replace(/    const topicCount = [^\n]+;/, '    const moduleRows = groupSessions(p.chatId ? sessionsByChat.get(p.chatId) || [] : [], paths.sessionsFile);\n    const topicCount = moduleRows.length;');
  list = list.replace('    const row = [];', '    if (moduleRows.length) elements.push(note("负责模块：" + moduleRows.slice(0, 4).map(s => cardText(s.moduleName)).join(" · ")));\n    const row = [];');
  list = list.replace(/    row\.push\(button\(`[^\n]*topicCount[^\n]+\n/, '    row.push(button(`🧩 ${topicCount} 个模块会话`, { a: DM.projectTopics, n: p.name }));\n');
  source = source.slice(0,listBegin) + list + source.slice(listEnd);
  replaceFunction('buildProjectTopicsCard','buildRmConfirmCard', `function buildProjectTopicsCard(project, sessions) {
    const rows = groupSessions(sessions, paths.sessionsFile);
    const elements = [md("**" + cardText(project.name) + "** · " + rows.length + " 个模块会话"), note("在原话题持续分配工作；职责变化时发送 /module 新模块名。")];
    if (!rows.length) elements.push(note("还没有关联模块会话，请到项目群发送 /resume。"));
    for (const row of rows.slice(0, 20)) {
      elements.push(md("**" + cardText(row.moduleName) + "**"));
      elements.push(note("最近任务：" + cardText(row.recentTask) + "\\n最近更新：" + pickerTime(row.activityAt / 1000) + " · " + row.shortId + (row.topicCount > 1 ? " · 已合并 " + row.topicCount + " 个话题记录" : "")));
    }
    if (rows.length > 20) elements.push(note("其余会话可到项目群通过 /resume 查看。"));
    const nav = [];
    if (project.chatId) nav.push(linkButton("进入项目群", openChatUrl(project.chatId)));
    nav.push(button("返回项目列表", { a: DM.projects }));
    elements.push(hr(), actions(nav));
    return card(elements, { header: { title: "负责模块 · " + project.name, template: "wathet" } });
  }`);
  replaceOnce('    for (const s of sessions) {\n      countByChat.set(s.chatId, (countByChat.get(s.chatId) ?? 0) + 1);\n    }', '    for (const s of groupSessions(sessions, files.sessionsFile)) {\n      countByChat.set(s.chatId, (countByChat.get(s.chatId) ?? 0) + 1);\n    }');
  const mapBegin = source.indexOf('      return sessions.filter((s) => s.chatId === p.chatId).sort(');
  const mapEnd = source.indexOf('\n    },\n    tailLogs',mapBegin);
  if (mapBegin < 0 || mapEnd < 0) throw new Error('Web session list layout changed');
  source = source.slice(0,mapBegin) + `      return groupSessions(sessions.filter((s) => s.chatId === p.chatId), files.sessionsFile).map((s) => ({
        threadId: s.threadId, chatId: s.chatId, sessionId: s.sessionId,
        moduleName: s.moduleName, recentTask: s.recentTask, activityAt: s.activityAt,
        shortId: s.shortId, topicCount: s.topicCount,
        summary: s.recentTask, backend: s.backend, model: s.model,
        createdAt: s.createdAt, updatedAt: s.updatedAt
      }));` + source.slice(mapEnd);
  const webBegin = source.indexOf('        list.slice(0, 50).forEach(function (s) {');
  const webEnd = source.indexOf('\n        if (list.length > 50)',webBegin);
  if (webBegin < 0 || webEnd < 0) throw new Error('Web session renderer layout changed');
  source = source.slice(0,webBegin) + `        list.slice(0, 50).forEach(function (s) {
          var entry = el('article');
          entry.style.marginBottom = '16px';
          entry.appendChild(el('strong', null, s.moduleName || '未命名模块'));
          entry.appendChild(el('div', 'note', '最近任务：' + (s.recentTask || '尚未记录最近任务')));
          var activity = Number(s.activityAt || s.updatedAt || 0);
          var updated = el('time', 'note', '最近更新：' + (activity ? new Date(activity).toLocaleString() : '暂无记录'));
          if (activity) updated.dateTime = new Date(activity).toISOString();
          entry.appendChild(updated);
          entry.appendChild(el('div', 'note', (s.shortId || '') + (s.topicCount > 1 ? ' · 已合并 ' + s.topicCount + ' 个话题记录' : '')));
          topicBox.appendChild(entry);
        });` + source.slice(webEnd);
  source = source.replace(/d\.appendChild\(el\('div', null, '[^\n]*p\.sessionCount[^\n]+\n/,
    "d.appendChild(el('div', null, '负责模块 · 共 ' + p.sessionCount + ' 个会话'));\n");
}
if (!source.includes('// Module names on the project overview.')) {
  replaceOnce('      sessionCount: p.chatId ? countByChat.get(p.chatId) ?? 0 : 0,',
    '      // Module names on the project overview.\n      moduleNames: groupSessions(sessions.filter(s => s.chatId === p.chatId), files.sessionsFile).slice(0, 4).map(s => s.moduleName),\n      sessionCount: p.chatId ? countByChat.get(p.chatId) ?? 0 : 0,');
  source = source.replace(/      item\.appendChild\(el\('div', 'path',[^\n]*p\.cwd\)\);/,
    line => line + "\n      item.appendChild(el('div', 'note', '负责模块：' + ((p.moduleNames || []).join(' · ') || '尚未关联会话')));");
  source = source.replace(/      meta\.appendChild\(el\('span', 'tag', '[^\n]*p\.sessionCount[^\n]+\n/,
    "      meta.appendChild(el('span', 'tag', '🧩 ' + p.sessionCount + ' 个模块会话'));\n");
  replaceOnce('      btn.onclick = function () { openDrawer(p.name); };',
    "      btn.textContent = '模块与设置';\n      btn.onclick = function () { openDrawer(p.name); };");
}
const stage=path.resolve('work','bridge-modules');fs.mkdirSync(stage,{recursive:true});
fs.writeFileSync(path.join(stage,'cli.js'),source);
execFileSync(process.execPath,['--check',path.join(stage,'cli.js')],{stdio:'pipe',windowsHide:true});
console.log(JSON.stringify({staged:true,changed:source!==original}));
if(process.argv.includes('--apply')){
  if(JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version!=='0.6.14')throw new Error('Only Bridge 0.6.14 is supported');
  if(!source.includes('async resumeSharedThread'))throw new Error('Shared-daemon fix must remain installed');
  if(source!==original)fs.copyFileSync(target,target+'.before-module-lists-'+Date.now()+'.bak');
  fs.copyFileSync(path.join(__dirname,'session-modules.cjs'),path.join(root,'dist','bridge-session-modules.cjs'));
  fs.writeFileSync(target+'.tmp-modules',source);fs.renameSync(target+'.tmp-modules',target);
  console.log(JSON.stringify({installed:true}));
}
