// Push listener: each configured Buzz identity keeps one live WebSocket to the relay (standard Nostr: NIP-42 sign-in,
// NIP-29 group messages) and answers, the moment they arrive, the messages that @mention it, that sit in a DM with it,
// or that reply in a thread it is already in. Only authors in allowFrom are answered; nobody else's text reaches a model.
// Each Buzz thread is one dsh Session with the identity's fixed provider/model, so follow-ups keep their context.
// Nothing here changes Buzz: any Buzz relay works, the same way the Buzz apps connect.
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const HEX64 = /^[0-9a-f]{64}$/;
const enc = new TextEncoder();

/** A signed Nostr event (NIP-01 id, BIP-340 signature). */
export function signEvent(secretHex, { kind, tags = [], content = "", created_at = Math.floor(Date.now() / 1000) }) {
  const pubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(secretHex)));
  const id = bytesToHex(sha256(enc.encode(JSON.stringify([0, pubkey, created_at, kind, tags, content]))));
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(secretHex)));
  return { id, pubkey, created_at, kind, tags, content, sig };
}
export const verifyEvent = (e) => {
  try {
    if (!e || !HEX64.test(e.id) || !HEX64.test(e.pubkey) || !/^[0-9a-f]{128}$/.test(e.sig) ||
      !Number.isSafeInteger(e.created_at) || e.created_at < 0 || !Number.isSafeInteger(e.kind) ||
      typeof e.content !== "string" || !Array.isArray(e.tags) ||
      !e.tags.every(t => Array.isArray(t) && t.every(v => typeof v === "string"))) return false;
    const id = bytesToHex(sha256(enc.encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
    return id === e.id && schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch { return false; }
};

/** A channel's member list (39002 p tags) makes it a DM when it is this identity plus at most one other. */
export const isDm = (memberPubkeys, me) => { const m = new Set(memberPubkeys); return m.has(me) && m.size <= 2; };
export const wsUrl = (relayUrl) => relayUrl.replace(/^http(s?):\/\//, "ws$1://").replace(/\/+$/, "");
const tagValues = (e, name) => (e.tags || []).filter((t) => t[0] === name).map((t) => t[1]);

/**
 * Decide whether `me` should answer event `e`, and which thread it belongs to. Pure, for tests.
 * @returns {null | { threadKey: string, replyTo: string, channel: string, fromAgent: boolean }}
 */
export function route(e, { me, allowFrom, allowAgents = new Set(), dmChannels, threads }) {
  if (!e || e.kind !== 9 || e.pubkey === me) return null;
  const fromAgent = !allowFrom.has(e.pubkey) && allowAgents.has(e.pubkey);
  if (!allowFrom.has(e.pubkey) && !fromAgent) return null;
  // Another agent counts only when it @mentions this one (no DM or thread follow-up), so two agents cannot keep a
  // thread going by replying to each other's replies; listen() also caps replies to agents per thread.
  if (fromAgent && !(e.tags || []).some((t) => t[0] === "p" && t[1] === me)) return null;
  const channel = tagValues(e, "h")[0];
  if (!channel) return null;
  const refs = (e.tags || []).filter((t) => t[0] === "e" && HEX64.test(t[1] || ""));
  const known = refs.map((t) => t[1]).find((id) => threads.has(id));
  const mentioned = tagValues(e, "p").includes(me);
  if (!mentioned && !known && !dmChannels.has(channel)) return null;
  const root = refs.find((t) => t[3] === "root")?.[1] ?? refs.find((t) => t[3] === "reply")?.[1] ?? refs[0]?.[1];
  const threadKey = known ? threads.get(known) : dmChannels.has(channel) && !root ? `dm:${channel}` : root ?? e.id;
  return { threadKey, replyTo: root ?? e.id, channel, fromAgent };
}

/**
 * One identity's live connection. `answer(text, ctx)` returns the reply text; `send(reply)` posts it.
 * Reconnects with backoff and resubscribes from the last event seen, so a dropped socket loses nothing.
 */
export function listen({ name, relayUrl, secretHex, allowFrom, allowAgents = [], maxAgentReplies = 5, answer, send, log, store, WebSocketImpl = globalThis.WebSocket, now = () => Date.now() }) {
  const me = bytesToHex(schnorr.getPublicKey(hexToBytes(secretHex)));
  const url = wsUrl(relayUrl);
  const allow = new Set(allowFrom);
  const agentsAllowed = new Set(allowAgents);
  const agentReplies = new Map();     // thread key -> replies this identity gave to agents in that thread
  const dmChannels = new Set();
  const members = new Set();
  // event id -> thread key (root, the triggering message, our own replies). Kept in `store` across restarts, so a reply
  // without @mention in an older thread is still recognised after dsh restarts. At most 5000 ids, oldest dropped.
  const threads = new Map(Object.entries(store?.load?.() ?? {}));
  const remember = (id, key) => {
    if (!id) return;
    threads.delete(id); threads.set(id, key);
    while (threads.size > 5000) threads.delete(threads.keys().next().value);
    store?.save?.(Object.fromEntries(threads));
  };
  const seen = new Set();
  const queues = new Map();           // thread key -> promise chain: one turn at a time per thread
  let since = Math.floor(now() / 1000);
  let ws, closed = false, delay = 1000, authed = false;
  let connectionSince = since;
  const subscribeChannel = (channel) => ws.send(JSON.stringify(["REQ", `channel:${channel}`,
    { kinds: [9], "#h": [channel], since: connectionSince }]));

  const subscribe = () => {
    ws.send(JSON.stringify(["REQ", "groups", { kinds: [39000, 39002], "#p": [me] }, { kinds: [39000, 39002], "#d": [...members] }]));
    ws.send(JSON.stringify(["REQ", "mentions", { kinds: [9], "#p": [me], since }]));
    for (const channel of members) subscribeChannel(channel);
    ws.send(JSON.stringify(["REQ", "membership", { kinds: [44100], "#p": [me], since }]));
  };
  const handle = (e) => {
    if (seen.has(e.id)) return;
    seen.add(e.id); if (seen.size > 5000) seen.delete(seen.values().next().value);
    if (e.created_at > since) since = e.created_at;
    const r = route(e, { me, allowFrom: allow, allowAgents: agentsAllowed, dmChannels, threads });
    if (!r) return;
    if (r.fromAgent) {
      const n = agentReplies.get(r.threadKey) ?? 0;
      if (n >= maxAgentReplies) return void log({ event: "buzz_agent_cap", agent: name, thread: r.threadKey.slice(0, 12), replies: n });
      agentReplies.set(r.threadKey, n + 1);
    }
    remember(e.id, r.threadKey); remember(r.replyTo, r.threadKey);
    const prev = queues.get(r.threadKey) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (closed) return;
      const t0 = now();
      let text, lastPosted;
      const post = async (text) => {
        if (closed || !text || text === lastPosted) return;
        // An automatic @mention back to another agent would trigger it again,
        // turning even a diagnostic acknowledgement into a reply loop.
        const id = await send({ channel: r.channel, replyTo: r.replyTo, mention: r.fromAgent ? undefined : e.pubkey, text });
        if (id) remember(id, r.threadKey);
        lastPosted = text;
      };
      // A provider or delegated task may take minutes before producing visible text.
      // Confirm human DMs reached the listener before starting that work. A failed
      // acknowledgement must not discard the user's request.
      if (dmChannels.has(r.channel) && !r.fromAgent) {
        try { await post(`(${name} received your message and is working on it.)`); }
        catch (err) { log({ event: "buzz_ack_error", agent: name, error: String(err?.message || err).slice(0, 200) }); }
      }
      try { text = await answer(e.content, { threadKey: r.threadKey, event: e, onProgress: post }); }
      catch (err) { text = `(${name} could not answer: ${String(err?.message || err).slice(0, 300)})`; }
      if (closed) return;
      await post(text || "(no answer)");
      log({ event: "buzz_turn", agent: name, thread: r.threadKey.slice(0, 12), ms: now() - t0, chars: (text || "").length });
    }).catch((err) => log({ event: "buzz_turn_error", agent: name, error: String(err?.message || err).slice(0, 200) }));
    queues.set(r.threadKey, next);
    void next.finally(() => { if (queues.get(r.threadKey) === next) queues.delete(r.threadKey); });
  };
  const onMessage = (raw) => {
    let m; try { m = JSON.parse(typeof raw === "string" ? raw : raw.toString()); } catch { return; }
    if (closed || !Array.isArray(m)) return;
    if (m[0] === "AUTH" && typeof m[1] === "string") {
      ws.send(JSON.stringify(["AUTH", signEvent(secretHex, { kind: 22242, tags: [["relay", url], ["challenge", m[1]]] })]));
    } else if (m[0] === "OK" && m[3] !== undefined && !authed) {
      if (m[2] === true) { authed = true; delay = 1000; subscribe(); log({ event: "buzz_connected", agent: name }); }
      else log({ event: "buzz_auth_refused", agent: name, reason: String(m[3]).slice(0, 200) });
    } else if (m[0] === "EVENT" && m[2] && typeof m[2] === "object") {
      const e = m[2];
      if (!verifyEvent(e)) return;
      if (e.kind === 39000 || e.kind === 39002) {
        const d = tagValues(e, "d")[0];
        if (!d) return;
        if (e.kind === 39002 && tagValues(e, "p").includes(me)) {
          // Buzz DMs are ordinary groups (named "DM", no marker tag): a channel whose only members are this identity and
          // one other is treated as a DM, so every message there is for it.
          if (isDm(tagValues(e, "p"), me)) dmChannels.add(d);
          else dmChannels.delete(d);
          if (!members.has(d)) { members.add(d); if (authed) subscribeChannel(d); }
        }
        if (e.kind === 39000 && (e.tags || []).some((t) => t[0] === "hidden" || (t[0] === "t" && t[1] === "dm"))) dmChannels.add(d);
      } else if (e.kind === 44100) {
        const d = tagValues(e, "h")[0] ?? tagValues(e, "d")[0];
        // Ask for the new channel's member list first; its 39002 (handled above) marks a DM and only then subscribes to
        // the messages. Subscribing here would let the first message of a new DM arrive before the channel is known
        // to be a DM, and it would be dropped as unaddressed chatter.
        if (d && !members.has(d)) ws.send(JSON.stringify(["REQ", `groups-new:${d}`, { kinds: [39000, 39002], "#d": [d] }]));
      } else handle(e);
    } else if (m[0] === "CLOSED") {
      log({ event: "buzz_subscription_closed", agent: name, subscription: m[1], reason: String(m[2] || "").slice(0, 200) });
      // CLOSED ends this subscription, not the socket. Leaving the connection open
      // would look healthy while permanently missing that channel's messages.
      // Reconnect through the existing backoff path and replay from the cursor.
      try { ws.close(); } catch { /* close may already be in progress */ }
    }
  };
  const open = () => {
    if (closed) return;
    authed = false;
    connectionSince = since;
    ws = new WebSocketImpl(url);
    ws.addEventListener("message", (ev) => onMessage(ev.data));
    ws.addEventListener("close", () => {
      if (closed) return;
      log({ event: "buzz_reconnect", agent: name, in_ms: delay });
      setTimeout(open, delay); delay = Math.min(delay * 2, 60_000);
    });
    ws.addEventListener("error", () => { try { ws.close(); } catch { /* close handler reconnects */ } });
  };
  open();
  return { me, close() { closed = true; try { ws?.close(); } catch { /* already closed */ } } };
}
