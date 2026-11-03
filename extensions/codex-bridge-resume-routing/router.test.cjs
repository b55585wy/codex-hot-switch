const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createResumeRouter, normalizeCwd, findNativeThread} = require('./router.cjs');

const ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000003';
function setup(options = {}) {
  const native = {id:ID, cwd:'E:\\work\\module', title:'最近任务', name:'后端模块', ...options.native};
  const project = {name:'工作项目', cwd:'E:\\work', chatId:'oc_work', backend:'codex-appserver', kind:'multi', blank:false, ...options.project};
  const projects = options.projects || [project];
  const records = [...(options.records || [])];
  const calls = {find:[], projects:0, sessions:0, bind:[], links:[], replies:[]};
  const router = createResumeRouter({
    isAdmin:msg => options.admin !== false,
    findThread:async id => {
      calls.find.push(id);
      if (options.lookupError) throw options.lookupError;
      return options.missing || id !== native.id ? null : native;
    },
    listProjects:async () => {calls.projects++; return projects;},
    listSessions:async () => {calls.sessions++; return records;},
    isAllowedProject:(msg, target) => options.allowed !== false && (!options.denyChatId || target.chatId !== options.denyChatId),
    bindSession:async (target, thread, msg) => {
      calls.bind.push({project:target, thread, msg});
      if (options.bindGate) await options.bindGate;
      if (options.bindError) throw options.bindError;
      const record = {threadId:'omt_created_' + calls.bind.length, sessionId:thread.id, chatId:target.chatId, backend:'codex-appserver'};
      records.push(record);
      return record;
    },
    linkFor:async (record, target) => {
      calls.links.push({record, project:target});
      if (options.linkError) throw options.linkError;
      return 'https://applink.feishu.cn/client/chat/open?chatId=' + target.chatId;
    },
    reply:async (msg, text) => {calls.replies.push({msg, text});},
    describe:thread => thread.name || thread.title
  });
  const msg = {content:'/resume ' + ID, senderId:'ou_owner', chatId:'oc_dm', chatType:'p2p'};
  return {router, msg, native, project, projects, records, calls, text:() => calls.replies.map(x => x.text).join('\n')};
}

test('a valid resume binds the existing native session exactly once without replacing its ID', async () => {
  const f = setup(); const result = await f.router(f.msg);
  assert.equal(result.ok, true); assert.equal(result.record.sessionId, ID); assert.equal(result.project.chatId, f.project.chatId);
  assert.equal(f.calls.bind.length, 1); assert.equal(f.calls.bind[0].thread.id, ID);
  assert.equal(f.calls.bind[0].project.chatId, f.project.chatId); assert.deepEqual(f.calls.find, [ID]);
  assert.ok(f.calls.replies.length > 0);
});

test('surrounding whitespace and multiple spaces between command and session are accepted', async () => {
  const f = setup(); const result = await f.router({...f.msg, content:'  \t/resume    ' + ID + '  \r\n'});
  assert.equal(result.ok, true); assert.deepEqual(f.calls.find, [ID]); assert.equal(f.calls.bind.length, 1);
});

test('uppercase UUID input is looked up using its canonical lowercase identity', async () => {
  const f = setup(); const result = await f.router({...f.msg, content:'/resume ' + ID.toUpperCase()});
  assert.equal(result.ok, true); assert.deepEqual(f.calls.find, [ID]); assert.equal(result.record.sessionId, ID);
});

for (const content of ['/resume', '/resume not-a-session', '/resume "' + ID + '"', '/resume ' + ID + ' trailing']) {
  test('invalid resume syntax replies with help without querying or binding: ' + content, async () => {
    const f = setup(); const result = await f.router({...f.msg, content});
    assert.equal(result.ok, false); assert.equal(f.calls.find.length, 0); assert.equal(f.calls.bind.length, 0);
    assert.match(f.text(), /resume|会话/i);
  });
}

test('admin authorization is checked before native metadata or projects are read', async () => {
  const f = setup({admin:false}); const result = await f.router(f.msg);
  assert.equal(result.ok, false); assert.equal(f.calls.find.length, 0); assert.equal(f.calls.projects, 0);
  assert.equal(f.calls.sessions, 0); assert.equal(f.calls.bind.length, 0); assert.ok(f.calls.replies.length > 0);
});

