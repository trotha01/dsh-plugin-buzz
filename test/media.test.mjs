import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { imageRefs, blossomGetAuth, fetchImage, eventImages, MAX_IMAGES } from '../media.mjs';
import { verifyEvent } from '../listen.mjs';
import { userContent, makeAnswerer } from '../agent-turn.mjs';

const RELAY = 'https://buzz.example.dev';
const SECRET = randomBytes(32).toString('hex');
const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const SHA = createHash('sha256').update(bytes).digest('hex');
const imeta = (url, m = 'image/png', x) => ['imeta', `url ${url}`, `m ${m}`, ...(x ? [`x ${x}`] : []), 'size 7'];

test('imageRefs keeps only images on this relay\'s /media/ path, matching type and sha256', () => {
  const other = 'b'.repeat(64);
  const refs = imageRefs({ tags: [
    ['p', 'x'],
    imeta(`${RELAY}/media/${SHA}.png`, 'image/png', SHA),
    imeta(`https://evil.example/media/${other}.png`),            // other origin
    imeta(`${RELAY}/media/${other}.pdf`, 'application/pdf'),       // not an image
    imeta(`${RELAY}/media/${other}.png`, 'image/png', 'c'.repeat(64)), // x does not match the path
    imeta(`${RELAY}/other/${other}.png`),                            // not /media/
    imeta(`${RELAY}/media/${SHA}.png`),                              // duplicate
  ] }, RELAY);
  assert.deepEqual(refs, [{ url: `${RELAY}/media/${SHA}.png`, sha256: SHA, mediaType: 'image/png', name: `buzz-${SHA.slice(0, 12)}.png` }]);
  const many = { tags: Array.from({ length: MAX_IMAGES + 3 }, (_, i) => imeta(`${RELAY}/media/${String(i).padStart(64, '0')}.jpg`, 'image/jpeg')) };
  assert.equal(imageRefs(many, RELAY).length, MAX_IMAGES);
});

test('blossomGetAuth is a valid signed kind 24242 get proof scoped to the blob and the relay host', () => {
  const h = blossomGetAuth(SECRET, RELAY, SHA, 1000);
  assert.match(h, /^Nostr /);
  const ev = JSON.parse(Buffer.from(h.slice(6), 'base64').toString());
  assert.equal(ev.kind, 24242);
  assert.ok(verifyEvent(ev));
  assert.deepEqual(ev.tags, [['t', 'get'], ['x', SHA], ['expiration', '1060'], ['server', 'buzz.example.dev']]);
});

test('fetchImage sends the proof, checks sha256 and size; eventImages counts failures and never throws', async () => {
  const seen = [];
  const ok = async (url, init) => { seen.push([url, init.headers.authorization.slice(0, 6), init.redirect]); return new Response(bytes, { headers: { 'content-type': 'image/png' } }); };
  const ref = imageRefs({ tags: [imeta(`${RELAY}/media/${SHA}.png`)] }, RELAY)[0];
  const img = await fetchImage(ref, { secretHex: SECRET, relayUrl: RELAY, fetchImpl: ok });
  assert.deepEqual([...img.data], [...bytes]);
  assert.deepEqual(seen, [[`${RELAY}/media/${SHA}.png`, 'Nostr ', 'error']]);
  const wrong = async () => new Response(new Uint8Array([1]));
  await assert.rejects(fetchImage(ref, { secretHex: SECRET, relayUrl: RELAY, fetchImpl: wrong }), /sha256/);
  const denied = async () => new Response('no', { status: 403 });
  assert.deepEqual(await eventImages({ tags: [imeta(`${RELAY}/media/${SHA}.png`)] }, { secretHex: SECRET, relayUrl: RELAY, fetchImpl: denied }), { images: [], failed: 1 });
  assert.deepEqual(await eventImages({ tags: [] }, { secretHex: SECRET, relayUrl: 'not a url' }), { images: [], failed: 0 });
});

const img = { data: bytes, mediaType: 'image/png', name: 'a.png' };
const ctxWith = (inputModalities, store) => ({ get: (n) => n === 'llm' ? { listModels: async () => [{ id: 'm', inputModalities }] } : n === 'attachments' ? store : undefined });

test('userContent: image models get image blocks from the attachment store', async () => {
  const saved = [];
  const store = { saveImage: async (i) => { saved.push(i); return { attachmentId: 'att-1', mediaType: i.mediaType, bytes: 7, width: 1, height: 1 }; } };
  const c = await userContent(ctxWith(['text', 'image'], store), { provider: 'p', model: 'm' }, 'what is this?', [img]);
  assert.deepEqual(c, [{ type: 'text', text: 'what is this?' }, { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 7, width: 1, height: 1 } }]);
  assert.deepEqual(saved, [{ data: bytes, mediaType: 'image/png', name: 'a.png' }]);
});

test('userContent: text-only models get a note instead, and failures are reported', async () => {
  const store = { saveImage: async () => { throw new Error('IMAGE_TOO_LARGE'); } };
  assert.deepEqual(await userContent(ctxWith(['text'], store), { provider: 'p', model: 'm' }, 'hi', [img]),
    [{ type: 'text', text: 'hi\n\n[1 image(s) attached in Buzz; this model (m) cannot see images]' }]);
  assert.deepEqual(await userContent(ctxWith(undefined, store), { provider: 'p', model: 'm' }, 'hi', [img], 1),
    [{ type: 'text', text: 'hi\n\n[1 attached image(s) could not be downloaded from Buzz; 1 attached image(s) were refused by dsh (type, size or dimensions)]' }]);
  assert.deepEqual(await userContent(ctxWith(['text']), { provider: 'p', model: 'm' }, 'plain'), [{ type: 'text', text: 'plain' }]);
});

test('makeAnswerer passes the Buzz event to deps.images and sends the image block in the user message', async () => {
  const sent = [];
  const events = [];
  const agent = { status: 'idle', session: { get seq() { return events.length; }, eventAt: (i) => events[i] },
    whenIdle: async () => {}, followup: (msg) => { sent.push(msg); events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'green' }] } } }); } };
  const store = { saveImage: async () => ({ attachmentId: 'att-9', mediaType: 'image/png', bytes: 7, width: 1, height: 1 }) };
  const ctx = { on: () => () => {}, get: (n) => n === 'agents' ? { get: () => agent } : n === 'llm' ? { listModels: async () => [{ id: 'codex', inputModalities: ['text', 'image'] }] } : n === 'attachments' ? store : undefined };
  const seenEvents = [];
  const answer = makeAnswerer(ctx, { name: 'Codex', provider: 'codex-chatgpt', model: 'codex' },
    { brandString: (s) => s, createUserMessage: (s) => s, SessionSeq: (s) => s, images: async (e) => { seenEvents.push(e.id); return { images: [img], failed: 0 }; } });
  assert.equal(await answer('colour?', { threadKey: 't', event: { id: 'ev1', tags: [] } }), 'green');
  assert.deepEqual(seenEvents, ['ev1']);
  assert.deepEqual(sent[0].content.map((b) => b.type), ['text', 'image']);
  assert.equal(sent[0].content[1].attachment.attachmentId, 'att-9');
});
