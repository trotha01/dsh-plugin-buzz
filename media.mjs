// Images attached in Buzz -> image bytes for the dsh turn.
// Buzz desktop and `buzz messages send --file` upload a file to the relay's Blossom store and put an `imeta` tag
// (NIP-92) on the message: ["imeta", "url https://<relay>/media/<sha256>.<ext>", "m image/png", "x <sha256>", ...].
// The relay serves /media/<sha256>[.<ext>] only with a Blossom (BUD-01) proof: a kind 24242 event with t=get,
// x=<sha256>, server=<relay host> and a short expiration, signed by a member, in `Authorization: Nostr <base64>`.
// Only images on this relay's own /media/ path are fetched (never a third-party URL), each is checked against its
// sha256, and type and size are capped.
import { createHash } from "node:crypto";
import { signEvent } from "./listen.mjs";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MEDIA_PATH = /^\/media\/([0-9a-f]{64})(?:\.([a-z0-9]{1,8}))?$/;
const EXT_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** imeta tag -> { url, m, x, ... } (each entry after the tag name is "key value"). */
export function parseImeta(tag) {
  const out = {};
  for (const entry of tag.slice(1)) {
    if (typeof entry !== "string") continue;
    const i = entry.indexOf(" ");
    if (i > 0 && !(entry.slice(0, i) in out)) out[entry.slice(0, i)] = entry.slice(i + 1).trim();
  }
  return out;
}

/** The images of one Buzz event that this relay stores: [{ url, sha256, mediaType, name }], at most MAX_IMAGES. */
export function imageRefs(event, relayUrl) {
  const relay = new URL(relayUrl);
  const refs = [];
  for (const tag of Array.isArray(event?.tags) ? event.tags : []) {
    if (!Array.isArray(tag) || tag[0] !== "imeta") continue;
    const meta = parseImeta(tag);
    let u; try { u = new URL(meta.url); } catch { continue; }
    if (u.origin !== relay.origin || u.search || u.hash) continue;
    const m = MEDIA_PATH.exec(u.pathname);
    if (!m) continue;
    const mediaType = IMAGE_TYPES.includes(meta.m) ? meta.m : EXT_TYPES[m[2]];
    if (!mediaType || (meta.m && meta.m !== mediaType)) continue;
    if (meta.x && meta.x !== m[1]) continue;
    if (refs.some((r) => r.sha256 === m[1])) continue;
    refs.push({ url: u.href, sha256: m[1], mediaType, name: `buzz-${m[1].slice(0, 12)}.${m[2] || mediaType.slice(6)}` });
    if (refs.length === MAX_IMAGES) break;
  }
  return refs;
}

/** Authorization header value for a Blossom get of `sha256` on the relay, signed with `secretHex`. */
export function blossomGetAuth(secretHex, relayUrl, sha256, nowSec = Math.floor(Date.now() / 1000)) {
  const ev = signEvent(secretHex, { kind: 24242, content: "Get media", created_at: nowSec,
    tags: [["t", "get"], ["x", sha256], ["expiration", String(nowSec + 60)], ["server", new URL(relayUrl).host]] });
  return "Nostr " + Buffer.from(JSON.stringify(ev)).toString("base64");
}

/** Fetch one image ref; resolves to { data: Uint8Array, mediaType, name } or throws a short, secret-free error. */
export async function fetchImage(ref, { secretHex, relayUrl, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
  const r = await fetchImpl(ref.url, { headers: { authorization: blossomGetAuth(secretHex, relayUrl, ref.sha256) }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`image download failed (HTTP ${r.status})`);
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_IMAGE_BYTES) throw new Error("image is larger than 10 MB");
  const data = new Uint8Array(await r.arrayBuffer());
  if (data.length > MAX_IMAGE_BYTES) throw new Error("image is larger than 10 MB");
  if (createHash("sha256").update(data).digest("hex") !== ref.sha256) throw new Error("image does not match its sha256");
  return { data, mediaType: ref.mediaType, name: ref.name };
}

/** All images of an event: { images: [...], failed: n }. Never throws. */
export async function eventImages(event, opts) {
  let refs; try { refs = imageRefs(event, opts.relayUrl); } catch { return { images: [], failed: 0 }; }
  const results = await Promise.allSettled(refs.map((ref) => fetchImage(ref, opts)));
  return { images: results.filter((r) => r.status === "fulfilled").map((r) => r.value), failed: results.filter((r) => r.status === "rejected").length };
}
