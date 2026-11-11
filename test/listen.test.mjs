import { test } from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { signEvent, verifyEvent, route, listen, wsUrl, isDm } from "../listen.mjs";
import { sessionIdFor, finalText } from "../agent-turn.mjs";

const AGENT = "11".repeat(32), OWNER = "22".repeat(32), OTHER = "33".repeat(32);
const pub = (s) => bytesToHex(schnorr.getPublicKey(Buffer.from(s, "hex")));
const ME = pub(AGENT), OWNER_PK = pub(OWNER), OTHER_PK = pub(OTHER);
const CH = "a6f725b6-ce62-477e-bb7c-3b041b00a32f";
const msg = (sec, tags, content = "hi", t = 2_000_000_000) => signEvent(sec, { kind: 9, tags: [["h", CH], ...tags], content, created_at: t });

test('a relay-closed subscription reconnects and resumes its DM cursor', {timeout: 5000}, async () => {
  const sockets = [], answered = [];
  let reconnected;
  const ready = new Promise(resolve => { reconnected = resolve; });
  class FakeWS {
    constructor() { this.h = {}; this.sent = []; sockets.push(this); if (sockets.length === 2) reconnected(this); }
    addEventListener(type, fn) { this.h[type] = fn; }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    message(frame) { this.h.message({data: JSON.stringify(frame)}); }
    close() { this.h.close?.(); }
  }
  const c = listen({name:'Grok',relayUrl:'https://relay.example',secretHex:AGENT,allowFrom:[OWNER_PK],
    now:()=>1000000,WebSocketImpl:FakeWS,log:()=>{},answer:async text=>{answered.push(text);return 'ok';},send:async()=>undefined});
  try {
    const ws = sockets[0];
    ws.message(['OK','auth',true,'']);
    ws.message(['EVENT','groups',signEvent(OTHER,{kind:39002,tags:[['d',CH],['p',ME],['p',OWNER_PK]]})]);
    const first = msg(OWNER, [], 'before disconnect', 1050);
    ws.message(['EVENT',`channel:${CH}`,first]);
    ws.message(['CLOSED',`channel:${CH}`,'temporary failure']);
    const next = await ready;
    next.message(['OK','auth',true,'']);
    assert.equal(next.sent.find(m=>m[1]===`channel:${CH}`)[2].since,1050);
    next.message(['EVENT',`channel:${CH}`,first]);
    next.message(['EVENT',`channel:${CH}`,msg(OWNER, [], 'after reconnect', 1051)]);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(answered,['before disconnect','after reconnect']);
  } finally { c.close(); }
});

test("signed events verify; a changed event does not; http(s) relay URLs become ws(s)", () => {
  const e = signEvent(AGENT, { kind: 22242, tags: [["challenge", "x"]] });
  assert.equal(e.pubkey, ME);
  assert.ok(verifyEvent(e));
  assert.ok(!verifyEvent({ ...e, content: "changed" }));
  assert.equal(wsUrl("https://buzz.example.com/"), "wss://buzz.example.com");
  assert.equal(wsUrl("http://localhost:3000"), "ws://localhost:3000");
});

test("route: answers the owner's mention, DM and thread reply; ignores others, itself and unrelated chatter", () => {
  const base = { me: ME, allowFrom: new Set([OWNER_PK]), dmChannels: new Set(), threads: new Map() };
  const mention = msg(OWNER, [["p", ME]]);
  assert.deepEqual(route(mention, base), { threadKey: mention.id, replyTo: mention.id, channel: CH, fromAgent: false });
  assert.equal(route(msg(OTHER, [["p", ME]]), base), null);                 // not in allowFrom
  assert.equal(route(msg(AGENT, [["p", ME]]), base), null);                 // its own message
  assert.equal(route(msg(OWNER, []), base), null);                          // not addressed to it
  const threads = new Map([["ab".repeat(32), "root-1"]]);
  const inThread = msg(OWNER, [["e", "ab".repeat(32), "", "reply"]]);
  assert.equal(route(inThread, { ...base, threads }).threadKey, "root-1");  // follow-up without @mention
  const dm = route(msg(OWNER, []), { ...base, dmChannels: new Set([CH]) });
  assert.equal(dm.threadKey, `dm:${CH}`);
});

