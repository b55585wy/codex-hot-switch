const assert=require('node:assert/strict');
const {test}=require('node:test');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {createSharedDaemonClient}=require('./bridge-shared-daemon.cjs');
const {loadClient}=require('./test-support.cjs');

function transportFixture({handshakeError=false}={}){
  let socket;const wire=[];let proxyKills=0;
  const proxy=Object.assign(new EventEmitter(),{
    pid:123,exitCode:null,signalCode:null,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),
    kill(){proxyKills++;this.signalCode='SIGTERM';this.emit('exit',null,'SIGTERM');}
  });
  class Socket extends EventEmitter{
    static OPEN=1;static CLOSED=3;
    readyState=0;
    constructor(url,options){super();socket=this;this.stream=options.createConnection();setImmediate(()=>{
      if(handshakeError)this.emit('error',new Error('upgrade failed'));
      else {this.readyState=1;this.emit('open');}
    });}
    send(payload,callback){
      const message=JSON.parse(payload);wire.push(message);callback?.();
      if(message.id&&message.method==='initialize')setImmediate(()=>this.emit('message',Buffer.from(JSON.stringify({id:message.id,result:{userAgent:'test'}}))));
    }
    close(){this.readyState=3;this.emit('close');proxy.exitCode=0;proxy.emit('exit',0,null);}
    terminate(){this.close();}
  }
  const Base=loadClient();
  const client=createSharedDaemonClient(Base,{bin:'codex',cwd:'E:\\'},{WebSocket:Socket,spawn:(bin,args)=>{
    assert.deepEqual(args,['app-server','proxy']);return proxy;
  }});
  return {client,wire,proxy,get socket(){return socket;},get proxyKills(){return proxyKills;}};
}

test('shared transport initializes through WebSocket and completes JSON-RPC requests',async()=>{
  const f=transportFixture();await f.client.connect();
  assert.equal(f.wire[0].method,'initialize');assert.equal(f.wire[1].method,'initialized');
  const pending=f.client.request('thread/read',{threadId:'original'},1000);
  const sent=f.wire.at(-1);f.socket.emit('message',Buffer.from(JSON.stringify({id:sent.id,result:{thread:{id:'original'}}})));
  assert.equal((await pending).thread.id,'original');await f.client.close();
});
test('shared client never answers or cancels another client approval',async()=>{
  const f=transportFixture();await f.client.connect();const count=f.wire.length;
  f.socket.emit('message',Buffer.from(JSON.stringify({id:77,method:'item/commandExecution/requestApproval',params:{threadId:'original'}})));
  assert.equal(f.wire.length,count);await f.client.close();
});
test('closing shared connection does not send interrupt, unload or clear-goal RPCs',async()=>{
  const f=transportFixture();await f.client.connect();
  await Promise.all([f.client.close(),f.client.close()]);
  assert.equal(f.wire.some(m=>/interrupt|unsubscribe|unload|goal\/clear/.test(m.method||'')),false);
  assert.equal(f.proxyKills,0);assert.equal(f.client.exited,true);
});
test('handshake failure cleans the proxy and rejects without leaving pending work',async()=>{
  const f=transportFixture({handshakeError:true});
  await assert.rejects(f.client.connect(),/upgrade failed/);
  assert.equal(f.client.exited,true);assert.equal(f.proxy.exitCode,0);
});
test('connection loss rejects pending requests and marks client disconnected',async()=>{
  const f=transportFixture();await f.client.connect();
  const pending=f.client.request('thread/read',{threadId:'original'},1000);
  const rejected=assert.rejects(pending,/Shared daemon connection closed/);
  f.socket.close();await rejected;await f.client.close();assert.equal(f.client.exited,true);
});
