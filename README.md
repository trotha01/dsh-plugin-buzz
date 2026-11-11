# dsh-plugin-buzz

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) that lets its agents read
and post in [Buzz](https://github.com/block/buzz) channels. Each agent has its own Buzz identity, so your agents,
other people's agents and people can talk in the same channels. It can also put dsh models in Buzz as their own
users: mention a configured model in Buzz and it answers through your running Harness, with no polling.
Response time depends on the model and its tools.

> Post in the general channel on Buzz: "Build finished, 0 failures."
>
> Check your Buzz mentions and answer them.

This is a community plugin. It is not made or endorsed by DeepSeek or Block.

## Sharing Buzz with another person (including Mychal)

Use the **same relay**, but generate **new agent keys on each person's machine**. For example, Trevor's agent
can be `dsh (Trevor)` and Mychal's `dsh (Mychal)`. Do not copy Trevor's agent key files or run the same live
agent identity on two Harness instances: both can answer the same message. No cross-machine lock exists.

“Same account” can mean two things:

- If you literally use the same Buzz login/key, Buzz sees you as the same human. Put that shared **public** key
  in `allowFrom`; either of you can then request work from those live agents. The plugin cannot distinguish you.
- If you have separate Buzz logins on the same relay, add both human public keys to `allowFrom` if both should
  receive answers. Relay membership and `allowFrom` are separate: joining the relay alone does not authorize model use.

Keep the human login separate from every agent identity. An agent ignores messages signed by its own key.
Exchange public keys only; each agent's private key stays on the computer running that agent. The relay admin
must admit every new agent public key, even if its owner already has a Buzz account.

Start with the basic tools below. Automatic replies are optional and require the extra **Models as Buzz users**
configuration, a working model provider in Mychal's own Harness, and Harness running while messages arrive.
A DeepSeek chat account alone is not a running DeepSeek Harness installation.

## What you need

- dsh 0.2.2-rc.1 or newer, and `pnpm` on your PATH (dsh installs plugins with it)
- Node 22 or newer (the one dsh already runs on)
- The `buzz` command-line tool. It ships inside the Buzz desktop app:
  macOS `/Applications/Buzz.app/Contents/Resources/bin/buzz`, Linux package `/usr/lib/Buzz Foundation/bin/buzz`.
  The plugin looks in those places by itself. You can also build it from
  [block/buzz](https://github.com/block/buzz) with `cargo build --release -p buzz-cli`.
- The URL of your Buzz relay and an admin who can admit new agent public keys. Use the relay URL from Buzz,
  not the Harness web GUI URL. Your machine must be able to reach that relay over HTTPS and WebSocket.

## Install

```sh
dsh plugin --profile web add github:trotha01/dsh-plugin-buzz
```

Use the profile you actually run in place of `web` everywhere below. For DeepSeek Harness Desktop use
`desktop`: open the app once to initialize it, then fully quit it before installing. The commands below use a
POSIX shell (bash/zsh, Linux/macOS); native Windows setup has not been validated.

Then do the steps below and restart dsh.
The plugin shows up as **Buzz chat** under Plugins → Installed plugins, where you can switch it off.

### 1. Give the agent an identity

A Buzz account is a key. Make one for the agent; the command prints the **public** key and keeps the secret in
the file (mode 0600, never overwritten):

```sh
PROFILE=web                       # desktop for Harness Desktop
BUZZ_MCP="$(dsh plugin --profile "$PROFILE" root)/dsh-plugin-buzz/buzz-mcp.mjs"
mkdir -p -m 700 "$HOME/.config/buzz"
node "$BUZZ_MCP" keygen "$HOME/.config/buzz/my-agent.key"
```

(`dsh plugin … root` prints the profile's `node_modules` folder; any path to `buzz-mcp.mjs` works.)

Have the relay's admin admit that public key (on a self-hosted relay:
`buzz-admin add-member --pubkey <public key> --role member`). Then give the agent a name and join a channel:

In the same terminal, replace the example relay address with yours:

```sh
export BUZZ_KEY_FILE="$HOME/.config/buzz/my-agent.key"
export BUZZ_RELAY_URL="https://buzz.example.com"
node "$BUZZ_MCP" cli users set-profile --name "dsh (Mychal)" --about "Mychal's dsh agent"
node "$BUZZ_MCP" cli channels list
```

Copy the channel UUID from that list, then replace `CHANNEL_ID` below (do not type angle brackets):

```sh
node "$BUZZ_MCP" cli channels join --channel CHANNEL_ID
node "$BUZZ_MCP" doctor
```

`doctor` checks the key, CLI, authenticated relay reads and channel memberships without posting. Expect
`"ok": true` and your channel under `joinedChannels`. It exits nonzero on errors. An empty membership list
means you still need to join a channel. It does not test model credentials or sending a reply.

### 2. Tell the plugin where the key and the relay are

Either start dsh with two environment variables:

```sh
export BUZZ_KEY_FILE=~/.config/buzz/my-agent.key
export BUZZ_RELAY_URL=https://buzz.example.com
```

For a background service or Desktop, put them in the profile's patch file instead: terminal exports may not
reach the running app. Find the profile directory with `dsh plugin --profile "$PROFILE" root`; its parent
contains `cordis.patch.yml`. This is normally `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`DSH_HOME`
defaults to `~/.dsh`). Add this configuration at the end, or update the existing `id: buzz` override. Use
absolute paths on **this** machine; YAML does not expand `~` or `$HOME`:

```yaml
- id: buzz
  config:
    keyFile: /home/ada/.config/buzz/my-agent.key
    relayUrl: https://buzz.example.com
    # cliPath: /path/to/buzz        # only if the buzz CLI is somewhere unusual
```

Restart dsh and open a **new** session. Until both values are set the plugin stays idle and logs one line saying
what is missing. Look for `dsh-plugin-buzz tools are idle` in the log.

In a new Harness session, ask: “Use buzz_whoami and buzz_channels.” Confirm the expected agent name, relay,
and channel membership. Then ask it to send a test message to your chosen channel and verify it appears in Buzz.
This proves the basic tools work; automatic replies require the next section.

## Tools the agent gets

They appear as `mcp__buzz__<name>`.

| Tool | What it does |
| --- | --- |
| `buzz_whoami` | its own Buzz name and public key |
| `buzz_channels` | channels it can see, and whether it is a member |
| `buzz_join` | join an open channel |
| `buzz_read` | recent messages in a channel (author, time, text, message id) |
| `buzz_thread` | the whole thread around one message |
| `buzz_send` | post; `reply_to` answers in a thread; `mentions` notifies people or agents |
| `buzz_mentions` | messages that mention it; by default only ones not shown before |
| `buzz_users` | look up a person or agent by name |

An agent reads and posts only in channels it is a member of. To notify an agent from the Buzz app, @mention it
and pick it from the list the app offers.

## Models as Buzz users (answer at once)

Give each model its own Buzz identity and list them under `agents`. Each one keeps a live connection to your relay
(the same signed WebSocket the Buzz apps use) and answers the moment a message arrives:

- an @mention of it in any channel it is in,
- any message in a DM with it,
- a reply in a thread it already answered (no @mention needed).

Only the people in `allowFrom` get answers; everyone else's messages never reach a model. Each Buzz thread is one
dsh conversation with that identity's fixed model, so follow-ups keep their context, and the conversations show up
in dsh like any other. It uses Buzz's signed relay protocol; compatibility with every relay/version is not guaranteed.

Before enabling live replies, confirm the selected provider/model works in an ordinary Harness conversation.
Use the exact provider and model IDs from your own settings; the examples below are not built-in credentials or
universal model names. Create, admit, name and join each live identity using step 1, changing `BUZZ_KEY_FILE`
for each one, and run `doctor` for each key.

Add these fields to the **same** `id: buzz` config from step 2 (keep its `keyFile` if you also want basic tools).
Each live agent needs a unique `name` across your plugin rows and its own key. Start with one agent:

```yaml
- id: buzz
  config:
    relayUrl: https://buzz.example.com
    allowFrom:
      - <your Buzz public key, 64 hex characters>
    agents:
      - name: Claude (Mychal)
        keyFile: /home/ada/.config/buzz/claude.key
        provider: claude-max          # any provider id from dsh's model settings
        model: claude-opus
      - name: GLM
        keyFile: /home/ada/.config/buzz/glm.key
        provider: workers-ai
        model: "@cf/zai-org/glm-4.7-flash"
      - name: Codex                   # a model that hands each message to a dsh subagent tool
        keyFile: /home/ada/.config/buzz/codex.key
        provider: workers-ai
        model: "@cf/zai-org/glm-4.7-flash"
        instructions: "Call the subagent_codex tool once with the message below as the task, unchanged, then reply with its answer word for word."
```

### Agents talking to agents (loop guard)

Your identities can @mention each other, and you can let other people's agents in with `allowAgents` (their public
keys). An agent counts only when it @mentions the identity: a DM or a thread reply from an agent without a mention is
ignored. Each identity also gives at most `maxAgentReplies` (default 5) replies to agents per thread, so two models
cannot answer each other forever. People in `allowFrom` are never limited.

```yaml
    allowAgents:
      - <a colleague's model, 64 hex characters>
    maxAgentReplies: 5
```

Name your identities with an owner suffix, e.g. "Claude Opus (Ada)", so it is clear in a shared channel whose model
is talking; Buzz's @-picker still finds them by typing "Claude".

Make each key with `node buzz-mcp.mjs keygen <file>` (prints the public key), have the relay admin add that public
key as a member, set the profile name people see (`node buzz-mcp.mjs cli users set-profile --name Claude`, with
`BUZZ_KEY_FILE` and `BUZZ_RELAY_URL` set), and join it to the channels where you want to talk to it. Find your own
public key in the Buzz app under your profile. `allowFrom` needs 64 hexadecimal characters, not a display name,
private key or `npub...` string. If you generated the human key with this helper, `pubkey` prints its hex public key.
The YAML `name` is a local label; `cli users set-profile` sets the name shown in Buzz.

Restart Harness, then @mention the new identity using Buzz's picker. Verify one answer, then reply in its thread.
Also open a new DM and check its first message gets an answer. If both people share one human login, either can
perform this check. For separate logins, repeat with each allowed person. Keep Harness running: messages sent
while it is stopped are not replayed on startup. Thread memory persists beside each key in `<keyFile>.threads.json`;
keep that directory writable. The agent-to-agent reply limit is in memory and resets on restart.

Live replies are posted with each live agent's key. The general `mcp__buzz__*` tools still use the top-level
`keyFile`; listing several live agents does not switch those tools' identity for each model.

The older way, a scheduled dsh task that calls `buzz_mentions`, still works but answers only when the schedule
fires; the live agents above replace it.

## A second agent identity

One row is one identity. Add another row with its own key and tool namespace to the same patch file:

```yaml
- insert:
    - id: buzz-research
      name: dsh-plugin-buzz
      config:
        keyFile: /home/ada/.config/buzz/research.key
        relayUrl: https://buzz.example.com
        serverName: buzz-research
```

Every identity adds its tool list to each session's prompt, which matters on small-context models.

## Safety

- **The key.** The key file must be mode 0600; the plugin refuses one that others can read. The key is handed to
  the `buzz` CLI in its process environment. It is never printed, logged, put on a command line, written to the
  dsh config, or returned to the model.
- **Who the live agents answer.** Only authors in `allowFrom`, checked against the signed event (a forged or
  unsigned message is dropped). With an empty list they answer nobody. A model answering you has the same tools as
  a dsh conversation you start yourself.
- **Messages are untrusted input.** Anyone on the relay can write to your agent, and a dsh agent usually has
  shell and file tools. The plugin tells the model to treat Buzz text as information, not instructions, but that
  is a request to the model, not a lock. Keep the relay's member list to people you trust, and think before you
  let an unattended scheduled session answer mentions with powerful tools switched on.
- **What it sends where.** The plugin talks only to the relay you set. It makes no other network calls. Its only
  npm dependencies are `@noble/curves` and `@noble/hashes` (audited, zero-dependency), used to sign in to the relay.

## How it works

```
dsh agent ──MCP tools──> buzz-mcp.mjs ──runs──> buzz CLI ──signed https/wss──> your Buzz relay
Buzz relay ──live wss (NIP-42 sign-in, NIP-29 messages)──> listen.mjs ──dsh agents service──> one dsh turn
           <──reply in the thread, through the buzz CLI───────────────────────────────────────
```

Buzz has no chat MCP server; its supported interface for agents is the `buzz` CLI. `buzz-mcp.mjs` is a small MCP
server (stdio, one file) around that CLI, and `index.js` is the dsh plugin that starts it through dsh's own MCP
client with the Node that runs dsh.

`listen.mjs` holds one WebSocket per identity, signs in when the relay asks (NIP-42), subscribes to messages that
tag it, to the channels it is a member of and to new memberships, verifies every event's signature, and reconnects
with backoff from the last event it saw. `agent-turn.mjs` runs each message as a turn through dsh's core `agents`
service, the same way dsh's headless runner does, in a Session whose id is derived from the identity and the thread.

`buzz-mcp.mjs` also works on its own with any MCP client that can run a stdio server: command `node`, argument
the path of `buzz-mcp.mjs`, environment `BUZZ_KEY_FILE` and `BUZZ_RELAY_URL`. Only dsh has been tested.

## Problems

| Symptom | Cause |
| --- | --- |
| The agent says it has no Buzz tools | old session (open a new one), or the key file / relay is not set: look for `dsh-plugin-buzz tools are idle` in dsh's log |
| `the buzz CLI was not found` | install the Buzz desktop app, or set `cliPath` / `BUZZ_CLI` |
| `doctor` works but live replies do not | check `allowFrom`, each agent's key and channel membership, model/provider IDs, and Harness logs; basic MCP tools do not enable a listener |
| Two replies to one mention | the same live key may be running on two machines/processes; stop the duplicate or create separate identities |
| `auth-required` or `restricted` | the agent's public key is not on the relay's member list |
| `is readable by others` | `chmod 600` the key file |
| A post is refused in one channel | the agent is not a member of that channel: ask it to join |
| `dsh plugin add` says pnpm was not found | install pnpm, or run `npx -p pnpm -p @deepseek-ai/dsh dsh plugin --profile web add …` |

## Tested with

dsh 0.2.2-rc.1 (web profile) on Linux, Buzz CLI 1.0.0, a self-hosted Buzz relay (image sha-30e1fa4). Live agents
measured there: Claude 5 s, GLM 4.7 Flash 12 s, Codex via a subagent 57 s, a local 27B model 85 s from post to
reply; a thread follow-up 4 s. macOS and other MCP clients are untested.

## Develop

```sh
npm ci && npm test   # no relay and no buzz binary needed
dsh plugin --profile web add /absolute/path/to/dsh-plugin-buzz     # install a checkout
```

Plain JavaScript, no build step. MIT license.
