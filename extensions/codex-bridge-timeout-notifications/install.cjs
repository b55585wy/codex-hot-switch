const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = process.argv[2];
if (!root) throw new Error('Pass the installed Bridge package path');
if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version !== '0.6.14') throw new Error('Requires Bridge 0.6.14');
const file = path.join(root, 'dist', 'cli.js');
let source = fs.readFileSync(file, 'utf8');
const original = source;
const marker = '// A watchdog reminder is not a native completion receipt.';
function replaceOnce(from, to) {
  if (source.split(from).length !== 2) throw new Error('Unexpected Bridge layout: ' + from.slice(0,100));
  source = source.replace(from, to);
}
if (!source.includes(marker)) {
  if (!source.includes('Bound module topics receive')) throw new Error('Preserve the previous routing patches');
  source = marker + '\n' + source;
  replaceOnce('if (sent === "sent" && input2.sessionId && input2.turnId)',
    'if (sent === "sent" && input2.outcome === "done" && input2.sessionId && input2.turnId)');
  replaceOnce('`_\\u23F1 ${idleLabel}\\u65E0\\u54CD\\u5E94\\uFF0C\\u5DF2\\u81EA\\u52A8\\u7EC8\\u6B62_`',
    '`_⏱ 连续 ${idleLabel} 未收到会话进展，本轮跟踪已超时；任务状态请查看原会话_`');
}
if (!source.includes('// Terminal error reminders record failed notification receipts.')) {
  source = '// Terminal error reminders record failed notification receipts.\n' + source;
  replaceOnce('if (sent === "sent" && input2.outcome === "done" && input2.sessionId && input2.turnId) {\n      for (const observer of desktopCompletionObservers) observer.markDelivered(input2);',
    'if (sent === "sent" && (input2.outcome === "done" || input2.outcome === "error") && input2.sessionId && input2.turnId) {\n      for (const observer of desktopCompletionObservers) observer.markDelivered(input2.outcome === "error" ? { ...input2, taskStatus: "failed" } : input2);');
}
const staged = path.resolve('work/bridge-timeout-notifications/cli.js');
fs.mkdirSync(path.dirname(staged), {recursive:true});
fs.writeFileSync(staged, source);
execFileSync(process.execPath, ['--check', staged]);
if (process.argv.includes('--apply')) {
  if (source !== original) fs.copyFileSync(file, file + '.before-timeout-notifications-' + Date.now() + '.bak');
  fs.writeFileSync(file + '.tmp-' + process.pid, source);
  fs.renameSync(file + '.tmp-' + process.pid, file);
}
console.log(JSON.stringify({applied:process.argv.includes('--apply'), changed:source !== original, staged}));
