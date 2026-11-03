import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createCcSwitchControl } from '../src/account/cc-switch-control';

const roots:string[]=[]; const id='ccs-aeda2df6ebc6';
afterEach(async () => {await Promise.all(roots.splice(0).map(path => rm(path,{recursive:true,force:true})));});
async function fixture(overrides:Record<string,unknown>={}, createKey=true) {
  const home=await mkdtemp(join(tmpdir(),'bridge-control-'));roots.push(home);
  const directory=join(home,'.cc-switch','bridge-control');await mkdir(directory,{recursive:true});
  if(createKey)await writeFile(join(directory,'key'),Buffer.alloc(32,7));
  let time=1000000; const urls:string[]=[];
  const control=createCcSwitchControl({home,now:()=>time,nonce:()=> 'b'.repeat(32),timeoutMs:600,
    wait:async ms=>{time+=ms;},launch:async url=>{
      urls.push(url);const parsed=new URL(url),payload=parsed.searchParams.get('payload')!;
      const key=await readFile(join(directory,'key'));
      expect(parsed.searchParams.get('signature')).toBe(createHmac('sha256',key).update(payload).digest('hex'));
      const request=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
      const response={version:1,nonce:request.nonce,issuedAt:time,ok:true,...(request.accountCode?{accountCode:request.accountCode,emailHash:'a'.repeat(64)}:{}),...overrides};
      const encoded=Buffer.from(JSON.stringify(response)).toString('base64url');
      await mkdir(join(directory,'responses'),{recursive:true});
      await writeFile(join(directory,'responses',request.nonce+'.json'),JSON.stringify({payload:encoded,signature:createHmac('sha256',key).update(encoded).digest('hex')}));
    }});
  return {home,directory,control,urls};
}
describe('CC Switch signed external control',()=>{
  it('creates the control key only during explicit setup and validates readiness',async()=>{
    const f=await fixture({},false);expect(await f.control.setup()).toEqual({ready:true});
    expect((await readFile(join(f.directory,'key'))).length).toBe(32);
    expect(f.urls[0]).toMatch(/^ccswitch:\/\/v1\/bridge\?/);
  });
  it('never replaces an existing key during setup',async()=>{
    const f=await fixture();await f.control.setup();expect(await readFile(join(f.directory,'key'))).toEqual(Buffer.alloc(32,7));
  });
  it('does not implicitly enable control for an activation request',async()=>{
    const f=await fixture({},false);await expect(f.control.activate(id)).rejects.toMatchObject({code:'setup_required'});expect(f.urls).toHaveLength(0);
  });
  it('sends only the stable account code and accepts the matching signed receipt',async()=>{
    const f=await fixture();expect(await f.control.activate(id)).toMatchObject({ready:true,accountCode:id,emailHash:'a'.repeat(64)});
    const request=JSON.parse(Buffer.from(new URL(f.urls[0]!).searchParams.get('payload')!,'base64url').toString('utf8'));
    expect(Object.keys(request).sort()).toEqual(['accountCode','issuedAt','nonce','operation','version']);expect(request.operation).toBe('activate');
  });
  it.each([{nonce:'c'.repeat(32)},{accountCode:'ccs-000000000000'},{issuedAt:1},{version:2},{emailHash:'invalid'}])('rejects an unassociated receipt %j',async data=>{
    const f=await fixture(data);await expect(f.control.activate(id)).rejects.toMatchObject({code:'untrusted_response'});
  });
  it('does not forward unknown adapter error text',async()=>{
    const f=await fixture({ok:false,error:'secret-token-value'});await expect(f.control.activate(id)).rejects.toMatchObject({code:'adapter_failed'});
  });
  it.each(['../key','ccs-1;shutdown','ccs-000000000000 extra',''])('rejects invalid account identifiers before invoking an external tool: %s',async value=>{
    const f=await fixture();await expect(f.control.activate(value)).rejects.toMatchObject({code:'invalid_account'});expect(f.urls).toHaveLength(0);
  });
  it('does not create a new control key after finding corrupt key material',async()=>{
    const f=await fixture();await writeFile(join(f.directory,'key'),'bad');await expect(f.control.setup()).rejects.toMatchObject({code:'key_unavailable'});
    expect(await readFile(join(f.directory,'key'),'utf8')).toBe('bad');expect(f.urls).toHaveLength(0);
  });
  it('times out without reporting a successful activation',async()=>{
    const f=await fixture();let now=0;const control=createCcSwitchControl({home:f.home,now:()=>now,wait:async ms=>{now+=ms;},timeoutMs:500,launch:async()=>{}});
    await expect(control.activate(id)).rejects.toMatchObject({code:'adapter_timeout'});
  });
  it('rejects a tampered response signature',async()=>{
    const f=await fixture();const control=createCcSwitchControl({home:f.home,nonce:()=> 'd'.repeat(32),launch:async url=>{
      const request=JSON.parse(Buffer.from(new URL(url).searchParams.get('payload')!,'base64url').toString('utf8'));
      await mkdir(join(f.directory,'responses'),{recursive:true});
      await writeFile(join(f.directory,'responses',request.nonce+'.json'),JSON.stringify({payload:Buffer.from(JSON.stringify({version:1,nonce:request.nonce,issuedAt:Date.now(),ok:true})).toString('base64url'),signature:'0'.repeat(64)}));
    }});await expect(control.check()).rejects.toMatchObject({code:'untrusted_response'});
  });
});
