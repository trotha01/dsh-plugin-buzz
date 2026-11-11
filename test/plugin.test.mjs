// The dsh wrapper's pure part. index.js imports dsh packages that exist only inside a dsh install, so the test
// registers tiny stand-ins for them before importing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { existsSync, readFileSync } from "node:fs";

register("data:text/javascript," + encodeURIComponent(`
  const stubs = {
    "@deepseek-ai/schemastery": "const s=()=>new Proxy(function(){},{get:(t,k)=>k==='then'?undefined:s,apply:()=>s()}); export default s();",
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
