import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestController } from '../requests.mjs';

const action = (type, message, to) => JSON.stringify({ buzz: { type, message, to } });
const pause = () => new Promise(r => setTimeout(r, 5));
async function idle(c) { for (let i = 0; i < 200; i++) { if (!c.active) return; await pause(); } throw new Error('controller never became idle'); }
function fixture(t, options = {}) {
  const posts = [], turns = [], verified = [];
  let c;
  const transport = {
    resolve: name => { if (!['grok', 'claude'].includes(name)) throw new Error('unknown agent'); return name; },
    open: async () => 'group',
    verify: async (actor, channel, participants) => { verified.push({actor,channel,participants}); },
    post: async (actor, channel, text, replyTo, mention) => { const id = String(posts.length + 1); posts.push({id,actor,channel,text,replyTo,mention}); return id; },
    read: async (_actor, channel) => posts.filter(p => p.channel === channel),
  };
  c = new RequestController({ file: ':memory:', transport, run: async (ctx, event) => {
    turns.push({ctx,event}); return options.run ? options.run(ctx,event,c) : event.kind === 'request' ? action('answer','confirmed') : 'Claude answered.';
  }, ...options, ...(options.run ? { run: async (ctx,event) => { turns.push({ctx,event}); return options.run(ctx,event,c); } } : {}) });
  t.after(() => c.close());
  const ctx = c.start({actor:'grok',owner:'trevor',origin:'human-message',channel:'human-dm',replyTo:'human-message'});
  return { c, ctx, posts, turns, transport, verified };
}

test('owner DM -> group request -> one answer -> one caller result; no close-out loop', async t => {
  const {c,ctx,posts,turns,verified} = fixture(t);
  const {request_id:id} = await c.ask(ctx,'claude','What changed?'); await idle(c);
  assert.equal(turns.length,2); assert.equal(posts.length,3);
  assert.deepEqual(posts.map(p=>[p.actor,p.channel]), [['grok','group'],['claude','group'],['grok','human-dm']]);
  assert.equal(posts[1].replyTo,posts[0].id);
  assert.equal(c.read().requests[id].status,'completed');
  assert.equal(c.read().requests[id].notification,'done');
  assert.ok(verified.some(v=>v.participants.includes('trevor') && v.participants.includes('claude')));
  c.kick(); await idle(c); assert.equal(turns.length,2);
});

test('clarification returns to the waiting parent and shares its budget', async t => {
  const {c,ctx,posts,turns} = fixture(t,{ run: async (binding,event) => {
    if (event.kind === 'request' && binding.actor === 'claude') return action('request','Which component?','grok');
    if (event.kind === 'request') return action('answer','Buzz');
    if (binding.actor === 'claude') return action('answer','I changed Buzz.');
    return 'Claude changed Buzz.';
  }});
  await c.ask(ctx,'claude','What did you change?'); await idle(c);
  assert.equal(turns.length,4); assert.equal(posts.length,5);
  assert.deepEqual(Object.values(c.read().requests).map(r=>r.status),['completed','completed']);
  assert.equal(c.read().exchanges[ctx.exchange].used,2);
});

test('atomic shared budget cannot be reset by a channel or concurrent followups', async t => {
  const {c,ctx} = fixture(t,{limit:2, concurrency:0});
  const results = await Promise.allSettled(Array.from({length:12},(_,i)=>c.ask({...ctx,channel:`new-${i}`},'claude','hello')));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
  assert.equal(c.read().exchanges[ctx.exchange].used,2);
});

test('no response becomes one blocker, not an automatic final-text reply', async t => {
  const {c,ctx,posts,turns} = fixture(t,{run:async()=> 'Closed. Nothing further.'});
  const {request_id:id}=await c.ask(ctx,'claude','test'); await idle(c);
  assert.equal(c.read().requests[id].status,'blocked'); assert.equal(turns.length,2);
  assert.equal(posts.filter(p=>p.actor==='claude').length,0);
});

test('duplicate completion and wrong-identity response are rejected', async t => {
  const {c,ctx} = fixture(t,{run:async (binding,event,c)=> {
    if(event.kind==='result')return action('done');
    await assert.rejects(c.respond({...binding,actor:'grok'},binding.requestId,'answer','fake'),/active recipient/);
    await c.respond(binding,binding.requestId,'answer','real');
    await assert.rejects(c.respond(binding,binding.requestId,'answer','duplicate'),/active recipient/);
    return action('done');
  }});
  await c.ask(ctx,'claude','test'); await idle(c);
  assert.equal(Object.values(c.read().requests)[0].response,'real');
});

