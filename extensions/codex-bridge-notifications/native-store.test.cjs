const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {readNativeThreads} = require('./observer.cjs');
const fixtureBase = path.resolve(__dirname, '../../work/notification-test-fixtures');
fs.mkdirSync(fixtureBase, {recursive:true});

test('native store query reads live main-session metadata and excludes archived rows', t => {
  const dir = fs.mkdtempSync(path.join(fixtureBase, 'native-'));
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(fixtureBase + path.sep));
    fs.rmSync(dir, {recursive:true, force:true});
  });
  const file = path.join(dir, 'state_5.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, source TEXT, cwd TEXT, title TEXT, name TEXT, archived INTEGER)');
  const add = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)');
  add.run('live', path.join(dir, 'live.jsonl'), 'vscode', 'E:\\', '当前任务', '后端模块', 0);
  add.run('old', path.join(dir, 'old.jsonl'), 'vscode', 'E:\\', '历史任务', null, 1);
  db.close();
  const before = fs.readFileSync(file);
  assert.deepEqual(readNativeThreads(dir).map(x => ({id:x.id, name:x.name, cwd:x.cwd})), [{id:'live', name:'后端模块', cwd:'E:\\'}]);
  assert.deepEqual(fs.readFileSync(file), before, 'Native SQLite database must remain unchanged');
});

test('missing native database reports a readable failure rather than creating a replacement', t => {
  const dir = fs.mkdtempSync(path.join(fixtureBase, 'missing-native-'));
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(fixtureBase + path.sep));
    fs.rmSync(dir, {recursive:true, force:true});
  });
  assert.throws(() => readNativeThreads(dir));
  assert.equal(fs.existsSync(path.join(dir, 'state_5.sqlite')), false);
});

test('goal status is joined read-only from the native goals database by exact thread ID', t => {
  const dir = fs.mkdtempSync(path.join(fixtureBase, 'native-goals-'));
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(fixtureBase + path.sep));
    fs.rmSync(dir, {recursive:true, force:true});
  });
  const stateFile = path.join(dir, 'state_5.sqlite'), goalFile = path.join(dir, 'goals_1.sqlite');
  const state = new DatabaseSync(stateFile);
  state.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, source TEXT, cwd TEXT, title TEXT, name TEXT, archived INTEGER)');
  const add = state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)');
  for (const id of ['active-goal', 'finished-goal', 'plain']) add.run(id, path.join(dir, id + '.jsonl'), 'vscode', 'E:\\', id, null, 0);
  state.close();
  const goals = new DatabaseSync(goalFile);
  goals.exec('CREATE TABLE thread_goals (thread_id TEXT, status TEXT)');
  goals.prepare('INSERT INTO thread_goals VALUES(?,?)').run('active-goal', 'active');
  goals.prepare('INSERT INTO thread_goals VALUES(?,?)').run('finished-goal', 'complete');
  goals.prepare('INSERT INTO thread_goals VALUES(?,?)').run('unrelated', 'active');
  goals.close();
  const stateBefore = fs.readFileSync(stateFile), goalBefore = fs.readFileSync(goalFile);
  const statuses = Object.fromEntries(readNativeThreads(dir).map(row => [row.id, row.goalStatus]));
  assert.deepEqual(statuses, {'active-goal':'active', 'finished-goal':'complete', plain:undefined});
  assert.deepEqual(fs.readFileSync(stateFile), stateBefore); assert.deepEqual(fs.readFileSync(goalFile), goalBefore);
});
