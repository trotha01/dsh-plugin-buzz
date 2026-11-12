import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestTransport } from '../request-transport.mjs';
import { pubkeyOf, setRunner, withIdentity, TOOLS } from '../buzz-mcp.mjs';
const owner='ab'.repeat(32), channel='a6f725b6-ce62-477e-bb7c-3b041b00a32f';
test('transport uses each runtime identity and refuses missing DM members',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'buzz-transport-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const identities=new Map();
  for(const [name,key]of [['Grok','11'.repeat(32)],['Claude','22'.repeat(32)]]){
    const file=join(dir,name);writeFileSync(file,key,{mode:0o600});identities.set(pubkeyOf(key),{name,BUZZ_KEY_FILE:file,BUZZ_OWNER_PUBKEY:owner});
  }
  const [grok,claude]=identities.keys();let members=[grok,claude,owner];const posts=[];
  setRunner(async(args,text)=>{
    if(args[0]==='dms')return JSON.stringify({channel_id:channel});
    if(args[1]==='members')return JSON.stringify(members.map(pubkey=>({pubkey})));
    if(args[0]==='users')return '[]';
    if(args[1]==='send'){
      const who=await TOOLS.find(t=>t.name==='buzz_whoami').run();posts.push({who,args,text});
      return JSON.stringify({event_id:'cd'.repeat(32)});
    }
    return '[]';
  });
  const transport=requestTransport(identities);
  assert.equal(transport.resolve('@Claude'),claude);
  assert.throws(()=>transport.resolve('unknown'),/configured/);
  assert.equal(await transport.open(grok,claude,owner),channel);
  await transport.verify(grok,channel,members);
  await Promise.all([transport.post(grok,channel,'question'),transport.post(claude,channel,'answer')]);
  assert.ok(posts[0].who.includes(grok));assert.ok(posts[1].who.includes(claude));
  members=[grok,owner];await assert.rejects(transport.verify(grok,channel,[grok,claude,owner]),/participants/);
});

test('natural DM request and answer intents use the shared controller; info stays ordinary chat',async()=>{
  const calls=[];
  const identity={requestContext:{actor:'grok'},requestController:{
    ask:async(...args)=>{calls.push(['ask',...args]);return {request_id:'r'};},
    respond:async(...args)=>{calls.push(['respond',...args]);return {status:'completed'};},
  }};
  const dm=TOOLS.find(t=>t.name==='buzz_dm');
  await withIdentity(identity,()=>dm.run({recipients:['Claude'],content:'@Claude what changed?',intent:'request'}));
  await withIdentity(identity,()=>dm.run({recipients:['Claude'],content:'Buzz',intent:'answer',request_id:'r'}));
  assert.equal(calls[0][0],'ask');assert.equal(calls[0][2],'Claude');assert.equal(calls[1][0],'respond');
  await assert.rejects(withIdentity({},()=>dm.run({recipients:['Claude'],content:'test',intent:'request'})),/bound DSH/);
});
