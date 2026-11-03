const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadThread} = require('./test-support.cjs');
for (const method of ['runStreamed', 'runGoal']) {
  test('account transition rejects ' + method + ' before any model or goal request', () => {
    const error = new Error('account transition');
    const Thread = loadThread({assertAccountReady() {throw error;}});
    const thread = new Thread({}, 'fixture-session');
    assert.throws(() => thread[method]('continue'), candidate => candidate === error);
  });
}
test('account transition rejects compaction before a backend request', async () => {
  const error = new Error('account transition');
  const Thread = loadThread({assertAccountReady() {throw error;}});
  const thread = new Thread({}, 'fixture-session');
  await assert.rejects(thread.compact(), candidate => candidate === error);
});