test('a missing native ID reports an error and does not create or bind a replacement session', async () => {
  const f = setup({missing:true}); const result = await f.router(f.msg);
  assert.equal(result.ok, false); assert.equal(f.calls.bind.length, 0); assert.equal(f.records.length, 0);
  assert.match(f.text(), /不存在|未找到|找不到|没有找到/);
});

test('an archived native session requires restoration instead of silently binding or replacing it', async () => {
  const f = setup({native:{archived:1}}); const result = await f.router(f.msg);
  assert.equal(result.ok, false); assert.equal(f.calls.bind.length, 0); assert.match(f.text(), /归档|恢复/);
});

test('native metadata errors are reported without claiming successful binding', async () => {
  const f = setup({lookupError:new Error('database temporarily unavailable')}); const result = await f.router(f.msg);
  assert.equal(result.ok, false); assert.equal(f.calls.bind.length, 0); assert.ok(f.calls.replies.length > 0);
});

test('Windows drive paths normalize prefix, separators, case and trailing separators consistently', () => {
  assert.equal(normalizeCwd('\\\\?\\E:\\Work\\Module\\'), normalizeCwd('e:/work/module'));
  assert.equal(normalizeCwd('E:\\'), normalizeCwd('e:/'));
});

test('Windows extended UNC paths normalize to the same share path', () => {
  assert.equal(normalizeCwd('\\\\?\\UNC\\NAS\\Share\\Work\\'), normalizeCwd('\\\\nas\\share\\work'));
});

test('the unique longest parent directory determines the target project', async () => {
  const projects = [
    {name:'E 根目录', cwd:'E:\\', chatId:'oc_root', backend:'codex-appserver', kind:'multi'},
    {name:'工作区', cwd:'E:\\work', chatId:'oc_parent', backend:'codex-appserver', kind:'multi'},
    {name:'具体模块', cwd:'E:\\work\\module', chatId:'oc_closest', backend:'codex-appserver', kind:'multi'}
  ];
  const f = setup({projects, native:{cwd:'\\\\?\\e:\\WORK\\MODULE\\backend'}});
  const result = await f.router(f.msg); assert.equal(result.ok, true); assert.equal(result.project.chatId, 'oc_closest');
  assert.equal(f.calls.bind[0].project.chatId, 'oc_closest');
});

test('textually similar directory prefixes do not cross a real directory boundary', async () => {
  const f = setup({native:{cwd:'E:\\workspace\\module'}}); const result = await f.router(f.msg);
  assert.equal(result.ok, false); assert.equal(f.calls.bind.length, 0);
});

test('multiple projects at the same closest directory require a choice rather than arbitrary binding', async () => {
  const projects = [
    {name:'项目甲', cwd:'E:\\work', chatId:'oc_a', backend:'codex-appserver', kind:'multi'},
    {name:'项目乙', cwd:'e:/WORK/', chatId:'oc_b', backend:'codex-appserver', kind:'multi'}
  ];
  const f = setup({projects}); const result = await f.router(f.msg);
  assert.equal(result.ok, false); assert.equal(f.calls.bind.length, 0); assert.ok(f.calls.replies.length > 0);
});

test('an explicit current-group project can disambiguate an otherwise tied directory', async () => {
  const projects = [
    {name:'项目甲', cwd:'E:\\work', chatId:'oc_a', backend:'codex-appserver', kind:'multi'},
    {name:'项目乙', cwd:'E:\\work', chatId:'oc_b', backend:'codex-appserver', kind:'multi'}
  ];
  const f = setup({projects}); const forced = projects[1];
  const result = await f.router({...f.msg, chatId:forced.chatId, chatType:'group'}, forced);
  assert.equal(result.ok, true); assert.equal(result.project.chatId, forced.chatId); assert.equal(f.calls.bind.length, 1);
});