test("route: allowed agents can mention or DM; bare group replies are ignored", () => {
  const base = { me: ME, allowFrom: new Set([OWNER_PK]), allowAgents: new Set([OTHER_PK]), dmChannels: new Set([CH]), threads: new Map([["ab".repeat(32), "t"]]) };
  assert.equal(route(msg(OTHER, [["p", ME]]), base).fromAgent, true);
  assert.equal(route(msg(OTHER, []), base).fromAgent, true);                                       // DM without mention
  assert.equal(route(msg(OTHER, [["e", "ab".repeat(32), "", "reply"]]), { ...base, dmChannels: new Set() }), null);    // thread follow-up without mention
  assert.equal(route(msg(OWNER, [["p", ME]]), base).fromAgent, false);
});

test("listen: loop guard caps replies to agents per thread; the owner is never capped", async () => {
  const sockets = [];
  class FakeWS {
    constructor() { this.sent = []; this.h = {}; sockets.push(this); queueMicrotask(() => this.emit("message", { data: JSON.stringify(["AUTH", "c"]) })); }
    addEventListener(t, f) { (this.h[t] ||= []).push(f); }
    emit(t, ev) { for (const f of this.h[t] || []) f(ev); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() {}
  }
  let answers = 0;
  const conn = listen({ name: "A", relayUrl: "https://r.example", secretHex: AGENT, allowFrom: [OWNER_PK], allowAgents: [OTHER_PK], maxAgentReplies: 2,
    WebSocketImpl: FakeWS, answer: async () => { answers++; return "ok"; }, send: async () => undefined, log: () => {} });
  await new Promise((r) => setTimeout(r, 5));
  const ws = sockets[0];
  ws.emit("message", { data: JSON.stringify(["OK", ws.sent[0][1].id, true, ""]) });
  const root = "ef".repeat(32);
  for (let i = 0; i < 4; i++) ws.emit("message", { data: JSON.stringify(["EVENT", "m", msg(OTHER, [["p", ME], ["e", root, "", "root"]], `agent ${i}`, 2_000_000_000 + i)]) });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(answers, 2);
  for (let i = 0; i < 3; i++) ws.emit("message", { data: JSON.stringify(["EVENT", "m", msg(OWNER, [["p", ME], ["e", root, "", "root"]], `owner ${i}`, 2_000_000_100 + i)]) });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(answers, 5);
  conn.close();
});

test("threads survive a restart: a reply without @mention in a remembered channel thread is answered by a new listener", async () => {
  let saved = {};
  const store = { load: () => saved, save: (o) => { saved = o; } };
  const mk = (got) => {
    const sockets = [];
    class FakeWS {
      constructor() { this.sent = []; this.h = {}; sockets.push(this); queueMicrotask(() => this.emit("message", { data: JSON.stringify(["AUTH", "c"]) })); }
      addEventListener(t, f) { (this.h[t] ||= []).push(f); }
      emit(t, ev) { for (const f of this.h[t] || []) f(ev); }
      send(s) { this.sent.push(JSON.parse(s)); }
      close() {}
    }
    const conn = listen({ name: "A", relayUrl: "https://r.example", secretHex: AGENT, allowFrom: [OWNER_PK], store, WebSocketImpl: FakeWS,
      answer: async (t, { threadKey }) => { got.push([t, threadKey]); return "ok"; }, send: async () => "be".repeat(32), log: () => {} });
    return { conn, ws: () => sockets[0] };
  };
  const got1 = [], a = mk(got1);
  await new Promise((r) => setTimeout(r, 5));
  a.ws().emit("message", { data: JSON.stringify(["OK", a.ws().sent[0][1].id, true, ""]) });
  const first = msg(OWNER, [["p", ME]], "start");
  a.ws().emit("message", { data: JSON.stringify(["EVENT", "m", first]) });
  await new Promise((r) => setTimeout(r, 5));
  a.conn.close();
  const got2 = [], b = mk(got2);                                                    // "after a restart"
  await new Promise((r) => setTimeout(r, 5));
  b.ws().emit("message", { data: JSON.stringify(["OK", b.ws().sent[0][1].id, true, ""]) });
  b.ws().emit("message", { data: JSON.stringify(["EVENT", "c", msg(OWNER, [["e", "be".repeat(32), "", "reply"]], "follow-up", 2_000_000_050)]) });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(got2, [["follow-up", first.id]]);
  b.conn.close();
});

test("DM detection: a channel of this identity plus one other is a DM; a bigger one is not", () => {
  assert.equal(isDm([ME, OWNER_PK], ME), true);
  assert.equal(isDm([ME, OWNER_PK, OTHER_PK], ME), false);
  assert.equal(isDm([OWNER_PK, OTHER_PK], ME), false);
});

test("listen: a message without mention in a DM (learned from the member list) is answered", async () => {
  const sockets = [];
  class FakeWS {
    constructor() { this.sent = []; this.h = {}; sockets.push(this); queueMicrotask(() => this.emit("message", { data: JSON.stringify(["AUTH", "c"]) })); }
    addEventListener(t, f) { (this.h[t] ||= []).push(f); }
    emit(t, ev) { for (const f of this.h[t] || []) f(ev); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() {}
  }
  const got = [];
  const conn = listen({ name: "Codex", relayUrl: "https://r.example", secretHex: AGENT, allowFrom: [OWNER_PK], WebSocketImpl: FakeWS,
    answer: async (t) => { got.push(t); return "ok"; }, send: async () => undefined, log: () => {} });
  await new Promise((r) => setTimeout(r, 5));
  const ws = sockets[0];
  ws.emit("message", { data: JSON.stringify(["OK", ws.sent[0][1].id, true, ""]) });
  const relay = "44".repeat(32);
  ws.emit("message", { data: JSON.stringify(["EVENT", "groups", signEvent(relay, { kind: 39002, tags: [["d", CH], ["p", ME], ["p", OWNER_PK]] })]) });
  ws.emit("message", { data: JSON.stringify(["EVENT", "channels", msg(OWNER, [], "plain DM")]) });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(got, ["plain DM"]);
  conn.close();
});

test("listen: signs in on the relay's challenge, subscribes, answers a pushed mention once, in its thread", async () => {
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.handlers = {}; sockets.push(this); queueMicrotask(() => this.emit("message", { data: JSON.stringify(["AUTH", "chal-1"]) })); }
    addEventListener(t, f) { (this.handlers[t] ||= []).push(f); }
    emit(t, ev) { for (const f of this.handlers[t] || []) f(ev); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.emit("close", {}); }
  }
  const answered = [], posted = [], logs = [];
  const conn = listen({
    name: "Claude", relayUrl: "https://buzz.example.com", secretHex: AGENT, allowFrom: [OWNER_PK], WebSocketImpl: FakeWS,
    answer: async (text, { threadKey }) => { answered.push({ text, threadKey }); return "391"; },
    send: async (r) => { posted.push(r); return "cd".repeat(32); },
    log: (o) => logs.push(o), now: () => 1_000_000,
  });
  await new Promise((r) => setTimeout(r, 5));
  const ws = sockets[0];
  assert.equal(ws.url, "wss://buzz.example.com");
  const [kind, auth] = ws.sent[0];
  assert.equal(kind, "AUTH");
  assert.ok(verifyEvent(auth));
  assert.deepEqual(auth.tags, [["relay", "wss://buzz.example.com"], ["challenge", "chal-1"]]);
  ws.emit("message", { data: JSON.stringify(["OK", auth.id, true, ""]) });
  assert.ok(ws.sent.some((m) => m[0] === "REQ" && m[1] === "mentions" && m[2]["#p"][0] === ME));

  const mention = msg(OWNER, [["p", ME]], "17 times 23?");
  ws.emit("message", { data: JSON.stringify(["EVENT", "mentions", mention]) });
  ws.emit("message", { data: JSON.stringify(["EVENT", "channels", mention]) });     // same event twice: answered once
  const forged = { ...msg(OTHER, [["p", ME]], "x"), pubkey: OWNER_PK };              // bad signature: ignored
  ws.emit("message", { data: JSON.stringify(["EVENT", "mentions", forged]) });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(answered, [{ text: "17 times 23?", threadKey: mention.id }]);
  assert.deepEqual(posted, [{ channel: CH, replyTo: mention.id, mention: OWNER_PK, text: "391" }]);

  const followup = msg(OWNER, [["e", "cd".repeat(32), "", "reply"]], "and 18?", 2_000_000_001);   // reply to our answer
  ws.emit("message", { data: JSON.stringify(["EVENT", "channels", followup]) });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(answered[1].threadKey, mention.id);
  assert.ok(!JSON.stringify(logs).includes(AGENT));
  conn.close();
});

