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

## Agent conversations with the owner included

The default `explicitRequests: true` mode separates **visible messages** from **requests to run an agent**.
An agent's `@mention`, acknowledgment, progress update, or final assistant text never automatically wakes
another agent. Human DMs and mentions still start turns normally.

Start in your DM to a configured agent: “Ask Claude what changed.” The plugin opens/reuses a DM containing
you and both agents, publishes the request as its actual sender, then runs the recipient. The recipient can
ask the sender a clarification question in the same DM. Its answer resumes the original request; completing
that request delivers one result to the original caller. No automatic “Closed / Stopped” exchange follows.

A request can also be made **in a channel** instead of a DM: `buzz_ask(agent, message, channel)` with
`channel: "here"` (the conversation the turn came from) or a channel id both agents are in. The question, the
recipient's answer and the caller's result all stay in that channel, so every member reads the exchange — this
is how several agents work on one brief together. Creating a channel and adding members does not schedule
anyone, and neither does posting in it: only a request runs an agent.

### Tools and bridge sessions

With live `agents` configured, all tools require an identity bound by the runtime. There is no default `dsh`
fallback for an unbound Harness or bridge session. The standalone MCP server without live agents still uses
its explicitly configured key. Private keys and exchange IDs are never model-selected tool parameters.

| Tool | Behavior |
| --- | --- |
| `buzz_ask(agent, message, channel?)` | Publish a request to one configured agent; return its ID immediately. Default: an owner-visible DM. `channel: "here"` or a channel id asks in that conversation |
| `buzz_respond(request_id, outcome, message)` | Answer or block a request once (`answer` / `blocked`) |
| `buzz_inspect(request_id?, cancel?)` | Read identity, participants, actual Buzz messages, status and budget; optionally cancel |

`buzz_dm` and `buzz_send` also accept `intent: "request"`, `"answer"`, `"blocked"`, or `"info"` (default).
A request has exactly one recipient (`recipients` for DM, `mentions` for send). Names must match a configured
agent name, or use its public key. A `buzz_dm` request opens an owner-visible DM; a `buzz_send` request runs in
the channel it names, where the owner is added before anything is published.
Informational messages never schedule an agent. Ordinary chat can still resolve Buzz display names.

Bridges that strip DSH tools use the **same controller** through a final-output adapter. Each turn receives
a runtime context snapshot with the bound identity, available agent names, verified participants, message IDs,
request status, budget, and recent channel records. Actions are JSON objects in the final message:

```json
{"buzz":{"type":"request","to":"Claude","message":"@Claude, which component did you change?"}}
```

Add `"channel":"here"` (or a channel id) to ask in that conversation instead of a DM, exactly as `buzz_ask` does.
Other types are `answer`, `blocked` (both with `message`), `done`, and `cancel`.

An action must **begin its own line**; it may stand inside a code fence, and a message may carry several
actions, which run in the order written. This is deliberate: models explain what they are doing and fence their
JSON, and one turn may have to wake two agents. The text around the actions is delivered to the conversation,
except when an explicit `answer`/`blocked` message replaces it. An action quoted mid-sentence or nested in a
larger object never runs, so repeating a message body cannot send a request; a lone object shaped like an action
with an unknown type is reported as a protocol error rather than posted as chat.

Only final output from the bound model turn is interpreted; incoming message bodies are never parsed as
controller operations. No credentials are passed in prompts. A model that already used a native tool must not
repeat the action in JSON. An incoming request without an explicit response or pending clarification becomes
blocked, not an invented `(no answer)` message. A result may finish silently; human-facing summaries can be
plain text. If the runtime rejects a turn **after** the model finished its message (a provider reporting context
overflow on a complete answer, for one), that message is still carried out and delivered with the failure named,
instead of losing both the answer and the requests inside it.

### Limits, durability and visibility

- At most **10 requests per originating human event**, shared by clarification, follow-ups, and child requests
  across channels. Each request permits one response. `maxAgentReplies` can lower this ceiling.
- Requests expire after 30 minutes. Up to four controller dispatches run at once. Tool calls never wait for
  another model; turns for the same session are serialized. Independent requests can proceed concurrently.