test('a forced group cannot bind a session from a different working directory', async () => {
  const f = setup(); const forced = {...f.project, cwd:'D:\\other', chatId:'oc_other'};
  const result = await f.router({...f.msg, chatId:forced.chatId, chatType:'group'}, forced);
  assert.equal(result.ok, false); assert.equal(f.calls.bind.length, 0); assert.ok(f.calls.replies.length > 0);
});

test('a forced non-Codex backend cannot receive a native Codex session', async () => {
  const f = setup(); const forced = {...f.project, backend:'claude-code'};
  const result = await f.router({...f.msg, chatId:forced.chatId, chatType:'group'}, forced);
  assert.equal(result.ok, false); assert.equal(f.calls.bind.length, 0);
});

test('automatic selection does not bind to a project with a different backend', async () => {
  const f = setup({project:{backend:'claude-code'}}); const result = await f.router(f.msg);
  assert.equal(result.ok, false); assert.equal(f.calls.bind.length, 0);
});

test('no directory-matching project produces a clear error without making a project', async () => {
  const f = setup({native:{cwd:'D:\\unregistered'}}); const result = await f.router(f.msg);
  assert.equal(result.ok, false); assert.equal(f.calls.bind.length, 0); assert.match(f.text(), /项目|目录|工作/);
});

for (const project of [{blank:true}, {chatId:''}]) {
  test('an unconfigured project is not used as a binding target: ' + JSON.stringify(project), async () => {
    const f = setup({project}); const result = await f.router(f.msg);
    assert.equal(result.ok, false); assert.equal(f.calls.bind.length, 0);
  });
}

test('an existing matching session ID, chat and backend reuses its original topic', async () => {
  const existing = {sessionId:ID, chatId:'oc_work', backend:'codex-appserver', threadId:'omt_original'};
  const f = setup({records:[existing]}); const result = await f.router(f.msg);
  assert.equal(result.ok, true); assert.equal(result.reused, true); assert.equal(result.record.threadId, 'omt_original');
  assert.equal(f.calls.bind.length, 0); assert.equal(f.calls.links[0].record.threadId, 'omt_original');
});

test('a session registered in another chat is not mistaken for a binding in the target project', async () => {
  const f = setup({records:[{sessionId:ID, chatId:'oc_unrelated', backend:'codex-appserver', threadId:'omt_other'}]});
  const result = await f.router(f.msg); assert.equal(result.ok, true); assert.equal(f.calls.bind.length, 1);
  assert.equal(result.record.chatId, 'oc_work');
});

test('a different backend record with the same ID is not reused', async () => {
  const f = setup({records:[{sessionId:ID, chatId:'oc_work', backend:'claude-code', threadId:'omt_claude'}]});
  const result = await f.router(f.msg); assert.equal(result.ok, true); assert.equal(f.calls.bind.length, 1);
  assert.equal(result.record.backend, 'codex-appserver');
});

test('another native session in the same chat does not satisfy the requested binding', async () => {
  const f = setup({records:[{sessionId:OTHER_ID, chatId:'oc_work', backend:'codex-appserver', threadId:'omt_other_session'}]});
  const result = await f.router(f.msg); assert.equal(result.ok, true); assert.equal(f.calls.bind.length, 1);
  assert.equal(result.record.sessionId, ID);
});

test('simultaneous resumes for one project and native ID bind once and reuse the result', async () => {
  let release; const bindGate = new Promise(resolve => {release = resolve;}); const f = setup({bindGate});
  const first = f.router(f.msg), second = f.router({...f.msg});
  await new Promise(resolve => setImmediate(resolve)); const concurrentBinds = f.calls.bind.length; release();
  const results = await Promise.all([first, second]);
  assert.equal(concurrentBinds, 1); assert.equal(f.calls.bind.length, 1); assert.ok(results.every(x => x.ok));
  assert.equal(results[0].record.threadId, results[1].record.threadId); assert.equal(results.filter(x => x.reused).length, 1);
});

