// One Buzz message -> one dsh turn, the way dsh's own headless runner does it: the core `agents` service creates (or
// resumes) the Session for the Buzz thread with the identity's provider/model, the message goes in as a user message,
// and the last assistant text of that turn is the reply. Sessions show up in the dsh UI like any other conversation.
import { createHash } from "node:crypto";

/** Stable Session id for (identity, thread), so a thread keeps its conversation across dsh restarts. */
export const sessionIdFor = (agentName, threadKey) =>
  `session-buzz-${createHash("sha256").update(`${agentName}\0${threadKey}`).digest("hex").slice(0, 32)}`;

/** Last non-empty assistant text after `firstSeq` (same rule as dsh-headless). */
export function finalText(session, firstSeq) {
  let text = "";
  let reason;
  for (let seq = firstSeq; seq < session.seq; seq++) {
    const e = session.eventAt(seq);
    if (e?.type === "turn/start") reason = undefined;
    if (e?.type === "turn/end") reason = e.data?.reason;
    if (e?.type === "assistant/message") {
      const t = (e.data?.message?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      if (t) text = t;
    }
  }
  // Provider failures are durable turn outcomes, not necessarily rejected whenIdle() promises.
  // Do not mistake an earlier "working on it" message for a successful final answer, or expose
  // raw provider error bodies (which may include request details) to the chat.
  if (reason?.kind === "error") throw new Error("The model turn failed. Check the Harness conversation for details, then retry.");
  if (reason?.kind === "interrupted" || reason?.kind === "aborted") throw new Error("The model turn was interrupted. Please resend your request.");
  return text;
}

/**
 * Returns answer(text, { threadKey }) for one identity. `deps` carries dsh's helpers (createUserMessage,
 * installModelSelection, brandString, SessionSeq), injected so tests run without dsh.
 */
export function makeAnswerer(ctx, { name, provider, model, instructions = "", cwd }, deps) {
  const selection = { provider, model };
  const setup = (agentCtx, agent) => {
    if (agent.model.current()?.model !== model || agent.model.current()?.provider !== provider) agent.model.select({ ...selection });
    deps.installModelSelection(agentCtx);
  };
  return async (text, { threadKey, onProgress }) => {
    const agents = ctx.get("agents");
    if (!agents) throw new Error("dsh agents service is not available");
    const sessionId = deps.brandString(sessionIdFor(name, threadKey));
    let agent = agents.get(sessionId);
    if (!agent) {
      try { ({ agent } = await agents.resume({ resumeSessionId: sessionId, agentOptions: { ...selection }, setup })); }
      catch { ({ agent } = await agents.create({ sessionId, meta: { cwd }, agentOptions: { ...selection }, setup })); }
    }
    await agent.whenIdle();
    const firstSeq = agent.session.seq;
    const body = instructions ? `${instructions}\n\n---\n${text}` : text;
    // Some runtime failures emit agent/error without a durable turn/end event.
    // Track only this conversation and release both listeners after every request.
    let failure;
    let progressDelivery = Promise.resolve();
    const stopErrors = ctx.on?.("agent/error", ({ agent: subject }) => {
      if (subject === agent) failure = { atOffset: agent.session.seq };
    });
    const stopTerminals = ctx.on?.("session/event", (session, event) => {
      if (session !== agent.session) return;
      if (event.type === "turn/end" && failure && event.seq >= failure.atOffset) failure = undefined;
      // A tool-using turn may run for minutes before becoming idle. Deliver completed
      // assistant messages now, without making the runtime event handler asynchronous.
      if (event.type === "assistant/message" && onProgress) {
        const text = (event.data?.message?.content || []).filter(b => b.type === "text").map(b => b.text).join("");
        if (text) progressDelivery = progressDelivery.then(() => onProgress(text)).catch(() => {});
      }
    });
    try {
      agent.followup(deps.createUserMessage({ content: [{ type: "text", text: body }], source: { kind: "user" } }));
      const subagents = ctx.get("subagents");
      for (;;) {
        await agent.whenIdle();
        await progressDelivery;
        if (failure) throw new Error("The model turn failed. Check the Harness conversation for details, then retry.");
        const idleSeq = agent.session.seq;
        // Publish idle-turn text before waiting for delegated work.
        const progress = finalText({ seq: idleSeq, eventAt: (s) => agent.session.eventAt(deps.SessionSeq(s)) }, firstSeq);
        if (progress && onProgress) await onProgress(progress);
        if (!(await subagents?.waitForChildren?.(agent)) && agent.status === "idle" && agent.session.seq === idleSeq) break;
      }
      return finalText({ seq: agent.session.seq, eventAt: (s) => agent.session.eventAt(deps.SessionSeq(s)) }, firstSeq);
    } finally {
      stopErrors?.();
      stopTerminals?.();
      await progressDelivery;
      await ctx.get("sessions")?.flush?.(agent.session);
    }
  };
}
