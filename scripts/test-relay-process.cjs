const { spawn, fork } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtemp, copyFile, writeFile, mkdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, sep } = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const esbuild = require('esbuild');
const workspace = resolve(__dirname, '..');
const fixtures = join(workspace, 'test', 'fixtures');
const appId = 'cli_process_acceptance';
const secret = 'process-acceptance-signing-secret';
const nodeId = '81818181-8181-4181-8181-818181818181';
const gatewayId = '82828282-8282-4282-8282-828282828282';
const token = randomBytes(32).toString('base64url');
let root, server, receiver, sender, library;
const checks = [];
const latencies = [];
function check(condition, name) { if (!condition) throw new Error(name); checks.push(name); }
function environment() {
  const env = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  return { ...env, HOME: join(root, 'test-home'), USERPROFILE: join(root, 'test-home'), NODE_PATH: '' };
}
async function bootServer(port = 0) {
  server = spawn(process.execPath, [join(root, 'relay-server.cjs'), '--storage-only'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...environment(), CODEX_RELAY_APP_ID: appId, CODEX_RELAY_TOKEN_FILE: join(root, 'test-token'),
      CODEX_RELAY_GATEWAY_ENABLED: 'false', CODEX_RELAY_PORT: String(port), CODEX_RELAY_DATA_DIR: join(root, 'server-data') },
  });
  const instance = server;
  return new Promise((resolveReady, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('server startup deadline')), 10000);
    instance.once('error', error => { clearTimeout(timer); reject(error); });
    instance.once('exit', code => { clearTimeout(timer); reject(new Error('server exited ' + code)); });
    instance.stderr.on('data', () => {});
    instance.stdout.on('data', bytes => {
      output = (output + bytes.toString()).slice(-8192);
      const found = /relay server listening at (ws:\/\/127\.0\.0\.1:\d+\/relay\/v1)/.exec(output);
      if (found) { clearTimeout(timer); resolveReady(found[1]); }
    });
  });
}
function bootReceiver(url) {
  const child = fork(join(fixtures, 'fleet-relay-process-receiver.cjs'), [], { cwd: root, silent: true,
    env: { ...environment(), RELAY_QA_URL: url, RELAY_QA_TOKEN_FILE: join(root, 'test-token'),
      RELAY_QA_LIBRARY: join(root, 'process-library.cjs'), RELAY_QA_DATA: join(root, 'worker-data') } });
  const messages = [], waiters = [];
  child.on('message', value => {
    messages.push(value);
    for (const waiter of [...waiters]) if (waiter.accept(value)) {
      waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(value);
    }
  });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  const next = (accept, timeout = 10000) => {
    const prior = messages.find(accept);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolveNext, reject) => {
      const waiter = { accept, resolve: resolveNext, timer: setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('receiver response deadline'));
      }, timeout) };
      waiters.push(waiter);
    });
  };
  return { child, messages, next };
}
async function waitFor(predicate, description) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(description);
}
async function stopProcess(instance) {
  if (!instance || instance.exitCode !== null || instance.signalCode !== null) return;
  await new Promise(done => {
    const timer = setTimeout(() => { instance.kill('SIGKILL'); done(); }, 3000);
    instance.once('exit', () => { clearTimeout(timer); done(); }); instance.kill('SIGTERM');
  });
}
async function stopReceiver() {
  if (!receiver) return;
  const current = receiver; receiver = undefined;
  if (current.child.connected) { current.child.send({ type: 'stop' }); await current.next(v => v.type === 'stopped').catch(() => {}); }
  await stopProcess(current.child);
}
async function source(url) {
  sender = new library.FleetRelayClient({ url, token, appId, nodeId: gatewayId, host: 'process-acceptance-source',
    role: 'worker', autoReconnect: false });
  await sender.connect();
  return new library.SignedFleetStore(sender, appId, secret);
}
function event(id) {
  return { kind: 'message', data: { messageId: id, chatId: 'oc_acceptance_dm', chatType: 'p2p',
    senderId: 'ou_acceptance', content: 'process acceptance', mentionedBot: false,
    threadId: 'omt_preserved', replyToMessageId: 'om_parent', raw: { event_id: id, nested: { retained: true } } } };
}
function command(value) {
  const now = Date.now();
  return { id: library.commandId(value, nodeId), appId, source: gatewayId, target: nodeId,
    createdAt: now, expiresAt: now + library.COMMAND_TTL_MS, event: value };
}
async function putCommand(store, value) {
  const cmd = command(value);
  await store.put('commands', cmd.id, cmd, nodeId, cmd.expiresAt);
  return cmd;
}
async function deliver(store, value) {
  const began = Date.now();
  const cmd = await putCommand(store, value);
  const received = await receiver.next(v => v.type === 'event' && v.event.data.messageId === value.data.messageId, 2500);
  const elapsed = Date.now() - began;
  check(isDeepStrictEqual(received.event, value), 'wire preserves event ' + value.data.messageId);
  check(elapsed < 2500, 'push avoids 60-second polling ' + value.data.messageId);
  latencies.push(elapsed);
  await waitFor(async () => !await store.get('commands', cmd.id), 'command receipt removal deadline');
  return cmd;
}
async function run() {
  root = await mkdtemp(join(tmpdir(), 'relay-process-acceptance-'));
  await mkdir(join(root, 'test-home'));
  await writeFile(join(root, 'test-token'), token, { mode: 0o600 });
  await copyFile(join(workspace, 'dist', 'relay-server.cjs'), join(root, 'relay-server.cjs'));
  await esbuild.build({ entryPoints: [join(fixtures, 'fleet-relay-process-library.ts')], outfile: join(root, 'process-library.cjs'),
    bundle: true, format: 'cjs', platform: 'node', target: 'node24', logLevel: 'silent',
    external: ['bufferutil', 'utf-8-validate', '@anthropic-ai/claude-agent-sdk'] });
  library = require(join(root, 'process-library.cjs'));
  let url = await bootServer();
  let store = await source(url);
  await store.put('routes', 'home', { nodeId });
  await store.put('nodes', gatewayId, { id: gatewayId, name: 'Gateway QA', kind: 'gateway', protocol: 1,
    seenAt: Date.now(), host: 'process-acceptance-source' });
  receiver = bootReceiver(url);
  const ready = await receiver.next(v => v.type === 'ready');
  check(ready.pid !== server.pid && ready.pid !== process.pid && server.pid !== process.pid, 'server and production worker run in independent processes');
  const original = await deliver(store, event('om_process_initial'));
  const card = { kind: 'cardAction', data: { messageId: 'om_process_card', chatId: 'oc_acceptance_dm',
    operator: { openId: 'ou_acceptance' }, threadId: 'omt_card_preserved',
    action: { tag: 'button', value: { a: 'test.continue', __r: 'render-token-preserved', __fleetNode: nodeId,
      __fleetProof: store.proof({ cardNode: nodeId }) } }, raw: { event_id: 'card-source-event' } } };
  await deliver(store, card);
  await stopReceiver();
  receiver = bootReceiver(url);
  await receiver.next(v => v.type === 'ready');
  await store.put('commands', original.id, original, nodeId, original.expiresAt);
  await waitFor(async () => !await store.get('commands', original.id), 'receipt replay cleanup deadline');
  check(receiver.messages.filter(v => v.type === 'event').length === 0, 'restarted worker retains inbox and never replays accepted command');
  await deliver(store, event('om_process_after_worker_restart'));
  const port = Number(new URL(url).port);
  await sender.close(); sender = undefined;
  await stopProcess(server); server = undefined;
  url = await bootServer(port);
  store = await source(url);
  await receiver.next(v => v.type === 'reconnected-active', 12000);
  await waitFor(() => sender.isNodeConnected(nodeId), 'reactivation presence deadline');
  check(true, 'server restart recovers storage and worker reactivates');
  await deliver(store, event('om_process_after_server_restart'));
  process.stdout.write(JSON.stringify({ success: true, checks: checks.length, independentProcesses: true, deliveryMs: latencies }) + '\n');
}
run().catch(error => { process.stderr.write(JSON.stringify({ success: false, checks, error: error.message }) + '\n'); process.exitCode = 1; })
  .finally(async () => {
    await stopReceiver();
    if (sender) await sender.close().catch(() => {});
    await stopProcess(server);
    if (root) { const target = resolve(root); if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('unsafe cleanup'); await rm(target, { recursive: true, force: true }); }
  });