test('the same native session can bind independently in two explicitly selected groups', async () => {
  let release; const bindGate = new Promise(resolve => {release = resolve;});
  const projects = [
    {name:'项目甲', cwd:'E:\\work', chatId:'oc_a', backend:'codex-appserver', kind:'multi'},
    {name:'项目乙', cwd:'E:\\work', chatId:'oc_b', backend:'codex-appserver', kind:'multi'}
  ];
  const f = setup({projects, bindGate});
  const pending = projects.map(p => f.router({...f.msg, chatId:p.chatId, chatType:'group'}, p));
  await new Promise(resolve => setImmediate(resolve)); const concurrentBinds = f.calls.bind.length; release();
  const results = await Promise.all(pending); assert.equal(concurrentBinds, 2); assert.ok(results.every(x => x.ok));
  assert.deepEqual(results.map(x => x.record.chatId).sort(), ['oc_a', 'oc_b']);
});

test('target-project access denial prevents binding even for an admin request', async () => {
  const f = setup({allowed:false}); const result = await f.router(f.msg);
  assert.equal(result.ok, false); assert.equal(f.calls.bind.length, 0); assert.equal(f.calls.links.length, 0);
});

test('target-project access denial also applies to explicitly forced groups', async () => {
  const f = setup({allowed:false}); const result = await f.router({...f.msg, chatId:f.project.chatId, chatType:'group'}, f.project);
  assert.equal(result.ok, false); assert.equal(f.calls.bind.length, 0);
});

test('binding failure reports failure and does not claim success or create a native replacement', async () => {
  const f = setup({bindError:new Error('Feishu permission denied')}); const result = await f.router(f.msg);
  assert.equal(result.ok, false); assert.equal(f.calls.bind.length, 1); assert.equal(f.records.length, 0); assert.equal(f.calls.links.length, 0);
  assert.match(f.text(), /失败|denied|错误|无法/i);
});

test('a failed binding releases its lock so the next retry can succeed', async () => {
  const options = {bindError:new Error('temporary chat error')}, f = setup(options);
  const first = await f.router(f.msg); assert.equal(first.ok, false); options.bindError = null;
  const second = await f.router(f.msg); assert.equal(second.ok, true); assert.equal(f.calls.bind.length, 2);
});

test('topic-link failure falls back to the group link while retaining the successful binding', async () => {
  const f = setup({linkError:new Error('topic link unavailable')}); const result = await f.router(f.msg);
  assert.equal(result.ok, true); assert.equal(f.calls.bind.length, 1); assert.equal(result.record.sessionId, ID);
  assert.match(f.text(), /https:\/\/applink\.feishu\.cn\//);
});

const fixtureBase = path.resolve(__dirname, '../../work/resume-routing-test-fixtures');
function nativeFixture(t) {
  fs.mkdirSync(fixtureBase, {recursive:true}); const dir = fs.mkdtempSync(path.join(fixtureBase, 'native-'));
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(fixtureBase + path.sep), 'Cleanup must stay inside its workspace fixture directory');
    fs.rmSync(dir, {recursive:true, force:true});
  });
  return dir;
}

test('native lookup reads the exact requested thread metadata without modifying its SQLite store', t => {
  const {DatabaseSync} = require('node:sqlite'), dir = nativeFixture(t), file = path.join(dir, 'state_5.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, name TEXT, title TEXT, archived INTEGER)');
  const add = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)');
  add.run(ID, 'E:\\work\\module', '后端模块', '最近任务', 0); add.run(OTHER_ID, 'D:\\other', '其他模块', '其他任务', 0); db.close();
  const before = fs.readFileSync(file), row = findNativeThread(dir, ID);
  assert.equal(row.id, ID); assert.equal(row.cwd, 'E:\\work\\module'); assert.equal(row.name, '后端模块');
  assert.deepEqual(fs.readFileSync(file), before); assert.ok(findNativeThread(dir, '00000000-0000-4000-8000-000000000000') == null);
  assert.ok(findNativeThread(dir, "' OR 1=1 --") == null, 'Native lookup must use the exact parameter rather than interpreting SQL text');
});

test('a missing native store is reported without creating a replacement database', t => {
  const dir = nativeFixture(t); assert.throws(() => findNativeThread(dir, ID));
  assert.equal(fs.existsSync(path.join(dir, 'state_5.sqlite')), false);
});
