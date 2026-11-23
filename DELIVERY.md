# Reliable delivery and session routing

Implemented in the task worktree `buzz-reliable-delivery-20261117`, branch
`codex/buzz-reliable-delivery-20261117`. Installed source was snapshotted in
commit `4e27259` before changes; that baseline includes changes made since the
previous audit. No historical audit result is treated as live verification.

## Delivery

Each identity/relay has a SQLite delivery database beside its key file, with
0600 permissions and an exclusive process lease. Verified allowlisted messages
are persisted before scheduling. Status includes received, waiting_metadata,
queued, started, answered, published, suppressed, failed and uncertain.
Reasons distinguish explicit-request policy, exhausted budgets, metadata,
queue expiry, model deadline and publication retry. Model failure is recorded
as an outcome even when its error reply is successfully published.

A persistent installation-time replay floor and 60-second overlap allow restart
and reconnect recovery without advancing past backlog in another channel.
Durable message IDs prevent replay from invoking completed work. Messages
waiting for DM metadata are reconsidered when membership arrives. Recovery
requires the relay to retain and return the history; it cannot recover events
that the relay has lost. History replay and ledger size grow over time; cursor
compaction requires a future per-subscription catch-up protocol.

Final answers are signed once and stored before publication. Nostr ACK timeout,
disconnect and ambiguous acceptance retry the exact event ID. Membership is
rechecked before every attempt. Automatic retries run every 30 seconds; no AI
polling is involved. Ephemeral receipts/progress notifications remain best effort.
Durable listener mode uses receipts and periodic activity updates instead of
streaming model text before its final answer is saved.

The request coordinator also persists signed request, response, caller-result
and owner-notice events. Publication retries do not repeat either model turn.
Canceled/expired exchanges stop pending request/response/result retries. Owner
notices can still be delivered. Existing legacy interrupted publications without
a saved signed event remain uncertain; they are not guessed or replayed.

A started turn interrupted by process exit becomes uncertain. It is never
rerun automatically, because it may have performed external actions. Queued
work expires after 30 minutes. A turn exceeding 30 minutes is marked uncertain
but retains its session queue until it actually finishes: marking a timeout
cannot safely cancel arbitrary external actions. A late answer can still be
saved and delivered. A stuck host turn still needs operator attention.

## Inspection and session alignment

`buzz_delivery_status({message_id})` is registered in the configured Buzz tool
namespace. It exposes status/reason/session/thread for the calling agent's
identity only. Structured `buzz_delivery` log records include the message ID.
`buzz_inspect` continues to expose request state, budgets and conversation data.
Ordinary agent DMs still require an explicit request when explicitRequests is
on; this policy is now inspectable, not silently reinterpreted as authorization.

Each configured agent can specify trusted local bindings:

```yaml
sessionBindings:
  - threadKey: "<Buzz root message ID>"
    sessionId: "<existing Harness session ID>"
```

The message sender cannot supply this configuration. Existing deterministic
session IDs and saved thread mappings are preserved. The actual destination is
saved with the delivery and in the coordinator's caller binding, so a result
returns to its originating session. An explicit target must already exist;
a failed resume does not create a replacement. Turns bound to the same session
share the answerer's queue. Configure a target session for one agent identity
only; do not bind multiple identities to the same session.

## Validation and rollout

100 offline Node tests pass on Node 24.20.0, including signed-event retry,
restart recovery, metadata arrival, budget/policy reasons, deadline reporting,
lease exclusion, ACK timeout cleanup, session serialization, fail-closed resume,
request/response/result retries and caller-session continuation. Tests use fake
relay sockets and model services; they do not prove live relay parity.

Installed files are backed up before staging. No service is stopped/restarted
and no live test message or model request is sent. Activation requires Trevor
to run `dsh-safe-restart` on griffith after this turn. After activation, verify a
private owner message's ID through reception, destination session and published
reply, then test an explicit agent request and its caller continuation.
