const test = require('node:test');
const assert = require('node:assert/strict');
const {configurePrivate} = require('../../scripts/configure-private.cjs');

test('a fresh bot enables quiet completion monitoring and bound-topic delivery', () => {
  const config = configurePrivate({accounts:{app:{id:'example-app', secret:{source:'exec', id:'secret-ref'}}}});
  assert.equal(config.preferences.cliBridge.enabled, true);
  assert.equal(config.preferences.cliBridge.desktopObserver.enabled, true);
  assert.equal(config.preferences.cliBridge.completionTarget, 'bound_topic');
  assert.equal(config.preferences.cliBridge.delivery, 'always');
  assert.equal(config.preferences.completionReminder.mode, 'always');
});
test('setup preserves credentials and does not mutate the source configuration', () => {
  const config = {accounts:{app:{secret:{source:'exec', provider:'example', id:'reference-only'}}}};
  const before = JSON.stringify(config), result = configurePrivate(config);
  assert.deepEqual(result.accounts, config.accounts); assert.equal(JSON.stringify(config), before);
});
test('setup preserves access, voice, watchdog and explicit notification-scope preferences', () => {
  const config = {preferences:{access:{ownerOpenId:'example-owner'}, voice:{enabled:false}, runIdleTimeoutSeconds:0,
    cliBridge:{notifyScope:'none', agents:{claude:true}, taskCompletion:{replyEnabled:false, replyTimeoutSeconds:900}}}};
  const result = configurePrivate(config);
  assert.deepEqual(result.preferences.access, config.preferences.access);
  assert.deepEqual(result.preferences.voice, config.preferences.voice);
  assert.equal(result.preferences.runIdleTimeoutSeconds, 0);
  assert.equal(result.preferences.cliBridge.notifyScope, 'none');
  assert.equal(result.preferences.cliBridge.agents.claude, true);
  assert.equal(result.preferences.cliBridge.taskCompletion.replyEnabled, false);
  assert.equal(result.preferences.cliBridge.taskCompletion.replyTimeoutSeconds, 900);
});
test('private setup is idempotent', () => {
  const once = configurePrivate({preferences:{completionReminder:{longTaskMinutes:7}}});
  assert.deepEqual(configurePrivate(once), once);
});
test('invalid top-level configuration is rejected', () => {
  for (const input of [null, [], 'invalid']) assert.throws(() => configurePrivate(input), /configuration object/);
});
