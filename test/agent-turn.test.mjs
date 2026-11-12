import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeAnswerer, finalText} from '../agent-turn.mjs';

test('completed assistant text reaches Buzz before a tool-using turn becomes idle', async () => {
  const handlers = new Map(), events = [], delivered = [];
  let finish, deliveredFirst;
  const busy = new Promise(r => { finish = r; });
  const firstDelivery = new Promise(r => { deliveredFirst = r; });
  let running = false;
  const emit = (text, session = agent.session) => {
    const event = {type:'assistant/message', seq:events.length, data:{message:{content:[
      {type:'reasoning',text:'private reasoning'}, {type:'text',text}
    ]}}};
    if (session === agent.session) events.push(event);
    handlers.get('session/event')(session, event);
  };
  const agent = {status:'idle', session:{get seq(){return events.length;},eventAt:i=>events[i]},
    whenIdle:()=>running ? busy : Promise.resolve(), followup:()=>{
      running = true;
      emit('unrelated', {});
      emit('Starting the review');
    }};
  const ctx = {on:(name,fn)=>{handlers.set(name,fn);return ()=>handlers.delete(name);},
    get:name=>name==='agents'?{get:()=>agent}:undefined};
  const answer = makeAnswerer(ctx,{name:'Grok',provider:'xai',model:'grok'},
    {brandString:s=>s,createUserMessage:s=>s,SessionSeq:s=>s});
  const result = answer('review',{threadKey:'dm:test',onProgress:async text=>{
    delivered.push(text); deliveredFirst();
  }});
  await firstDelivery;
  assert.deepEqual(delivered,['Starting the review']);
  emit('Review complete');
  finish();
  assert.equal(await result,'Review complete');
  assert.equal(delivered.at(-1),'Review complete');
  assert.equal(handlers.size,0);
});

test('runtime errors without turn/end report failure, flush the session and remove listeners', async () => {
  const handlers = new Map();
  let flushed = false;
  const agent = {status:'idle', session:{seq:0,eventAt:()=>undefined}, whenIdle:async()=>{},
    followup:()=>handlers.get('agent/error')({agent,error:new Error('private provider details')})};
  const ctx = {
    on:(name, fn)=>{ handlers.set(name,fn); return ()=>handlers.delete(name); },
    get:name=>({agents:{get:()=>agent},sessions:{flush:async session=>{
      assert.equal(session,agent.session); flushed=true;
    }}}[name])
  };
  const answer=makeAnswerer(ctx,{name:'Grok',provider:'xai',model:'grok'},
    {brandString:s=>s,createUserMessage:s=>s,SessionSeq:s=>s});
  await assert.rejects(answer('hi',{threadKey:'dm:test'}), /The model turn failed/);
  assert.equal(flushed,true);
  assert.equal(handlers.size,0);
});

test('runtime errors from another conversation do not fail this answer', async () => {
  const handlers = new Map();
  const events = [];
  const agent = {status:'idle',session:{get seq(){return events.length;},eventAt:i=>events[i]},whenIdle:async()=>{},
    followup:()=>{
      handlers.get('agent/error')({agent:{},error:new Error('unrelated')});
      events.push({type:'assistant/message',data:{message:{content:[{type:'text',text:'Hello'}]}}});
    }};
  const ctx={on:(name,fn)=>{handlers.set(name,fn);return ()=>handlers.delete(name);},get:name=>name==='agents'?{get:()=>agent}:undefined};
  const answer=makeAnswerer(ctx,{name:'Grok',provider:'xai',model:'grok'},
    {brandString:s=>s,createUserMessage:s=>s,SessionSeq:s=>s});
  assert.equal(await answer('hi',{threadKey:'dm:test'}),'Hello');
  assert.equal(handlers.size,0);
});

test('provider failure after progress is reported rather than returning stale progress or leaking details', async () => {
  const events = [];
  const agent = {status:'idle', session:{get seq(){return events.length;},eventAt:i=>events[i]}, whenIdle:async()=>{},
    followup:()=>events.push(
      {type:'assistant/message',data:{message:{content:[{type:'text',text:'Working on it'}]}}},
      {type:'turn/end',data:{reason:{kind:'error',error:{code:'provider-error',message:'private request details'}}}}
    )};
  const answer = makeAnswerer({get: n=>n==='agents'?{get:()=>agent}:undefined},
    {name:'Grok',provider:'xai',model:'grok'}, {brandString:s=>s,createUserMessage:s=>s,SessionSeq:s=>s});
  await assert.rejects(answer('hi',{threadKey:'dm:test'}), e=>
    e.message.includes('model turn failed') && !e.message.includes('private request'));
});

