const assert = require('node:assert/strict');
const {test} = require('node:test');
const {loadBackend, loadResolveThread, loadResolveDocThread, loadThread} = require('./test-support.cjs');

const original = 'original-session';
const options = {cwd:'E:\\',sessionId:original,model:'bridge-default',effort:'low',mode:'full'};
function fixture({error, sharedError, state = 'active', sharedId = original, importError} = {}) {
  const calls = [];
  const independent = {
    request: async method => { calls.push(['independent',method]); if(error)throw error; return {thread:{id:original}}; },
    close: async () => { calls.push(['close-independent']); }
  };
  const shared = {
    connect: async () => {calls.push(['connect-shared']); if(sharedError)throw sharedError;},
    request: async (method,params) => {
      calls.push(['shared',method,params]);
      if(method === 'thread/read')return {thread:{id:original,status:{type:state}}};
      return {thread:{id:sharedId},model:'original-model',reasoningEffort:'high'};
    },
    close: async () => calls.push(['close-shared'])
  };
  class Thread {constructor(client,id,model,effort){Object.assign(this,{client,sessionId:id,model,effort});}}
  const Backend = loadBackend({
    AppServerClient: class {}, CodexThread: Thread,
    loadSharedModule: async () => {if(importError)throw importError;return {createSharedDaemonClient: () => shared};}
  });
  const backend = new Backend();
  backend.spawn = async () => independent;
  return {backend,calls,shared,independent};
}

