// dsh-plugin-buzz: (1) mounts the Buzz MCP server shipped in this package (buzz-mcp.mjs) through dsh's MCP client,
// so agents get mcp__<serverName>__buzz_send, buzz_read, buzz_mentions, ... as their own Buzz identity; and
// (2) optionally puts dsh models in Buzz as their own users: each entry of `agents` keeps a live connection to the
// relay and answers your messages to it right away (push, no polling) with a fixed dsh provider/model.
// Plain ESM, no build step. Settings come from the row's config, else from the environment dsh runs in.
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { readKey, pubkeyOf, cliPath, cliEnv } from './buzz-mcp.mjs'
import { listen } from './listen.mjs'
import { makeAnswerer } from './agent-turn.mjs'

export const name = 'buzz'
export const inject = ['tools']

const HEX64 = /^[0-9a-f]{64}$/

export const Config = Schema.object({
  keyFile: Schema.string().default('').description('File with this agent\'s Buzz (Nostr) secret key, mode 0600. Default: $BUZZ_KEY_FILE'),
  relayUrl: Schema.string().default('').description('Your Buzz relay, e.g. https://buzz.example.com. Default: $BUZZ_RELAY_URL'),
  cliPath: Schema.string().default('').description('Path of the buzz CLI. Default: $BUZZ_CLI, else the copy inside the Buzz desktop app, else buzz on PATH'),
  serverName: Schema.string().default('buzz').description('Tool namespace: tools appear as mcp__<serverName>__buzz_send'),
  allowFrom: Schema.array(Schema.string()).default([]).description('Buzz public keys (64-character hex) whose messages the agents below answer. Empty: they answer nobody'),
  allowAgents: Schema.array(Schema.string()).default([]).description('Public keys of other agents (e.g. a colleague\'s models) the agents below answer, but only when that agent @mentions them. The agents below always accept each other this way'),
  maxAgentReplies: Schema.natural().default(5).description('Loop guard: at most this many replies to agents per Buzz thread, per identity'),
  cwd: Schema.string().default('').description('Working directory of the dsh conversations started from Buzz. Default: where dsh runs'),
  agents: Schema.array(Schema.object({
    name: Schema.string().required().description('Label for logs and Session ids, e.g. Claude'),
    keyFile: Schema.string().required().description('This identity\'s Buzz secret key file, mode 0600'),
    provider: Schema.string().required().description('dsh provider id, as in the model picker settings'),
    model: Schema.string().required().description('dsh model id of that provider'),
    instructions: Schema.string().default('').description('Text put before every message to this identity, e.g. "Pass the message to subagent_codex unchanged and reply with its answer."'),
  })).default([]).description('dsh models that live in Buzz as their own users. Mention one, DM it, or reply in its thread: it answers at once'),
})

const LISTENERS = (globalThis.__dshPluginBuzzListeners ??= new Map())   // pubkey -> live connection, shared across reloads

export const SERVER = fileURLToPath(new URL('./buzz-mcp.mjs', import.meta.url))

/** The MCP client row this plugin mounts, or a string saying what is missing. Pure, for tests. */
export function resolve(config = {}, env = process.env) {
  const keyFile = config.keyFile || env.BUZZ_KEY_FILE || ''
  const relayUrl = config.relayUrl || env.BUZZ_RELAY_URL || ''
  const cliPath = config.cliPath || env.BUZZ_CLI || ''
  if (!keyFile) return 'no key file: set BUZZ_KEY_FILE (or keyFile in the row config) to the agent\'s key file'
  if (!relayUrl) return 'no relay: set BUZZ_RELAY_URL (or relayUrl in the row config) to your Buzz relay address'
  if (!/^https?:\/\//.test(relayUrl)) return `relayUrl must start with http:// or https:// (got ${relayUrl})`
  const childEnv = { BUZZ_KEY_FILE: keyFile, BUZZ_RELAY_URL: relayUrl }
  if (cliPath) childEnv.BUZZ_CLI = cliPath
  return {
    serverName: config.serverName || 'buzz',
    transport: 'stdio',
    command: process.execPath,          // the same Node that runs dsh
    args: [SERVER],
    env: childEnv,
  }
}

/** Thread memory for one identity: <keyFile>.threads.json beside the key (0600), so it survives restarts. */
export function threadStore(keyFile) {
  const file = `${keyFile}.threads.json`
  return {
    load() { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} } },
    save(obj) { try { writeFileSync(`${file}.tmp`, JSON.stringify(obj), { mode: 0o600 }); renameSync(`${file}.tmp`, file) } catch { /* memory only */ } },
  }
}

