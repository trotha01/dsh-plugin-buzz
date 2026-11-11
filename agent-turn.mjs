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
  for (let seq = firstSeq; seq < session.seq; seq++) {
    const e = session.eventAt(seq);
    if (e?.type === "assistant/message") {
      const t = (e.data?.message?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      if (t) text = t;
    }
  }
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
  return async (text, { threadKey }) => {
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
    agent.followup(deps.createUserMessage({ content: [{ type: "text", text: body }], source: { kind: "user" } }));
    const subagents = ctx.get("subagents");
    for (;;) {
      await agent.whenIdle();
      const idleSeq = agent.session.seq;
      if (!(await subagents?.waitForChildren?.(agent)) && agent.status === "idle" && agent.session.seq === idleSeq) break;
    }
    await ctx.get("sessions")?.flush?.(agent.session);
    return finalText({ seq: agent.session.seq, eventAt: (s) => agent.session.eventAt(deps.SessionSeq(s)) }, firstSeq);
  };
}
