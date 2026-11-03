const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = process.argv[2];
if (!root) throw new Error('Usage: node install.cjs <bridge-package-root> [--apply]');
const target = path.join(root, 'dist', 'cli.js');
let source = fs.readFileSync(target, 'utf8');
const original = source;
const marker = '// Local fix: reconnect existing shared-daemon sessions (2026-10-30).';

function replaceOnce(before, after) {
  if (source.split(before).length !== 2) throw new Error('Unexpected Bridge layout: ' + before.slice(0, 70));
  source = source.replace(before, after);
}

if (!source.includes(marker)) {
  const begin = source.indexOf('  async startThread(opts) {', source.indexOf('var CodexAppServerBackend = class'));
  const end = source.indexOf('\n};\nfunction isBoilerplateUserText', begin);
  if (begin < 0 || end < 0) throw new Error('Codex backend methods not found');
  source = source.slice(0, begin) + `  ${marker}
  async startThread(opts) {
    const sandbox = withAutoCompact(sandboxParams(opts.mode, opts.network), opts.autoCompact);
    const client = await this.spawn(opts.cwd);
    try {
      const res = await client.request("thread/start", {
        cwd: opts.cwd,
        approvalPolicy: APPROVAL_POLICY,
        ...sandbox,
        developerInstructions: BRIDGE_DEVELOPER_INSTRUCTIONS,
        ...opts.model ? { model: opts.model } : {}
      });
      return new CodexThread(client, res.thread.id, opts.model, opts.effort);
    } catch (err) {
      await client.close().catch(() => void 0);
      throw err;
    }
  }
  async resumeThread(opts) {
    const sandbox = withAutoCompact(sandboxParams(opts.mode, opts.network), opts.autoCompact);
    const client = await this.spawn(opts.cwd);
    try {
      const res = await client.request("thread/resume", {
        threadId: opts.sessionId,
        cwd: opts.cwd,
        approvalPolicy: APPROVAL_POLICY,
        ...sandbox,
        developerInstructions: BRIDGE_DEVELOPER_INSTRUCTIONS,
        ...opts.model ? { model: opts.model } : {}
      });
      return new CodexThread(client, res.thread.id, opts.model, opts.effort);
    } catch (err) {
      await client.close().catch(() => void 0);
      const message = err instanceof Error ? err.message : String(err);
      if (!/already has an active writer|thread-store conflict/i.test(message)) throw err;
      return this.resumeSharedThread(opts);
    }
  }
  async resumeSharedThread(opts) {
    let client;
    try {
      const bin = resolveCodexBin();
      const { createSharedDaemonClient } = await import("./bridge-shared-daemon.cjs");
      client = createSharedDaemonClient(AppServerClient, { bin, cwd: opts.cwd });
      await client.connect();
      const read = await client.request("thread/read", { threadId: opts.sessionId, includeTurns: false }, 10000);
      if (read.thread?.id !== opts.sessionId || !read.thread.status || read.thread.status.type === "notLoaded") {
        throw new Error("原会话未在共享后台中加载，可能由独立的桌面进程持有。");
      }
      // Rejoin without replacing the original model, permissions, instructions or goal.
      const res = await client.request("thread/resume", { threadId: opts.sessionId, excludeTurns: true }, 20000);
      if (res.thread?.id !== opts.sessionId) throw new Error("共享后台返回了不同的会话 ID。");
      log.info("agent", "resume-shared", { sessionId: opts.sessionId, pid: client.pid ?? null });
      return new CodexThread(client, res.thread.id, res.model, res.reasoningEffort ?? void 0);
    } catch (err) {
      if (client) await client.close().catch(() => void 0);
      const message = err instanceof Error ? err.message : String(err);
      const failure = new Error(\x60无法连接原会话 \x24{opts.sessionId} 的共享后台：\x24{message}。原绑定已保留，未新建会话。\x60);
      failure.preserveSession = true;
      throw failure;
    }
  }
  async spawn(cwd) {
    const bin = resolveCodexBin();
    if (!bin) throw new Error("codex CLI not found (set CODEX_BIN or install @openai/codex)");
    const warmed = takeWarmClient(bin);
    void refillWarmPool();
    if (warmed) return warmed;
    const client = new AppServerClient({ bin, cwd });
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.close().catch(() => void 0);
      throw err;
    }
  }` + source.slice(end);

  replaceOnce('      log.fail("agent", err, { phase: "resume-on-turn", threadId });\n',
    '      log.fail("agent", err, { phase: "resume-on-turn", threadId });\n      if (err?.preserveSession || /already has an active writer|thread-store conflict/i.test(err instanceof Error ? err.message : String(err))) throw err;\n');
  replaceOnce('        log.fail("agent", err, { phase: "comment-resume", sessionKey });\n',
    '        log.fail("agent", err, { phase: "comment-resume", sessionKey });\n        if (err?.preserveSession || /already has an active writer|thread-store conflict/i.test(err instanceof Error ? err.message : String(err))) throw err;\n');
  replaceOnce('\n          const ev = mapNotification(step.value);\n',
    '\n          if (self.client.sharedDaemon && step.value.params?.threadId !== self.sessionId) continue;\n          const ev = mapNotification(step.value);\n');
  replaceOnce('\n        const ev = mapNotification(step.value);\n',
    '\n        if (this.client.sharedDaemon && step.value.params?.threadId !== this.sessionId) continue;\n        const ev = mapNotification(step.value);\n');
}

const stage = path.resolve('work', 'bridge-repair');
fs.mkdirSync(stage, { recursive: true });
const staged = path.join(stage, 'cli.js');
fs.writeFileSync(staged, source);
execFileSync(process.execPath, ['--check', staged], {stdio:'pipe', windowsHide:true});
console.log(JSON.stringify({staged, changed: source !== original}));
if (process.argv.includes('--apply')) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (version !== '0.6.14') throw new Error('This patch is scoped to Bridge 0.6.14');
  if (source !== original) fs.copyFileSync(target, target + '.before-shared-daemon-' + Date.now() + '.bak');
  fs.copyFileSync(path.join(__dirname, 'bridge-shared-daemon.cjs'), path.join(root, 'dist', 'bridge-shared-daemon.cjs'));
  fs.writeFileSync(target + '.tmp-fix', source);
  fs.renameSync(target + '.tmp-fix', target);
  console.log(JSON.stringify({installed:true, version}));
}