test('a successful later turn does not inherit a previous provider error', () => {
  const events = [
    {type:'turn/end',data:{reason:{kind:'error'}}},
    {type:'turn/start'},
    {type:'assistant/message',data:{message:{content:[{type:'text',text:'Recovered'}]}}},
    {type:'turn/end',data:{reason:{kind:'completed'}}}
  ];
  assert.equal(finalText({seq:events.length,eventAt:i=>events[i]},0),'Recovered');
});

test('idle text is published before waiting for children, then child completion is published', async () => {
  const events = [], progress = [];
  const push = text => events.push({type:'assistant/message',data:{message:{content:[{type:'text',text}]}}});
  const agent = {status:'idle',session:{get seq(){return events.length;},eventAt:i=>events[i]},whenIdle:async()=>{},followup:()=>push('Waiting for the review')};
  let waits = 0;
  const ctx = {get:name=>({agents:{get:()=>agent},subagents:{waitForChildren:async()=>{
    if (waits++ === 0) { assert.deepEqual(progress,['Waiting for the review']); push('Review complete'); return true; }
    return false;
  }}}[name])};
  const answer=makeAnswerer(ctx,{name:'Grok',provider:'xai',model:'grok'}, {brandString:s=>s,createUserMessage:s=>s,SessionSeq:s=>s});
  assert.equal(await answer('review',{threadKey:'dm:test',onProgress:async text=>progress.push(text)}),'Review complete');
  assert.deepEqual(progress,['Waiting for the review','Review complete']);
});

test('Buzz identity and verified delivery metadata are set before the model starts', async () => {
  let bound=false,body;
  const event={pubkey:'a'.repeat(64),id:'b'.repeat(64),tags:[['h','group-dm']]};
  const agent={status:'idle',session:{seq:0,eventAt:()=>undefined},whenIdle:async()=>{},followup:message=>{
    assert.equal(bound,true);body=message.content[0].text;
  }};
  const answer=makeAnswerer({get:n=>n==='agents'?{get:()=>agent}:undefined},
    {name:'Grok',provider:'p',model:'m'}, {brandString:s=>s,createUserMessage:s=>s,SessionSeq:s=>s,
      bindIdentity:(actual,received)=>{assert.equal(actual,agent);assert.equal(received,event);bound=true;}});
  await answer('hello',{threadKey:'dm:group-dm',event});
  assert.match(body,/You are Grok on Buzz/);
  assert.match(body,/channel=group-dm/);
  assert.match(body,/not an AI Bridge inbox/);
});

test('Buzz titles are set before input, persist on replies, and respect manual renames', async () => {
  let current, receivedTitle;
  const renamed = [];
  const session = {seq:0,eventAt:()=>undefined};
  const agent = {status:'idle',session,whenIdle:async()=>{},followup:()=>{receivedTitle=current.title;}};
  const titles = {get:()=>current,rename:(actual,title)=>{
    assert.equal(actual,session);
    current={title,source:{kind:'user'}}; renamed.push(title);
  }};
  const answer=makeAnswerer({get:n=>({agents:{get:()=>agent},sessionTitle:titles}[n])},
    {name:'Codex',provider:'p',model:'m'}, {brandString:s=>s,createUserMessage:s=>s,SessionSeq:s=>s});
  await answer('Fix\nTagalog channel',{threadKey:'first'});
  assert.equal(receivedTitle,'Buzz · Codex · Fix Tagalog channel');
  await answer('Continue',{threadKey:'first'});
  assert.equal(renamed.length,1);
  current={title:'My custom title',source:{kind:'user'}};
  await answer('Continue',{threadKey:'first'});
  assert.equal(receivedTitle,'My custom title');
  current={title:'Review and Simplify AI-247',source:{kind:'llm'}};
  await answer('Fix Tagalog channel',{threadKey:'legacy'});
  assert.equal(receivedTitle,'Buzz · Codex · Fix Tagalog channel');
  current=undefined;
  await answer('',{threadKey:'request',sessionTopic:'Review the channel fix'});
  assert.equal(receivedTitle,'Buzz · Codex · Review the channel fix');
});
