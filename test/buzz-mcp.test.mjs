// node --test test/*.test.mjs      (no relay, no buzz binary: the CLI runner is replaced by a fake)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handle, setRunner, readKey, pubkeyOf, TOOLS } from "../buzz-mcp.mjs";

const SERVER = fileURLToPath(new URL("../buzz-mcp.mjs", import.meta.url));
const KEY = "0000000000000000000000000000000000000000000000000000000000000001";
const GEN_X = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";   // secp256k1 generator, x coordinate
const CH = "a6f725b6-ce62-477e-bb7c-3b041b00a32f", OTHER = "f".repeat(64), EV = "e".repeat(64);
let dir, calls, replies;
const call = async (name, args = {}) => (await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).result;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buzz-mcp-"));
  writeFileSync(join(dir, "a.key"), KEY + "\n", { mode: 0o600 });
  process.env.BUZZ_KEY_FILE = join(dir, "a.key");
  delete process.env.BUZZ_STATE_DIR;
  calls = [];
  replies = {
    "channels list": [{ channel_id: CH, name: "general", description: "" }],
    "users get": [{ pubkey: OTHER, display_name: "Mychal bot" }],
    "messages get": [{ id: EV, pubkey: OTHER, created_at: 1794364500, content: "hi there", tags: [["h", CH]] }],
    "messages send": { accepted: true, event_id: EV, message: "" },
    "feed get": [],
  };
  setRunner(async (args, stdin) => { calls.push({ args, stdin }); return JSON.stringify(replies[args.slice(0, 2).join(" ")] ?? null); });
});

test("public key is derived from the key file; the key itself never appears in a result", async () => {
  assert.equal(pubkeyOf(readKey(process.env.BUZZ_KEY_FILE)), GEN_X);
  replies["users get"] = [{ pubkey: GEN_X, display_name: "dsh (Trevor)" }];
  const r = await call("buzz_whoami");
  assert.match(r.content[0].text, /dsh \(Trevor\)/);
  assert.ok(r.content[0].text.includes(GEN_X));
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test("a key file readable by others is refused", async () => {
  chmodSync(process.env.BUZZ_KEY_FILE, 0o644);
  const r = await call("buzz_whoami");
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /chmod 600/);
});

test("nsec keys are accepted", () => {
  // nsec for secret key 1 (bech32 of 31 zero bytes and 0x01)
  writeFileSync(join(dir, "n.key"), "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsmhltgl\n", { mode: 0o600 });
  assert.equal(readKey(join(dir, "n.key")), KEY);
});

test("keygen writes a 0600 file once and prints only the public key", () => {
  const f = join(dir, "new.key");
  const out = execFileSync(process.execPath, [SERVER, "keygen", f], { encoding: "utf8" }).trim();
  assert.match(out, /^[0-9a-f]{64}$/);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const secret = readFileSync(f, "utf8").trim();
  assert.notEqual(out, secret);
  assert.equal(pubkeyOf(secret), out);
  assert.notEqual(spawnSync(process.execPath, [SERVER, "keygen", f]).status, 0);       // never overwrites
  assert.equal(readFileSync(f, "utf8").trim(), secret);
});

test("initialize negotiates a known version; tools are listed without internals", async () => {
  const init = (await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).result;
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.equal((await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } })).result.protocolVersion, "2025-11-25");
  const { tools } = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result;
  assert.deepEqual(tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.ok(tools.every((t) => t.inputSchema.type === "object" && !("run" in t)));
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal((await handle({ jsonrpc: "2.0", id: 3, method: "server/discover" })).error.code, -32601);
});

test("buzz_read resolves a channel name and shows author names and ids", async () => {
  const r = await call("buzz_read", { channel: "#General", limit: 5 });
  assert.match(r.content[0].text, /Mychal bot \(ffffffff\): hi there/);
  assert.ok(r.content[0].text.includes(`id=${EV}`) && r.content[0].text.includes("channel=#general"));
  const get = calls.find((c) => c.args[1] === "get" && c.args[0] === "messages");
  assert.deepEqual(get.args, ["messages", "get", "--channel", CH, "--limit", "5"]);
});

