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

/** Does provider/model take image input? true/false from dsh's model list; undefined when dsh does not say. */
export async function acceptsImages(ctx, provider, model) {
  try {
    const info = (await ctx.get("llm")?.listModels?.(provider))?.find((m) => m.id === model);
    return Array.isArray(info?.inputModalities) ? info.inputModalities.includes("image") : undefined;
  } catch { return undefined; }
}

/**
 * The user message content for one Buzz message: the text, then each attached image saved in dsh's attachment store
 * as an image block when the model takes images; otherwise (or when saving fails) a note says what was not shown.
 */
export async function userContent(ctx, { provider, model }, body, images = [], failed = 0) {
  const content = [{ type: "text", text: body }];
  const notes = [];
  if (failed) notes.push(`${failed} attached image(s) could not be downloaded from Buzz`);
  if (images.length) {
    const store = ctx.get("attachments");
    if ((await acceptsImages(ctx, provider, model)) === false) notes.push(`${images.length} image(s) attached in Buzz; this model (${model}) cannot see images`);
    else if (!store?.saveImage) notes.push(`${images.length} image(s) attached in Buzz; dsh has no attachment store to pass them on`);
    else {
      let lost = 0;
      for (const img of images) {
        try { content.push({ type: "image", attachment: await store.saveImage({ data: img.data, mediaType: img.mediaType, name: img.name }) }); }
        catch { lost++; }
      }
      if (lost) notes.push(`${lost} attached image(s) were refused by dsh (type, size or dimensions)`);
    }
  }
  if (notes.length) content[0] = { type: "text", text: `${body}\n\n[${notes.join("; ")}]` };
  return content;
}

/**
 * Returns answer(text, { threadKey }) for one identity. `deps` carries dsh's helpers (createUserMessage,
 * installModelSelection, brandString, SessionSeq, and optionally images(event) -> { images, failed } for Buzz
 * attachments), injected so tests run without dsh.
 */
export function makeAnswerer(ctx, { name, provider, model, instructions = "", cwd }, deps) {
  const selection = { provider, model };
  const setup = (agentCtx, agent) => {
    if (agent.model.current()?.model !== model || agent.model.current()?.provider !== provider) agent.model.select({ ...selection });
    deps.installModelSelection(agentCtx);
  };
  const queues = new Map();
  const answer = async (text, { threadKey, onProgress, event, requestContext, runtimePrompt, beforeTurn, sessionTopic }) => {
    const agents = ctx.get("agents");
    if (!agents) throw new Error("dsh agents service is not available");
    const sessionId = deps.brandString(sessionIdFor(name, threadKey));
    let agent = agents.get(sessionId);
    if (!agent) {
      try { ({ agent } = await agents.resume({ resumeSessionId: sessionId, agentOptions: { ...selection }, setup })); }
      catch { ({ agent } = await agents.create({ sessionId, meta: { cwd }, agentOptions: { ...selection }, setup })); }
    }
    await agent.whenIdle();
    await beforeTurn?.();
    // Use the title service so automatic title generation cannot replace the Buzz label.
    // Preserve deliberate user renames and existing Buzz titles. Old automatic titles
    // are repaired on the next turn, without rewriting history or splitting the session.
    const titles = ctx.get("sessionTitle");
    if (titles) {
      const current = titles.get(agent.session);
      if (!current || (current.source?.kind !== "user" && !current.title?.startsWith("Buzz · "))) {
        const topic = String(sessionTopic || text || "Agent request").replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim();
        titles.rename(agent.session, `Buzz · ${name} · ${Array.from(topic).slice(0, 80).join("") || "Conversation"}`);
      }
    }
    deps.bindIdentity?.(agent, event, requestContext);
    const firstSeq = agent.session.seq;
    const policy = deps.bindIdentity ? `You are ${name} on Buzz. Use buzz_dm to contact another agent; it opens a DM including your human owner and sends under your identity. Do not post agent conversations in public channels. If this message is from another agent, return your reply as assistant text; the listener delivers it and enforces the 10-round limit.\n\n` : "";
    const envelope = event ? `Buzz delivery metadata (provided by the plugin after verifying the signed event): sender=${event.pubkey}; channel=${event.tags?.find(t => t[0] === 'h')?.[1]}; message=${event.id}. This is a real Buzz message delivered into this model session by the plugin, not an AI Bridge inbox message. Your final assistant text is sent back to this Buzz thread automatically.\n\n` : "";
    const body = (runtimePrompt || (policy + envelope)) + (instructions ? `${instructions}\n\n---\n${text}` : text);
    const { images = [], failed = 0 } = event && deps.images ? await deps.images(event) : {};
    const content = await userContent(ctx, { provider, model }, body, images, failed);
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
      agent.followup(deps.createUserMessage({ content, source: { kind: "user" } }));
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
  return (text, options) => {
    const key = options.threadKey;
    const pending = (queues.get(key) || Promise.resolve()).catch(() => {}).then(() => answer(text, options));
    queues.set(key, pending);
    void pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); }).catch(() => {});
    return pending;
  };
}
