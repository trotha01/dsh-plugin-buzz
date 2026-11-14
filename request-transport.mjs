import { withIdentity, buzzJson, ensureOwner } from './buzz-mcp.mjs';
const HEX = /^[0-9a-f]{64}$/, UUID = /^[0-9a-f-]{36}$/;
export function requestTransport(identities) {
  const as = (actor, fn) => {
    const identity = identities.get(actor);
    if (!identity) throw new Error('No configured runtime identity for this agent');
    return withIdentity(identity, fn);
  };
  return {
    agents: () => [...identities].map(([pubkey, i]) => ({ name: i.name, pubkey })),
    resolve(ref) {
      const key = String(ref || '').replace(/^@/, '').toLowerCase();
      const matches = [...identities].filter(([pk, i]) => pk === key || i.name.toLowerCase() === key);
      if (matches.length !== 1) throw new Error('Choose one configured agent by exact name or public key');
      return matches[0][0];
    },
    open: (actor, recipient, owner) => as(actor, async () => {
      const dm = await buzzJson(['dms', 'open', '--pubkey', recipient, '--pubkey', owner]);
      const channel = dm?.channel_id ?? dm?.dm_id;
      if (dm?.accepted === false || !UUID.test(channel || '')) throw new Error('Could not open owner-visible DM');
      return channel;
    }),
    verify: (actor, channel, participants) => as(actor, async () => {
      await ensureOwner(channel, identities.get(actor).BUZZ_OWNER_PUBKEY);
      const members = await buzzJson(['channels', 'members', '--channel', channel]);
      if (!Array.isArray(members) || !participants.every(p => members.some(m => m.pubkey === p))) throw new Error('Cannot verify conversation participants');
      return members;
    }),
    post: (actor, channel, text, replyTo, mention) => as(actor, async () => {
      const args = ['messages', 'send', '--channel', channel, '--content', '-'];
      if (replyTo) args.push('--reply-to', replyTo);
      if (mention) args.push('--mention', mention);
      const sent = await buzzJson(args, text), id = sent?.event_id ?? sent?.id;
      if (sent?.accepted === false || !HEX.test(id || '')) throw new Error('Publication uncertain: inspect channel before retrying');
      return id;
    }),
    read: (actor, channel) => as(actor, () => buzzJson(['messages', 'get', '--channel', channel, '--limit', '30'])),
  };
}
export function requestTools(controller) {
  const string = { type: 'string' };
  return [
    { name: 'buzz_ask', description: 'Request work or clarification from another configured agent. Without channel it opens a DM including your owner; channel="here" (or a channel id you and that agent are both in) asks in that conversation, where every member reads the question and the answer. Returns immediately; the result arrives in a later turn. Mentions and channel membership alone do not schedule agents.',
      inputSchema: { type: 'object', properties: { agent: string, message: string, channel: { type: 'string', description: '"here" for the conversation this turn came from, or a Buzz channel id' } }, required: ['agent', 'message'], additionalProperties: false },
      run: (args, ctx) => controller.ask(ctx, args.agent, args.message, { channel: args.channel }) },
    { name: 'buzz_respond', description: 'Answer or block the current request exactly once. An answer does not request another answer.',
      inputSchema: { type: 'object', properties: { request_id: string, outcome: { enum: ['answer', 'blocked'] }, message: string }, required: ['request_id', 'outcome', 'message'], additionalProperties: false },
      run: (args, ctx) => controller.respond(ctx, args.request_id, args.outcome, args.message) },
    { name: 'buzz_inspect', description: 'Inspect your bound identity, participants, stored conversation, request status and shared budget. cancel=true cancels this exchange.',
      inputSchema: { type: 'object', properties: { request_id: string, cancel: { type: 'boolean' } }, additionalProperties: false },
      run: (args, ctx) => args.cancel ? controller.cancel(ctx) : controller.inspect(ctx, args.request_id) },
  ];
}