test("buzz_send passes the text on stdin, never as an argument, and validates ids", async () => {
  const text = '--private-key x; "quoted" $(rm -rf /)';
  const r = await call("buzz_send", { channel: CH, content: text, reply_to: EV, mentions: ["Mychal bot", OTHER] });
  assert.match(r.content[0].text, new RegExp(`sent\\. id=${EV}`));
  const send = calls.find((c) => c.args[1] === "send");
  assert.equal(send.stdin, text);
  assert.ok(!send.args.includes(text));
  assert.deepEqual(send.args, ["messages", "send", "--channel", CH, "--content", "-", "--reply-to", EV, "--mention", OTHER, "--mention", OTHER]);
  for (const bad of [{ channel: CH, content: "x", reply_to: "--broadcast" }, { channel: "--relay", content: "x" }, { channel: CH, content: "  " }])
    assert.equal((await call("buzz_send", bad)).isError, true);
  assert.equal(calls.filter((c) => c.args[1] === "send").length, 1);
});

test("a refused message is an error, not a fake success", async () => {
  replies["messages send"] = { accepted: false, message: "restricted: not a member" };
  const r = await call("buzz_send", { channel: CH, content: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not a member/);
});

test("send requires a valid acknowledgement before reporting success", async () => {
  for (const response of [null, {}, { accepted: true }, { event_id: "bad" }]) {
    replies["messages send"] = response;
    const r = await call("buzz_send", { channel: CH, content: "hello" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /delivery is unconfirmed/);
  }
  replies["messages send"] = { accepted: true, id: EV };
  assert.equal((await call("buzz_send", { channel: CH, content: "hello" })).content[0].text, `sent. id=${EV}`);
});

test("buzz_mentions shows each mention once and remembers its place in a 0600 file", async () => {
  replies["feed get"] = [{ id: EV, pubkey: OTHER, created_at: 1794364500, content: "@dsh ping", tags: [["h", CH]] },
                         { id: "d".repeat(64), pubkey: GEN_X, created_at: 1794364600, content: "my own message", tags: [] }];
  const first = await call("buzz_mentions");
  assert.match(first.content[0].text, /@dsh ping/);
  assert.ok(!first.content[0].text.includes("my own message"));
  const cur = join(dir, "a.cursor");
  assert.equal(readFileSync(cur, "utf8").trim(), "1794364500");
  assert.equal(statSync(cur).mode & 0o777, 0o600);
  assert.equal((await call("buzz_mentions")).content[0].text, "(no new mentions)");
  assert.ok(calls.at(-1).args.includes("--since"));
  assert.match((await call("buzz_mentions", { new_only: false })).content[0].text, /@dsh ping/);
});

test("CLI failures come back as tool errors", async () => {
  setRunner(async () => { throw new Error("auth_error: not a relay member"); });
  const r = await call("buzz_channels");
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not a relay member/);
  assert.equal((await handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "nope" } })).error.code, -32602);
});

test("invalid secret scalars and corrupted nsec checksums fail before contacting the relay", () => {
  for (const key of ["0".repeat(64), "f".repeat(64), "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsmhltgq", "nsec1x"]) {
    writeFileSync(process.env.BUZZ_KEY_FILE, key);
    assert.throws(() => readKey(process.env.BUZZ_KEY_FILE), /range|nsec/);
  }
});

test("doctor checks a key and authenticated channel reads without sending messages", () => {
  const cli = join(dir, "fake buzz");
  writeFileSync(cli, `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.slice(0,4).join(' ') !== '--format agent channels list') process.exit(9);\nconsole.log(JSON.stringify([{channel_id: '${CH}', name: 'general'}]));\n`, { mode: 0o700 });
  const env = { ...process.env, BUZZ_CLI: cli, BUZZ_RELAY_URL: "https://relay.example" };
  const result = spawnSync(process.execPath, [SERVER, "doctor"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.pubkey, GEN_X);
  assert.deepEqual(data.joinedChannels, [{ id: CH, name: "general" }]);
  assert.ok(!result.stdout.includes(KEY));
  const missing = spawnSync(process.execPath, [SERVER, "doctor"], { env: { ...env, BUZZ_CLI: join(dir, "missing") }, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /CLI was not found/);
  const badUrl = spawnSync(process.execPath, [SERVER, "doctor"], { env: { ...env, BUZZ_RELAY_URL: "https://" }, encoding: "utf8" });
  assert.equal(badUrl.status, 1);
  assert.match(badUrl.stderr, /valid http/);
});
