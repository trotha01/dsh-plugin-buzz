import { test } from "node:test";
import assert from "node:assert/strict";
import { watch } from "../watch.mjs";
import { signEvent, verifyEvent } from "../listen.mjs";

const SECRET = "11".repeat(32);
const event = (created_at = 1000) => signEvent(SECRET, { kind: 9, tags: [["h", "channel"]], content: "hello", created_at });

class FakeWS {
  static sockets = [];
  constructor(url) { this.url = url; this.sent = []; this.handlers = {}; FakeWS.sockets.push(this); queueMicrotask(() => this.emit("open", {})); }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  emit(type, value) { for (const fn of this.handlers[type] || []) fn(value); }
  message(frame) { this.emit("message", { data: JSON.stringify(frame) }); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() {}
}

const output = () => ({ text: "", write(value) { this.text += value; return true; }, on() {}, off() {} });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("watch authenticates, resubscribes, deduplicates events and drops invalid signatures", async () => {
  FakeWS.sockets = [];
  const out = output();
  const w = watch({ relayUrl: "https://relay.example", secretHex: SECRET, filters: [{ kinds: [9], "#h": ["channel"] }],
    since: 900, WebSocketImpl: FakeWS, out, heartbeatIntervalMs: 100000 });
  await tick();
  const ws = FakeWS.sockets[0];
  const initialReq = ws.sent.find(m => m[0] === "REQ");
  assert.equal(initialReq[2].since, 900);
  ws.message(["AUTH", "challenge"]);
  const auth = ws.sent.find(m => m[0] === "AUTH");
  assert.ok(verifyEvent(auth[1]));
  ws.message(["OK", auth[1].id, true, ""]);
  assert.equal(ws.sent.filter(m => m[0] === "REQ").length, 2);
  const good = event();
  ws.message(["EVENT", initialReq[1], good]);
  ws.message(["EVENT", initialReq[1], good]);
  ws.message(["EVENT", initialReq[1], { ...good, content: "forged" }]);
  ws.message(["EOSE", initialReq[1]]);
  assert.deepEqual(out.text.trim().split("\n").map(JSON.parse), [good, { type: "eose" }]);
  w.close();
});

test("watch reconnects and resumes from last seen minus 60", async () => {
  FakeWS.sockets = [];
  const out = output();
  const w = watch({ relayUrl: "https://relay.example", secretHex: SECRET, filters: [{ kinds: [9] }], since: 900,
    WebSocketImpl: FakeWS, out, heartbeatIntervalMs: 100000 });
  await tick();
  const first = FakeWS.sockets[0], req = first.sent.find(m => m[0] === "REQ");
  first.message(["EVENT", req[1], event(1100)]);
  first.emit("close", {});
  await new Promise(resolve => setTimeout(resolve, 1100));
  await tick();
  const resumed = FakeWS.sockets[1].sent.find(m => m[0] === "REQ");
  assert.equal(resumed[2].since, 1040);
  w.close();
});

test("CLOSED for a heartbeat probe does not drop the subscription", async () => {
  const { watch } = await import("../watch.mjs");
  const sockets = [];
  class FakeWS { constructor(u) { this.l = {}; this.sent = []; sockets.push(this); queueMicrotask(() => this.emit("open")); }
    addEventListener(t, f) { (this.l[t] ||= []).push(f); } emit(t, e = {}) { for (const f of this.l[t] || []) f(e); }
    send(d) { this.sent.push(JSON.parse(d)); } close() {} }
  const w = watch({ relayUrl: "http://r", secretHex: "1".repeat(64), filters: [{ kinds: [9] }], WebSocketImpl: FakeWS, out: { write() {} } });
  await new Promise(r => setTimeout(r, 5));
  sockets[0].emit("message", { data: JSON.stringify(["CLOSED", "buzz-watch-heartbeat:9", ""]) });
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(sockets.length, 1);
  w.close();
});
