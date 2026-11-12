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
import { readKey, pubkeyOf, cliPath, cliEnv, validateRelay, ensureOwner, TOOLS, withIdentity } from './buzz-mcp.mjs'
import { listen } from './listen.mjs'
import { makeAnswerer } from './agent-turn.mjs'
import { eventImages } from './media.mjs'
import { RequestController, requestPrompt } from './requests.mjs'
import { requestTransport, requestTools } from './request-transport.mjs'

export const name = 'buzz'
export const inject = ['tools']

const HEX64 = /^[0-9a-f]{64}$/

export const Config = Schema.object({
  keyFile: Schema.string().default('').description('File with this agent\'s Buzz (Nostr) secret key, mode 0600. Default: $BUZZ_KEY_FILE'),
  relayUrl: Schema.string().default('').description('Your Buzz relay, e.g. https://buzz.example.com. Default: $BUZZ_RELAY_URL'),
  cliPath: Schema.string().default('').description('Path of the buzz CLI. Default: $BUZZ_CLI, else the copy inside the Buzz desktop app, else buzz on PATH'),
  serverName: Schema.string().default('buzz').description('Tool namespace: tools appear as mcp__<serverName>__buzz_send'),
  ownerPubkey: Schema.string().default('').description('Human owner public key. Added to every conversation before agent messages are sent; sends fail closed if membership cannot be confirmed. Default: $BUZZ_OWNER_PUBKEY'),
  allowFrom: Schema.array(Schema.string()).default([]).description('Buzz public keys (64-character hex) whose messages the agents below answer. Empty: they answer nobody'),
  allowAgents: Schema.array(Schema.string()).default([]).description('Other agent public keys recognized for owner-visible DMs. Automatic mention replies apply only in legacy mode'),
  explicitRequests: Schema.boolean().default(true).description('Use explicit, durable agent requests instead of automatic agent replies'),
  requestStore: Schema.string().default('').description('SQLite request ledger path; defaults beside the first agent key'),
  maxAgentReplies: Schema.natural().default(10).description('Shared request budget per originating human event (maximum 10); legacy mode uses per-thread reply caps'),
  cwd: Schema.string().default('').description('Working directory of the dsh conversations started from Buzz. Default: where dsh runs'),
  agents: Schema.array(Schema.object({
    name: Schema.string().required().description('Label for logs and Session ids, e.g. Claude'),
    keyFile: Schema.string().required().description('This identity\'s Buzz secret key file, mode 0600'),
    provider: Schema.string().required().description('dsh provider id, as in the model picker settings'),
    model: Schema.string().required().description('dsh model id of that provider'),
    cwd: Schema.string().default('').description('Working directory for new conversations with this identity. Overrides the shared cwd; use a separate directory per agent'),
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
  try { validateRelay(relayUrl) } catch (e) { return e.message }
  const childEnv = { BUZZ_KEY_FILE: keyFile, BUZZ_RELAY_URL: relayUrl }
  const owner = config.ownerPubkey || env.BUZZ_OWNER_PUBKEY || ''
  if (owner && !HEX64.test(owner)) return 'ownerPubkey must be a 64-character hex public key'
  if (owner) childEnv.BUZZ_OWNER_PUBKEY = owner
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

/** Check owner membership using the sending identity, without exposing its secret key. */
export function makeVisibilityGuard({ relayUrl, keyFile, cli, ownerPubkey }) {
  return channel => ensureOwner(channel, ownerPubkey, args => new Promise((resolve, reject) => {
    execFile(cli || cliPath(), ['--format', 'agent', ...args], {
      env: { ...cliEnv(readKey(keyFile)), BUZZ_RELAY_URL: relayUrl }, timeout: 45_000, maxBuffer: 8 << 20,
    }, (err, out) => {
      if (err) return reject(new Error('Cannot include conversation owner; Buzz message blocked'))
      try { resolve(JSON.parse(out)) } catch { reject(new Error('Cannot verify conversation owner; Buzz message blocked')) }
    })
  }))
}

export function makeSender({ relayUrl, keyFile, cli, ownerPubkey }) {
  const guard = makeVisibilityGuard({ relayUrl, keyFile, cli, ownerPubkey })
  return async ({ channel, replyTo, mention, text }) => {
    await guard(channel)
    return new Promise((resolve, reject) => {
      const key = readKey(keyFile)
      const env = { ...cliEnv(key), BUZZ_RELAY_URL: relayUrl }
      const args = ['--format', 'agent', 'messages', 'send', '--channel', channel, '--content', '-', '--reply-to', replyTo]
      if (mention && HEX64.test(mention)) args.push('--mention', mention)
      const child = execFile(cli || cliPath(), args, { env, timeout: 45_000, maxBuffer: 8 << 20 }, (err, out) => {
        if (err) return reject(new Error(err.code === 'ENOENT' ? 'the buzz CLI was not found; set cliPath or BUZZ_CLI' : 'Buzz reply failed; check relay access and channel membership'))
        try {
          const j = JSON.parse(out)
          const id = j?.event_id ?? j?.id
          if (j?.accepted === false || !HEX64.test(id || '')) throw new Error()
          resolve(id)
        } catch { reject(new Error('Buzz reply was refused or returned no valid message id; check channel membership')) }
      })
      child.stdin.on('error', () => {})
      child.stdin.end(text)
    })
  }
}

/** Bind credentials from the actual calling agent, never a model-supplied identity argument. */
export function registerIdentityTools(ctx, row, identities, agentPubkeys) {
  for (const tool of TOOLS) ctx.tools.register({
    name: `mcp__${row.serverName}__${tool.name}`,
    description: tool.description,
    parameters: tool.inputSchema,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (args, exec) => {
      const identity = identities.get(exec.agent)
      if (!identity)
        throw new Error('Buzz identity is not bound to this conversation; send a new message in Buzz before using its tools')
      return withIdentity(identity, () => tool.run(args))
    },
  })
}

async function dshDeps() {
  const [{ createUserMessage }, { installModelSelection }, { brandString }, { SessionSeq }] = await Promise.all([
    import('@deepseek-ai/dsh-llm'), import('@deepseek-ai/dsh-agent'), import('@deepseek-ai/dsh-brand'), import('@deepseek-ai/dsh-session'),
  ])
  return { createUserMessage, installModelSelection, brandString, SessionSeq }
}

export async function apply(ctx, config = {}) {
  const log = ctx.logger?.('buzz')
  const say = (msg) => (log?.info ? log.info(msg) : console.log(`[buzz] ${msg}`))
  const warn = (msg) => (log?.warn ? log.warn(msg) : console.warn(`[buzz] ${msg}`))

  const row = resolve(config)
  if (typeof row === 'string') warn(`dsh-plugin-buzz tools are idle: ${row}`)
  else if (!(config.agents || []).length) await ctx.plugin(mcpClient, row)

  const ownerPubkey = config.ownerPubkey || process.env.BUZZ_OWNER_PUBKEY || ''
  if (ownerPubkey && !HEX64.test(ownerPubkey)) return warn('Buzz agents are idle: invalid ownerPubkey')
  const agents = config.agents || []
  if (!agents.length) return
  const relayUrl = config.relayUrl || process.env.BUZZ_RELAY_URL || ''
  try { validateRelay(relayUrl) } catch (e) { return warn(`Buzz agents are idle: ${e.message}`) }
  const allowFrom = (config.allowFrom || []).map((s) => s.trim().toLowerCase()).filter((s) => HEX64.test(s))
  if (!allowFrom.length) warn('Buzz agents answer no humans until allowFrom lists at least one public key')
  if (allowFrom.length !== (config.allowFrom || []).length) warn('Invalid allowFrom entries ignored: use 64-character hex public keys, not names or npub strings')
  const deps = await dshDeps()
  const cli = config.cliPath || process.env.BUZZ_CLI || ''
  const cwd = config.cwd || process.cwd()
  const live = []
  const keys = new Map()
  const usedNames = new Set(), usedKeys = new Set()
  for (const a of agents) {
    try {
      const key = readKey(a.keyFile), pubkey = pubkeyOf(key)
      if (usedNames.has(a.name) || usedKeys.has(pubkey)) throw new Error('duplicate agent name or key; give each live agent a unique name and key')
      usedNames.add(a.name); usedKeys.add(pubkey); keys.set(a, key)
    } catch (e) { warn(`Buzz agent ${a.name} is idle: ${e.message}`) }
  }
  // Own identities may @mention each other; other agents only if listed. Humans in allowFrom are never capped.
  const allowAgents = [...new Set([...(config.allowAgents || []).map((s) => s.trim().toLowerCase()).filter((s) => HEX64.test(s)),
    ...[...keys.values()].map(pubkeyOf)])]
  const identities = new WeakMap()
  if (typeof row !== 'string') registerIdentityTools(ctx, row, identities, allowAgents)
  const maxAgentReplies = Number.isInteger(config.maxAgentReplies) ? config.maxAgentReplies : 10
  const explicitRequests = config.explicitRequests !== false
  const configured = new Map([...keys].map(([a, key]) => [pubkeyOf(key), {
    ...(typeof row === 'string' ? {} : row.env), name: a.name, BUZZ_KEY_FILE: a.keyFile,
    BUZZ_RELAY_URL: relayUrl, BUZZ_CLI: cli, BUZZ_OWNER_PUBKEY: ownerPubkey, agentPubkeys: allowAgents,
  }]))
  const answerers = new Map()
  let controller
  for (const [a, key] of keys) {
    const actor = pubkeyOf(key)
    answerers.set(actor, makeAnswerer(ctx, { ...a, cwd: a.cwd || cwd }, { ...deps,
      bindIdentity: (agent, event, requestContext) => identities.set(agent, {
        ...configured.get(actor), requestContext, requestController: controller, replyOnly: !explicitRequests && allowAgents.includes(event?.pubkey),
      }), images: event => eventImages(event, { secretHex: key, relayUrl }),
    }))
  }
  if (explicitRequests && ownerPubkey && keys.size) {
    controller = new RequestController({
      file: config.requestStore || `${[...keys.keys()][0].keyFile}.requests.sqlite`,
      transport: requestTransport(configured), limit: maxAgentReplies, log: warn,
      run: (binding, { kind, snapshot }) => answerers.get(binding.actor)('', {
        threadKey: binding.threadKey || `request:${binding.exchange}:${binding.requestId || 'caller'}`,
        requestContext: binding, runtimePrompt: requestPrompt(kind, snapshot),
        beforeTurn: async () => { controller.assertActive(binding); await controller.inspect(binding, snapshot.request?.id); },
      }),
    })
    for (const tool of requestTools(controller)) ctx.tools.register({
      name: `mcp__${config.serverName || 'buzz'}__${tool.name}`, description: tool.description,
      parameters: tool.inputSchema,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (args, exec) => {
        const binding = identities.get(exec.agent)?.requestContext
        if (!binding) throw new Error('No bound Buzz request context; start from your owner DM')
        return JSON.stringify(await tool.run(args, binding))
      },
    })
    controller.kick()
  } else if (explicitRequests) warn('Agent requests require a configured human owner; automatic agent replies are disabled')
  for (const a of agents) {
    const secretHex = keys.get(a)
    if (!secretHex) continue
    const actor = pubkeyOf(secretHex)
    const conn = listen({
      name: a.name, relayUrl, secretHex, allowFrom, allowAgents, maxAgentReplies, ownerPubkey, explicitRequests,
      beforeAnswer: makeVisibilityGuard({ relayUrl, keyFile: a.keyFile, cli, ownerPubkey }),
      answer: async (text, options) => {
        if (!controller) return answerers.get(actor)(text, options)
        const binding = controller.start({ actor, owner: ownerPubkey, origin: options.event.id, threadKey: options.threadKey,
          channel: options.event.tags.find(t => t[0] === 'h')[1], replyTo: options.event.id, human: options.event.pubkey === ownerPubkey })
        const snapshot = await controller.inspect(binding)
        const result = await answerers.get(actor)(text, { ...options, onProgress: undefined,
          requestContext: binding, runtimePrompt: requestPrompt('human', snapshot) + '\n\nHuman message:\n' })
        const output = await controller.finish(binding, result)
        return output?.text || ''
      },
      send: makeSender({ relayUrl, keyFile: a.keyFile, cli, ownerPubkey }),
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
  ctx.on?.('dispose', () => { void controller?.close(); for (const c of live) { c.close(); if (LISTENERS.get(c.me) === c) LISTENERS.delete(c.me) } })
}
