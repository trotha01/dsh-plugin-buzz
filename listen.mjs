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
  const fromAgent = allowAgents.has(e.pubkey);
  if (!allowFrom.has(e.pubkey) && !fromAgent) return null;
  const channel = tagValues(e, "h")[0];
  if (!channel) return null;
  // Explicit mentions and one-to-one DMs let agents converse without waking every agent in a group thread.
  if (fromAgent && !dmChannels.has(channel) && !tagValues(e, "p").includes(me)) return null;
  const refs = (e.tags || []).filter((t) => t[0] === "e" && HEX64.test(t[1] || ""));
  const known = refs.map((t) => t[1]).find((id) => threads.has(id));
  const mentioned = tagValues(e, "p").includes(me);
  if (!mentioned && !known && !dmChannels.has(channel)) return null;
  const root = refs.find((t) => t[3] === "root")?.[1] ?? refs.find((t) => t[3] === "reply")?.[1] ?? refs[0]?.[1];
  // A DM contains independent threads. Preserve recorded mappings (including legacy
  // channel-wide sessions) only for replies; a new top-level message starts fresh.
  const threadKey = known ? threads.get(known) : root ?? e.id;
  return { threadKey, replyTo: root ?? e.id, channel, fromAgent };
}

/**
 * One identity's live connection. `answer(text, ctx)` returns the reply text; `send(reply)` posts it.
 * Reconnects with backoff and resubscribes from the last event seen, so a dropped socket loses nothing.
 */
