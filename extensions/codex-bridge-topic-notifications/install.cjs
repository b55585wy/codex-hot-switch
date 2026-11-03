const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = process.argv[2];
if (!root) throw new Error('Pass the installed Bridge package path');
if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version !== '0.6.14') throw new Error('Requires Bridge 0.6.14');
const target = path.join(root, 'dist', 'cli.js');
let source = fs.readFileSync(target, 'utf8');
const original = source;
function replaceOnce(from, to) {
  if (source.split(from).length !== 2) throw new Error('Unexpected Bridge layout: ' + from.slice(0,100));
  source = source.replace(from, to);
}
const marker = '// Bound module topics receive their own completion notifications.';
if (!source.includes(marker)) {
  if (!source.includes('Explicit session IDs work from private chats')) throw new Error('Keep the explicit resume routing patch');
  source = marker + '\nimport { findBoundCompletionTopic, sendObservedCompletion } from "./bridge-topic-notifications.cjs";\n' + source;
  replaceOnce('createResumeRouter, findNativeThread, topicLinkFromMessage, retryBeforeTlsEstablished }',
    'createResumeRouter, findNativeThread, topicLinkFromMessage, retryBeforeTlsEstablished, withinProject }');
  const begin = source.indexOf('  async function sendCompletionNotice(msg, target, cardObject) {');
  const end = source.indexOf('\n  let replyReaction;', begin);
  if (begin < 0 || end < 0) throw new Error('Completion sender missing');
  source = source.slice(0,begin) + `  async function sendCompletionNotice(msg, target, cardObject) {
    if (!msg.notificationOnly) return sendOwnerCard(target, cardObject);
    const topic = await opts.resolveCompletionTopic?.(msg);
    return sendObservedCompletion({ msg, target, topic, channel: opts.channel });
  }
` + source.slice(end);
  replaceOnce('    completionAlreadySent: (msg) => desktopObserver?.hasDelivered(msg)', `    resolveCompletionTopic: (msg) => opts.cfg.preferences?.cliBridge?.completionTarget === "bound_topic"
      ? findBoundCompletionTopic(msg, { sessionsFile: observerFiles.sessionsFile, projectsFile: observerFiles.projectsFile,
          channel, isChatAllowed: (chatId) => isChatAllowed(opts.cfg, chatId), withinProject })
      : undefined,
    completionAlreadySent: (msg) => desktopObserver?.hasDelivered(msg)`);
  replaceOnce('source: msg.hookEventName });\n      if (!pending3)', 'source: msg.hookEventName, destination: sent2.destination ?? "owner", chatId: sent2.chatId, threadId: sent2.threadId });\n      if (!pending3)');
  replaceOnce('if (!pending3) return { decision: "allow", messageId: sent2.messageId };',
    'if (!pending3) return { decision: "allow", messageId: sent2.messageId, destination: sent2.destination ?? "owner", chatId: sent2.chatId, threadId: sent2.threadId };');
}
const stage = path.resolve('work/bridge-topic-notifications/cli.js');
fs.mkdirSync(path.dirname(stage), {recursive:true});
fs.writeFileSync(stage, source);
execFileSync(process.execPath, ['--check', stage]);
if (process.argv.includes('--apply')) {
  if (source !== original) fs.copyFileSync(target, target + '.before-topic-notifications-' + Date.now() + '.bak');
  for (const [file, installed] of [
    ['delivery.cjs', 'bridge-topic-notifications.cjs'],
    ['../codex-bridge-notifications/observer.cjs', 'bridge-codex-observer.cjs']
  ]) {
    const destination = path.join(root, 'dist', installed);
    fs.copyFileSync(path.join(__dirname, file), destination + '.tmp-' + process.pid);
    fs.renameSync(destination + '.tmp-' + process.pid, destination);
  }
  fs.writeFileSync(target + '.tmp-' + process.pid, source);
  fs.renameSync(target + '.tmp-' + process.pid, target);
}
console.log(JSON.stringify({applied:process.argv.includes('--apply'), changed:source !== original, stage}));
