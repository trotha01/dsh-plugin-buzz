// The dsh wrapper's pure part. index.js imports dsh packages that exist only inside a dsh install, so the test
// registers tiny stand-ins for them before importing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { existsSync, readFileSync } from "node:fs";

register("data:text/javascript," + encodeURIComponent(`
  const stubs = {
    "@deepseek-ai/schemastery": "const s=()=>new Proxy(function(){},{get:(t,k)=>k==='then'?undefined:s,apply:()=>s()}); export default s();",
    "@deepseek-ai/dsh-llm": "export const createUserMessage = x => x;",
    "@deepseek-ai/dsh-agent": "export const installModelSelection = () => {};",
    "@deepseek-ai/dsh-brand": "export const brandString = x => x;",
    "@deepseek-ai/dsh-session": "export const SessionSeq = x => x;",
    "@deepseek-ai/dsh-mcp-client": "export const name='mcp-client'; export async function apply(){}",
  };
  export function resolve(spec, ctx, next) { return spec in stubs ? { url: "data:text/javascript," + encodeURIComponent(stubs[spec]), shortCircuit: true } : next(spec, ctx); }
`));
const { resolve, SERVER, apply, name } = await import("../index.js");

test("mounts the server shipped in the package with the same Node as dsh", () => {
  const row = resolve({}, { BUZZ_KEY_FILE: "/k/a.key", BUZZ_RELAY_URL: "https://buzz.example.com" });
  assert.deepEqual(row, { serverName: "buzz", transport: "stdio", command: process.execPath, args: [SERVER],
    env: { BUZZ_KEY_FILE: "/k/a.key", BUZZ_RELAY_URL: "https://buzz.example.com" } });
  assert.ok(existsSync(SERVER));
});

test("row config wins over the environment; a second identity gets its own namespace", () => {
  const row = resolve({ keyFile: "/k/b.key", relayUrl: "https://r2.example", cliPath: "/opt/buzz", serverName: "buzz-research" },
    { BUZZ_KEY_FILE: "/k/a.key", BUZZ_RELAY_URL: "https://buzz.example.com", BUZZ_CLI: "/env/buzz" });
  assert.equal(row.serverName, "buzz-research");
  assert.deepEqual(row.env, { BUZZ_KEY_FILE: "/k/b.key", BUZZ_RELAY_URL: "https://r2.example", BUZZ_CLI: "/opt/buzz" });
});

test("missing or bad settings leave the plugin idle instead of failing dsh", async () => {
  assert.match(resolve({}, {}), /BUZZ_KEY_FILE/);
  assert.match(resolve({ keyFile: "/k" }, {}), /BUZZ_RELAY_URL/);
  assert.match(resolve({ keyFile: "/k", relayUrl: "buzz.example.com" }, {}), /http/);
  const warned = [], mounted = [];
  await apply({ logger: () => ({ warn: (m) => warned.push(m) }), plugin: (...a) => mounted.push(a) }, {});
  assert.equal(mounted.length, 0);
  assert.equal(warned.length, 1);
});

test("the secret key is never part of the mounted row", () => {
  assert.ok(!JSON.stringify(resolve({}, { BUZZ_KEY_FILE: "/k/a.key", BUZZ_RELAY_URL: "https://x.example", BUZZ_PRIVATE_KEY: "s3cret" })).includes("s3cret"));
});

test("package manifest is a loadable dsh bundle", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(pkg.type, "module");
  for (const f of ["index.js", "buzz-mcp.mjs", "cordis.patch.yml", "icon.svg"]) assert.ok(pkg.files.includes(f) && existsSync(new URL("../" + f, import.meta.url)));
  assert.match(readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8"), new RegExp(`name: ${pkg.name}\\b`));
  assert.equal(name, "buzz");
});

test("malformed relay URLs are rejected before a listener can start", () => {
  for (const relayUrl of ["https://", "https://user:secret@relay.example", "wss://relay.example", "https://relay.example/#fragment"]) {
    assert.equal(typeof resolve({ keyFile: "/k", relayUrl }, {}), "string");
  }
});