export function listen({ name, relayUrl, secretHex, allowFrom, allowAgents = [], maxAgentReplies = 10, ownerPubkey, beforeAnswer = async () => {}, explicitRequests = false, channelAgentMentions = false, answer, send, log, store, WebSocketImpl = globalThis.WebSocket, now = () => Date.now(), statusIntervalMs = 60_000, ledger, sendSigned, resolveSession, retryIntervalMs = 30_000, turnTimeoutMs = 30 * 60_000, queueTimeoutMs = 30 * 60_000, heartbeatIntervalMs = 30_000, heartbeatTimeoutMs = 10_000 }) {
  const me = bytesToHex(schnorr.getPublicKey(hexToBytes(secretHex)));
  const url = wsUrl(relayUrl);
  const allow = new Set(allowFrom);
  const agentsAllowed = new Set(allowAgents);
  const limit = Number.isSafeInteger(maxAgentReplies) ? Math.max(0, Math.min(10, maxAgentReplies)) : 10;
  const { __agentReplies = {}, ...savedThreads } = store?.load?.() ?? {};
  const agentReplies = new Map(Object.entries(__agentReplies));
  const persist = () => store?.save?.({ ...Object.fromEntries(threads), __agentReplies: Object.fromEntries(agentReplies) });
  const dmChannels = new Set();
  const members = new Set();
  // event id -> thread key (root, the triggering message, our own replies). Kept in `store` across restarts, so a reply
  // without @mention in an older thread is still recognised after dsh restarts. At most 5000 ids, oldest dropped.
  const threads = new Map(Object.entries(savedThreads));
  const remember = (id, key) => {
    if (!id) return;
    threads.delete(id); threads.set(id, key);
    while (threads.size > 5000) threads.delete(threads.keys().next().value);
    persist();
  };
  const seen = new Set();
  const statusTimers = new Set();
  const queues = new Map();           // thread key -> promise chain: one turn at a time per thread
  let since = ledger?.cursor(Math.floor(now() / 1000)) ?? Math.floor(now() / 1000);
  const publishing = new Set();
  const publications = new Set();
  const update = (id, patch) => {
    const row = ledger?.put(id, patch);
    if (ledger) log({event: 'buzz_delivery', agent: name, message: id, state: patch.state, reason: patch.reason});
    return row;
  };
  const publish = row => {
    const task = publishRow(row);
    publications.add(task);
    void task.finally(() => publications.delete(task)).catch(() => {});
    return task;
  };
  const publishRow = async (row) => {
    if (closed || publishing.has(row.id) || !row.outbox) return;
    publishing.add(row.id);
    try {
      await beforeAnswer(row.route.channel);
      const id = await sendSigned(row.outbox);
      remember(id, row.route.threadKey);
      update(row.id, {state: 'published', reason: null});
    } catch (err) {
      update(row.id, {state: 'answered', reason: 'publication_retry', error: String(err?.message || err).slice(0, 200)});
    } finally { publishing.delete(row.id); }
  };
  const recover = () => {
    if (closed || !ledger) return;
    for (const row of ledger.list()) {
      if (row.state === 'answered' && row.outbox && sendSigned) void publish(row);
      else if (['received', 'queued', 'waiting_metadata'].includes(row.state) && !seen.has(row.id)) handle(row.event);
    }
  };
  const retryTimer = ledger && setInterval(recover, retryIntervalMs);
  retryTimer?.unref?.();
  let ws, closed = false, delay = 1000, authed = false;
  let connectionSince = since;
  let reconnectTimer, heartbeatTimer, heartbeatDeadline, probeId, reconnect;
  let probeSequence = 0;
  const subscribeChannel = (channel) => ws.send(JSON.stringify(["REQ", `channel:${channel}`,
    { kinds: [9], "#h": [channel], since: Math.max(0, connectionSince - (ledger ? 60 : 0)) }]));

  const subscribe = () => {
    ws.send(JSON.stringify(["REQ", "groups", { kinds: [39000, 39002], "#p": [me] }, { kinds: [39000, 39002], "#d": [...members] }]));
    ws.send(JSON.stringify(["REQ", "mentions", { kinds: [9], "#p": [me], since: Math.max(0, since - (ledger ? 60 : 0)) }]));
    for (const channel of members) subscribeChannel(channel);
    ws.send(JSON.stringify(["REQ", "membership", { kinds: [44100], "#p": [me], since: Math.max(0, since - (ledger ? 60 : 0)) }]));
  };
  const handle = (e) => {
    if (e.kind !== 9 || e.pubkey === me || (!allow.has(e.pubkey) && !agentsAllowed.has(e.pubkey))) return;
    const existing = ledger?.get(e.id);
    if (existing && !['received', 'queued', 'waiting_metadata'].includes(existing.state)) {
      if (existing.state === 'answered' && sendSigned) void publish(existing);
      return;
    }
    // Controller publications are already scheduled durably. The signed marker also survives
    // relay echo before ACK, reconnect replay, and separate recipient processes.
    if (agentsAllowed.has(e.pubkey) && e.tags.some(t => t[0] === 'buzz-request')) {
      update(e.id, {state: 'suppressed', reason: 'durable_request_delivery', event: e});
      return;
    }
    if (seen.has(e.id)) return;
    if (ledger && !existing) update(e.id, {state: 'received', event: e});
    // Keep the installation replay floor: receipt of one channel cannot prove other channels caught up.
    if (!ledger && e.created_at > since) since = e.created_at;
    const r = existing?.route ?? route(e, { me, allowFrom: allow, allowAgents: agentsAllowed, dmChannels, threads });
    if (!r) {
      if (ledger) update(e.id, {state: members.has(tagValues(e, 'h')[0]) ? 'suppressed' : 'waiting_metadata', reason: 'not_addressed_or_membership_unknown'});
      return;
    }
    if (explicitRequests && r.fromAgent && !(channelAgentMentions &&
        !dmChannels.has(r.channel) && tagValues(e, "p").includes(me))) {
      update(e.id, {state: 'suppressed', reason: 'explicit_request_required', route: r}); return;
    }
    if (r.fromAgent && existing?.state !== 'queued') {
      const n = agentReplies.get(r.threadKey) ?? 0;
      if (n >= limit) {
        update(e.id, {state: 'suppressed', reason: 'reply_budget_exhausted', route: r});
        return void log({event: 'buzz_agent_cap', agent: name, thread: r.threadKey.slice(0, 12), replies: n});
      }
      agentReplies.set(r.threadKey, n + 1);
      persist();
    }
    const sessionId = existing?.sessionId ?? resolveSession?.(r.threadKey);
    update(e.id, {state: 'queued', route: r, sessionId, queuedAt: existing?.queuedAt ?? now()});
    seen.add(e.id); if (seen.size > 5000) seen.delete(seen.values().next().value);
    remember(e.id, r.threadKey); remember(r.replyTo, r.threadKey);
    const previous = queues.get(r.threadKey);
    const receivedAt = now();
    let lastActivity = receivedAt, lastModelText, delivery = Promise.resolve();
    let active = false, finished = false;
    // Serialize all sends so a slow status delivery cannot overtake the final answer.
    const post = (text, modelText = false) => {
      const pending = delivery.then(async () => {
        if (closed || !text || (modelText && text === lastModelText)) return;
        const id = await send({ channel: r.channel, replyTo: r.replyTo,
          mention: explicitRequests && r.fromAgent ? undefined : e.pubkey, text });
        if (id) remember(id, r.threadKey);
        lastActivity = now();
        if (modelText) lastModelText = text;
      });
      delivery = pending.catch(() => {});
      return pending;
    };
    const status = (text) => post(text).catch(err =>
      log({ event: "buzz_status_error", agent: name, error: String(err?.message || err).slice(0, 200) }));
    // Receipt is outside the thread queue: even a queued request is acknowledged now.
    // Persist before attempting the send: retries (including after restart) must not spam receipts.
    const needsReceipt = !r.fromAgent && !existing?.receiptAttempted;
    if (needsReceipt) update(e.id, {receiptAttempted: true});
    const receipt = !needsReceipt ? Promise.resolve() : status(previous
      ? `(${name} received your message. It is queued behind an earlier request in this thread.)`
      : `(${name} received your message and is starting work.)`);
    let timer, deadlineTimer;
    if (!r.fromAgent) {
      timer = setInterval(() => {
        if (closed || finished || now() - lastActivity < statusIntervalMs) return;
        // Reserve this interval even when the relay is slow or unavailable.
        lastActivity = now();
        const seconds = Math.floor((now() - receivedAt) / 1000);
        void status(active
          ? `(${name}: your request is still running after ${seconds}s. No new progress report yet; I will post the result here.)`
          : `(${name}: your request is still queued after ${seconds}s, waiting for the earlier request in this thread.)`);
      }, statusIntervalMs);
      timer.unref?.();
      statusTimers.add(timer);
    }
    const next = (previous ?? Promise.resolve()).then(async () => {
      await receipt;
      if (closed) return;
      if (ledger && now() - ledger.get(e.id).queuedAt >= queueTimeoutMs) {
        update(e.id, {state: 'failed', reason: 'queue_deadline_exceeded'}); return;
      }
      try { await beforeAnswer(r.channel); }
      catch (err) {
        // No model work has begun: retain the original deadline and budget reservation.
        if (ledger) {
          update(e.id, {state: 'queued', reason: 'visibility_check_retry'});
          seen.delete(e.id);
          log({event: 'buzz_visibility_retry', agent: name, error: String(err?.message || err).slice(0, 200)});
          return;
        }
        throw err;
      }
      if (closed) return;
      update(e.id, {state: 'started'});
      active = true;
      deadlineTimer = ledger && setTimeout(() => {
        update(e.id, {state: 'uncertain', reason: 'turn_deadline_exceeded_still_running'});
      }, turnTimeoutMs);
      deadlineTimer?.unref?.();
      const t0 = now();
      if (previous && !r.fromAgent) await status(`(${name} is now starting your queued request.)`);
      let text;
      try { text = await answer(e.content, { threadKey: r.threadKey, sessionId, event: e, onProgress: (r.fromAgent || ledger) ? async () => {} : text => post(text, true) }); }
      catch (err) { update(e.id, {outcome: 'model_failed'}); text = `(${name} could not answer: ${String(err?.message || err).slice(0, 300)})`; }
      finished = true;
      clearTimeout(deadlineTimer);
      clearInterval(timer);
      if (ledger && sendSigned && text) {
        const tags = [['h', r.channel], ['e', r.replyTo, '', 'reply']];
        // No recipient mention: delivery notifications/final replies must not create automatic agent loops.
        const outbox = signEvent(secretHex, {kind: 9, tags, content: text});
        const row = update(e.id, {state: 'answered', outbox});
        if (!closed) await publish(row);
      } else {
        if (closed) return;
        if (text) await post(text, true);
        update(e.id, {state: 'published'});
      }
      log({ event: "buzz_turn", agent: name, thread: r.threadKey.slice(0, 12), ms: now() - t0, chars: (text || "").length });
    }).catch((err) => {
      update(e.id, {state: active ? 'uncertain' : 'failed', reason: active ? 'turn_interrupted' : 'visibility_check_failed'});
      log({ event: "buzz_turn_error", agent: name, error: String(err?.message || err).slice(0, 200) });
    })
      .finally(() => { finished = true; clearTimeout(deadlineTimer); clearInterval(timer); statusTimers.delete(timer); });
    queues.set(r.threadKey, next);
    void next.finally(() => { if (queues.get(r.threadKey) === next) queues.delete(r.threadKey); });
  };
  const onMessage = (raw) => {
    let m; try { m = JSON.parse(typeof raw === "string" ? raw : raw.toString()); } catch { return; }
    if (closed || !Array.isArray(m)) return;
    if (m[0] === 'EOSE' && probeId && m[1] === probeId) {
      clearTimeout(heartbeatDeadline);
      ws.send(JSON.stringify(['CLOSE', probeId]));
      probeId = undefined;
    } else if (m[0] === "AUTH" && typeof m[1] === "string") {
      ws.send(JSON.stringify(["AUTH", signEvent(secretHex, { kind: 22242, tags: [["relay", url], ["challenge", m[1]]] })]));
    } else if (m[0] === "OK" && m[3] !== undefined && !authed) {
      if (m[2] === true) { authed = true; delay = 1000; subscribe(); recover(); log({ event: "buzz_connected", agent: name }); }
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
          if (isDm(tagValues(e, "p"), me) || (ownerPubkey && tagValues(e, "p").includes(ownerPubkey) &&
              tagValues(e, "p").filter(p => p !== ownerPubkey).every(p => p === me || agentsAllowed.has(p)) &&
              isDm(tagValues(e, "p").filter(p => p !== ownerPubkey), me))) dmChannels.add(d);
          else dmChannels.delete(d);
          if (!members.has(d)) { members.add(d); if (authed) subscribeChannel(d); }
        }
        if (e.kind === 39000 && (e.tags || []).some((t) => t[0] === "hidden" || (t[0] === "t" && t[1] === "dm"))) dmChannels.add(d);
        recover();
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
      reconnect();
    }
  };
  const open = () => {
    if (closed) return;
    authed = false;
    connectionSince = since;
    const socket = ws = new WebSocketImpl(url);
    let disconnected = false;
    reconnect = () => {
      if (closed || disconnected || socket !== ws) return;
      disconnected = true;
      clearInterval(heartbeatTimer); clearTimeout(heartbeatDeadline);
      probeId = undefined;
      // Do not wait for a close event: a half-open TCP connection may never emit one.
      try { socket.close(); } catch { /* already disconnected */ }
      log({ event: "buzz_reconnect", agent: name, in_ms: delay });
      reconnectTimer = setTimeout(open, delay); delay = Math.min(delay * 2, 60_000);
      // Keep a pending reconnect alive even after the old socket has fully closed.
    };
    const disconnect = reconnect;
    heartbeatDeadline = setTimeout(disconnect, heartbeatIntervalMs + heartbeatTimeoutMs);
    heartbeatDeadline.unref?.();
    heartbeatTimer = setInterval(() => {
      if (closed || disconnected || !authed || probeId) return;
      clearTimeout(heartbeatDeadline);
      probeId = `heartbeat:${++probeSequence}`;
      heartbeatDeadline = setTimeout(disconnect, heartbeatTimeoutMs);
      heartbeatDeadline.unref?.();
      // Nostr REQ/EOSE works with the native WebSocket API, which has no ping().
      // An impossible event ID avoids fetching channel history for a health check.
      try { socket.send(JSON.stringify(['REQ', probeId, {ids: ['0'.repeat(64)], limit: 1}])); }
      catch { disconnect(); }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    socket.addEventListener("message", (ev) => { if (!disconnected && socket === ws) onMessage(ev.data); });
    socket.addEventListener("close", disconnect);
    socket.addEventListener("error", disconnect);
  };
  open();
  return { me, drain: () => Promise.allSettled([...queues.values(), ...publications]), close() { closed = true; clearTimeout(reconnectTimer); clearInterval(heartbeatTimer); clearTimeout(heartbeatDeadline); clearInterval(retryTimer); for (const timer of statusTimers) clearInterval(timer); statusTimers.clear(); try { ws?.close(); } catch { /* already closed */ } } };
}
