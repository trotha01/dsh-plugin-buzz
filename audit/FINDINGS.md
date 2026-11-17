# Buzz delivery investigation

Inspected 2026-11-17 (Asia/Shanghai). No running code, configuration, state, or services changed; no messages sent and no model calls made.

## Evidence and limits

The installed package at `/home/trevor/dsh-home/profiles/web/node_modules/dsh-plugin-buzz` differs from the shared checkout and the prior recovery worktree. Findings below refer to installed files on disk; this investigation did not inspect the process's loaded JavaScript. The shared checkout has unrelated uncommitted changes and was left alone.

- MCP already exists: `buzz-mcp.mjs` exposes chat tools. `index.js` separately registers `buzz_ask`, `buzz_respond`, and `buzz_inspect` against a local RequestController. The standalone MCP chat interface is not the same as this bound scheduling interface.
- Installed `listen.mjs:104` suppresses agent-originated messages in explicit-request mode, except explicit mentions in non-DM channels when `channelAgentMentions` is enabled. That flag is enabled in the configured web profile; explicitRequests defaults to true. Even a mentioned agent DM is suppressed.
- Installed `listen.mjs:108` stops channel replies at ten per thread. Counts are persisted in the thread store and have no reset/expiry in this listener. Read-only inspection found one thread at ten for Claude and one for Grok. Thus there are actual saved states that activate the cap, although no specific user-reported failed message was correlated to them.
- The request ledger had 13 exchanges and two requests, both completed with notifications marked done. These are coordinator records, not independent proof of recipient comprehension. They provide no evidence of a failed durable request in this snapshot.
- Listener queues and seen IDs are memory-only; startup sets `since` to current time. Messages arriving during downtime are outside that initial replay window. Events are marked seen before routing/execution. Posting failures do not have a durable reply outbox.
- The controller has persistence, budgets and deadlines already, but interrupted in-flight work is marked blocked and uncertain results are not automatically replayed. The transport resolves only locally configured identities; an external agent allowlist does not make that agent a schedulable controller recipient.
- The request prompt says ordinary mentions never schedule a reply while the channel-mention compatibility flag permits them. Agents receive an inconsistent description of behavior.

## Reproduction

`audit/installed/listen.mjs` is an exact snapshot of the installed listener. `audit/delivery.test.mjs` uses fake sockets and synthetic keys, with no relay access. Four tests pass: uncapped mention reaches answerer; persisted ten-reply cap suppresses it; mentioned agent DM is suppressed in explicit mode; startup subscriptions use current time. These prove local code behavior, not live network parity.

Run: `node --test audit/delivery.test.mjs` (Node 24.20.0 used). The ignored node_modules symlink points to existing dependencies in the shared checkout and does not modify them.

## Recommendation

Use one durable request coordinator with an authenticated MCP interface for every participating agent. Extend the existing coordinator rather than create a second scheduler. Keep Buzz as the visible conversation and publish request/result status there.

Expose send/request, inspect/status, receive/claim, and acknowledge/respond operations. Bind identity at authentication, use stable request IDs and idempotent retries, persist inbox/outbox and delivery stages, and distinguish accepted, scheduled, started, answered, blocked and uncertain outcomes. The host still needs a worker that wakes or resumes recipients; an MCP tool interface alone does not implement that lifecycle. Keep finite per-exchange loop budgets with visible exhaustion, rather than permanent silent per-thread stops. Reconcile ambiguous relay publication before retrying to avoid duplicates.

For external agents, define authenticated registration and capability/availability checks; the current resolver only knows local configured agents. Provide bridge adapters where native tools are unavailable. Correct the prompt/flag mismatch and report suppressed/unsupported requests explicitly.

Official MCP architecture reference: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/architecture/index.mdx (consulted during investigation). MCP supplies client/host/server interfaces; delivery persistence and scheduling must be designed in the application.

No production fix or new server was deployed. The user requested investigation and architectural assessment; silently changing loop guards or deploying a new coordination service would obscure the diagnosis.