/** Post a reply as one identity through the buzz CLI; resolves to the new message id (or undefined). */
export function makeSender({ relayUrl, keyFile, cli }) {
  return ({ channel, replyTo, mention, text }) => new Promise((resolve) => {
    const key = readKey(keyFile)
    const env = { ...cliEnv(key), BUZZ_RELAY_URL: relayUrl }
    const args = ['--format', 'agent', 'messages', 'send', '--channel', channel, '--content', '-', '--reply-to', replyTo]
    if (mention && HEX64.test(mention)) args.push('--mention', mention)
    const child = execFile(cli || cliPath(), args, { env, timeout: 45_000, maxBuffer: 8 << 20 }, (err, out) => {
      if (err) return resolve(undefined)
      try { const j = JSON.parse(out); resolve(j?.event_id ?? j?.id) } catch { resolve(undefined) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(text)
  })
}

async function dshDeps() {
  const [{ createUserMessage }, { installModelSelection }, { brandString }, { SessionSeq }] = await Promise.all([
    import('@deepseek-ai/dsh-llm'), import('@deepseek-ai/dsh-agent'), import('@deepseek-ai/dsh-brand'), import('@deepseek-ai/dsh-session'),
  ])
  return { createUserMessage, installModelSelection, brandString, SessionSeq }
}

export async function apply(ctx, config) {
  const log = ctx.logger?.('buzz')
  const say = (msg) => (log?.info ? log.info(msg) : console.log(`[buzz] ${msg}`))
  const warn = (msg) => (log?.warn ? log.warn(msg) : console.warn(`[buzz] ${msg}`))

  const row = resolve(config)
  if (typeof row === 'string') warn(`dsh-plugin-buzz tools are idle: ${row}`)
  else await ctx.plugin(mcpClient, row)

  const agents = config.agents || []
  if (!agents.length) return
  const relayUrl = config.relayUrl || process.env.BUZZ_RELAY_URL || ''
  if (!/^https?:\/\//.test(relayUrl)) return warn('Buzz agents are idle: set relayUrl (https://...)')
  const allowFrom = (config.allowFrom || []).map((s) => s.trim().toLowerCase()).filter((s) => HEX64.test(s))
  if (!allowFrom.length) warn('Buzz agents answer nobody until allowFrom lists at least one public key')
  const deps = await dshDeps()
  const cli = config.cliPath || process.env.BUZZ_CLI || ''
  const cwd = config.cwd || process.cwd()
  const live = []
  const keys = new Map()
  for (const a of agents) {
    try { keys.set(a.name, readKey(a.keyFile)) } catch (e) { warn(`Buzz agent ${a.name} is idle: ${e.message}`) }
  }
  // Own identities may @mention each other; other agents only if listed. Humans in allowFrom are never capped.
  const allowAgents = [...new Set([...(config.allowAgents || []).map((s) => s.trim().toLowerCase()).filter((s) => HEX64.test(s)),
    ...[...keys.values()].map(pubkeyOf)])]
  const maxAgentReplies = Number.isInteger(config.maxAgentReplies) ? config.maxAgentReplies : 5
  for (const a of agents) {
    const secretHex = keys.get(a.name)
    if (!secretHex) continue
    const conn = listen({
      name: a.name, relayUrl, secretHex, allowFrom, allowAgents, maxAgentReplies,
      answer: makeAnswerer(ctx, { ...a, cwd }, deps),
      send: makeSender({ relayUrl, keyFile: a.keyFile, cli }),
      store: threadStore(a.keyFile),
      log: (o) => say(JSON.stringify(o)),
    })
    // A config reload can apply this plugin again without disposing the old instance; one listener per identity per
    // process, or every message is answered twice.
    LISTENERS.get(conn.me)?.close()
    LISTENERS.set(conn.me, conn)
    say(`Buzz agent ${a.name} (${a.provider}/${a.model}) listening as ${conn.me}`)
    live.push(conn)
  }
  ctx.on?.('dispose', () => { for (const c of live) { c.close(); if (LISTENERS.get(c.me) === c) LISTENERS.delete(c.me) } })
}
