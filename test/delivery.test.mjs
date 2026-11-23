import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DeliveryLedger, publishSigned} from '../delivery.mjs';
import {listen, signEvent} from '../listen.mjs';
import {makeAnswerer} from '../agent-turn.mjs';
const key='11'.repeat(32), peer='22'.repeat(32);
const me=signEvent(key,{kind:9}).pubkey, other=signEvent(peer,{kind:9}).pubkey;
const flush=()=>new Promise(r=>setImmediate(r));
const event=(content='hello',mention=true)=>signEvent(peer,{kind:9,created_at:1000,tags:[['h','channel'],...(mention?[['p',me]]:[])],content});
function fixture(ledger, overrides={}) {
  let socket; const answers=[], sent=[], logs=[];
  class WS {
    constructor(){socket=this;this.handlers={};this.sent=[];}
    addEventListener(k,f){this.handlers[k]=f;}
    send(raw){this.sent.push(JSON.parse(raw));}
    frame(m){this.handlers.message({data:JSON.stringify(m)});}
    close(){}
  }
  const client=listen({name:'test',relayUrl:'https://example.invalid',secretHex:key,allowFrom:[other],ledger,
    WebSocketImpl:WS,now:()=>1000000,log:e=>logs.push(e),resolveSession:()=> 'bound-session',
    answer:async(text,ctx)=>{answers.push(ctx);return 'answer';},send:async()=>undefined,
    sendSigned:async e=>{sent.push(e);return e.id;},...overrides});
  socket.frame(['OK','auth',true,'']);
  return {client,socket,answers,sent,logs,deliver:e=>socket.frame(['EVENT','messages',e]),
    close:async()=>{client.close();await client.drain();}};
}
test('restart preserves outbox ID, retries failed publication without rerunning model',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'buzz-delivery-')),file=join(dir,'ledger');
  let ledger=new DeliveryLedger(file),attempt;
  const e=event();
  const f=fixture(ledger,{sendSigned:async e=>{attempt=e.id;throw Error('offline');}});
  f.deliver(e);await flush();await f.client.drain();
  assert.equal(ledger.get(e.id).state,'answered');assert.equal(f.answers[0].sessionId,'bound-session');
  await f.close();ledger.close();
  ledger=new DeliveryLedger(file);const g=fixture(ledger);
  await flush();await g.client.drain();g.deliver(e);await flush();
  assert.equal(g.answers.length,0);assert.equal(g.sent.length,1);assert.equal(g.sent[0].id,attempt);
  assert.equal(ledger.get(e.id).state,'published');
  await g.close();ledger.close();rmSync(dir,{recursive:true});
});
test('early DM is reconsidered when membership arrives',async()=>{
  const l=new DeliveryLedger(':memory:'),f=fixture(l),e=event('early',false);
  f.deliver(e);assert.equal(l.get(e.id).state,'waiting_metadata');
  f.socket.frame(['EVENT','groups',signEvent(peer,{kind:39002,tags:[['d','channel'],['p',me],['p',other]]})]);
  await flush();await f.client.drain();assert.equal(f.answers.length,1);assert.equal(l.get(e.id).state,'published');
  await f.close();l.close();
});
test('started work becomes uncertain after restart; queued work remains recoverable',()=>{
  const dir=mkdtempSync(join(tmpdir(),'buzz-recovery-')),file=join(dir,'ledger');
  let l=new DeliveryLedger(file);l.put('a',{state:'started'});l.put('b',{state:'queued'});l.close();
  l=new DeliveryLedger(file);assert.equal(l.get('a').state,'uncertain');assert.equal(l.get('b').state,'queued');
  l.close();rmSync(dir,{recursive:true});
});
test('replay floor survives restart and newer traffic cannot advance past another channel backlog',async()=>{
  const l=new DeliveryLedger(':memory:');l.cursor(500);const f=fixture(l);
  assert.equal(f.socket.sent.find(m=>m[1]==='mentions')[2].since,440);
  f.deliver(event());await flush();await f.client.drain();assert.equal(l.cursor(1000),500);
  await f.close();l.close();
});
test('budget exhaustion and explicit-request filtering have inspectable reasons',async()=>{
  for(const explicitRequests of [false,true]){
    const l=new DeliveryLedger(':memory:'),f=fixture(l,{allowAgents:[other],explicitRequests,maxAgentReplies:0});
    const e=event();f.deliver(e);await flush();
    assert.equal(l.get(e.id).reason,explicitRequests?'explicit_request_required':'reply_budget_exhausted');
    assert.equal(f.answers.length,0);await f.close();l.close();
  }
});
test('turn deadline marks uncertainty without overlapping a still-running model',async()=>{
  const l=new DeliveryLedger(':memory:');let finish;const gate=new Promise(r=>finish=r);
  const f=fixture(l,{turnTimeoutMs:5,answer:()=>gate});const e=event();f.deliver(e);
  await new Promise(r=>setTimeout(r,15));assert.equal(l.get(e.id).reason,'turn_deadline_exceeded_still_running');
  f.deliver(e);finish('late answer');await f.client.drain();assert.equal(l.get(e.id).state,'published');
  await f.close();l.close();
});
test('ledger ownership prevents concurrent listeners',()=>{
  const dir=mkdtempSync(join(tmpdir(),'buzz-lock-')),file=join(dir,'ledger');const l=new DeliveryLedger(file);
  assert.throws(()=>new DeliveryLedger(file),/Another listener/);l.close();rmSync(dir,{recursive:true});
});
test('publisher handles duplicate ACK and timeout and closes its socket',async()=>{
  for(const ack of [true,false]){
    let closed=0;
    class WS {
      constructor(){this.h={};queueMicrotask(()=>this.h.open());}
      addEventListener(k,f){this.h[k]=f;}
      send(raw){const m=JSON.parse(raw);if(ack)queueMicrotask(()=>this.h.message({data:JSON.stringify(['OK',m[1].id,false,'duplicate: already have event'])}));}
      close(){closed++;}
    }
    const e=signEvent(key,{kind:9});const p=publishSigned({relayUrl:'https://example.invalid',secretHex:key,event:e,signEvent,WebSocketImpl:WS,timeoutMs:5});
    if(ack)assert.equal(await p,e.id);else await assert.rejects(p,/timeout/);
    assert.equal(closed,1);
  }
});
test('existing-session bindings fail closed if resume fails',async()=>{
  let created=0;
  const answer=makeAnswerer({get:()=>({get:()=>undefined,resume:async()=>{throw Error('missing');},create:async()=>{created++;}})},
    {name:'a',provider:'p',model:'m',sessionBindings:[{threadKey:'thread',sessionId:'existing'}]}, {brandString:s=>s});
  await assert.rejects(answer('hi',{threadKey:'thread'}),/Bound session/);assert.equal(created,0);
});

test('two threads bound to one session serialize their turns',async()=>{
  let busy=false,finish,started=0;const events=[];
  const gate=new Promise(r=>finish=r);
  const agent={status:'idle',session:{get seq(){return events.length;},eventAt:i=>events[i]},
    whenIdle:async()=>{if(busy)await gate;},followup:()=>{started++;busy=true;events.push({type:'assistant/message',data:{message:{content:[{type:'text',text:'ok'}]}}});}};
  const ids=[];
  const answer=makeAnswerer({get:n=>n==='agents'?{get:id=>{ids.push(id);return agent;}}:undefined},
    {name:'a',provider:'p',model:'m',sessionBindings:[{threadKey:'one',sessionId:'existing'},{threadKey:'two',sessionId:'existing'}]},
    {brandString:s=>s,createUserMessage:s=>s,SessionSeq:s=>s});
  const a=answer('a',{threadKey:'one'}),b=answer('b',{threadKey:'two'});await flush();assert.equal(started,1);
  busy=false;finish();await Promise.all([a,b]);assert.equal(started,2);assert.deepEqual(ids,['existing','existing']);
});