test("live sender rejects missing CLI and relay refusal instead of reporting success", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { makeSender } = await import("../index.js");
  const dir = mkdtempSync(join(tmpdir(), "buzz-sender-"));
  const keyFile = join(dir, "agent.key");
  writeFileSync(keyFile, "11".repeat(32), { mode: 0o600 });
  const reply = { channel: "test", replyTo: "ab".repeat(32), text: "hello" };
  await assert.rejects(makeSender({ relayUrl: "https://relay.example", keyFile, cli: join(dir, "missing") })(reply), /CLI was not found/);
  const cli = join(dir, "fake-buzz");
  writeFileSync(cli, `#!${process.execPath}\nconsole.log(JSON.stringify({accepted:false,event_id:'${"ab".repeat(32)}'}));`, { mode: 0o700 });
  await assert.rejects(makeSender({ relayUrl: "https://relay.example", keyFile, cli })(reply), /refused/);
  writeFileSync(cli, `#!${process.execPath}\nconsole.log(JSON.stringify({accepted:true,event_id:'${"ab".repeat(32)}'}));`);
  assert.equal(await makeSender({ relayUrl: "https://relay.example", keyFile, cli })(reply), "ab".repeat(32));
});

test("duplicate names or keys cannot silently select another agent's identity", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pubkeyOf } = await import("../buzz-mcp.mjs");
  const dir = mkdtempSync(join(tmpdir(), "buzz-duplicates-"));
  const first = join(dir, "first.key"), second = join(dir, "second.key");
  writeFileSync(first, "11".repeat(32), { mode: 0o600 });
  writeFileSync(second, "22".repeat(32), { mode: 0o600 });
  const original = globalThis.WebSocket, sockets = [], warnings = [], logs = [];
  let dispose;
  globalThis.WebSocket = class {
    constructor() { sockets.push(this); }
    addEventListener() {}
    close() {}
  };
  try {
    await apply({ logger: () => ({ info: m => logs.push(m), warn: m => warnings.push(m) }),
      plugin() {}, on: (_, fn) => { dispose = fn; } }, {
      relayUrl: "https://relay.example", allowFrom: ["33".repeat(32)], agents: [
        { name: "first", keyFile: first, provider: "p", model: "m" },
        { name: "first", keyFile: second, provider: "p", model: "m" },
        { name: "duplicate-key", keyFile: first, provider: "p", model: "m" },
      ],
    });
    assert.equal(sockets.length, 1);
    assert.equal(warnings.filter(m => m.includes("duplicate agent")).length, 2);
    assert.ok(logs.some(m => m.includes(pubkeyOf("11".repeat(32)))));
    assert.ok(!logs.some(m => m.includes(pubkeyOf("22".repeat(32)))));
  } finally { dispose?.(); globalThis.WebSocket = original; }
});

test('owner configuration reaches MCP and invalid owners disable the row', () => {
  const config = {keyFile: '/key', relayUrl: 'https://relay.example', ownerPubkey: 'ab'.repeat(32)};
  assert.equal(resolve(config, {}).env.BUZZ_OWNER_PUBKEY, config.ownerPubkey);
  assert.match(resolve({...config, ownerPubkey: 'invalid'}, {}), /ownerPubkey/);
});

test('live sender never posts when owner cannot be included', async () => {
  const {mkdtempSync, writeFileSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {makeSender} = await import('../index.js');
  const dir = mkdtempSync(join(tmpdir(), 'buzz-owner-'));
  const keyFile = join(dir, 'key'), cli = join(dir, 'cli'), posted = join(dir, 'posted');
  writeFileSync(keyFile, '11'.repeat(32), {mode: 0o600});
  writeFileSync(cli, `#!${process.execPath}\nimport{writeFileSync}from'node:fs'; if(process.argv.includes('messages'))writeFileSync(${JSON.stringify(posted)},'posted');console.log('[]');`, {mode: 0o700});
  await assert.rejects(makeSender({keyFile, cli, relayUrl: 'https://relay.example', ownerPubkey: 'ab'.repeat(32)})({channel: 'test', text: 'secret'}), /not added/);
  assert.equal(existsSync(posted), false);
});

test('native Buzz tools select the calling agent, not a supplied identity', async () => {
  const {registerIdentityTools} = await import('../index.js');
  const {setRunner, pubkeyOf} = await import('../buzz-mcp.mjs');
  const {mkdtempSync,writeFileSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(),'buzz-bind-'));
  const keyFile = join(dir,'key');
  writeFileSync(keyFile,'11'.repeat(32),{mode:0o600});
  setRunner(async()=> '[]');
  const caller = {}, identities = new WeakMap([[caller,{BUZZ_KEY_FILE:keyFile}]]), tools=[];
  registerIdentityTools({tools:{register:t=>tools.push(t)}},{serverName:'buzz',env:{BUZZ_KEY_FILE:'/missing'}},identities,[]);
  const who = tools.find(t=>t.name==='mcp__buzz__buzz_whoami');
  assert.ok((await who.execute({keyFile:'/wrong'}, {agent:caller})).includes(pubkeyOf('11'.repeat(32))));
  assert.throws(()=>who.execute({}, {agent:{session:{id:'session-buzz-unbound'}}}), /not bound/);
});

