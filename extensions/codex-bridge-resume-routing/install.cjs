const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = process.argv[2];
if (!root) throw new Error('Pass the installed Bridge package path');
if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version !== '0.6.14') throw new Error('Requires Bridge 0.6.14');
const target = path.join(root, 'dist', 'cli.js');
let source = fs.readFileSync(target, 'utf8');
const before = source;
function replaceOnce(from, to) {
  if (source.split(from).length !== 2) throw new Error('Unexpected Bridge layout: ' + from.slice(0, 100));
  source = source.replace(from, to);
}
const marker = '// Explicit session IDs work from private chats and project groups.';
if (!source.includes(marker)) {
  if (!source.includes('Local desktop completion notifications')) throw new Error('Preserve the notification patch before installing this change');
  source = marker + '\nimport { createResumeRouter, findNativeThread, topicLinkFromMessage, retryBeforeTlsEstablished } from "./bridge-resume-router.cjs";\n' + source;
  replaceOnce('    if (msg.chatType === "p2p") {\n      if (cliBridge?.onMessage({', `    if (msg.chatType === "p2p") {
      if (/^\\s*\\/resume(?:\\s|$)/i.test(msg.content || "")) {
        await exactResume(msg);
        return;
      }
      if (cliBridge?.onMessage({`);
  replaceOnce('    const goalObjective = parseGoalTrigger(text);', `    if (cmd === "resume" && /^\\/resume\\s+\\S/i.test(text)) {
      await exactResume(msg, project);
      return;
    }
    const goalObjective = parseGoalTrigger(text);`);
  replaceOnce('  const onMessage = async (msg) => {', `  async function resumeTopicLink(record, project) {
    try {
      let item;
      const messageId = record.topicMessageId || record.rootMessageId;
      if (messageId) {
        const message = await channel.rawClient.im.v1.message.get({ path: { message_id: messageId } });
        item = message.data?.items?.[0];
      } else if (record.threadId !== project.chatId) {
        const messages = await channel.rawClient.im.v1.message.list({ params: { container_id_type: "thread", container_id: record.threadId, sort_type: "ByCreateTimeAsc", page_size: 1 } });
        item = messages.data?.items?.[0];
      }
      const url = topicLinkFromMessage(item, project.chatId);
      if (url) return url;
    } catch (err) { log.warn("resume", "topic-link-unavailable", { err: String(err) }); }
    return openChatUrl(project.chatId);
  }
  async function bindExactSession(project, native, msg) {
    const flat = (project.kind ?? "multi") === "single";
    const key = flat ? turnSession(project.chatId, project, msg.senderId).sessionKey : void 0;
    if (key && active.get(key)) throw new Error("该单会话群正在执行任务，请结束后再切换。");
    const reservation = key ? { queue: [], requesterOpenId: msg.senderId } : void 0;
    if (key) active.set(key, reservation);
    try {
    const view = presentSession({ sessionId: native.id, backend: "codex-appserver", name: native.name }, paths.sessionsFile);
    const label = view.moduleName === "未命名模块" ? (native.name || "已有模块") : view.moduleName;
    let threadId = key, rootMessageId, topicMessageId;
    if (!flat) {
      const anchor = await retryBeforeTlsEstablished(() => channel.send(project.chatId, { markdown: "🧩 **" + cardText(label) + "**\\n关联已有会话：" + native.id }));
      rootMessageId = anchor.messageId;
      const reply = await retryBeforeTlsEstablished(() => channel.rawClient.im.v1.message.reply({ path: { message_id: rootMessageId }, data: {
        msg_type: "text", content: JSON.stringify({ text: "已关联原会话。请在此话题发送下一步指令。\\n会话：" + native.id }), reply_in_thread: true
      } }));
      topicMessageId = reply.data?.message_id;
      threadId = reply.data?.thread_id || (topicMessageId ? await getThreadId(channel, topicMessageId, 4) : void 0);
      if (!threadId) throw new Error("飞书未返回话题 ID，未创建或启动新的 Codex 会话。");
    }
    const now = Date.now();
    const record = { threadId, chatId: project.chatId, cwd: native.cwd, sessionId: native.id, backend: "codex-appserver",
      summary: label, createdAt: now, updatedAt: now, rootMessageId, topicMessageId };
    await upsertSession(record);
    if (flat) {
      const previous = sessions.get(key);
      sessions.delete(key);
      if (previous) await previous.close().catch(() => {});
      lastUsage.delete(key);
    }
    log.info("resume", "exact-bound", { sessionId: native.id, threadId, project: project.name });
    return record;
    } finally {
      if (key && active.get(key) === reservation) active.delete(key);
      if (reservation?.queue.length) {
        await channel.send(project.chatId, { markdown: "切换期间收到的 " + reservation.queue.length + " 条指令尚未执行，请在群内重新发送。" }).catch(() => {});
      }
    }
  }
  const exactResume = createResumeRouter({
    isAdmin: (msg) => isAdmin(cfg, msg.senderId),
    findThread: (id) => findNativeThread(process.env.CODEX_HOME || join(homedir(), ".codex"), id),
    listProjects,
    listSessions,
    isAllowedProject: (msg, project) => isChatAllowed(cfg, project.chatId) && isUserAllowedInProject(cfg, project, msg.senderId),
    bindSession: bindExactSession,
    linkFor: resumeTopicLink,
    describe: (native) => presentSession({ sessionId: native.id, backend: "codex-appserver", name: native.name }, paths.sessionsFile).moduleName,
    reply: (msg, markdown) => retryBeforeTlsEstablished(() => channel.send(msg.chatId, { markdown }, { replyTo: msg.messageId, replyInThread: msg.chatType !== "p2p" && Boolean(msg.threadId) }))
  });
  const onMessage = async (msg) => {`);
  replaceOnce('后续指令请在已绑定的话题发送；未绑定时在项目群使用 /resume ', '后续指令请在已绑定的话题发送；也可直接私聊我 /resume ');
}
const staged = path.resolve('work/bridge-resume-routing/cli.js');
fs.mkdirSync(path.dirname(staged), {recursive:true});
fs.writeFileSync(staged, source);
execFileSync(process.execPath, ['--check', staged]);
if (process.argv.includes('--apply')) {
  if (source !== before) fs.copyFileSync(target, target + '.before-resume-routing-' + Date.now() + '.bak');
  const helper = path.join(root, 'dist', 'bridge-resume-router.cjs');
  fs.copyFileSync(path.join(__dirname, 'router.cjs'), helper + '.tmp-' + process.pid);
  fs.renameSync(helper + '.tmp-' + process.pid, helper);
  fs.writeFileSync(target + '.tmp-' + process.pid, source);
  fs.renameSync(target + '.tmp-' + process.pid, target);
}
console.log(JSON.stringify({applied:process.argv.includes('--apply'), changed:source !== before, staged}));
