import { test } from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { signEvent, verifyEvent, route, listen, wsUrl } from "../listen.mjs";
import { sessionIdFor, finalText } from "../agent-turn.mjs";

const AGENT = "11".repeat(32), OWNER = "22".repeat(32), OTHER = "33".repeat(32);
const pub = (s) => bytesToHex(schnorr.getPublicKey(Buffer.from(s, "hex")));
const ME = pub(AGENT), OWNER_PK = pub(OWNER), OTHER_PK = pub(OTHER);
const CH = "a6f725b6-ce62-477e-bb7c-3b041b00a32f";
const msg = (sec, tags, content = "hi", t = 2_000_000_000) => signEvent(sec, { kind: 9, tags: [["h", CH], ...tags], content, created_at: t });

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

test("route: an allowed agent counts only when it @mentions this identity", () => {
  const base = { me: ME, allowFrom: new Set([OWNER_PK]), allowAgents: new Set([OTHER_PK]), dmChannels: new Set([CH]), threads: new Map([["ab".repeat(32), "t"]]) };
  assert.equal(route(msg(OTHER, [["p", ME]]), base).fromAgent, true);
  assert.equal(route(msg(OTHER, []), base), null);                                       // DM without mention
  assert.equal(route(msg(OTHER, [["e", "ab".repeat(32), "", "reply"]]), base), null);    // thread follow-up without mention
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
