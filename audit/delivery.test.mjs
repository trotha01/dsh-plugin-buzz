import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listen, signEvent, route } from './installed/listen.mjs';

const secret = '11'.repeat(32), peer = '22'.repeat(32);
const me = signEvent(secret, {kind: 9}).pubkey;
const other = signEvent(peer, {kind: 9}).pubkey;
const root = 'aa'.repeat(32), channel = 'audit-channel';
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(saved = {}, overrides = {}) {
  let socket;
  const answers = [], logs = [];
  class WS {
    constructor() { socket = this; this.handlers = {}; this.sent = []; }
    addEventListener(k, f) { this.handlers[k] = f; }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    frame(f) { this.handlers.message({data: JSON.stringify(f)}); }
    close() { this.handlers.close?.(); }
  }
  const client = listen({name: 'audit', relayUrl: 'https://example.invalid', secretHex: secret,
    allowFrom: [], allowAgents: [other], explicitRequests: true, channelAgentMentions: true,
    WebSocketImpl: WS, now: () => 1000000, store: {load: () => saved, save: () => {}},
    log: entry => logs.push(entry), answer: async text => { answers.push(text); return 'answer'; }, send: async () => undefined, ...overrides});
  socket.frame(['OK', 'auth', true, '']);
  return {client, socket, answers, logs};
}
function message(socket) {
  socket.frame(['EVENT', 'channel', signEvent(peer, {kind: 9, created_at: 1001,
    tags: [['h', channel], ['p', me], ['e', root, '', 'root']], content: 'request'})]);
}
test('an uncapped channel mention reaches the agent', async () => {
  const f = fixture();
  try { message(f.socket); await flush(); assert.equal(f.answers.length, 1); }
  finally { f.client.close(); }
});
test('persisted ten-reply cap drops an otherwise identical channel mention', async () => {
  const f = fixture({__agentReplies: {[root]: 10}});
  try { message(f.socket); await flush(); assert.equal(f.answers.length, 0);
    assert.ok(f.logs.some(x => x.event === 'buzz_agent_cap')); }
  finally { f.client.close(); }
});
test('explicit request mode drops even a mentioned agent DM', async () => {
  const f = fixture();
  try {
    f.socket.frame(['EVENT', 'groups', signEvent(peer, {kind: 39002,
      tags: [['d', channel], ['p', me], ['p', other]]})]);
    message(f.socket); await flush(); assert.equal(f.answers.length, 0);
    assert.equal(f.logs.filter(x => x.event === 'buzz_agent_cap').length, 0);
  } finally { f.client.close(); }
});
test('fresh listener starts subscriptions at current time, not a durable delivery cursor', () => {
  const f = fixture();
  try { assert.equal(f.socket.sent.find(x => x[1] === 'mentions')[2].since, 1000); }
  finally { f.client.close(); }
});

const routing = (threads = new Map()) => ({ me, allowFrom: new Set([other]), dmChannels: new Set([channel]), threads });
const routedEvent = (id, refs = []) => ({ id, kind: 9, pubkey: other, tags: [['h', channel], ...refs] });
test('new top-level DMs start distinct threads; replies preserve stored mappings', () => {
  assert.equal(route(routedEvent('first'), routing()).threadKey, 'first');
  assert.equal(route(routedEvent('second'), routing()).threadKey, 'second');
  assert.equal(route(routedEvent('third', [['e', root, '', 'reply']]), routing(new Map([[root, 'existing-thread']]))).threadKey, 'existing-thread');
});
test('an unaddressed event seen before DM metadata is not reconsidered after metadata arrives', async () => {
  const f = fixture({}, {allowFrom: [other], allowAgents: []});
  const e = signEvent(peer, {kind: 9, created_at: 1001, tags: [['h', channel]], content: 'early DM'});
  try {
    f.socket.frame(['EVENT', 'mentions', e]);
    f.socket.frame(['EVENT', 'groups', signEvent(peer, {kind: 39002, tags: [['d', channel], ['p', me], ['p', other]]})]);
    f.socket.frame(['EVENT', 'channel', e]);
    await flush(); assert.equal(f.answers.length, 0);
  } finally { f.client.close(); }
});
test('failed final publication is not retried on duplicate inbound delivery', async () => {
  let attempts = 0;
  const f = fixture({}, {send: async () => { attempts++; throw new Error('simulated relay failure'); }});
  try {
    message(f.socket); await flush(); message(f.socket); await flush();
    assert.equal(f.answers.length, 1); assert.equal(attempts, 1);
    assert.ok(f.logs.some(x => x.event === 'buzz_turn_error'));
  } finally { f.client.close(); }
});

import { sessionIdFor } from './installed/agent-turn.mjs';
test('session identity is stable per agent and thread and isolated across either', () => {
  assert.equal(sessionIdFor('Claude', root), sessionIdFor('Claude', root));
  assert.notEqual(sessionIdFor('Claude', root), sessionIdFor('Grok', root));
  assert.notEqual(sessionIdFor('Claude', root), sessionIdFor('Claude', 'different-thread'));
});
