#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signEvent, verifyEvent, wsUrl } from "./listen.mjs";

const HEX64 = /^[0-9a-f]{64}$/;

/** Subscribe to a Buzz relay and write verified events as JSON lines. */
export function watch({ relayUrl, secretHex, filters = [], since, WebSocketImpl = globalThis.WebSocket,
  out = process.stdout, log = () => {}, heartbeatIntervalMs = 30_000, heartbeatTimeoutMs = 10_000 }) {
  if (!WebSocketImpl) throw new Error("WebSocket is not available");
  const url = wsUrl(relayUrl);
  const baseSince = Number.isSafeInteger(since) ? Math.max(0, since) : Math.max(0, Math.floor(Date.now() / 1000) - 60);
  const seen = new Set();
  let lastSeen, ws, reconnectTimer, heartbeatTimer, heartbeatDeadline, probeId;
  let closed = false, delay = 1000, sequence = 0;

  const line = (value) => {
    if (closed) return;
    try { out.write(`${JSON.stringify(value)}\n`); }
    catch (err) { if (err?.code === "EPIPE") stop(); else throw err; }
  };
  const subscriptionFilters = () => filters.map(filter => ({
    ...filter,
    since: Math.max(0, lastSeen === undefined ? baseSince : lastSeen - 60),
  }));

  function open() {
    if (closed) return;
    const socket = ws = new WebSocketImpl(url);
    const subId = `buzz-watch:${++sequence}`;
    let disconnected = false, eose = false, authPending = false;
    const sendReq = () => socket.send(JSON.stringify(["REQ", subId, ...subscriptionFilters()]));
    const disconnect = () => {
      if (closed || disconnected || socket !== ws) return;
      disconnected = true;
      clearInterval(heartbeatTimer); clearTimeout(heartbeatDeadline);
      probeId = undefined;
      try { socket.close(); } catch { /* already closed */ }
      log({ event: "buzz_watch_reconnect", in_ms: delay });
      reconnectTimer = setTimeout(open, delay); // stays ref'd: the process must live until it reconnects
      delay = Math.min(delay * 2, 30_000);
    };
    const armInitialDeadline = () => {
      clearTimeout(heartbeatDeadline);
      heartbeatDeadline = setTimeout(disconnect, heartbeatIntervalMs + heartbeatTimeoutMs);
      heartbeatDeadline.unref?.();
    };
    const startHeartbeat = () => {
      armInitialDeadline();
      heartbeatTimer = setInterval(() => {
        if (closed || disconnected || probeId) return;
        clearTimeout(heartbeatDeadline);
        probeId = `buzz-watch-heartbeat:${++sequence}`;
        heartbeatDeadline = setTimeout(disconnect, heartbeatTimeoutMs);
        heartbeatDeadline.unref?.();
        try { socket.send(JSON.stringify(["REQ", probeId, { ids: ["0".repeat(64)], limit: 1 }])); }
        catch { disconnect(); }
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    };
    socket.addEventListener("open", () => {
      if (disconnected || socket !== ws) return;
      try { sendReq(); startHeartbeat(); } catch { disconnect(); }
    });
    socket.addEventListener("message", (ev) => {
      if (disconnected || socket !== ws) return;
      let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch { return; }
      if (!Array.isArray(m)) return;
      if (m[0] === "AUTH" && typeof m[1] === "string") {
        authPending = true;
        socket.send(JSON.stringify(["AUTH", signEvent(secretHex, { kind: 22242, tags: [["relay", url], ["challenge", m[1]]] })]));
      } else if (m[0] === "OK" && authPending) {
        if (m[2] === true) { authPending = false; delay = 1000; sendReq(); }
      } else if (m[0] === "CLOSED" && m[1] === subId) {
        const reason = String(m[2] || "");
        if (/auth/i.test(reason)) authPending = true;
        else disconnect();
      } else if (m[0] === "EOSE" && m[1] === probeId) {
        clearTimeout(heartbeatDeadline);
        socket.send(JSON.stringify(["CLOSE", probeId]));
        probeId = undefined;
        armInitialDeadline();
      } else if (m[0] === "EOSE" && m[1] === subId && !eose) {
        eose = true; line({ type: "eose" });
      } else if (m[0] === "EVENT" && m[1] === subId && verifyEvent(m[2])) {
        const event = m[2];
        if (seen.has(event.id)) return;
        seen.add(event.id); while (seen.size > 5000) seen.delete(seen.values().next().value);
        lastSeen = Math.max(lastSeen ?? event.created_at, event.created_at);
        line(event);
      }
    });
    socket.addEventListener("close", disconnect);
    socket.addEventListener("error", disconnect);
  }

  const onPipeError = (err) => { if (err?.code === "EPIPE") stop(); };
  out.on?.("error", onPipeError);
  function stop() {
    if (closed) return;
    closed = true;
    clearTimeout(reconnectTimer); clearInterval(heartbeatTimer); clearTimeout(heartbeatDeadline);
    out.off?.("error", onPipeError);
    try { ws?.close(); } catch { /* already closed */ }
  }
  open();
  return { close: stop };
}

function cli() {
  const channels = [], authors = [];
  let since;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const value = args[++i];
    if (!value) throw new Error(`${args[i - 1]} requires a value`);
    if (args[i - 1] === "--channel") channels.push(value);
    else if (args[i - 1] === "--author") authors.push(value);
    else if (args[i - 1] === "--since") { since = Number(value); if (!Number.isSafeInteger(since) || since < 0) throw new Error("--since must be a non-negative integer"); }
    else throw new Error(`unknown option: ${args[i - 1]}`);
  }
  const relayUrl = process.env.BUZZ_RELAY_URL;
  if (!relayUrl) throw new Error("BUZZ_RELAY_URL is not set");
  let secretHex = process.env.BUZZ_PRIVATE_KEY?.trim().toLowerCase();
  if (!secretHex && process.env.BUZZ_KEY_FILE) secretHex = readFileSync(process.env.BUZZ_KEY_FILE, "utf8").trim().split(/\s+/).pop()?.toLowerCase();
  if (!HEX64.test(secretHex || "")) throw new Error("BUZZ_PRIVATE_KEY or BUZZ_KEY_FILE must contain a 64-character hex key");
  const filter = { kinds: [9] };
  if (channels.length) filter["#h"] = channels;
  if (authors.length) filter.authors = authors;
  const watcher = watch({ relayUrl, secretHex, filters: [filter], since });
  const stop = () => watcher.close();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try { cli(); } catch (err) { process.stderr.write(`buzz-watch: ${err.message}\n`); process.exitCode = 1; }
}