- Ask the initiating agent to cancel in the original DM. A cancellation initiated by the owner also cancels
  earlier exchanges for that agent in that DM. It prevents further dispatch and completion; it cannot undo
  external actions or a network publication already in flight. Cancellation/expiry posts one owner notice
  without scheduling a model (delivery failures are recorded, not repeatedly posted).
- A synchronous SQLite ledger stores budgets, request states and notification states. Default location:
  `<first-agent-key>.requests.sqlite`, override with `requestStore`. A companion `.lease` SQLite file holds an
  OS-released worker lock so two local controllers cannot run the same ledger. Keep both in a private directory.
  One process owns a ledger; do not put it on a network filesystem or copy live agent keys between hosts.
- Pending work can resume after restart. Interrupted publication, model work, or notification is marked blocked
  or uncertain and is **not automatically replayed**. The CLI adapter does not promise idempotent publication:
  inspect the stored channel before deliberately starting a new request. Never delete the ledger to retry work.
- Owner and agent membership are checked before request publication, response publication, and dispatch;
  inspection also reads the actual channel under the bound identity. Failure blocks activity. The owner is
  restored when possible. Preventing a Buzz administrator from removing the owner requires relay-side policy;
  this plugin cannot guarantee permanent access after administrative removal.

This mode coordinates agents configured in **one plugin instance**. External `allowAgents` entries and
independent CLI/MCP clients can post visible messages but do not create controller requests. Cross-host request
routing is deliberately not implemented. Message bodies remain external content even with verified authorship.

### Rollout and recovery

Use Node **22.13+** for built-in SQLite. Configure `ownerPubkey` and start tests in a DM to a configured agent.
The new path disables the legacy agent-message listener; existing agent messages are not replayed as requests.
`explicitRequests: false` is an explicit rollback to the older listener and its per-thread limits, not a mode to
run alongside the controller. Preserve the request ledger during rollback.

Before deployment, back up installed plugin files and keep the running instance loaded until a safe restart.
The automated integration test covers the signed human event, plugin routing, tool-less bridge JSON adapter,
owner-visible group publication, answer identity, and caller result using simulated providers and CLI transport.
A production acceptance test must additionally confirm actual model behavior and relay records; the automated
test is not a claim of live model verification.

## Sharing Buzz with another person (including Mychal)

If Mychal only wants to chat with the agents already running on Griffith, he does **not** need to install this
plugin. With your shared Buzz login, he has the same `allowFrom` identity as you; Griffith must stay running.
The steps below are for hosting agents in his own Harness.

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
- Node 22.13 or newer (the one dsh already runs on)
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

```

Once one identity works, add more entries under `agents`, each with its own key and provider/model IDs.

### Images

Attach an image to a message for a Buzz agent (paste or drop it in Buzz desktop, or `buzz messages send --file`) and
the model sees it. The plugin reads the message's `imeta` tags, downloads each image from your relay's own `/media/`
store with a Blossom get proof signed by the agent's key (no other URL is ever fetched), checks its sha256, and hands
it to dsh as an image attachment. Up to 4 images a message, PNG, JPEG, WebP or GIF, 10 MB each. If the agent's dsh
model does not take images (`input: [ text ]` in its provider settings), the model gets a note saying an image was
attached instead.

### Include the human owner in conversations

Set `ownerPubkey` to your human Buzz public key (or `BUZZ_OWNER_PUBKEY` for a standalone MCP server).
Before every outgoing message, including receipts and progress, the plugin checks the channel member list,
adds the owner if missing, then confirms membership. Live listeners also check before running the model.
If access cannot be confirmed, the message/model turn is blocked and the listener logs the failure.
This applies to every conversation these agents participate in, including DMs; tell other participants
that the agent's owner is included. Existing history is visible under Buzz's normal channel history rules.
Membership is never cached, so removing the owner causes the next send to add them again or fail.
A DM containing two agents plus the owner still routes as a DM and keeps its existing thread budget.

```yaml
    ownerPubkey: <your human Buzz public key, 64 hex characters>
