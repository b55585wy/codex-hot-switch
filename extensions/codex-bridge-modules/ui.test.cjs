const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const M=require('./session-modules.cjs');
const source=fs.readFileSync(process.env.BRIDGE_TEST_SOURCE || path.resolve(__dirname, '../../dist/cli.js'),'utf8');
function extract(name,next){const begin=source.indexOf('function '+name+'(');const end=source.indexOf('function '+next+'(',begin);if(begin<0||end<0)throw new Error(name+' missing');return source.slice(begin,end);}
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-module-ui-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'sessions.json');}
function loadCard(name,next,file){return vm.runInNewContext('('+extract(name,next)+')',{
  ...M,paths:{sessionsFile:file},metaNote:()=>'',pickerTime:()=> '刚刚',RES:{pick:'resume.pick'},DM:{menu:'menu',projects:'projects'},
  md:text=>({type:'md',text}),note:text=>({type:'note',text}),hr:()=>({type:'hr'}),
  actions:buttons=>({type:'actions',buttons}),button:(label,value)=>({label,value}),linkButton:(label,url)=>({label,url}),
  openChatUrl:id=>'chat:'+id,card:(elements,options)=>({elements,options})
});}
test('resume card separates stable module and recent task, retaining native selection ID',t=>{
  const file=fixture(t);const row={sessionId:'original',backend:'codex-appserver',name:'旧标题',updatedAt:100};
  M.setModuleName(file,row,'科研平台 UI');M.recordRecentTask(file,row,'迁移琴键主题');
  const build=loadCard('buildResumeCard','buildResumeLaunchingCard',file);const card=build({threads:[row],backend:'codex-appserver'});
  assert.match(JSON.stringify(card),/科研平台 UI/);assert.match(JSON.stringify(card),/迁移琴键主题/);
  const action=card.elements.find(e=>e.type==='actions');assert.equal(action.buttons[0].value.t,'original');
});
test('project module card merges duplicate records and avoids long raw prompts',t=>{
  const file=fixture(t);const row={sessionId:'original',backend:'codex-appserver',summary:'YOU ARE THE EXECUTOR',updatedAt:100};
  const build=loadCard('buildProjectTopicsCard','buildRmConfirmCard',file);const card=build({name:'项目',chatId:'group'},[row,row]);
  const text=JSON.stringify(card);assert.match(text,/1 个模块会话/);assert.match(text,/未命名模块/);assert.doesNotMatch(text,/YOU ARE/);
});
test('resume card uses the selected backend for stable module names',t=>{
  const file=fixture(t);M.setModuleName(file,{sessionId:'claude-session',backend:'claude'},'Claude测试模块');
  const build=loadCard('buildResumeCard','buildResumeLaunchingCard',file);const card=build({threads:[{sessionId:'claude-session',name:'旧名'}],backend:'claude'});assert.match(JSON.stringify(card),/Claude测试模块/);
});
function commandFixture(t,{admin=true,record=true}={}){
  const file=fixture(t);const replies=[];const bound={sessionId:'original',backend:'codex-appserver'};
  const code=extract('handleModuleCommand','parseCommand').replace('async function','function');
  // Keep the real async command body; function expression extraction includes its async prefix below.
  const fn=vm.runInNewContext('(async '+code+')',{
    ...M,paths:{sessionsFile:file},cfg:{},isAdmin:()=>admin,
    denyAdminCommand:async()=>replies.push('denied'),
    channel:{send:async(chat,body)=>replies.push(body.markdown)},
    turnSession:key=>({sessionKey:key}),getSession:async()=>record?bound:undefined,Error
  });
  return {fn,replies,file,bound};
}
test('module command saves label for an existing topic without starting an agent',async t=>{
  const f=commandFixture(t);await f.fn({senderId:'owner',chatId:'group',threadId:'topic'}, {kind:'multi'},'/module UI模块');
  assert.equal(M.presentSession(f.bound,f.file).moduleName,'UI模块');assert.match(f.replies[0],/已将本会话/);
});
test('non-admin cannot rename, and main-group command cannot rename an unrelated topic',async t=>{
  const denied=commandFixture(t,{admin:false});await denied.fn({senderId:'other',chatId:'group',threadId:'topic'},{kind:'multi'},'/module name');assert.equal(denied.replies[0],'denied');
  const main=commandFixture(t);await main.fn({senderId:'owner',chatId:'group'},{kind:'multi'},'/module name');assert.match(main.replies[0],/在负责该模块的话题/);assert.equal(fs.existsSync(M.metadataPath(main.file)),false);
});
test('single-session groups can name their bound session',async t=>{
  const f=commandFixture(t);await f.fn({senderId:'owner',chatId:'group'},{kind:'single'},'/module 后端');assert.equal(M.presentSession(f.bound,f.file).moduleName,'后端');
});
test('missing binding and invalid module names return actionable replies',async t=>{
  const missing=commandFixture(t,{record:false});await missing.fn({senderId:'owner',chatId:'group',threadId:'topic'},{kind:'multi'},'/module name');assert.match(missing.replies[0],/尚未绑定/);
  const f=commandFixture(t);await f.fn({senderId:'owner',chatId:'group',threadId:'topic'},{kind:'multi'},'/module '+ '字'.repeat(41));assert.match(f.replies[0],/1–40/);
});
test('querying module name is read-only and names are escaped for cards',async t=>{
  const f=commandFixture(t);M.setModuleName(f.file,f.bound,'模块[*]');await f.fn({senderId:'owner',chatId:'group',threadId:'topic'},{kind:'multi'},'/module');assert.match(f.replies[0],/模块\\\[/);
});
