import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {listen,signEvent,verifyEvent} from '../listen.mjs';
import {requestTransport} from '../request-transport.mjs';
import {RequestController} from '../requests.mjs';

test('durable channel request and response relay echoes never start automatic turns',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'buzz-echo-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const keys=['11'.repeat(32),'22'.repeat(32)], actors=keys.map(k=>signEvent(k,{kind:9}).pubkey);
  const owner=signEvent('33'.repeat(32),{kind:9}).pubkey;
  const channel='8f909951-1c1e-4f0b-9a2d-6b0f21d2a3c4';
  const identities=new Map(actors.map((a,i)=>{const file=join(dir,String(i));writeFileSync(file,keys[i],{mode:0o600});return [a,{BUZZ_KEY_FILE:file}];}));
  const sockets=[], listeners=[]; let automatic=0, requested=0;
  class WS {constructor(){this.h={};sockets.push(this);}addEventListener(k,f){this.h[k]=f;}send(){}close(){}}
  for(let i=0;i<2;i++)listeners.push(listen({name:'test',relayUrl:'https://invalid',secretHex:keys[i],allowFrom:[owner],allowAgents:actors,
    explicitRequests:true,channelAgentMentions:true,WebSocketImpl:WS,log:()=>{},send:async()=>{},answer:async()=>{automatic++;return 'duplicate';}}));
  t.after(async()=>{for(const l of listeners){l.close();await l.drain();}});
  const publications=[];
  const transport={...requestTransport(identities),resolve:x=>x,verify:async()=>{},read:async()=>[],
    publish:async(_actor,e)=>{assert.ok(verifyEvent(e));publications.push(e);for(const s of sockets)s.h.message({data:JSON.stringify(['EVENT','mentions',e])});return e.id;}};
  const c=new RequestController({file:':memory:',transport,run:async(_ctx,{kind})=>{if(kind==='request')requested++;return JSON.stringify({buzz:{type:'answer',message:'done'}});}});
  t.after(()=>c.close());
  const ctx=c.start({actor:actors[0],owner,origin:'human',channel,replyTo:'human'});
  await c.ask(ctx,actors[1],'do work',{channel:'here'});
  for(let i=0;c.active && i<200;i++)await new Promise(r=>setTimeout(r,5));
  for(const l of listeners)await l.drain();
  assert.equal(requested,1);assert.equal(automatic,0);
  // Replays remain suppressed after the request has completed.
  for(const e of publications)for(const s of sockets)s.h.message({data:JSON.stringify(['EVENT','mentions',e])});
  for(const l of listeners)await l.drain();assert.equal(automatic,0);
  const plain=signEvent(keys[0],{kind:9,tags:[['h',channel],['p',actors[1]]],content:'ordinary mention'});
  sockets[1].h.message({data:JSON.stringify(['EVENT','mentions',plain])});await listeners[1].drain();assert.equal(automatic,1);
});
