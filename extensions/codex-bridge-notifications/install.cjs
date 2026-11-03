const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = process.argv[2];
if (!root) throw new Error('Pass the installed Bridge package path');
if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version !== '0.6.14') {
  throw new Error('This local patch targets Bridge 0.6.14 only');
}
const target = path.join(root, 'dist', 'cli.js');
let source = fs.readFileSync(target, 'utf8');
const before = source;
const marker = '// Local desktop completion notifications (2026-10-30).';
function replaceOnce(from, to) {
  if (source.split(from).length !== 2) throw new Error('Unexpected Bridge layout: ' + from.slice(0,100));
  source = source.replace(from, to);
}
if (!source.includes(marker)) {
  if (!source.includes('async resumeSharedThread') || !source.includes('Local module-oriented')) {
    throw new Error('Install the existing session and module fixes first');
  }
  source = `${marker}
import { createCodexObserver, readGoalStatus, safeSummary } from "./bridge-codex-observer.cjs";
const desktopCompletionObservers = new Set();
function markManagedNotificationTurn(sessionId, turnId) {
  for (const observer of desktopCompletionObservers) observer.markBridgeTurn(sessionId, turnId);
}
` + source;
  replaceOnce('    delivery: "away_only",', '    delivery: raw?.delivery === "always" ? "always" : "away_only",');
  replaceOnce('    sessionId: String(data.session_id ?? data.sessionId ?? ""),', `    sessionId: String(data.session_id ?? data.sessionId ?? ""),
    turnId: String(data.turn_id ?? data.turnId ?? ""),`);
  replaceOnce('    const route = await presence();\n    log.info("cli-bridge", "hook-recv", {', `    if (msg.type === "task_complete" && opts.completionAlreadySent?.(msg)) {
      return { decision: "allow", reason: "already_notified" };
    }
    if (msg.type === "task_complete" && msg.source === "codex" && opts.deferCompletion?.(msg)) {
      return { decision: "allow", reason: "goal_active" };
    }
    const route = msg.type === "task_complete" && p.delivery === "always"
      ? { routeToFeishu: true, reason: "always" } : await presence();
    log.info("cli-bridge", "hook-recv", {`);
  replaceOnce('const canReplyFromFeishu = p.taskCompletion.replyEnabled && !await localActivity();',
    'const canReplyFromFeishu = !msg.notificationOnly && p.taskCompletion.replyEnabled && !await localActivity();');
  replaceOnce('      if (!pending3) return { decision: "allow" };', `      opts.onCompletionSent?.(msg, sent2.messageId);
      log.info("cli-bridge", "completion-sent", { sessionId: msg.sessionId, turnId: msg.turnId, messageId: sent2.messageId, source: msg.hookEventName });
      if (!pending3) return { decision: "allow", messageId: sent2.messageId };`);
  replaceOnce('      activeTurnId = result.turn.id;', `      activeTurnId = result.turn.id;
      self.notificationTurnId = result.turn.id;
      markManagedNotificationTurn(self.sessionId, result.turn.id);`);
  replaceOnce('  async function handleMessage(msg) {\n    const p = prefs();', `  const completionsInFlight = new Map();
  function handleMessage(msg) {
    const key = msg.type === "task_complete" && msg.turnId ? msg.source + ":" + msg.sessionId + ":" + msg.turnId : "";
    if (!key) return handleMessageInner(msg);
    if (completionsInFlight.has(key)) return completionsInFlight.get(key);
    const pending = handleMessageInner(msg).finally(() => completionsInFlight.delete(key));
    completionsInFlight.set(key, pending);
    return pending;
  }
  async function handleMessageInner(msg) {
    const p = prefs();`);
  replaceOnce('  async function sendCompletionReminder(input2) {\n    await sendCompletionReminderReply({ channel, cfg, dedupe: completionReminderSent }, input2);\n  }', `  async function sendCompletionReminder(input2) {
    const sent = await sendCompletionReminderReply({ channel, cfg, dedupe: completionReminderSent }, input2);
    if (sent === "sent" && input2.sessionId && input2.turnId) {
      for (const observer of desktopCompletionObservers) observer.markDelivered(input2);
    }
  }`);
  replaceOnce('          await sendCompletionReminder({\n            cardMsgId: finalMsgId,', `          await sendCompletionReminder({
            sessionId: opts.thread.sessionId,
            turnId: opts.thread.notificationTurnId,
            cardMsgId: finalMsgId,`);
  replaceOnce('  const cliBridge = createCliBridgeService({\n    cfg: opts.cfg,', `  const observerFiles = botPaths(app.id);
  let desktopObserver;
  const cliBridge = createCliBridgeService({
    cfg: opts.cfg,
    completionAlreadySent: (msg) => desktopObserver?.hasDelivered(msg) || !msg.notificationOnly && desktopObserver?.hasManagedTurn(msg),
    deferCompletion: (msg) => {
      if (opts.cfg.preferences?.cliBridge?.desktopObserver?.enabled !== true) return false;
      try { return readGoalStatus(process.env.CODEX_HOME || join(homedir(), ".codex"), msg.sessionId) === "active"; }
      catch (err) { log.fail("desktop-notify", err, { phase: "goal-read" }); return true; }
    },
    onCompletionSent: (msg) => desktopObserver?.markDelivered(msg),`);
  replaceOnce('  const orchestrator = createOrchestrator(channel, opts.cfg, opts.fallbackCwd, cliBridge);', `  desktopObserver = createCodexObserver({
    codexHome: process.env.CODEX_HOME || join(homedir(), ".codex"),
    statePath: join(observerFiles.dir, "desktop-notifications.json"),
    enabled: () => {
      const p = getCliBridgePreferences(opts.cfg);
      return p.enabled && p.agents.codex && p.taskCompletion.enabled && opts.cfg.preferences?.cliBridge?.desktopObserver?.enabled === true;
    },
    deliver: async (msg) => {
      const view = presentSession({ sessionId: msg.sessionId, backend: "codex-appserver", name: msg.name }, observerFiles.sessionsFile);
      const summary = "负责模块：" + view.moduleName + "\\n\\n" + safeSummary(msg.summary) + "\\n\\n会话：" + msg.sessionId + "\\n后续指令请在已绑定的话题发送；未绑定时在项目群使用 /resume " + msg.sessionId;
      const result = await cliBridge.handleMessage({ ...msg, summary });
      if (result.reason === "missing_owner") throw new Error("Notification owner missing");
      return result;
    },
    log: (event, fields) => log.info("desktop-notify", event, fields)
  });
  desktopCompletionObservers.add(desktopObserver);
  const orchestrator = createOrchestrator(channel, opts.cfg, opts.fallbackCwd, cliBridge);`);
  replaceOnce('  log.info("ws", "connected", { appId: app.id, fallbackCwd: opts.fallbackCwd });', `  await desktopObserver.start().catch((err) => log.fail("desktop-notify", err, { phase: "start" }));
  log.info("ws", "connected", { appId: app.id, fallbackCwd: opts.fallbackCwd });`);
  replaceOnce('    await orchestrator.shutdown();\n    await cliBridge.shutdown()', `    await desktopObserver.stop();
    desktopCompletionObservers.delete(desktopObserver);
    await orchestrator.shutdown();
    await cliBridge.shutdown()`);
  const oldCopy = '    note("\\u9501\\u5C4F\\u3001\\u6216\\u952E\\u9F20\\u7A7A\\u95F2\\u8D85\\u8FC7\\u8BBE\\u5B9A\\u65F6\\u957F\\uFF0C\\u5C31\\u5F53\\u4F60\\u53BB\\u63A5\\u5496\\u5561\\u4E86 \\u2192 \\u81EA\\u52A8\\u63A5\\u7BA1\\uFF1B\\u56DE\\u5230\\u7535\\u8111/\\u89E3\\u9501\\u7ACB\\u5373\\u6536\\u624B\\u3002"),';
  replaceOnce(oldCopy, '    note("任务运行中保持安静；完成通知可直接发送。审批和钩子回复仍按本机离开状态接管。"),');
}
if (!source.includes('// Completion delivery is independent from the reply waiter.')) {
  replaceOnce(`  const completionsInFlight = new Map();
  function handleMessage(msg) {
    const key = msg.type === "task_complete" && msg.turnId ? msg.source + ":" + msg.sessionId + ":" + msg.turnId : "";
    if (!key) return handleMessageInner(msg);
    if (completionsInFlight.has(key)) return completionsInFlight.get(key);
    const pending = handleMessageInner(msg).finally(() => completionsInFlight.delete(key));
    completionsInFlight.set(key, pending);
    return pending;
  }`, `  // Completion delivery is independent from the reply waiter.
  const completionsInFlight = new Map();
  function handleMessage(msg) {
    const key = msg.type === "task_complete" && msg.turnId ? msg.source + ":" + msg.sessionId + ":" + msg.turnId : "";
    if (!key) return handleMessageInner(msg);
    const previous = completionsInFlight.get(key);
    if (previous) return msg.notificationOnly ? previous.sent : previous.interaction;
    const flight = {};
    flight.sent = new Promise((resolve, reject) => { flight.resolveSent = resolve; flight.rejectSent = reject; });
    flight.sent.catch(() => {});
    completionsInFlight.set(key, flight);
    flight.interaction = handleMessageInner(msg).then((result) => {
      flight.resolveSent(result);
      return result;
    }, (error) => {
      flight.rejectSent(error);
      throw error;
    }).finally(() => completionsInFlight.delete(key));
    return flight.interaction;
  }`);
  replaceOnce('      opts.onCompletionSent?.(msg, sent2.messageId);', `      const completionKey = msg.turnId ? msg.source + ":" + msg.sessionId + ":" + msg.turnId : "";
      completionsInFlight.get(completionKey)?.resolveSent({ decision: "allow", messageId: sent2.messageId });
      opts.onCompletionSent?.(msg, sent2.messageId);`);
}
if (!source.includes('// Readable completion notifications use ordinary text messages.')) {
  replaceOnce('  const sendOwnerCard = (target, cardObject) => sendManagedCard(opts.channel, target.receiveId, cardObject, void 0, false, target.receiveIdType);', `  const sendOwnerCard = (target, cardObject) => sendManagedCard(opts.channel, target.receiveId, cardObject, void 0, false, target.receiveIdType);
  // Readable completion notifications use ordinary text messages.
  async function sendCompletionNotice(msg, target, cardObject) {
    if (!msg.notificationOnly) return sendOwnerCard(target, cardObject);
    const response = await opts.channel.rawClient.im.v1.message.create({
      params: { receive_id_type: target.receiveIdType },
      data: { receive_id: target.receiveId, msg_type: "text", content: JSON.stringify({ text: "✅ Codex 本轮工作已结束\\n\\n" + (msg.summary || "请查看原会话。") }) }
    });
    const messageId = response.data?.message_id;
    if (!messageId) throw new Error("Feishu notification rejected: " + String(response.code ?? "missing message id"));
    return { messageId };
  }`);
  replaceOnce('      const sent2 = await sendOwnerCard(\n        target2,', '      const sent2 = await sendCompletionNotice(\n        msg, target2,');
}
if (!source.includes('// Failed turns have independent completion receipts.')) {
  source = '// Failed turns have independent completion receipts.\n' + source;
  replaceOnce('if (msg.type === "task_complete" && msg.source === "codex" && opts.deferCompletion?.(msg)) {',
    'if (msg.type === "task_complete" && msg.source === "codex" && msg.taskStatus !== "failed" && opts.deferCompletion?.(msg)) {');
  replaceOnce('const key = msg.type === "task_complete" && msg.turnId ? msg.source + ":" + msg.sessionId + ":" + msg.turnId : "";',
    'const key = msg.type === "task_complete" && msg.turnId ? msg.source + ":" + msg.sessionId + ":" + msg.turnId + (msg.taskStatus === "failed" ? ":failed" : "") : "";');
  replaceOnce('const completionKey = msg.turnId ? msg.source + ":" + msg.sessionId + ":" + msg.turnId : "";',
    'const completionKey = msg.turnId ? msg.source + ":" + msg.sessionId + ":" + msg.turnId + (msg.taskStatus === "failed" ? ":failed" : "") : "";');
}
const stage = path.resolve('work/bridge-notifications/cli.js');
fs.mkdirSync(path.dirname(stage), {recursive:true});
fs.writeFileSync(stage, source);
execFileSync(process.execPath, ['--check', stage]);
if (process.argv.includes('--apply')) {
  if (source !== before) fs.copyFileSync(target, target + '.before-notifications-' + Date.now() + '.bak');
  const helper = path.join(root, 'dist', 'bridge-codex-observer.cjs');
  fs.copyFileSync(path.join(__dirname, 'observer.cjs'), helper + '.tmp-' + process.pid);
  fs.renameSync(helper + '.tmp-' + process.pid, helper);
  fs.writeFileSync(target + '.tmp-' + process.pid, source);
  fs.renameSync(target + '.tmp-' + process.pid, target);
}
console.log(JSON.stringify({staged:stage, applied:process.argv.includes('--apply'), changed:source !== before}));
