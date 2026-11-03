const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function configurePrivate(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Expected a bot configuration object');
  const next = JSON.parse(JSON.stringify(config));
  const preferences = next.preferences ||= {};
  const current = preferences.cliBridge || {};
  preferences.completionReminder = {...preferences.completionReminder, mode:'always',
    longTaskMinutes:preferences.completionReminder?.longTaskMinutes || 3};
  preferences.cliBridge = {...current, enabled:true, delivery:'always', completionTarget:'bound_topic',
    agents:{...current.agents, codex:true, claude:current.agents?.claude ?? false},
    notifyScope:current.notifyScope ?? 'all',
    taskCompletion:{...current.taskCompletion, enabled:true},
    desktopObserver:{...current.desktopObserver, enabled:true}};
  return next;
}
function main(args) {
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const bot = value('--bot'), explicit = value('--config');
  if (!explicit && (!bot || !/^[A-Za-z0-9_-]+$/.test(bot))) throw new Error('Usage: npm run setup:private -- --bot <app-id> [--apply], or --config <config-file>');
  const file = explicit ? path.resolve(explicit) : path.join(os.homedir(), '.feishu-codex-bridge', 'bots', bot, 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = configurePrivate(config);
  if (args.includes('--apply')) {
    const pidFile = path.join(path.dirname(path.dirname(path.dirname(file))), 'service.pid');
    let pid;
    try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch {}
    if (pid) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
      if (alive) throw new Error('Stop Bridge before editing its persisted configuration; start it again after applying this setup');
    }
    fs.copyFileSync(file, file + '.before-private-setup-' + Date.now() + '.bak');
    const temp = file + '.private-setup-' + process.pid;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', {mode:0o600});
    fs.renameSync(temp, file);
  }
  console.log(JSON.stringify({applied:args.includes('--apply'), completionTarget:'bound_topic', desktopObserver:true,
    delivery:'always', completionReminder:'always', notifyScope:next.preferences.cliBridge.notifyScope}));
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode=1; }
}
module.exports = {configurePrivate};
