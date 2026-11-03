const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.env.BRIDGE_PACKAGE_ROOT || path.resolve(__dirname, '../..');
if (!root) throw new Error('Set BRIDGE_PACKAGE_ROOT to the installed Bridge package');
const source = fs.readFileSync(process.env.BRIDGE_TEST_SOURCE || path.join(root, 'dist', 'cli.js'), 'utf8');

class TestQueue {
  items = [];
  ended = false;
  push(item) { this.items.push(item); }
  close() { this.ended = true; }
  clear() { this.items = []; }
}

function slice(begin, end) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start);
  if (start < 0 || finish < 0) throw new Error('Cannot extract ' + begin);
  return source.slice(start, finish);
}

function loadClient(overrides = {}) {
  const code = slice('var AppServerClient = class', '\n// src/agent/codex-appserver/client-pool.ts');
  return vm.runInNewContext(code + '\nAppServerClient;', {
    AsyncQueue: TestQueue, Map, Error, setTimeout, clearTimeout, process,
    JsonRpcError: class JsonRpcError extends Error {},
    UnsentRequestError: class UnsentRequestError extends Error {},
    log: {info() {}, warn() {}}, ...overrides
  });
}

function loadBackend(overrides = {}) {
  let code = slice('var CodexAppServerBackend = class', '\nfunction isBoilerplateUserText');
  code = code.replace('await import("./bridge-shared-daemon.cjs")', 'await loadSharedModule()');
  return vm.runInNewContext(code + '\nCodexAppServerBackend;', {
    Error, DEFAULT_TITLE_DEPS: {},
    sandboxParams: () => ({sandbox: 'read-only'}),
    withAutoCompact: value => value,
    APPROVAL_POLICY: 'never', BRIDGE_DEVELOPER_INSTRUCTIONS: 'bridge instructions',
    resolveCodexBin: () => 'codex-test',
    takeWarmClient: () => null, refillWarmPool: async () => {},
    log: {info() {}}, assertAccountReady() {},
    ...overrides
  });
}

function loadResolveThread(overrides) {
  const code = slice('  async function resolveThread(', '  async function evictLiveSessionsForChat(');
  return vm.runInNewContext(`(function(){${code}; return resolveThread;})()`, {Error, ...overrides});
}

function loadResolveDocThread(overrides) {
  const code = slice('  async function resolveDocThread(', '  async function onBotAddedToChat(');
  return vm.runInNewContext(`(function(){${code}; return resolveDocThread;})()`, {Error, ...overrides});
}

function loadThread(overrides = {}) {
  const code = slice('var CodexThread = class', '\nvar CodexAppServerBackend = class');
  return vm.runInNewContext(code + '\nCodexThread;', {
    Error, Date, Promise, setTimeout, clearTimeout, assertAccountReady() {},
    toUserInput: input => [{type:'text', text:input}],
    mapNotification: notification => notification.params?.mapped,
    isGoalTerminal: status => status === 'complete',
    log:{fail() {}}, markManagedNotificationTurn() {}, ...overrides
  });
}

module.exports = {root, loadClient, loadBackend, loadResolveThread, loadResolveDocThread, loadThread};