test('normal resume keeps the standalone backend and original ID',async()=>{
  const f=fixture(); const thread=await f.backend.resumeThread(options);
  assert.equal(thread.sessionId,original); assert.equal(thread.client,f.independent);
  assert.equal(f.calls.some(c=>c[0]==='connect-shared'),false);
});
test('writer conflict closes the failed client before rejoining the original daemon',async()=>{
  const f=fixture({error:new Error('already has an active writer')});
  const thread=await f.backend.resumeThread(options);
  assert.equal(thread.sessionId,original); assert.equal(thread.client,f.shared);
  assert.equal(thread.model,'original-model'); assert.equal(thread.effort,'high');
  assert.ok(f.calls.findIndex(c=>c[0]==='close-independent') < f.calls.findIndex(c=>c[0]==='connect-shared'));
  const params=f.calls.find(c=>c[0]==='shared'&&c[1]==='thread/resume')[2];
  assert.deepEqual(JSON.parse(JSON.stringify(params)),{threadId:original,excludeTurns:true});
  assert.equal(f.calls.some(c=>/turn\/|goal\//.test(c[1]||'')),false);
});
test('not-loaded daemon target is rejected without creating a new session',async()=>{
  const f=fixture({error:new Error('thread-store conflict'),state:'notLoaded'});
  await assert.rejects(f.backend.resumeThread(options),error=>error.preserveSession===true);
  assert.ok(f.calls.some(c=>c[0]==='close-shared'));
  assert.equal(f.calls.some(c=>c[1]==='thread/start'),false);
});
test('connection failure cleans both clients and preserves original mapping',async()=>{
  const f=fixture({error:new Error('active writer: already has an active writer'),sharedError:new Error('daemon offline')});
  await assert.rejects(f.backend.resumeThread(options),error=>error.preserveSession===true&&/daemon offline/.test(error.message));
  assert.ok(f.calls.some(c=>c[0]==='close-independent')); assert.ok(f.calls.some(c=>c[0]==='close-shared'));
});
test('missing shared module cannot enter the fresh-session fallback',async()=>{
  const f=fixture({error:new Error('already has an active writer'),importError:new Error('module unavailable')});
  await assert.rejects(f.backend.resumeThread(options),error=>error.preserveSession===true);
});
test('mismatched shared session identity is rejected',async()=>{
  const f=fixture({error:new Error('already has an active writer'),sharedId:'wrong-session'});
  await assert.rejects(f.backend.resumeThread(options),error=>error.preserveSession===true);
});
test('start request failure closes its independent client',async()=>{
  const f=fixture({error:new Error('permission denied')});
  await assert.rejects(f.backend.startThread(options),/permission denied/);
  assert.ok(f.calls.some(c=>c[0]==='close-independent'));
});
test('non-conflict resume failures close the client and retain the original error',async()=>{
  const f=fixture({error:new Error('permission denied')});
  await assert.rejects(f.backend.resumeThread(options),/permission denied/);
  assert.ok(f.calls.some(c=>c[0]==='close-independent'));
  assert.equal(f.calls.some(c=>c[0]==='connect-shared'),false);
});
test('spawn handshake failure closes the newly created client',async()=>{
  let closed=0;
  const Backend=loadBackend({AppServerClient:class{
    async connect(){throw new Error('handshake failed');}
    async close(){closed++;}
  }});
  await assert.rejects(new Backend().spawn('E:\\'),/handshake failed/);assert.equal(closed,1);
});
test('warm client is reused without a second handshake',async()=>{
  const warmed={}; const Backend=loadBackend({takeWarmClient:()=>warmed});
  assert.equal(await new Backend().spawn('E:\\'),warmed);
});
test('preserved resume error cannot replace the topic binding',async()=>{
  let writes=0;let starts=0;
  const error=Object.assign(new Error('module unavailable'),{preserveSession:true});
  const resolve=loadResolveThread({
    sessions:new Map(),getSession:async()=>({sessionId:original,backend:'codex-appserver',cwd:'E:\\'}),
    getProjectByChatId:async()=>({cwd:'E:\\'}),
    backendFor:()=>({resumeThread:async()=>{throw error;},startThread:async()=>{starts++;}}),
    patchSession:async()=>{writes++;},log:{info(){},fail(){}},fallbackCwd:'E:\\'
  });
  await assert.rejects(resolve('topic','chat'),/module unavailable/);
  assert.equal(starts,0);assert.equal(writes,0);
});
test('document resume also preserves mapping after shared transport failure',async()=>{
  let starts=0;let writes=0;
  const error=Object.assign(new Error('shared daemon unavailable'),{preserveSession:true});
  const resolve=loadResolveDocThread({
    sessions:new Map(),commentInstrUsed:new Map(),
    getSession:async()=>({sessionId:original,cwd:'E:\\',backend:'codex-appserver'}),
    backendFor:()=>({resumeThread:async()=>{throw error;},startThread:async()=>{starts++;}}),
    upsertSession:async()=>{writes++;},log:{fail(){},info(){}}
  });
  await assert.rejects(resolve('document','E:\\','instructions','question'),/shared daemon unavailable/);
  assert.equal(starts,0);assert.equal(writes,0);
});

test('a raw active-writer error cannot recreate a topic session on a fresh upstream build',async()=>{
  let starts=0,writes=0;
  const error=new Error('already has an active writer');
  const resolve=loadResolveThread({
    sessions:new Map(),getSession:async()=>({sessionId:original,backend:'codex-appserver',cwd:'E:\\'}),
    getProjectByChatId:async()=>({cwd:'E:\\'}),
    backendFor:()=>({resumeThread:async()=>{throw error;},startThread:async()=>{starts++;}}),
    patchSession:async()=>{writes++;},log:{info(){},fail(){}},fallbackCwd:'E:\\'
  });
  await assert.rejects(resolve('topic','chat'),candidate=>candidate===error);
  assert.equal(starts,0);assert.equal(writes,0);
});

test('a raw writer-store conflict cannot recreate a document session on a fresh upstream build',async()=>{
  let starts=0,writes=0;
  const error=new Error('thread-store conflict');
  const resolve=loadResolveDocThread({
    sessions:new Map(),commentInstrUsed:new Map(),
    getSession:async()=>({sessionId:original,cwd:'E:\\',backend:'codex-appserver'}),
    backendFor:()=>({resumeThread:async()=>{throw error;},startThread:async()=>{starts++;}}),
    upsertSession:async()=>{writes++;},log:{fail(){},info(){}}
  });
  await assert.rejects(resolve('document','E:\\','instructions','question'),candidate=>candidate===error);
  assert.equal(starts,0);assert.equal(writes,0);
});
test('shared goal stream ignores events from another thread',async()=>{
  const events=[
    {params:{threadId:'other',mapped:{type:'turn_started',turnId:'wrong'}}},
    {params:{threadId:original,mapped:{type:'turn_started',turnId:'right'}}},
    {params:{threadId:'other',mapped:{type:'goal_update',objective:'goal',status:'complete'}}},
    {params:{threadId:original,mapped:{type:'goal_update',objective:'goal',status:'complete'}}},
    {params:{threadId:original,mapped:{type:'done'}}}
  ];
  const client={sharedDaemon:true,request:async()=>({}),stream:async function*(){yield* events;}};
  const Thread=loadThread();const run=new Thread(client,original).runGoal('goal');
  const seen=[];for await(const event of run.events)seen.push(event);
  assert.equal(seen.some(e=>e.turnId==='wrong'),false);assert.equal(seen[0].turnId,'right');
});
test('shared compaction ignores another thread completion',async()=>{
  const events=[
    {params:{threadId:'other',mapped:{type:'done'}}},
    {params:{threadId:original,mapped:{type:'context_compacted'}}},
    {params:{threadId:original,mapped:{type:'done'}}}
  ];
  const client={sharedDaemon:true,request:async()=>({}),stream:async function*(){yield* events;}};
  const Thread=loadThread({COMPACT_TIMEOUT_MS:1000});
  const result=await new Thread(client,original).compact();assert.equal(result.compacted,true);
});