test('plugin bridge path opens an owner-visible request and routes structured answers without tools',async()=>{
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {setRunner,pubkeyOf}=await import('../buzz-mcp.mjs');const {signEvent}=await import('../listen.mjs');
  const dir=mkdtempSync(join(tmpdir(),'buzz-plugin-request-'));
  const ownerKey='33'.repeat(32),owner=pubkeyOf(ownerKey),grok=pubkeyOf('11'.repeat(32)),claude=pubkeyOf('22'.repeat(32));
  const channel='a6f725b6-ce62-477e-bb7c-3b041b00a32f';
  const agents=[['Grok','11'.repeat(32)],['Claude','22'.repeat(32)]].map(([name,key])=>{
    const keyFile=join(dir,name);writeFileSync(keyFile,key,{mode:0o600});return {name,keyFile,provider:'bridge',model:name};
  });
  const cli=join(dir,'cli');writeFileSync(cli,`#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.includes('members')?[{pubkey:'${owner}'}]:{event_id:'${'ab'.repeat(32)}'}));`,{mode:0o700});
  const posts=[],prompts=[],registered=[],sockets=[];let dispose;
  setRunner(async(args,text)=>{
    if(args[0]==='dms')return JSON.stringify({channel_id:channel});
    if(args[1]==='members')return JSON.stringify([grok,claude,owner].map(pubkey=>({pubkey})));
    if(args[1]==='send'){posts.push(text);return JSON.stringify({event_id:String(posts.length).padStart(64,'0')});}
    return '[]';
  });
  const sessions=new Map();
  const service={get:id=>sessions.get(id),resume:async()=>{throw Error('new');},create:async({sessionId})=>{
    const events=[];const agent={status:'idle',session:{get seq(){return events.length;},eventAt:i=>events[i]},whenIdle:async()=>{},
      followup:message=>{
        const prompt=message.content[0].text;prompts.push(prompt);
        const text=prompt.includes('"kind":"human"')?JSON.stringify({buzz:{type:'request',to:'Claude',message:'What changed?'}}):
          prompt.includes('"kind":"request"')?JSON.stringify({buzz:{type:'answer',message:'Buzz changed.'}}):'Claude changed Buzz.';
        events.push({type:'assistant/message',data:{message:{content:[{type:'text',text}]}}});
      }};sessions.set(sessionId,agent);return {agent};
  }};
  const original=globalThis.WebSocket;
  globalThis.WebSocket=class{constructor(){this.h={};sockets.push(this);}addEventListener(t,f){this.h[t]=f;}send(){}close(){}};
  try{
    await apply({tools:{register:t=>registered.push(t)},get:n=>n==='agents'?service:undefined,
      logger:()=>({info(){},warn(){}}),on:(name,fn)=>{if(name==='dispose')dispose=fn;return ()=>{};}},
      {keyFile:agents[0].keyFile,relayUrl:'https://relay.example',ownerPubkey:owner,allowFrom:[owner],agents,cliPath:cli});
    const e=signEvent(ownerKey,{kind:9,tags:[['h',channel],['p',grok]],content:'Ask Claude what changed'});
    sockets[0].h.message({data:JSON.stringify(['EVENT','messages',e])});
    for(let i=0;i<100&&posts.length<3;i++)await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(posts,['What changed?','Buzz changed.','Claude changed Buzz.']);
    assert.equal(prompts.length,3);assert.ok(prompts[1].includes(claude));assert.ok(prompts[1].includes(owner));
    assert.ok(registered.some(t=>t.name==='mcp__buzz__buzz_ask'));
    const who=registered.find(t=>t.name==='mcp__buzz__buzz_whoami');
    assert.throws(()=>who.execute({}, {agent:{session:{id:'unbound-bridge'}}}),/not bound/);
  }finally{dispose?.();await new Promise(r=>setTimeout(r,20));globalThis.WebSocket=original;rmSync(dir,{recursive:true,force:true});}
});
