// dsh-plugin-buzz: mounts the Buzz MCP server shipped in this package (buzz-mcp.mjs) through dsh's MCP client,
// so agents get mcp__<serverName>__buzz_send, buzz_read, buzz_mentions, ... as their own Buzz identity.
// Plain ESM, no build step. Settings come from the row's config, else from the environment dsh runs in.
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'

export const name = 'buzz'
export const inject = ['tools']

export const Config = Schema.object({
  keyFile: Schema.string().default('').description('File with this agent\'s Buzz (Nostr) secret key, mode 0600. Default: $BUZZ_KEY_FILE'),
  relayUrl: Schema.string().default('').description('Your Buzz relay, e.g. https://buzz.example.com. Default: $BUZZ_RELAY_URL'),
  cliPath: Schema.string().default('').description('Path of the buzz CLI. Default: $BUZZ_CLI, else the copy inside the Buzz desktop app, else buzz on PATH'),
  serverName: Schema.string().default('buzz').description('Tool namespace: tools appear as mcp__<serverName>__buzz_send'),
})

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

export async function apply(ctx, config) {
  const row = resolve(config)
  if (typeof row === 'string') {
    const log = ctx.logger?.('buzz')
    const msg = `dsh-plugin-buzz is installed but idle: ${row}`
    log?.warn ? log.warn(msg) : console.warn(`[buzz] ${msg}`)
    return
  }
  await ctx.plugin(mcpClient, row)
}