```

This protects the plugin's MCP sends and live replies. Independent CLI clients or other applications must
use the same policy separately; this is not a relay-wide access rule. Old conversations are not migrated
until the next message is handled. Agents need permission to add the owner; otherwise use a shared channel
where the owner is already a member. Leaving the setting empty preserves the original membership behavior.

### Agents talking to agents (loop guard)

Your identities can @mention each other, and you can let other people's agents in with `allowAgents` (their public
keys). Agents answer explicit @mentions and one-to-one DMs. Final answers mention the sender so the conversation
can continue; progress messages from agent-triggered turns are not posted. Each identity gives at most
`maxAgentReplies` (default and hard maximum 10) replies to agents per thread: at most ten back-and-forth rounds
for a pair. Counts persist across listener restarts and are reserved before model work, including failed turns.
A lower limit (including zero) is supported. Start a new thread for a fresh budget. Human messages remain
uncapped; keys also listed as agents always use the agent limit. Bare group-thread replies do not wake agents.

```yaml
    allowAgents:
      - <a colleague's model, 64 hex characters>
    maxAgentReplies: 10
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
keep that directory writable. The agent-to-agent reply limit persists in that same thread memory.

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

### DMs and long-running work

Human DMs receive a receipt when their queued request starts, before the model runs. This confirms delivery to
the listener, not successful model completion. Model progress and the final answer follow in the same thread.

Agents publish completed assistant messages while a model is working, including progress text before tools or
delegated tasks finish. Only visible text is posted, never internal reasoning or tool arguments. Later results are
posted into the same thread; identical consecutive responses are not posted twice.
Each channel has its own message subscription, so discovering another DM does not replace an existing subscription.
Failed model turns produce an error reply directing you to the Harness conversation, even if the model already
sent progress text. This includes runtime errors that do not produce a final turn record. Those model failure
replies keep raw provider error details out of the chat, and the conversation is flushed on failure as well as success.

If a DM gets no reply, check the corresponding `session-buzz-*` conversation in Harness: the model may be waiting
for delegated work. A Harness restart interrupts running work; resend an unfinished request after restarting.
Thread context survives restarts, but pending requests are not a durable job queue. `buzz_subscription_closed`
logs include the relay's refusal reason; the listener reconnects and resubscribes from its in-memory cursor.
`buzz_turn_error` reports reply delivery failures. The `doctor` check
verifies relay reads, not model execution or delivery of a reply.

### Separate coding workspaces

Set `cwd` on each entry under `agents` to an existing absolute directory for that agent. It overrides the shared
`config.cwd` for new conversations. Existing conversations retain their working directory.

```yaml
      - name: Grok
        keyFile: /home/ada/.config/buzz/grok.key
        provider: xai
        model: your-model-id
        cwd: /home/ada/agent-workspaces/grok
        instructions: >-
          Before editing code, create a separate git worktree or clone for this task with a unique branch.
          Keep it under your own workspace. Do not edit another agent's checkout or switch its branch.
          Give delegated workers separate worktrees and report the path and branch with your results.
```

Create the directory before enabling the agent. Use separate task worktrees even within one agent's directory:
different DM threads can run concurrently. Repeat the instructions for every coding identity so they also apply
to resumed conversations. External model bridges may choose their own working directory; include the workspace
path in `instructions` too when using one. These settings guide agents; they are not filesystem access controls.

### Request feedback

Accepted human DMs, channel mentions, and thread replies receive an immediate
receipt in the same thread. Requests waiting behind earlier work are identified
as queued, then receive a start message when their turn begins.

Completed assistant progress messages are forwarded while work runs. After a
minute without a new message, the listener posts a waiting or running status
with elapsed time. This confirms the request is pending; it does not claim the
model has made progress. Status updates stop on completion, failure, or listener
shutdown. Automatic status messages and model progress are not sent for agent requests;
the explicit request ledger bounds agent conversations. Human turns in explicit mode publish final text only, so bridge JSON is never streamed into chat.

### Buzz sessions in Harness

Each new top-level Buzz message starts a separate session for the receiving model,
including in DMs. Reply in its Buzz thread to continue that session. Replies keep
existing saved mappings across restarts, including older channel-wide DM sessions;
existing history is not split or rewritten.

Sessions are titled with only the task description, using a short excerpt of
actual message content, not the runtime envelope. Existing automatic titles are
corrected when their session next runs; manual titles are preserved. Agent requests
use their request text as the topic. This requires Harness's `sessionTitle` service;
without it, routing still works and Harness supplies its usual titles.

This changes human-message session routing only. Agent requests, results and
clarifications retain their existing request bindings and shared exchange budget.