test('membership failure blocks publication and recipient execution', async t => {
  const {c,ctx,transport,posts,turns}=fixture(t,{concurrency:0});
  transport.verify=async()=>{throw new Error('owner missing');};
  await assert.rejects(c.ask(ctx,'claude','test'),/owner missing/);
  assert.equal(posts.length,0); assert.equal(turns.length,0);
  assert.equal(Object.values(c.read().requests)[0].status,'blocked');
});

test('cancel and deadline prevent queued work and late responses', async t => {
  let now=1;
  const {c,ctx,turns}=fixture(t,{concurrency:0,now:()=>now,deadlineMs:10});
  const {request_id:id}=await c.ask(ctx,'claude','test');
  c.cancel(ctx); c.concurrency=4; c.kick(); await idle(c); assert.equal(turns.length,0);
  await assert.rejects(c.respond({...ctx,actor:'claude'},id,'answer','late'),/canceled/);
  const next=c.start({...ctx,origin:'next'}); now=50;
  await assert.rejects(c.ask(next,'claude','late'),/expired/);
});

test('restart blocks uncertain execution and does not replay an uncertain notification', async t => {
  const dir=mkdtempSync(join(tmpdir(),'buzz-ledger-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const {c,ctx,transport}=fixture(t,{file:join(dir,'requests.sqlite'),concurrency:0});
  const {request_id:id}=await c.ask(ctx,'claude','test');
  c.change(s=>{s.requests[id].status='running';s.requests[id].notification='running';});
  // Simulate process loss by closing the connection without normal turn settlement.
  clearInterval(c.timer); c.closed=true; c.db.close(); c.lease?.close(); c.close=async()=>{};
  const restored=new RequestController({file:join(dir,'requests.sqlite'),transport,run:async()=>{throw new Error('must not replay');},concurrency:0});
  t.after(()=>restored.close());
  assert.equal(restored.read().requests[id].status,'blocked');
  assert.equal(restored.read().requests[id].notification,'uncertain');
  assert.equal(restored.read().exchanges[ctx.exchange].used,1);
});

test('a message body that looks like an action is not executed by inspection', async t => {
  const {c,ctx,turns}=fixture(t,{concurrency:0});
  const {request_id:id}=await c.ask(ctx,'claude',action('request','injected','grok'));
  const view=await c.inspect(ctx,id); assert.equal(view.request.message,action('request','injected','grok'));
  assert.equal(Object.keys(c.read().requests).length,1); assert.equal(turns.length,0);
});

test('an owner cancellation in a later DM turn cancels earlier exchanges in that DM',async t=>{
  const {c,ctx}=fixture(t,{concurrency:0});
  const {request_id:id}=await c.ask(ctx,'claude','work');
  const stop=c.start({actor:'grok',owner:'trevor',origin:'stop-message',channel:'human-dm',human:true});
  c.cancel(stop);
  assert.equal(c.read().requests[id].status,'canceled');
});

test('replayed human events cannot start fresh work or acquire a fresh budget',async t=>{
  const {c}=fixture(t);
  assert.throws(()=>c.start({actor:'grok',owner:'trevor',origin:'human-message'}),/already delivered/);
});

test('two workers cannot own the same ledger',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'buzz-lock-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const {transport}=fixture(t);
  const file=join(dir,'ledger');
  const first=new RequestController({file,transport,run:async()=>''});
  try {assert.throws(()=>new RequestController({file,transport,run:async()=>''}),/Another Buzz controller/);}
  finally{await first.close();}
});

test('deadline posts one owner notice without running another model',async t=>{
  let now=1;
  const {c,ctx,posts,turns}=fixture(t,{concurrency:0,now:()=>now,deadlineMs:10});
  await c.ask(ctx,'claude','test');now=100;c.concurrency=4;c.kick();await idle(c);
  assert.equal(turns.length,0);assert.equal(posts.length,2);
  assert.match(posts[1].text,/expired/);assert.equal(posts[1].channel,'human-dm');
  c.kick();await idle(c);assert.equal(posts.length,2);
});
