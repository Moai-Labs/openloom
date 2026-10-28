"use strict";
// Patch a MediaRecorder webm in the browser so it carries a real Duration.
// MediaRecorder writes the Segment and its Clusters with "unknown"
// (all-ones) sizes and omits the Info.Duration element, so players cannot
// show a length. The patch adds Duration by rebuilding only the Info
// element and copying everything else byte-for-byte, so the uploaded file
// keeps the container structure the server verifies. Returns null when the
// layout is unfamiliar.
//
// The exact code the recorder page runs — loaded from /webm-patch.js by the
// browser, required by the tests here — so a patch the tests accept is the
// patch recordings get.

// Returns {value, len, unknown} for a vint, or null when malformed or cut
// short. ids keep the marker bit set.
function webmVint(bytes, off, isId) {
  if (off >= bytes.length) return null;
  const first = bytes[off];
  if (!first) return null;
  let len = 1;
  for (let mask = 0x80; !(first & mask); mask >>= 1) {
    len++;
    if (len > 8) return null;
  }
  if (off + len > bytes.length) return null;
  const maskBits = 0xff >>> len;
  let value = isId ? first : first & maskBits;
  let allOnes = !isId && (first & maskBits) === maskBits;
  for (let i = 1; i < len; i++) {
    const b = bytes[off + i];
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  return { value, len, unknown: allOnes };
}

// Children of a container region; null when it does not parse cleanly.
function webmChildren(bytes, start, end) {
  const out = [];
  let pos = start;
  while (pos < end) {
    const id = webmVint(bytes, pos, true);
    if (!id) return null;
    const size = webmVint(bytes, pos + id.len, false);
    if (!size) return null;
    const bodyStart = pos + id.len + size.len;
    if (bodyStart > end) return null;
    const bodyEnd = size.unknown ? end : Math.min(bodyStart + size.value, end);
    out.push({ id: id.value, start: pos, bodyStart, bodyEnd, next: bodyEnd });
    if (size.unknown) return out; // nothing can be seen past an unknown-size element
    pos = bodyEnd;
  }
  return out;
}

// Encodes an EBML size vint: the marker bit names the byte length — 0x80
// for one byte, 0x40 for two, 0x20 for three — and the data bits fill the
// rest. Every bit set would mean "unknown size", so the largest encodable
// value in len bytes is 2^(7*len) - 2 and the encoder widens one byte
// before a value would reach it (127 needs two bytes, 16383 needs three).
// Division by 256**k, never a 32-bit shift, keeps sizes past 2^31 correct.
function webmSizeVint(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2 ** 56 - 2) {
    throw new RangeError("size out of the EBML vint range");
  }
  let len = 1;
  while (len < 8 && value > 2 ** (7 * len) - 2) len++;
  const out = new Uint8Array(len);
  for (let i = 1; i < len; i++) {
    out[i] = Math.floor(value / 256 ** (len - 1 - i)) & 0xff;
  }
  if (len < 8) {
    out[0] = (Math.floor(value / 256 ** (len - 1)) & (0xff >> len)) | (0x80 >> (len - 1));
  } else {
    out[0] = 0x01; // eight bytes: a first byte with no data bits at all
  }
  return out;
}

async function patchWebmDuration(blob, durationMs) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const top = webmChildren(bytes, 0, bytes.length);
  if (!top || top.length < 2) return null;
  const ebml = top[0];
  const segId = webmVint(bytes, ebml.next, true);
  const segSize = segId && segId.value === 0x18538067 ? webmVint(bytes, ebml.next + segId.len, false) : null;
  // only the head is rebuilt, so it must sit inside an unknown-size Segment
  if (!segSize || !segSize.unknown) return null;
  const kids = webmChildren(bytes, ebml.next + segId.len + segSize.len, bytes.length);
  if (!kids) return null;
  const info = kids.find((el) => el.id === 0x1549a966);
  if (!info || info.next !== info.bodyEnd) return null;
  const parts = webmChildren(bytes, info.bodyStart, info.bodyEnd);
  if (!parts) return null;
  let scale = 1000000;
  const kept = [];
  for (const part of parts) {
    if (part.id === 0x4489) continue; // old Duration, replaced below
    if (part.id === 0x2ad7b1 && part.bodyEnd - part.bodyStart <= 8) {
      let v = 0;
      for (let i = part.bodyStart; i < part.bodyEnd; i++) v = v * 256 + bytes[i];
      if (v > 0) scale = v;
    }
    kept.push(bytes.slice(part.start, part.next));
  }
  const dur = new Uint8Array(11);
  dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88;
  new DataView(dur.buffer).setFloat64(3, durationMs * 1000000 / scale);
  const bodyLen = kept.reduce((n, p) => n + p.length, 0) + 11;
  const out = [bytes.slice(0, info.start), new Uint8Array([0x15, 0x49, 0xa9, 0x66]), webmSizeVint(bodyLen), ...kept, dur, bytes.slice(info.next)];
  return new Blob(out, { type: blob.type });
}

const api = { webmVint, webmChildren, webmSizeVint, patchWebmDuration };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof self !== "undefined") self.OpenLoomWebmPatch = api;
