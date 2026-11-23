# Delivery and session follow-up

Inspected installed files on disk; not the running process's loaded modules. No live messages, model calls, configuration changes or service restarts. The service journal query supplied no message-level Buzz events, so no particular user-reported failed message has been correlated. Earlier audit state counts were not freshly verified.

## Tests

Eight offline tests pass in `audit/delivery.test.mjs`, against a fresh copy of installed listen.mjs (identical to the previous audit snapshot) and installed agent-turn.mjs. Synthetic signed events, fake sockets, no network. Node 24.20.0.

They establish: an uncapped channel mention invokes the answerer; a stored ten-reply count suppresses it; explicit-request mode suppresses mentioned agent DMs; startup subscriptions use current time; top-level DMs get separate threads and replies preserve stored mappings; an event rejected before DM metadata remains deduplicated after metadata arrives; failed final publication is not retried on duplicate input; session IDs are deterministic per identity/thread and differ across identities/threads.

The metadata ordering test is a conditional code-level reproduction, not evidence that the relay emitted that sequence. The listener already delays newly discovered channel subscriptions until membership arrives. Restart test checks subscription bounds, not an actual outage. No live endpoint parity claimed.

## Session routing

`route` uses stored referenced-event mappings, otherwise root/reply event IDs, otherwise the triggering event ID. `sessionIdFor` hashes agent name plus thread key. New top-level DMs intentionally start fresh; replying retains the mapped session. Renaming an identity changes that derived session ID. The ID is not explicitly namespaced by relay/channel.

In installed requests.mjs dispatch, recipient binding has requestId but no threadKey. Installed index.js selects `request:<exchange>:<requestId>` as fallback. Results reuse r.caller (including its original threadKey or requestId). Thus recipient requests are isolated, while results resume the caller's bound session. This is source inspection, not a new controller integration test.

## Suggested implementation

1. Persist each verified inbound event before scheduling. Record event ID, recipient, routing decision/reason, request ID and destination session. Distinguish transport acceptance, queueing, model start, completion and reply publication. Surface suppressed/expired/failed states to the sender without automatically starting another agent turn.
2. Persist replay checkpoints and replay with overlap plus durable deduplication. Do not treat seen as completed. Re-evaluate temporarily unresolved membership separately from permanent policy rejection.
3. Use a durable reply outbox with stable signed event IDs; reconcile ambiguous relay acceptance and retry publication without rerunning the model. Recover interrupted work with explicit uncertain state where tool side effects cannot safely be replayed.
4. Unify ordinary-message versus explicit-request rules and prompts; preserve finite per-exchange budgets and report exhaustion. Bound model execution and queue waits with explicit timeout status and cleanup.
5. Persist an authorized mapping `(relay, channel, thread, recipient identity) -> session ID`, plus source session/request and return destination. Support explicitly binding an existing working session; never infer the destination solely from topic or allow an arbitrary sender to choose another user's session. Serialize all inbound work through that session's host queue. Preserve existing mappings during migration.
6. Validate with a private end-to-end canary covering reception, scheduling, target session, response and sender-session continuation, then relay outage/restart/duplicate tests. No canary messages were sent in this audit.

MCP can expose request/status/binding operations over the same coordinator; changing the interface alone does not supply persistence or recovery.
