const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const M=require('./session-modules.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-modules-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'sessions.json');}
const session={sessionId:'00000000-0000-4000-8000-000000000001',backend:'codex-appserver',summary:'旧标题',updatedAt:100};
test('module name persists separately from task and original session identity',t=>{
  const file=fixture(t);M.setModuleName(file,session,'科研平台 UI');M.recordRecentTask(file,session,'迁移主题与验证交互',1000);
  const row=M.presentSession(session,file);assert.equal(row.moduleName,'科研平台 UI');assert.equal(row.recentTask,'迁移主题与验证交互');assert.equal(row.sessionId,session.sessionId);assert.equal(row.activityAt,1000000);
  M.recordRecentTask(file,session,'修复导航',2000);assert.equal(M.presentSession(session,file).moduleName,'科研平台 UI');
});
test('duplicate topics for the same session become one module row',t=>{
  const file=fixture(t);const rows=M.groupSessions([{...session,threadId:'old',updatedAt:1},{...session,threadId:'new',updatedAt:2}],file);
  assert.equal(rows.length,1);assert.equal(rows[0].topicCount,2);assert.equal(rows[0].threadId,'new');
});
test('matching UUIDs on different backends remain separate',t=>{
  const file=fixture(t);M.setModuleName(file,session,'Codex模块');
  const other={...session,backend:'claude'};assert.notEqual(M.presentSession(other,file).moduleName,'Codex模块');assert.equal(M.groupSessions([session,other],file).length,2);
});
test('the same module remains visible independently in both project groups',t=>{
  const file=fixture(t);const rows=M.groupSessions([{...session,chatId:'one'},{...session,chatId:'two'}],file);assert.equal(rows.length,2);
});
test('empty list and absent metadata are readable without writing files',t=>{
  const file=fixture(t);assert.deepEqual(M.groupSessions([],file),[]);assert.equal(M.presentSession(session,file).recentTask,'尚未记录最近任务');assert.equal(fs.existsSync(M.metadataPath(file)),false);
});
test('module naming checks empty names, newline, max length and missing session',t=>{
  const file=fixture(t);for(const name of ['', ' ', 'abc\ndef', '字'.repeat(41)])assert.throws(()=>M.setModuleName(file,session,name),/1–40/);
  M.setModuleName(file,session,'字'.repeat(40));assert.equal(M.presentSession(session,file).moduleName.length,40);
  assert.throws(()=>M.setModuleName(file,{},'name'),/尚未绑定/);
});
test('raw instructions are never used as module titles',t=>{
  const file=fixture(t);assert.equal(M.presentSession({...session,summary:'YOU ARE THE CODEAGENT EXECUTOR.\nWRITE OWNERSHIP: ...'},file).moduleName,'未命名模块');
  assert.equal(M.presentSession({...session,summary:'x'.repeat(600)},file).moduleName,'未命名模块');
});
test('commands do not replace recent work and credential fields are redacted',t=>{
  const file=fixture(t);M.recordRecentTask(file,session,'实现导入',1793288000000);M.recordRecentTask(file,session,'/module 新名');
  assert.equal(M.presentSession(session,file).recentTask,'实现导入');
  M.recordRecentTask(file,session,'配置 api_key=DO_NOT_DISPLAY');assert.equal(M.presentSession(session,file).recentTask.includes('DO_NOT_DISPLAY'),false);
});
test('short acknowledgements do not erase a meaningful task',t=>{
  const file=fixture(t);M.recordRecentTask(file,session,'完成 UI 迁移');
  for(const acknowledgement of ['goon','继续','好的','OK'])M.recordRecentTask(file,session,acknowledgement);
  assert.equal(M.presentSession(session,file).recentTask,'完成 UI 迁移');
});
test('corrupt metadata degrades read-only display but is never overwritten',t=>{
  const file=fixture(t);const target=M.metadataPath(file);fs.writeFileSync(target,'broken');
  assert.equal(M.presentSession(session,file).moduleName,'旧标题');assert.throws(()=>M.setModuleName(file,session,'新名'),/保留原文件/);assert.equal(fs.readFileSync(target,'utf8'),'broken');
});
test('read and write permission failures surface without mutating the original sessions file',t=>{
  const file=fixture(t);fs.mkdirSync(M.metadataPath(file));assert.throws(()=>M.setModuleName(file,session,'module'),/保留原文件/);assert.equal(fs.existsSync(file),false);
});
test('session timestamps accept seconds or milliseconds and sort recent work first',t=>{
  const file=fixture(t);const newer={...session,sessionId:'new',updatedAt:1793288001000};
  const older={...session,sessionId:'old',updatedAt:1793288000};
  assert.equal(M.groupSessions([older,newer],file)[0].sessionId,'new');
});
test('a later completion timestamp is reflected after the last task was assigned',t=>{
  const file=fixture(t);M.recordRecentTask(file,session,'任务',1793288000000);const row=M.presentSession({...session,updatedAt:1793288009000},file);assert.equal(row.activityAt,1793288009000);
});