test("agent-turn: stable session id per identity and thread; final text is the last assistant text", () => {
  assert.equal(sessionIdFor("Claude", "t1"), sessionIdFor("Claude", "t1"));
  assert.notEqual(sessionIdFor("Claude", "t1"), sessionIdFor("Codex", "t1"));
  const ev = [{ type: "user/message" }, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "first" }] } } },
    { type: "assistant/message", data: { message: { content: [{ type: "tool_use" }] } } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "final" }] } } }];
  assert.equal(finalText({ seq: ev.length, eventAt: (i) => ev[i] }, 0), "final");
});

test("listen: the first message of a brand-new DM is answered (member list is fetched before the messages)", async () => {
  const sockets = [];
  class FakeWS {
    constructor() { this.sent = []; this.h = {}; sockets.push(this); queueMicrotask(() => this.emit("message", { data: JSON.stringify(["AUTH", "c"]) })); }
    addEventListener(t, f) { (this.h[t] ||= []).push(f); }
    emit(t, ev) { for (const f of this.h[t] || []) f(ev); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() {}
  }
  const got = [];
  const conn = listen({ name: "Grok", relayUrl: "https://r.example", secretHex: AGENT, allowFrom: [OWNER_PK], WebSocketImpl: FakeWS,
    answer: async (t) => { got.push(t); return "ok"; }, send: async () => undefined, log: () => {} });
  await new Promise((r) => setTimeout(r, 5));
  const ws = sockets[0];
  ws.emit("message", { data: JSON.stringify(["OK", ws.sent[0][1].id, true, ""]) });
  const relay = "44".repeat(32);
  ws.emit("message", { data: JSON.stringify(["EVENT", "membership", signEvent(relay, { kind: 44100, tags: [["h", CH], ["p", ME]] })]) });
  const subscribedToCh = () => ws.sent.some((m) => m[0] === "REQ" && m[1] === `channel:${CH}` && m[2]["#h"].includes(CH));
  assert.ok(!subscribedToCh(), "no message subscription before the member list");
  assert.ok(ws.sent.some((m) => m[1] === `groups-new:${CH}` && m[2]["#d"][0] === CH));
  ws.emit("message", { data: JSON.stringify(["EVENT", "groups-new", signEvent(relay, { kind: 39002, tags: [["d", CH], ["p", ME], ["p", OWNER_PK]] })]) });
  assert.ok(subscribedToCh());
  ws.emit("message", { data: JSON.stringify(["EVENT", "channels", msg(OWNER, [], "first DM")]) });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(got, ["first DM"]);
  conn.close();
});

test("malformed events return false without throwing, including correctly signed malformed tags", () => {
  const valid = msg(OWNER, [["p", ME]]);
  for (const e of [null, {}, { ...valid, sig: "bad" }, { ...valid, pubkey: "bad" },
    signEvent(OWNER, { kind: 9, tags: [null] }), signEvent(OWNER, { kind: 9, tags: [["p", 42]] })]) {
    assert.equal(verifyEvent(e), false);
  }
});

test("malformed relay frames do not interrupt subsequent messages and closing prevents a pending reply", async () => {
  let ws;
  class FakeWS {
    constructor() { ws = this; this.h = {}; }
    addEventListener(t, f) { this.h[t] = f; }
    send() {}
    close() {}
    message(data) { this.h.message({ data: JSON.stringify(data) }); }
  }
  let finish, started;
  const ready = new Promise(r => { started = r; });
  const answer = new Promise(r => { finish = r; });
  const posted = [];
  const conn = listen({ name: "A", relayUrl: "https://relay.example", secretHex: AGENT, allowFrom: [OWNER_PK],
    WebSocketImpl: FakeWS, log: () => {}, answer: () => { started(); return answer; }, send: async r => posted.push(r) });
  for (const frame of [null, 42, {}, ["EVENT", "m", { tags: null }]]) assert.doesNotThrow(() => ws.message(frame));
  ws.message(["EVENT", "m", msg(OWNER, [["p", ME]])]);
  await ready;
  conn.close();
  finish("done");
  await new Promise(r => setImmediate(r));
  assert.deepEqual(posted, []);
});

test("DM discovery uses the connection cursor even after newer traffic in another channel", async () => {
  let ws;
  class FakeWS {
    constructor() { ws = this; this.sent = []; this.h = {}; }
    addEventListener(t, f) { this.h[t] = f; }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() {}
    message(m) { this.h.message({ data: JSON.stringify(m) }); }
  }
  const c = listen({ name: 'A', relayUrl: 'https://relay.example', secretHex: AGENT, allowFrom: [OWNER_PK],
    now: () => 1000000, WebSocketImpl: FakeWS, log: () => {}, answer: async () => 'ok', send: async () => undefined });
  ws.message(['OK', 'auth', true, '']);
  ws.message(['EVENT', 'mentions', msg(OWNER, [['p', ME]], 'newer', 1100)]);
  ws.message(['EVENT', 'groups', signEvent(OTHER, {kind:39002, tags:[['d', CH], ['p', ME], ['p', OWNER_PK]]})]);
  const req = ws.sent.find(m => m[1] === `channel:${CH}`);
  assert.equal(req[2].since, 1000, 'must include the DM message at 1050');
  c.close();
});

test("progress is sent before completion, final text is deduplicated, and later results are delivered", async () => {
  let ws, finish, progressSent;
  const ready = new Promise(r => progressSent = r), done = new Promise(r => finish = r);
  class FakeWS {
    constructor() { ws = this; }
    addEventListener(t, f) { if (t === 'message') this.message = m => f({ data: JSON.stringify(m) }); }
    send() {} close() {}
  }
  const posts = [];
  const c = listen({name:'Grok',relayUrl:'https://relay.example',secretHex:AGENT,allowFrom:[OWNER_PK],WebSocketImpl:FakeWS,log:()=>{},
    answer:async (text, {onProgress}) => { await onProgress('Working'); await onProgress('Working'); progressSent(); await done; await onProgress('Finished'); return 'Finished'; },
    send:async r => { posts.push(r.text); return 'de'.repeat(32); }});
  ws.message(['EVENT','mentions',msg(OWNER,[['p',ME]])]);
  await ready;
  assert.deepEqual(posts,['Working']);
  finish(); await new Promise(r=>setImmediate(r));
  assert.deepEqual(posts,['Working','Finished']); c.close();
});

test("concurrent new DMs keep independent discovery and message subscriptions", async () => {
  let ws;
  class FakeWS {
    constructor() { ws = this; this.active = new Map(); }
    addEventListener(t, f) { if (t === 'message') this.message = m => f({data: JSON.stringify(m)}); }
    send(raw) { const [type, id, filter] = JSON.parse(raw); if (type === 'REQ') this.active.set(id, filter); }
    close() {}
  }
  const answered = [];
  const c = listen({name:'Grok', relayUrl:'https://relay.example', secretHex:AGENT, allowFrom:[OWNER_PK],
    WebSocketImpl:FakeWS, log:()=>{}, answer:async text => { answered.push(text); return 'ok'; }, send:async()=>undefined});
  try {
    ws.message(['OK', 'auth', true, '']);
    const channels = [CH, 'b6f725b6-ce62-477e-bb7c-3b041b00a32f'];
    for (const channel of channels) ws.message(['EVENT', 'membership', signEvent(OTHER,
      {kind:44100, tags:[['h',channel],['p',ME]]})]);
    for (const channel of channels) {
      assert.deepEqual(ws.active.get(`groups-new:${channel}`)['#d'], [channel]);
      ws.message(['EVENT', `groups-new:${channel}`, signEvent(OTHER,
        {kind:39002, tags:[['d',channel],['p',ME],['p',OWNER_PK]]})]);
    }
    for (const channel of channels) {
      assert.deepEqual(ws.active.get(`channel:${channel}`)['#h'], [channel]);
      ws.message(['EVENT', `channel:${channel}`, signEvent(OWNER,
        {kind:9, tags:[['h',channel]], content:channel})]);
    }
    await new Promise(r=>setImmediate(r));
    assert.deepEqual(answered, channels);
  } finally { c.close(); }
});

test('human DMs are acknowledged before model work; receipt failure still runs the request', async () => {
  for (const failReceipt of [false, true]) {
    let ws, finish, started;
    const ready = new Promise(r => started = r), done = new Promise(r => finish = r);
    const posts = [], logs = [];
    class FakeWS {
      constructor() { ws = this; }
      addEventListener(t, f) { if (t === 'message') this.message = m => f({data: JSON.stringify(m)}); }
      send() {} close() {}
    }
    const c = listen({name:'Grok',relayUrl:'https://relay.example',secretHex:AGENT,allowFrom:[OWNER_PK],WebSocketImpl:FakeWS,
      log:e=>logs.push(e),answer:async()=>{started();await done;return 'Done';},send:async r=>{
        posts.push(r.text); if (failReceipt && posts.length === 1) throw new Error('offline');
      }});
    try {
      ws.message(['EVENT','groups',signEvent(OTHER,{kind:39002,tags:[['d',CH],['p',ME],['p',OWNER_PK]]})]);
      ws.message(['EVENT','channel',msg(OWNER,[])]);
      await ready;
      assert.deepEqual(posts,['(Grok received your message and is working on it.)']);
      finish(); await new Promise(r=>setImmediate(r));
      assert.equal(posts.at(-1),'Done');
      assert.equal(logs.some(e=>e.event==='buzz_ack_error'),failReceipt);
    } finally { finish(); c.close(); }
  }
});

test('two agents exchange ten rounds, suppress progress, and retain the cap across restarts', async () => {
  const sockets = [], counts = [0, 0], posts = [], saved = [{}, {}];
  class FakeWS {
    constructor() { sockets.push(this); }
    addEventListener(t, f) { if (t === 'message') this.message = m => f({data:JSON.stringify(m)}); }
    send() {} close() {}
  }
  const secrets = [AGENT, OTHER], keys = [ME, OTHER_PK];
  const root = 'fa'.repeat(32);
  const create = i => listen({name:`Agent${i}`,relayUrl:'https://relay.example',secretHex:secrets[i],
    // Even an agent accidentally included in the human allowlist must be capped.
    allowFrom:[OWNER_PK, keys[1-i]],allowAgents:[keys[1-i]],maxAgentReplies:100,
    store:{load:()=>saved[i],save:o=>{saved[i]=o;}},WebSocketImpl:FakeWS,log:()=>{},
    answer:async (text,{onProgress})=>{counts[i]++;await onProgress('working');return `reply ${counts[i]}`;},
    send:async r=>{
      posts.push(r);
      assert.equal(r.mention,keys[1-i]);
      const e=msg(secrets[i],[['p',r.mention],['e',r.replyTo,'','root']],r.text);
      sockets[1-i].message(['EVENT','mentions',e]);
      return e.id;
    }});
  const connections=[create(0),create(1)];
  try {
    sockets[0].message(['EVENT','mentions',msg(OTHER,[['p',ME],['e',root,'','root']],'start')]);
    await new Promise(r=>setImmediate(r));
    assert.deepEqual(counts,[10,10]);
    assert.equal(posts.length,20);
    assert.ok(posts.every(p=>p.text!=='working'));
    connections[0].close();
    connections[0]=create(0);
    sockets[2].message(['EVENT','mentions',msg(OTHER,[['p',ME],['e',root,'','root']],'after restart')]);
    await new Promise(r=>setImmediate(r));
    assert.deepEqual(counts,[10,10]);
  } finally {for(const c of connections)c.close();}
});
