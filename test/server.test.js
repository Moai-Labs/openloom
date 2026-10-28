"use strict";
// API tests for the clip server. They boot the real server on an ephemeral
// port with a throwaway data directory and talk to it over HTTP.

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-test-"));
process.env.PORT = "0";
process.env.MAX_UPLOAD_BYTES = String(64 * 1024); // absolute guard, small so tests can hit it
// free-plan limits, shrunk so tests exercise them without real payloads
process.env.FREE_MAX_CLIPS = "2";
process.env.FREE_MAX_CLIP_BYTES = String(16 * 1024);
process.env.FREE_MAX_DURATION_MS = "30000";
// paid-plan limits, shrunk so tests exercise them without real payloads
process.env.PAID_MAX_CLIPS = "50";
process.env.PAID_MAX_TOTAL_BYTES = String(13 * 1024);

const server = require("../server.js");
const { Store } = require("../lib/store");
const { Accounts } = require("../lib/accounts");
const { readTar } = require("../lib/tar");
const { readWebmDurationMs, WebmDurationScanner } = require("../lib/webm-duration");
const webmPatch = require("../lib/webm-patch");
const payments = require("../lib/payments");

// The server listens inside its own async boot; wait for the port.
async function waitForListen() {
  for (let i = 0; i < 100; i++) {
    if (server.listening) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("server never started listening");
}
let base = "";

test("server boots and serves pages", async () => {
  await waitForListen();
  base = `http://127.0.0.1:${server.address().port}`;
  // wait until the pages have loaded too (they load right after the store boots)
  for (let i = 0; i < 100; i++) {
    const res = await request("GET", "/").catch(() => null);
    if (res && res.status === 200) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("pages never became available");
});

function request(method, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + urlPath, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on("error", reject);
    if (body) req.end(body); else req.end();
  });
}

// account helpers -----------------------------------------------------------

async function makeAccount(email) {
  const res = await request("POST", "/api/accounts", {
    body: JSON.stringify({ email, password: "correct horse battery" }),
    headers: { "content-type": "application/json" }
  });
  assert.equal(res.status, 201, "account creation should work: " + res.body);
  return JSON.parse(res.body);
}

async function uploadClip(token, { payload, bytes = 2048, title, durationMs, contentType = "video/webm" } = {}) {
  const headers = {
    "content-type": contentType,
    authorization: `Bearer ${token}`
  };
  if (title !== undefined) headers["x-title"] = encodeURIComponent(title);
  if (durationMs !== undefined) headers["x-duration-ms"] = String(durationMs);
  // the server verifies a webm's duration from the file itself, so the
  // default payload is a real one whose media timeline matches the header
  const body = payload || webmPayload(bytes, durationMs ?? 1000);
  const res = await request("POST", "/api/clips", { body, headers });
  return { res, clip: res.status === 201 ? JSON.parse(res.body) : null };
}

// --- pages and limits ------------------------------------------------------

test("health check answers", async () => {
  const res = await request("GET", "/healthz");
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

test("recorder page is served at /", async () => {
  const res = await request("GET", "/");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.ok(res.body.toString().includes("Start recording"));
});

test("the limits page is published", async () => {
  const res = await request("GET", "/limits");
  assert.equal(res.status, 200);
  const html = res.body.toString();
  assert.ok(html.includes("3 stored clips"));
  assert.ok(html.includes("5 minutes"));
  assert.ok(html.includes("100 MB"));
  assert.ok(html.includes("test USDC"), "the paid plan says how it is paid");
  assert.ok(!html.includes("not available yet"), "the paid plan is available now");
});

test("the limits API states the free plan and the paid plan", async () => {
  const res = await request("GET", "/api/limits");
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.plan, "free");
  assert.equal(data.maxClips, 2); // as shrunk by env for this suite
  assert.equal(data.maxDurationMs, 30000);
  assert.equal(data.maxClipBytes, 16 * 1024);
  assert.equal(data.priceUsd, 10);
  assert.equal(data.paidPlan.totalBytes, 13 * 1024); // as shrunk by env for this suite
  assert.equal(data.test, true);
  assert.match(data.notice, /test/i);
});

test("the upgrade page is published and says payments are tests", async () => {
  const res = await request("GET", "/upgrade");
  assert.equal(res.status, 200);
  const html = res.body.toString();
  assert.ok(html.includes("test payment"), "the page labels the payment a test");
  assert.ok(html.includes("2 GB"));
});

test("watch page is served at /v/<id>", async () => {
  const res = await request("GET", "/v/ABCDEFGHIJKLMNOPQR");
  assert.equal(res.status, 200);
  assert.ok(res.body.toString().includes("watch"));
});

// --- accounts --------------------------------------------------------------

test("sign up, sign in, sign out", async () => {
  const made = await makeAccount("ada@example.com");
  assert.match(made.token, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(made.email, "ada@example.com");

  // duplicate signup is refused
  const dup = await request("POST", "/api/accounts", {
    body: JSON.stringify({ email: "ada@example.com", password: "correct horse battery" }),
    headers: { "content-type": "application/json" }
  });
  assert.equal(dup.status, 409);

  // validation
  const weak = await request("POST", "/api/accounts", {
    body: JSON.stringify({ email: "short@example.com", password: "short" }),
    headers: { "content-type": "application/json" }
  });
  assert.equal(weak.status, 400);
  const badEmail = await request("POST", "/api/accounts", {
    body: JSON.stringify({ email: "not-an-email", password: "correct horse battery" }),
    headers: { "content-type": "application/json" }
  });
  assert.equal(badEmail.status, 400);
  const notJson = await request("POST", "/api/accounts", { body: "hello", headers: {} });
  assert.equal(notJson.status, 400);

  // login: right and wrong
  const good = await request("POST", "/api/sessions", {
    body: JSON.stringify({ email: "ada@example.com", password: "correct horse battery" }),
    headers: { "content-type": "application/json" }
  });
  assert.equal(good.status, 200);
  const secondToken = JSON.parse(good.body).token;
  const bad = await request("POST", "/api/sessions", {
    body: JSON.stringify({ email: "ada@example.com", password: "wrong" }),
    headers: { "content-type": "application/json" }
  });
  assert.equal(bad.status, 401);
  const noUser = await request("POST", "/api/sessions", {
    body: JSON.stringify({ email: "nobody@example.com", password: "correct horse battery" }),
    headers: { "content-type": "application/json" }
  });
  assert.equal(noUser.status, 401);

  // me
  const anon = await request("GET", "/api/me");
  assert.equal(anon.status, 401);
  const mine = await request("GET", "/api/me", { headers: { authorization: `Bearer ${made.token}` } });
  assert.equal(mine.status, 200);
  const meBody = JSON.parse(mine.body);
  assert.equal(meBody.email, "ada@example.com");
  assert.equal(meBody.usage.clips, 0);
  assert.equal(meBody.limits.maxClips, 2);

  // logout kills the session it belongs to
  const out = await request("DELETE", "/api/sessions/current", { headers: { authorization: `Bearer ${secondToken}` } });
  assert.equal(out.status, 204);
  assert.equal((await request("GET", "/api/me", { headers: { authorization: `Bearer ${secondToken}` } })).status, 401);
  // the first session still works
  assert.equal((await request("GET", "/api/me", { headers: { authorization: `Bearer ${made.token}` } })).status, 200);
});

test("session tokens are not stored in plaintext", async () => {
  const made = await makeAccount("hashcheck@example.com");
  const raw = fs.readFileSync(path.join(process.env.DATA_DIR, "accounts.json"), "utf8");
  assert.ok(!raw.includes(made.token));
  assert.ok(raw.includes("passwordHash"));
  await request("DELETE", "/api/my/account", { headers: { authorization: `Bearer ${made.token}` } });
});

// --- uploads need an account, and carry the owner --------------------------

test("uploads require an account", async () => {
  const res = await request("POST", "/api/clips", {
    body: crypto.randomBytes(64),
    headers: { "content-type": "video/webm" }
  });
  assert.equal(res.status, 401);
  const message = JSON.parse(res.body).error;
  assert.match(message, /sign up|sign in/i);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);
});

test("full clip lifecycle: create, metadata, play, download, delete by session", async () => {
  const { token } = await makeAccount("lifecycle@example.com");
  const payload = webmPayload(2048, 4200);
  const { res: create, clip } = await uploadClip(token, { payload, title: "Sprint demo #1", durationMs: 4200 });
  assert.equal(create.status, 201);
  assert.match(clip.id, /^[A-Za-z0-9_-]{10,64}$/);
  assert.equal(clip.sharePath, `/v/${clip.id}`);
  assert.ok(clip.managePath.includes(clip.id));
  assert.ok(clip.manageToken.length > 20);

  // metadata
  const meta = await request("GET", `/api/clips/${clip.id}`);
  assert.equal(meta.status, 200);
  const metaBody = JSON.parse(meta.body);
  assert.equal(metaBody.title, "Sprint demo #1");
  assert.equal(metaBody.bytes, payload.length);
  assert.equal(metaBody.durationMs, 4200);
  assert.equal(metaBody.filename, "Sprint demo #1.webm");
  assert.equal(metaBody.contentType, "video/webm");
  // the public metadata does not leak ownership internals
  assert.ok(!("accountId" in metaBody));
  assert.ok(!("tokenHash" in metaBody));

  // playback (full body)
  const file = await request("GET", `/api/clips/${clip.id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.headers["content-type"], "video/webm");
  assert.equal(file.headers["accept-ranges"], "bytes");
  assert.deepEqual(file.body, payload);
  assert.ok(!("content-disposition" in file.headers));

  // range request (what a seeking video element does)
  const partial = await request("GET", `/api/clips/${clip.id}/file`, {
    headers: { range: "bytes=100-199" }
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers["content-range"], `bytes 100-199/${payload.length}`);
  assert.deepEqual(partial.body, payload.subarray(100, 200));

  // open-ended and suffix ranges
  const openEnded = await request("GET", `/api/clips/${clip.id}/file`, {
    headers: { range: "bytes=2000-" }
  });
  assert.equal(openEnded.status, 206);
  assert.deepEqual(openEnded.body, payload.subarray(2000));

  // download attachment
  const download = await request("GET", `/api/clips/${clip.id}/file?download=1`);
  assert.equal(download.status, 200);
  assert.match(download.headers["content-disposition"], /attachment/);
  assert.match(download.headers["content-disposition"], /Sprint demo #1\.webm/);

  // deletion needs the owner's session or the manage token
  const noAuth = await request("DELETE", `/api/clips/${clip.id}`);
  assert.equal(noAuth.status, 403);
  const right = await request("DELETE", `/api/clips/${clip.id}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(right.status, 204);

  const gone = await request("GET", `/api/clips/${clip.id}`);
  assert.equal(gone.status, 404);
  const fileGone = await request("GET", `/api/clips/${clip.id}/file`);
  assert.equal(fileGone.status, 404);
  const again = await request("DELETE", `/api/clips/${clip.id}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(again.status, 404);
});

test("the manage token still deletes when signed out", async () => {
  const { token } = await makeAccount("managekey@example.com");
  const { clip } = await uploadClip(token, {});
  const wrong = await request("DELETE", `/api/clips/${clip.id}`, {
    headers: { authorization: "Bearer not-the-token" }
  });
  assert.equal(wrong.status, 403);
  const right = await request("DELETE", `/api/clips/${clip.id}`, {
    headers: { authorization: `Bearer ${clip.manageToken}` }
  });
  assert.equal(right.status, 204);
});

test("another account's session cannot delete a clip it does not own", async () => {
  const a = await makeAccount("owner@example.com");
  const b = await makeAccount("stranger@example.com");
  const { clip } = await uploadClip(a.token, {});
  const res = await request("DELETE", `/api/clips/${clip.id}`, {
    headers: { authorization: `Bearer ${b.token}` }
  });
  assert.equal(res.status, 403);
  // and b cannot list or see it in their own list
  const listB = JSON.parse((await request("GET", "/api/my/clips", { headers: { authorization: `Bearer ${b.token}` } })).body);
  assert.deepEqual(listB.clips, []);
  const listA = JSON.parse((await request("GET", "/api/my/clips", { headers: { authorization: `Bearer ${a.token}` } })).body);
  assert.equal(listA.clips.length, 1);
  assert.equal(listA.clips[0].id, clip.id);
  // cleanup for the clip-count tests below
  await request("DELETE", `/api/clips/${clip.id}`, { headers: { authorization: `Bearer ${clip.manageToken}` } });
});

test("untitled uploads get a default filename and null title", async () => {
  const { token } = await makeAccount("untitled@example.com");
  const { res, clip } = await uploadClip(token, { bytes: 64 });
  assert.equal(res.status, 201);
  const meta = JSON.parse((await request("GET", `/api/clips/${clip.id}`)).body);
  assert.equal(meta.title, null);
  assert.equal(meta.filename, "recording.webm");
  await request("DELETE", `/api/clips/${clip.id}`, { headers: { authorization: `Bearer ${clip.manageToken}` } });
});

test("non-video content types are refused", async () => {
  const { token } = await makeAccount("mimes@example.com");
  const res = await request("POST", "/api/clips", {
    body: Buffer.from("hello"),
    headers: { "content-type": "text/plain", authorization: `Bearer ${token}` }
  });
  assert.equal(res.status, 415);
});

// --- the free limits -------------------------------------------------------

test("a clip over the size cap is refused and leaves nothing behind", async () => {
  const { token } = await makeAccount("sizecap@example.com");
  const res = await request("POST", "/api/clips", {
    body: crypto.randomBytes(16 * 1024 + 100),
    headers: { "content-type": "video/webm", authorization: `Bearer ${token}` }
  });
  assert.equal(res.status, 413);
  assert.match(JSON.parse(res.body).error, /free plan/i);
  const storeDir = path.join(process.env.DATA_DIR, "clips");
  assert.deepEqual(fs.readdirSync(storeDir), []);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "tmp")), []);
});

test("a clip over the duration cap is refused on the declared duration", async () => {
  const { token } = await makeAccount("durcap@example.com");
  // well past the cap plus the encoder slop the auto-stopped recorder needs
  const { res } = await uploadClip(token, { bytes: 1024, durationMs: 60000 });
  assert.equal(res.status, 413);
  assert.match(JSON.parse(res.body).error, /free plan/i);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);
});

test("a webm whose real timeline exceeds the cap is refused even when the header and Duration lie", async () => {
  const { token } = await makeAccount("webmcap@example.com");
  // 40 s of media timeline; both the Info.Duration element and the header
  // claim one second
  const webm = minimalWebm(40000, { declaredMs: 1000 });
  const res = await request("POST", "/api/clips", {
    body: webm,
    headers: {
      "content-type": "video/webm",
      "x-duration-ms": "1000",
      authorization: `Bearer ${token}`
    }
  });
  assert.equal(res.status, 413);
  assert.match(JSON.parse(res.body).error, /40|minute/i);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);
});

test("a webm whose BlockDuration stretches the timeline past the cap is refused", async () => {
  const { token } = await makeAccount("webmblockdur@example.com");
  // every block timestamp sits at zero, but the file itself says the final
  // block runs ten minutes — the old read discarded that as too long and
  // stored the clip as a 0 ms one
  const webm = webmFile({ blockGroups: [{ clusterMs: 0, relMs: 0, blockDuration: 600000 }] });
  const res = await request("POST", "/api/clips", {
    body: webm,
    headers: {
      "content-type": "video/webm",
      "x-duration-ms": "1000",
      authorization: `Bearer ${token}`
    }
  });
  assert.equal(res.status, 413);
  assert.match(JSON.parse(res.body).error, /minute/i);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);
});

test("a webm that parses briefly and then turns malformed is refused — no partial duration", async () => {
  const { token } = await makeAccount("webmtrunc@example.com");
  // 8 s of readable timeline, then garbage where a further element would be
  const webm = Buffer.concat([minimalWebm(8000), Buffer.from([0x00, 0x01, 0x02])]);
  const res = await request("POST", "/api/clips", {
    body: webm,
    headers: { "content-type": "video/webm", authorization: `Bearer ${token}` }
  });
  assert.equal(res.status, 413);
  assert.match(JSON.parse(res.body).error, /verif/i);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);
});

test("a webm with an omitted Duration is still enforced from its timeline", async () => {
  const { token } = await makeAccount("webmnodur@example.com");
  const over = await request("POST", "/api/clips", {
    body: minimalWebm(40000, { omitDuration: true }),
    headers: { "content-type": "video/webm", authorization: `Bearer ${token}` }
  });
  assert.equal(over.status, 413);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);
  const ok = await request("POST", "/api/clips", {
    body: minimalWebm(8000, { omitDuration: true }),
    headers: { "content-type": "video/webm", authorization: `Bearer ${token}` }
  });
  assert.equal(ok.status, 201);
  const clip = JSON.parse(ok.body);
  const meta = JSON.parse((await request("GET", `/api/clips/${clip.id}`)).body);
  assert.equal(meta.durationMs, 8000);
  await request("DELETE", `/api/clips/${clip.id}`, { headers: { authorization: `Bearer ${clip.manageToken}` } });
});

test("a webm that carries no verifiable timeline is refused — fail closed", async () => {
  const { token } = await makeAccount("webmgarbage@example.com");
  // a header can claim anything, so bytes the parser cannot read cannot be stored
  const res = await uploadClip(token, { payload: crypto.randomBytes(2048), durationMs: 1000 });
  assert.equal(res.res.status, 413);
  assert.match(JSON.parse(res.res.body).error, /verif/i);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);
  // a webm-shaped file with Info but no cluster timestamps either
  const noTimeline = await uploadClip(token, { payload: webmPayload(512, 1000, { noTimeline: true }), durationMs: 1000 });
  assert.equal(noTimeline.res.status, 413);
  assert.match(JSON.parse(noTimeline.res.body).error, /verif/i);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);
});

test("a webm within the cap gets its parsed duration recorded", async () => {
  const { token } = await makeAccount("webmok@example.com");
  const webm = minimalWebm(8000); // 8 s inside the file, nothing declared
  const res = await request("POST", "/api/clips", {
    body: webm,
    headers: { "content-type": "video/webm", authorization: `Bearer ${token}` }
  });
  assert.equal(res.status, 201);
  const clip = JSON.parse(res.body);
  const meta = JSON.parse((await request("GET", `/api/clips/${clip.id}`)).body);
  assert.equal(meta.durationMs, 8000);
  await request("DELETE", `/api/clips/${clip.id}`, { headers: { authorization: `Bearer ${clip.manageToken}` } });
});

test("the parser reads real durations from the media timeline", () => {
  assert.equal(readWebmDurationMs(minimalWebm(6500)), 6500);
  // an understated Info.Duration is ignored in favour of the block timecodes
  assert.equal(readWebmDurationMs(minimalWebm(6500, { declaredMs: 1 })), 6500);
  assert.equal(readWebmDurationMs(Buffer.from("not a webm")), null);
  assert.equal(readWebmDurationMs(Buffer.alloc(0)), null);
});

test("an asserted BlockDuration counts in full, however long", () => {
  // a block at timestamp zero whose explicit BlockDuration says ten minutes:
  // the file's own word, and never to be discarded in favour of a shorter read
  const webm = webmFile({ blockGroups: [{ clusterMs: 0, relMs: 0, blockDuration: 600000 }] });
  assert.equal(readWebmDurationMs(webm), 600000);
});

test("a track DefaultDuration counts in full, however long", () => {
  const webm = webmFile({
    tracks: [{ trackNumber: 1, defaultNs: 600e9 }],
    spans: [[0, 0]]
  });
  assert.equal(readWebmDurationMs(webm), 600000);
});

test("a laced block is measured through its frame count and the track default", () => {
  const webm = webmFile({
    tracks: [{ trackNumber: 1, defaultNs: 600e9 }],
    laced: [{ clusterMs: 0, relMs: 0, frames: 2 }]
  });
  assert.equal(readWebmDurationMs(webm), 1200000);
  // within the cap: two 33 ms frames from the default
  const sane = webmFile({
    tracks: [{ trackNumber: 1, defaultNs: 33e6 }],
    laced: [{ clusterMs: 0, relMs: 0, frames: 2 }]
  });
  assert.equal(readWebmDurationMs(sane), 66);
});

// Feeds a file to a scanner `size` bytes at a time; Infinity pushes it whole.
function pushedInChunks(buf, size) {
  const scanner = new WebmDurationScanner();
  if (size === Infinity) {
    scanner.push(buf);
    return scanner.end();
  }
  for (let i = 0; i < buf.length; i += size) {
    scanner.push(buf.subarray(i, Math.min(i + size, buf.length)));
  }
  return scanner.end();
}

// Raw heads for tests that need deliberately malformed structure: the EBML
// header, an unknown-size Segment, an Info with TimestampScale 1e6.
function rawWebmHead() {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]),
    Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40])
  ]);
}
const CLUSTER_UNKNOWN = Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
function clusterTimestamp(ms) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(ms, 0);
  return Buffer.concat([Buffer.from([0xe7, 0x84]), b]);
}
// A Tracks element with one TrackEntry per {trackNumber, defaultNs}, built
// apart from webmFile so a test can place it after the clusters.
function tracksElement(entries) {
  const body = Buffer.concat(entries.map(({ trackNumber, defaultNs }) => {
    const durBody = Buffer.alloc(uintBodySize(defaultNs));
    let v = defaultNs;
    for (let i = durBody.length - 1; i >= 0; i--) { durBody[i] = v & 0xff; v = Math.floor(v / 256); }
    const entryBody = Buffer.concat([
      Buffer.from([0xd7, 0x81, trackNumber]),
      Buffer.from([0x23, 0xe3, 0x83, 0x80 | durBody.length]), durBody
    ]);
    return Buffer.concat([Buffer.from([0xae, 0x80 | entryBody.length]), entryBody]);
  }));
  return Buffer.concat([Buffer.from([0x16, 0x54, 0xae, 0x6b, 0x80 | body.length]), body]);
}

test("Tracks arriving after blocks are refused — a late DefaultDuration must not measure blocks short", () => {
  // a block at timestamp zero with no Tracks in sight reads as 0 ms; a
  // ten-minute DefaultDuration declared behind it would then govern
  // playback while the measured timeline stays at zero. The scanner never
  // reconciles metadata that arrives late: the ordering itself is refused.
  const base = webmFile({ spans: [[0, 0]] }); // Info + one block at ts 0, no Tracks
  const late = Buffer.concat([base, tracksElement([{ trackNumber: 1, defaultNs: 600e9 }])]);
  assert.equal(readWebmDurationMs(late), null);
  for (const size of [4096, 64, 7, 3, 2, 1]) {
    assert.equal(pushedInChunks(late, size), null, `chunk size ${size}`);
  }
});

test("a track that scales its own timestamps is refused, not silently skipped", () => {
  // TrackTimestampScale changes how the track's blocks map onto the segment
  // timeline — supported playback runs at a speed the measured timeline
  // does not describe. The scanner cannot verify that clock, so the file is
  // refused instead of reported at the default scale.
  const scale = Buffer.alloc(8);
  scale.writeDoubleBE(2, 0); // playback at half the measured speed
  const tts = Buffer.concat([Buffer.from([0x23, 0x31, 0x4f, 0x80 | scale.length]), scale]);
  const webm = webmFile({
    tracks: [{ trackNumber: 1, defaultNs: 33e6, extraElements: [tts] }],
    spans: [[0, 0]]
  });
  assert.equal(readWebmDurationMs(webm), null);
  for (const size of [4096, 64, 7, 3, 2, 1]) {
    assert.equal(pushedInChunks(webm, size), null, `chunk size ${size}`);
  }
});

test("a block whose body cannot hold its header is malformed even with the next element buffered", () => {
  // the SimpleBlock declares a 2-byte body — one track byte plus one byte of
  // what should be its timecode — and the next SimpleBlock's bytes sit
  // directly behind it in the same buffer. Judging the header by what
  // happens to be buffered would let a short block consume the element that
  // follows; it is judged against the declared body instead.
  const webm = Buffer.concat([
    rawWebmHead(),
    CLUSTER_UNKNOWN,
    clusterTimestamp(0),
    Buffer.from([0xa3, 0x82, 0x81, 0x00]), // declared body: 2 bytes, a header needs 4
    // a 5 s block right behind it, complete with a 9-byte body, so the only
    // defect in the file is the short block's own header
    Buffer.from([0xa3, 0x89, 0x81, 0x13, 0x88, 0x00, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e])
  ]);
  for (const size of [Infinity, 4096, 64, 7, 3, 2, 1]) {
    assert.equal(pushedInChunks(webm, size), null, `chunk size ${size}`);
  }
});

test("an unknown-size child cannot overrun the bounded parent that encloses it", () => {
  // a known-size Segment holds an unknown-size Cluster whose SimpleBlock
  // claims a body running past the Segment's end — and the file physically
  // carries a Void behind that end, so this is invalid structure, not
  // truncation. The block is judged against the Segment boundary even
  // though its immediate parent (the cluster) has none.
  const bodyBytes = 40;
  const info = Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]);
  const block = Buffer.concat([Buffer.from([0xa3]), sizeVint(60), Buffer.alloc(60, 0x11)]);
  const segmentSize = info.length + CLUSTER_UNKNOWN.length + clusterTimestamp(0).length + 2 + bodyBytes;
  const webm = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]),
    Buffer.from([0x18, 0x53, 0x80, 0x67]), sizeVint(segmentSize), // the Segment, size declared
    info,
    CLUSTER_UNKNOWN, // the cluster never declares a size
    clusterTimestamp(0),
    block, // its body runs 20 bytes past the Segment's declared end
    Buffer.from([0xec, 0x81, 0x00]) // and a real element follows, past the boundary
  ]);
  for (const size of [Infinity, 4096, 64, 7, 3, 2, 1]) {
    assert.equal(pushedInChunks(webm, size), null, `chunk size ${size}`);
  }
});

test("a laced block whose track asserts no frame duration is refused", () => {
  const webm = webmFile({ laced: [{ clusterMs: 0, relMs: 0, frames: 2 }] });
  assert.equal(readWebmDurationMs(webm), null);
});

// --- round 5: blocks are measured only on a verified Cluster Timestamp ------
// A block's timecode is relative to its own Cluster's Timestamp. Measuring a
// block before that Timestamp has arrived — substituting zero — reads a
// block followed by a ten-minute Timestamp as near zero, and nothing later
// corrects it. The scanner defers every block's measurement to its cluster's
// exit and refuses a cluster whose Timestamp never arrives or contradicts
// itself. simpleBlock(): a track-1 SimpleBlock with a relative timecode.

function simpleBlock(relMs) {
  const body = Buffer.concat([
    Buffer.from([0x81]), // track number 1
    (() => { const b = Buffer.alloc(2); b.writeInt16BE(relMs, 0); return b; })(),
    Buffer.from([0x00, 0x00]) // flags and a first payload byte
  ]);
  return Buffer.concat([Buffer.from([0xa3]), sizeVint(body.length), body]);
}

test("blocks met before their cluster's Timestamp are measured once it arrives", () => {
  // the blocks come first; the Timestamp arrives later and is the base for
  // every block in the cluster — the ten-minute one lifts them, never zeroes
  // them. Absolute times: 600000, 601000, 600500; the fallback adds the last
  // observed frame gap (1000 ms) to the highest timestamp.
  const webm = Buffer.concat([
    rawWebmHead(),
    CLUSTER_UNKNOWN,
    simpleBlock(0),
    simpleBlock(1000),
    clusterTimestamp(600000),
    simpleBlock(500)
  ]);
  assert.equal(readWebmDurationMs(webm), 602000);
  for (const size of [4096, 64, 7, 3, 2, 1]) {
    assert.equal(pushedInChunks(webm, size), 602000, `chunk size ${size}`);
  }
});

test("a cluster holding blocks that never names a Timestamp is refused", () => {
  const webm = Buffer.concat([rawWebmHead(), CLUSTER_UNKNOWN, simpleBlock(0), simpleBlock(1000)]);
  for (const size of [Infinity, 4096, 64, 7, 3, 2, 1]) {
    assert.equal(pushedInChunks(webm, size), null, `chunk size ${size}`);
  }
});

test("two different Cluster Timestamps in one cluster are refused", () => {
  const webm = Buffer.concat([
    rawWebmHead(),
    CLUSTER_UNKNOWN,
    clusterTimestamp(0),
    simpleBlock(0),
    clusterTimestamp(600000),
    simpleBlock(1000)
  ]);
  for (const size of [Infinity, 4096, 64, 7, 3, 2, 1]) {
    assert.equal(pushedInChunks(webm, size), null, `chunk size ${size}`);
  }
});

test("a repeated equal Cluster Timestamp is allowed", () => {
  const webm = Buffer.concat([
    rawWebmHead(),
    CLUSTER_UNKNOWN,
    clusterTimestamp(1000),
    simpleBlock(0),
    clusterTimestamp(1000),
    simpleBlock(500)
  ]);
  // absolute 1000, 1500; the fallback adds the observed 500 ms gap
  for (const size of [Infinity, 4096, 7, 3, 1]) {
    assert.equal(pushedInChunks(webm, size), 2000, `chunk size ${size}`);
  }
});

test("a zero TimestampScale stops the clock and is refused", () => {
  const head = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]),
    Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x84, 0x2a, 0xd7, 0xb1, 0x81, 0x00]) // scale 0
  ]);
  const webm = Buffer.concat([head, CLUSTER_UNKNOWN, clusterTimestamp(0), simpleBlock(1000)]);
  assert.equal(readWebmDurationMs(webm), null);
});

test("two Info elements disagreeing about TimestampScale are refused", () => {
  const info = (scaleElement) => Buffer.concat([
    Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x80 | scaleElement.length]), scaleElement
  ]);
  const oneMs = info(Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40])); // 1000000
  const twoMs = info(Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x1e, 0x84, 0x80])); // 2000000
  const head = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]),
    Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
  ]);
  assert.equal(readWebmDurationMs(Buffer.concat([
    head, oneMs, twoMs, CLUSTER_UNKNOWN, clusterTimestamp(0), simpleBlock(1000)
  ])), null);
  // the same scale declared twice agrees with itself and stays readable
  assert.equal(readWebmDurationMs(Buffer.concat([
    head, oneMs, oneMs, CLUSTER_UNKNOWN, clusterTimestamp(0), simpleBlock(1000)
  ])), 1000);
});

test("malformed input after a readable timeline is refused — no partial duration", () => {
  const webm = minimalWebm(6500);
  assert.equal(readWebmDurationMs(Buffer.concat([webm, Buffer.from([0x00, 0x01, 0x02])])), null);
  assert.equal(readWebmDurationMs(Buffer.concat([webm, Buffer.from([0x53, 0x80])])), null);
});

test("truncated input after a readable timeline is refused", () => {
  const webm = minimalWebm(6500);
  assert.equal(readWebmDurationMs(webm.subarray(0, webm.length - 3)), null);
  assert.equal(readWebmDurationMs(webm.subarray(0, webm.length - 1)), null);
});

test("an element that overruns its parent's boundary is refused", () => {
  const parts = [];
  parts.push(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]));
  parts.push(Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  parts.push(Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x83, 0x2a, 0xd7, 0xb1, 0x81, 0x0f, 0x42, 0x40]));
  // a cluster declaring 10 body bytes whose SimpleBlock claims 20
  parts.push(Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x8a]));
  parts.push(Buffer.from([0xe7, 0x84, 0x00, 0x00, 0x00, 0x00]));
  parts.push(Buffer.from([0xa3, 0x80 | 20]), Buffer.alloc(20));
  assert.equal(readWebmDurationMs(Buffer.concat(parts)), null);
});

test("the streaming scanner matches the buffered read on awkward chunk sizes", () => {
  for (const step of [1, 3, 7, 4096]) {
    const webm = minimalWebm(12000);
    const scanner = new WebmDurationScanner();
    for (let i = 0; i < webm.length; i += step) {
      scanner.push(webm.subarray(i, Math.min(i + step, webm.length)));
    }
    assert.equal(scanner.end(), 12000, `chunk size ${step}`);
  }
});

// --- round 6: an unknown-size cluster counts even when a sibling ends it ----
// MediaRecorder writes every Cluster with an unknown size; a live recording
// is therefore a chain of them, and each one ends only where the next segment
// sibling begins. The scanner used to pop such a cluster without resolving
// it, silently discarding everything it held — a long recording front-loaded
// into an early cluster read as ~0 ms once any later cluster appeared.

test("a later cluster does not erase the earlier clusters' timelines", () => {
  // the evasion shape from the free-plan review: the long timeline lives in
  // an unknown-size cluster, and a tiny zero-timestamp cluster behind it made
  // the scanner drop the first one's blocks and read the file as 0 ms
  const webm = Buffer.concat([
    rawWebmHead(),
    CLUSTER_UNKNOWN, clusterTimestamp(0), simpleBlock(0), simpleBlock(32767),
    CLUSTER_UNKNOWN, clusterTimestamp(0), simpleBlock(0)
  ]);
  // absolute 0 and 32767, then a restart to 0: the fallback adds the last
  // observed gap (32767 ms) to the highest timestamp — an over-read, which is
  // the safe direction for a cap
  assert.equal(readWebmDurationMs(webm), 65534);
  for (const size of [Infinity, 4096, 64, 7, 3, 2, 1]) {
    assert.equal(pushedInChunks(webm, size), 65534, `chunk size ${size}`);
  }
});

test("consecutive unknown-size clusters keep a continuous timeline", () => {
  // what MediaRecorder actually writes for a long recording: one
  // unknown-size cluster per flush, each picking up where the last left off
  const webm = Buffer.concat([
    rawWebmHead(),
    CLUSTER_UNKNOWN, clusterTimestamp(0), simpleBlock(0), simpleBlock(1000),
    CLUSTER_UNKNOWN, clusterTimestamp(2000), simpleBlock(0), simpleBlock(1000),
    CLUSTER_UNKNOWN, clusterTimestamp(4000), simpleBlock(0)
  ]);
  // absolute 0, 1000, 2000, 3000, 4000, plus the final observed gap of 1000
  assert.equal(readWebmDurationMs(webm), 5000);
  for (const size of [Infinity, 4096, 64, 7, 3, 2, 1]) {
    assert.equal(pushedInChunks(webm, size), 5000, `chunk size ${size}`);
  }
});

test("a sibling-terminated cluster still needs its own Timestamp", () => {
  // ending a cluster at a sibling must not excuse it from the Timestamp
  // rule: blocks with no base to measure from are refused, not measured
  const webm = Buffer.concat([
    rawWebmHead(),
    CLUSTER_UNKNOWN, simpleBlock(0), simpleBlock(1000),
    CLUSTER_UNKNOWN, clusterTimestamp(0), simpleBlock(0)
  ]);
  for (const size of [Infinity, 4096, 64, 7, 3, 2, 1]) {
    assert.equal(pushedInChunks(webm, size), null, `chunk size ${size}`);
  }
  // and so must the successor: a Timestamp-less cluster after a good one
  // is refused, not folded in at zero
  const after = Buffer.concat([
    rawWebmHead(),
    CLUSTER_UNKNOWN, clusterTimestamp(0), simpleBlock(0),
    CLUSTER_UNKNOWN, simpleBlock(1000)
  ]);
  for (const size of [Infinity, 4096, 7, 1]) {
    assert.equal(pushedInChunks(after, size), null, `chunk size ${size}`);
  }
});

test("the clip-count cap stops the fourth... and every extra clip", async () => {
  const { token } = await makeAccount("countcap@example.com");
  const first = await uploadClip(token, { bytes: 512, durationMs: 1000 });
  assert.equal(first.res.status, 201);
  const second = await uploadClip(token, { bytes: 512, durationMs: 1000 });
  assert.equal(second.res.status, 201);
  const third = await uploadClip(token, { bytes: 512, durationMs: 1000 });
  assert.equal(third.res.status, 403);
  assert.match(JSON.parse(third.res.body).error, /free plan/i);

  // deleting one frees the slot
  await request("DELETE", `/api/clips/${second.clip.id}`, {
    headers: { authorization: `Bearer ${second.clip.manageToken}` }
  });
  const next = await uploadClip(token, { bytes: 512, durationMs: 1000 });
  assert.equal(next.res.status, 201);

  // usage in /api/me reflects the count
  const me = JSON.parse((await request("GET", "/api/me", { headers: { authorization: `Bearer ${token}` } })).body);
  assert.equal(me.usage.clips, 2);

  // cleanup
  await request("DELETE", `/api/clips/${next.clip.id}`, { headers: { authorization: `Bearer ${next.clip.manageToken}` } });
  await request("DELETE", `/api/clips/${first.clip.id}`, { headers: { authorization: `Bearer ${first.clip.manageToken}` } });
});

// --- export ----------------------------------------------------------------

test("export bundles the manifest and every clip, once per link", async () => {
  const a = await makeAccount("export@example.com");
  const payload = webmPayload(1000, 2000);
  const { clip } = await uploadClip(a.token, { payload, title: "export me", durationMs: 2000 });

  const anon = await request("POST", "/api/my/export");
  assert.equal(anon.status, 401);

  const linkRes = await request("POST", "/api/my/export", { headers: { authorization: `Bearer ${a.token}` } });
  assert.equal(linkRes.status, 201);
  const { exportPath } = JSON.parse(linkRes.body);
  assert.match(exportPath, /^\/api\/my\/export\//);

  const tar = await request("GET", exportPath);
  assert.equal(tar.status, 200);
  assert.match(tar.headers["content-type"], /x-tar/);
  assert.match(tar.headers["content-disposition"], /attachment/);

  const entries = [];
  for await (const entry of readTar(tar.body)) entries.push(entry);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("openloom-export.json"), "manifest present");
  assert.ok(names.includes(`clips/${clip.id}/meta.json`));
  assert.ok(names.includes(`clips/${clip.id}/video.bin`));
  const video = entries.find((e) => e.name === `clips/${clip.id}/video.bin`);
  assert.deepEqual(video.content, payload);
  const manifest = JSON.parse(entries.find((e) => e.name === "openloom-export.json").content);
  assert.equal(manifest.clipCount, 1);
  assert.equal(manifest.clips[0].id, clip.id);

  // one-time: the same link refuses a second download
  const replay = await request("GET", exportPath);
  assert.equal(replay.status, 403);

  // a forged link token refuses too
  const forged = await request("GET", "/api/my/export/AAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(forged.status, 403);

  await request("DELETE", `/api/clips/${clip.id}`, { headers: { authorization: `Bearer ${clip.manageToken}` } });
});

// --- delete everything, delete the account ---------------------------------

test("delete all clips empties the account", async () => {
  const a = await makeAccount("purge@example.com");
  const b = await makeAccount("bystander@example.com");
  const mine = await uploadClip(a.token, { bytes: 256, durationMs: 1000 });
  const theirs = await uploadClip(b.token, { bytes: 256, durationMs: 1000 });
  assert.equal(theirs.res.status, 201);

  const res = await request("DELETE", "/api/my/clips", { headers: { authorization: `Bearer ${a.token}` } });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).removed, 1);

  const list = JSON.parse((await request("GET", "/api/my/clips", { headers: { authorization: `Bearer ${a.token}` } })).body);
  assert.deepEqual(list.clips, []);
  // the bystander's clip is untouched
  const stillThere = await request("GET", `/api/clips/${theirs.clip.id}`);
  assert.equal(stillThere.status, 200);
  await request("DELETE", `/api/clips/${theirs.clip.id}`, { headers: { authorization: `Bearer ${theirs.clip.manageToken}` } });
});

test("deleting the account removes the clips and every session", async () => {
  const a = await makeAccount("goodbye@example.com");
  const { clip } = await uploadClip(a.token, { bytes: 256, durationMs: 1000 });

  const res = await request("DELETE", "/api/my/account", { headers: { authorization: `Bearer ${a.token}` } });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).removedClips, 1);

  // clip and share page data are really gone
  assert.equal((await request("GET", `/api/clips/${clip.id}`)).status, 404);
  assert.equal((await request("GET", `/api/clips/${clip.id}/file`)).status, 404);
  // the session is dead, the password no longer opens anything
  assert.equal((await request("GET", "/api/me", { headers: { authorization: `Bearer ${a.token}` } })).status, 401);
  const login = await request("POST", "/api/sessions", {
    body: JSON.stringify({ email: "goodbye@example.com", password: "correct horse battery" }),
    headers: { "content-type": "application/json" }
  });
  assert.equal(login.status, 401);
  // the email is free again
  const again = await makeAccount("goodbye@example.com");
  assert.match(again.token, /^.{20,}$/);
  await request("DELETE", "/api/my/account", { headers: { authorization: `Bearer ${again.token}` } });
});

// --- persistence under concurrency -----------------------------------------

test("concurrent signups all persist, with exactly one of a duplicated email", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-accounts-"));
  const acc = new Accounts(dir);
  await acc.init();
  const emails = Array.from({ length: 8 }, (_, i) => `user${i}@racing.example`);
  const created = await Promise.allSettled(emails.map((e) => acc.create(e, "correct horse battery")));
  assert.ok(created.every((r) => r.status === "fulfilled"), "8 concurrent signups all succeed");
  // two racing signups of the same email: exactly one wins
  const dupe = await Promise.allSettled([
    acc.create("dupe@racing.example", "correct horse battery"),
    acc.create("dupe@racing.example", "correct horse battery")
  ]);
  const outcomes = dupe.map((r) => r.status);
  assert.deepEqual(outcomes.sort(), ["fulfilled", "rejected"]);

  // restart: a fresh instance reads the persisted file
  const restarted = new Accounts(dir);
  await restarted.init();
  assert.equal(restarted.data.accounts.length, 9);
  // every persisted account opens with its password, and no stray .tmp survives
  for (const email of emails) {
    const res = await restarted.login(email, "correct horse battery");
    assert.ok(res.token.length > 20);
  }
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("a session created before a restart still authenticates after it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-accounts-"));
  const acc = new Accounts(dir);
  await acc.init();
  const { token } = await acc.create("survivor@racing.example", "correct horse battery");
  assert.ok(await acc.auth(token));

  const restarted = new Accounts(dir);
  await restarted.init();
  assert.deepEqual((await restarted.auth(token)).email, "survivor@racing.example");

  // a concurrent logout under load: 5 logins and 5 logouts interleaved
  const tokens = await Promise.all(
    Array.from({ length: 5 }, () => restarted.login("survivor@racing.example", "correct horse battery"))
  );
  await Promise.all(tokens.map((t) => restarted.logout(t.token)));
  const after = new Accounts(dir);
  await after.init();
  assert.equal(after.data.sessions.length, 1, "only the original session survives");
  assert.ok(await after.auth(token));
});

test("an oversized upload does not disturb a concurrent valid upload", async () => {
  const a = await makeAccount("racer-a@example.com");
  const b = await makeAccount("racer-b@example.com");

  // A pushes past the 16 KB cap mid-flight, while B is still streaming
  const oversized = new Promise((resolve, reject) => {
    const req = http.request(base + "/api/clips", {
      method: "POST",
      headers: { "content-type": "video/webm", authorization: `Bearer ${a.token}` }
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.write(Buffer.alloc(12 * 1024));
    // B starts and finishes entirely inside A's pause
    setTimeout(() => {
      req.write(Buffer.alloc(12 * 1024));
      req.end();
    }, 150);
  });

  await new Promise((r) => setTimeout(r, 30));
  const valid = await uploadClip(b.token, { bytes: 8192, durationMs: 1000 });

  const failed = await oversized;
  assert.equal(failed.status, 413, "the oversized upload is refused");
  assert.equal(valid.res.status, 201, "the concurrent valid upload survives");
  assert.equal((await request("GET", `/api/clips/${valid.clip.id}/file`)).status, 200,
    "the valid clip's file is intact afterwards");
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "tmp")), [],
    "no staging files are left behind");
  await request("DELETE", `/api/clips/${valid.clip.id}`, {
    headers: { authorization: `Bearer ${valid.clip.manageToken}` }
  });
});

// --- hardening kept from step 1 --------------------------------------------

test("unknown ids answer 404 everywhere", async () => {
  assert.equal((await request("GET", "/api/clips/AAAAAAAAAAAAAAAAAA")).status, 404);
  assert.equal((await request("GET", "/api/clips/AAAAAAAAAAAAAAAAAA/file")).status, 404);
  assert.equal((await request("DELETE", "/api/clips/AAAAAAAAAAAAAAAAAA")).status, 404);
});

test("malformed ids are treated as unknown, not as paths", async () => {
  assert.equal((await request("GET", "/api/clips/..%2f..%2fetc")).status, 404);
  assert.equal((await request("GET", "/api/clips/short")).status, 404);
});

test("my routes with a garbage token answer 401", async () => {
  assert.equal((await request("GET", "/api/my/clips", { headers: { authorization: "Bearer garbage" } })).status, 401);
  assert.equal((await request("DELETE", "/api/my/clips", { headers: { authorization: "Bearer garbage" } })).status, 401);
});

test("store rejects invalid ids and survives a fresh init", async () => {
  const store = new Store(process.env.DATA_DIR);
  assert.equal(store.isValidId("../etc/passwd"), false);
  assert.equal(store.isValidId("ABCDEFGHIJKLMNOPQR"), true);
  await store.init(); // idempotent
});

// --- round 5: every stored clip is verified, whatever it was labelled ------

test("an upload whose blocks precede an over-cap Cluster Timestamp is refused", async () => {
  const { token } = await makeAccount("latebase@example.com");
  const webm = Buffer.concat([
    rawWebmHead(), CLUSTER_UNKNOWN, simpleBlock(0), clusterTimestamp(600000), simpleBlock(0)
  ]);
  const res = await request("POST", "/api/clips", {
    body: webm,
    headers: {
      "content-type": "video/webm",
      "x-duration-ms": "1000",
      authorization: `Bearer ${token}`
    }
  });
  assert.equal(res.status, 413);
  assert.match(JSON.parse(res.body).error, /minute/i);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);

  // the same ordering within the cap is measured from the late Timestamp,
  // not read as a near-zero clip
  const ok = Buffer.concat([
    rawWebmHead(), CLUSTER_UNKNOWN, simpleBlock(0), clusterTimestamp(1000), simpleBlock(500)
  ]);
  const good = await request("POST", "/api/clips", {
    body: ok,
    headers: { "content-type": "video/webm", authorization: `Bearer ${token}` }
  });
  assert.equal(good.status, 201);
  const clip = JSON.parse(good.body);
  const meta = JSON.parse((await request("GET", `/api/clips/${clip.id}`)).body);
  assert.equal(meta.durationMs, 2000);
  await request("DELETE", `/api/clips/${clip.id}`, { headers: { authorization: `Bearer ${clip.manageToken}` } });
});

test("an over-cap MP4 is refused — no format escapes the duration check", async () => {
  const { token } = await makeAccount("mp4cap@example.com");
  const ftyp = Buffer.from([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, // size + "ftyp"
    0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 1, // "isom", minor version
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31 // compatible brands
  ]);
  const mdat = Buffer.concat([Buffer.from([0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74]), crypto.randomBytes(1024)]);
  const res = await request("POST", "/api/clips", {
    body: Buffer.concat([ftyp, mdat]),
    headers: {
      "content-type": "video/mp4",
      "x-duration-ms": "1000",
      authorization: `Bearer ${token}`
    }
  });
  assert.equal(res.status, 413);
  assert.match(JSON.parse(res.body).error, /verif/i);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);
});

test("a webm relabeled as another format is still verified, and stored as a webm", async () => {
  const { token } = await makeAccount("relabel@example.com");
  // 40 s of real timeline under a video/mp4 label and a lying declared header
  const res = await request("POST", "/api/clips", {
    body: minimalWebm(40000, { declaredMs: 1000 }),
    headers: {
      "content-type": "video/mp4",
      "x-duration-ms": "1000",
      authorization: `Bearer ${token}`
    }
  });
  assert.equal(res.status, 413);
  assert.match(JSON.parse(res.body).error, /40|minute/i);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);

  // a within-cap webm under the same label is accepted — and the file, not
  // the request, decides its content type and filename
  const ok = await request("POST", "/api/clips", {
    body: minimalWebm(8000),
    headers: { "content-type": "video/mp4", authorization: `Bearer ${token}` }
  });
  assert.equal(ok.status, 201);
  const clip = JSON.parse(ok.body);
  const meta = JSON.parse((await request("GET", `/api/clips/${clip.id}`)).body);
  assert.equal(meta.contentType, "video/webm");
  assert.equal(meta.filename, "recording.webm");
  const file = await request("GET", `/api/clips/${clip.id}/file`);
  assert.equal(file.headers["content-type"], "video/webm");
  await request("DELETE", `/api/clips/${clip.id}`, { headers: { authorization: `Bearer ${clip.manageToken}` } });
});

test("a matroska upload is labelled from its own DocType", async () => {
  const { token } = await makeAccount("mkvlabel@example.com");
  const mkv = Buffer.concat([
    // EBML header with DocType "matroska"
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x8b, 0x42, 0x82, 0x88,
      0x6d, 0x61, 0x74, 0x72, 0x6f, 0x73, 0x6b, 0x61]),
    Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]),
    CLUSTER_UNKNOWN, clusterTimestamp(0), simpleBlock(8000)
  ]);
  const res = await request("POST", "/api/clips", {
    body: mkv,
    headers: { "content-type": "video/webm", authorization: `Bearer ${token}` }
  });
  assert.equal(res.status, 201);
  const clip = JSON.parse(res.body);
  const meta = JSON.parse((await request("GET", `/api/clips/${clip.id}`)).body);
  assert.equal(meta.contentType, "video/matroska");
  assert.equal(meta.filename, "recording.mkv");
  await request("DELETE", `/api/clips/${clip.id}`, { headers: { authorization: `Bearer ${clip.manageToken}` } });
});

test("the multi-cluster evasion shape is measured in full and refused over the cap", async () => {
  const { token } = await makeAccount("multiclustercap@example.com");
  // the review's evasion: the long timeline in an unknown-size cluster, a
  // tiny zero-timestamp cluster behind it — the upload used to read as ~0 ms
  // and slip past the duration cap
  const evasive = Buffer.concat([
    rawWebmHead(),
    CLUSTER_UNKNOWN, clusterTimestamp(0), simpleBlock(0), simpleBlock(32767),
    CLUSTER_UNKNOWN, clusterTimestamp(0), simpleBlock(0)
  ]);
  const res = await request("POST", "/api/clips", {
    body: evasive,
    headers: {
      "content-type": "video/webm",
      "x-duration-ms": "1000",
      authorization: `Bearer ${token}`
    }
  });
  assert.equal(res.status, 413);
  assert.match(JSON.parse(res.body).error, /minute/i);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);

  // the same shape within the cap stores with its full parsed duration —
  // 0 and 1000, then a cluster at 2000, plus the final 1000 ms gap
  const ok = await request("POST", "/api/clips", {
    body: Buffer.concat([
      rawWebmHead(),
      CLUSTER_UNKNOWN, clusterTimestamp(0), simpleBlock(0), simpleBlock(1000),
      CLUSTER_UNKNOWN, clusterTimestamp(2000), simpleBlock(0)
    ]),
    headers: { "content-type": "video/webm", authorization: `Bearer ${token}` }
  });
  assert.equal(ok.status, 201);
  const clip = JSON.parse(ok.body);
  const meta = JSON.parse((await request("GET", `/api/clips/${clip.id}`)).body);
  assert.equal(meta.durationMs, 3000);
  await request("DELETE", `/api/clips/${clip.id}`, { headers: { authorization: `Bearer ${clip.manageToken}` } });
});

test("an upload whose sibling-terminated cluster lacks a Timestamp is refused — nothing is retained", async () => {
  // the upload-side twin of the scanner regressions above: the same
  // malformed fixtures, sent the way the recorder sends files, with a
  // plausible client-written duration to make sure the header never
  // rescues a file the scanner could not verify
  const { token } = await makeAccount("tslessupload@example.com");
  const headers = {
    "content-type": "video/webm",
    "x-duration-ms": "3000", // plausible, within the cap, and irrelevant
    authorization: `Bearer ${token}`
  };
  // no Timestamp in the cluster that a sibling ends — the first one
  const missingBefore = Buffer.concat([
    rawWebmHead(),
    CLUSTER_UNKNOWN, simpleBlock(0), simpleBlock(1000),
    CLUSTER_UNKNOWN, clusterTimestamp(0), simpleBlock(0)
  ]);
  const before = await request("POST", "/api/clips", { body: missingBefore, headers });
  assert.equal(before.status, 413);
  assert.match(JSON.parse(before.body).error, /could not be verified|minute/i);

  // and the successor — a Timestamp-less cluster after a good one
  const missingAfter = Buffer.concat([
    rawWebmHead(),
    CLUSTER_UNKNOWN, clusterTimestamp(0), simpleBlock(0),
    CLUSTER_UNKNOWN, simpleBlock(1000)
  ]);
  const after = await request("POST", "/api/clips", { body: missingAfter, headers });
  assert.equal(after.status, 413);
  assert.match(JSON.parse(after.body).error, /could not be verified|minute/i);

  // neither upload left anything behind: no metadata, no file
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "tmp")), []);
  const me = JSON.parse((await request("GET", "/api/me", { headers: { authorization: `Bearer ${token}` } })).body);
  assert.equal(me.usage.clips, 0);
  assert.equal(me.usage.bytes, 0);
});

// --- round 5: the recorder's Duration patch, exercised verbatim -------------

// A MediaRecorder-shaped webm whose Info body is padded with a Void so the
// patched Info body lands exactly on targetBodyLen bytes — the sizes where
// the size vint changes width.
function patchFixture(targetBodyLen, durationMs = 4000) {
  const parts = [];
  parts.push(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]));
  parts.push(Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  const scale = Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]);
  const voidTotal = targetBodyLen - scale.length - 11; // the Duration element the patch adds
  assert.ok(voidTotal >= 2, "fixture target leaves room for a Void");
  let n = 1;
  while (voidTotal - 1 - n > Math.pow(2, 7 * n) - 2) n++;
  const voidBody = voidTotal - 1 - n;
  const infoBody = Buffer.concat([scale, Buffer.from([0xec]), sizeVint(voidBody), Buffer.alloc(voidBody)]);
  parts.push(Buffer.from([0x15, 0x49, 0xa9, 0x66]), sizeVint(infoBody.length), infoBody);
  parts.push(CLUSTER_UNKNOWN, clusterTimestamp(0), simpleBlock(durationMs));
  return Buffer.concat(parts);
}

test("webmSizeVint marks each width with its own marker bit", () => {
  const cases = [
    [0, [0x80]],
    [126, [0xfe]],
    [127, [0x40, 0x7f]], // the width grows one byte before all-ones could mean "unknown"
    [128, [0x40, 0x80]], // the old encoder wrote 0x80 0x80 here: a zero-length element
    [16382, [0x7f, 0xfe]],
    [16383, [0x20, 0x3f, 0xff]],
    [16384, [0x20, 0x40, 0x00]],
    [2 ** 21 - 2, [0x3f, 0xff, 0xfe]]
  ];
  for (const [value, expected] of cases) {
    assert.deepEqual(Array.from(webmPatch.webmSizeVint(value)), expected, `size ${value}`);
  }
  // round trip through the same reading the server's scanner uses
  for (const value of [0, 1, 126, 127, 128, 16382, 16383, 16384, 2 ** 21 - 2, 2 ** 28]) {
    const out = webmPatch.webmSizeVint(value);
    let len = 1;
    for (let mask = 0x80; !(out[0] & mask); mask >>= 1) len++;
    let decoded = out[0] & (0xff >> len);
    for (let i = 1; i < out.length; i++) decoded = decoded * 256 + out[i];
    assert.equal(decoded, value, `round trip ${value}`);
  }
  assert.throws(() => webmPatch.webmSizeVint(2 ** 56 - 1), RangeError);
  assert.throws(() => webmPatch.webmSizeVint(-1), RangeError);
});

test("the recorder's patch keeps the file verifiable at every size-vint width", async () => {
  for (const target of [126, 127, 128, 16382, 16383, 16384]) {
    const original = patchFixture(target);
    assert.equal(readWebmDurationMs(original), 4000, `fixture ${target} parses`);
    const patched = await webmPatch.patchWebmDuration(new Blob([original]), 4000);
    assert.ok(patched, `patch ${target} applied`);
    const bytes = Buffer.from(await patched.arrayBuffer());
    // the rebuilt Info's size vint carries the marker of its own width
    const infoVintAt = 12 + 12 + 4; // EBML header + Segment header + the Info id
    let len = 1;
    for (let mask = 0x80; !(bytes[infoVintAt] & mask); mask >>= 1) len++;
    assert.equal(len, target <= 126 ? 1 : target <= 16382 ? 2 : 3, `width ${target}`);
    let decoded = bytes[infoVintAt] & (0xff >> len);
    for (let i = 1; i < len; i++) decoded = decoded * 256 + bytes[infoVintAt + i];
    assert.equal(decoded, target, `declared Info body ${target}`);
    // the media timeline survives the rebuild byte-for-byte elsewhere
    assert.equal(readWebmDurationMs(bytes), 4000, `patched ${target} still scans`);
  }
});

test("a patched recording uploads cleanly — the old encoder's corrupting size is gone", async () => {
  const { token } = await makeAccount("patched@example.com");
  // 128 was the exact body size the old encoder corrupted: 0x80 0x80
  const patched = await webmPatch.patchWebmDuration(new Blob([patchFixture(128)]), 4000);
  const bytes = Buffer.from(await patched.arrayBuffer());
  const res = await request("POST", "/api/clips", {
    body: bytes,
    headers: { "content-type": "video/webm", authorization: `Bearer ${token}` }
  });
  assert.equal(res.status, 201);
  const clip = JSON.parse(res.body);
  const meta = JSON.parse((await request("GET", `/api/clips/${clip.id}`)).body);
  assert.equal(meta.durationMs, 4000);
  await request("DELETE", `/api/clips/${clip.id}`, { headers: { authorization: `Bearer ${clip.manageToken}` } });
});

test("the patch script the recorder loads is served and wired in", async () => {
  const res = await request("GET", "/webm-patch.js");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/javascript/);
  assert.match(res.body.toString(), /OpenLoomWebmPatch/);
  const page = await request("GET", "/");
  assert.match(page.body.toString(), /<script src="\/webm-patch\.js"><\/script>/);
  // one definition now: the inline copies are gone from the page
  assert.ok(!page.body.toString().includes("function webmSizeVint"));
  assert.ok(!page.body.toString().includes("function patchWebmDuration"));
});

// --- helpers ---------------------------------------------------------------

// A minimal but structurally honest webm: EBML header, Segment of unknown
// size, Info with TimestampScale and (optionally) Duration, then Clusters of
// unknown size — each with a Timestamp and one SimpleBlock — so the file
// carries a real media timeline the way MediaRecorder output does.
function minimalWebm(durationMs, { declaredMs = null, omitDuration = false } = {}) {
  return webmFile({
    spans: spansFor(durationMs),
    declaredDurationMs: omitDuration ? null : (declaredMs ?? durationMs)
  });
}

// A webm padded to at least `padTo` bytes with a Void element, handy when a
// test needs a payload of a particular size.
function webmPayload(padTo, timelineMs, { noTimeline = false } = {}) {
  return webmFile({
    spans: noTimeline ? [] : spansFor(timelineMs),
    declaredDurationMs: null,
    padTo
  });
}

// Absolute timestamps over 32767 ms do not fit a block's signed 16-bit
// timecode, so the overflow moves into the Cluster's own Timestamp.
function spansFor(absMs) {
  if (absMs <= 32767) return [[0, absMs]];
  return [[32768, absMs - 32768]];
}

function webmFile({ spans = [], declaredDurationMs = null, padTo = 0, tracks = [], blockGroups = [], laced = [] } = {}) {
  const parts = [];
  // EBML header: DocType "webm"
  parts.push(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]));
  // Segment, unknown size (what MediaRecorder emits for live recordings)
  parts.push(Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  // Info: TimestampScale (1e6) plus, when wanted, a Duration double
  const infoParts = [Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40])];
  if (declaredDurationMs !== null) {
    infoParts.push(Buffer.from([0x44, 0x89, 0x88]));
    const d = Buffer.alloc(8);
    d.writeDoubleBE(declaredDurationMs, 0);
    infoParts.push(d);
  }
  const infoBody = Buffer.concat(infoParts);
  parts.push(Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x80 | infoBody.length]), infoBody);
  // Tracks: a TrackEntry per {trackNumber, defaultNs}, as a real muxer writes it
  if (tracks.length) {
    const entries = tracks.map(({ trackNumber, defaultNs, extraElements = [] }) => {
      const durSize = uintBodySize(defaultNs);
      const durBody = Buffer.alloc(durSize);
      let v = defaultNs;
      for (let i = durBody.length - 1; i >= 0; i--) { durBody[i] = v & 0xff; v = Math.floor(v / 256); }
      const entryBody = Buffer.concat([
        Buffer.from([0xd7, 0x81, trackNumber]), // TrackNumber, one byte
        ...extraElements,
        Buffer.from([0x23, 0xe3, 0x83, 0x80 | durBody.length]), durBody // DefaultDuration
      ]);
      return Buffer.concat([Buffer.from([0xae, 0x80 | entryBody.length]), entryBody]);
    });
    const tracksBody = Buffer.concat(entries);
    parts.push(Buffer.from([0x16, 0x54, 0xae, 0x6b, 0x80 | tracksBody.length]), tracksBody);
  }
  for (const [clusterMs, relMs] of spans) {
    parts.push(Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    const ts = Buffer.alloc(4);
    ts.writeUInt32BE(clusterMs, 0);
    parts.push(Buffer.from([0xe7, 0x84]), ts);
    const blockBody = Buffer.concat([
      Buffer.from([0x81]), // track number 1
      (() => { const b = Buffer.alloc(2); b.writeInt16BE(relMs, 0); return b; })(),
      Buffer.from([0x00, 0x00]) // flags and a first payload byte
    ]);
    parts.push(Buffer.from([0xa3, 0x80 | blockBody.length]), blockBody);
  }
  // laced SimpleBlocks: {clusterMs, relMs, frames} — Xiph-style lacing flag,
  // a frame-count byte, one (zero-length) size byte per extra frame
  for (const { clusterMs, relMs, frames } of laced) {
    parts.push(Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    const ts = Buffer.alloc(4);
    ts.writeUInt32BE(clusterMs, 0);
    parts.push(Buffer.from([0xe7, 0x84]), ts);
    const blockBody = Buffer.concat([
      Buffer.from([0x81]), // track number 1
      (() => { const b = Buffer.alloc(2); b.writeInt16BE(relMs, 0); return b; })(),
      Buffer.from([0x02]), // lacing: Xiph
      Buffer.from([frames - 1]), // frame count - 1
      Buffer.alloc(frames - 1, 0), // Xiph sizes: zero-length first frames
      Buffer.from([0x00]) // a payload byte for the last frame
    ]);
    parts.push(Buffer.from([0xa3, 0x80 | blockBody.length]), blockBody);
  }
  // BlockGroups: {clusterMs, relMs, blockDuration} — a Block plus its
  // explicit BlockDuration, as the spec puts them
  for (const { clusterMs, relMs, blockDuration } of blockGroups) {
    parts.push(Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    const ts = Buffer.alloc(4);
    ts.writeUInt32BE(clusterMs, 0);
    parts.push(Buffer.from([0xe7, 0x84]), ts);
    const blockBody = Buffer.concat([
      Buffer.from([0x81]), // track number 1
      (() => { const b = Buffer.alloc(2); b.writeInt16BE(relMs, 0); return b; })(),
      Buffer.from([0x00, 0x00]) // flags and a first payload byte
    ]);
    const durSize = uintBodySize(blockDuration);
    const durBody = Buffer.alloc(durSize);
    let v = blockDuration;
    for (let i = durBody.length - 1; i >= 0; i--) { durBody[i] = v & 0xff; v = Math.floor(v / 256); }
    const groupBody = Buffer.concat([
      Buffer.from([0xa1, 0x80 | blockBody.length]), blockBody,
      Buffer.from([0x9b, 0x80 | durBody.length]), durBody
    ]);
    parts.push(Buffer.from([0xa0, 0x80 | groupBody.length]), groupBody);
  }
  const base = Buffer.concat(parts);
  const need = padTo - base.length;
  if (need >= 2) {
    // Void: the one element every matroska reader must skip harmlessly
    let n = 1;
    while (need - 1 - n > Math.pow(2, 7 * n) - 2) n++;
    const size = need - 1 - n;
    return Buffer.concat([base, Buffer.from([0xec]), sizeVint(size), Buffer.alloc(size)]);
  }
  return base;
}

// how many body bytes an unsigned integer needs (1–8, EBML style)
function uintBodySize(value) {
  let n = 1;
  while (value >= Math.pow(2, 8 * n)) n++;
  return n;
}

// An EBML size vint: marker bit plus the value in the remaining bits.
function sizeVint(value) {
  let n = 1;
  while (value > Math.pow(2, 7 * n) - 2) n++;
  const buf = Buffer.alloc(n);
  let v = value;
  for (let i = n - 1; i > 0; i--) {
    buf[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  buf[0] = (v & (0xff >> (n - 1))) | (0x80 >> (n - 1));
  return buf;
}

// --- payments: unit level ---------------------------------------------------

function transferLog({ contract, to, microUsdc }) {
  return {
    address: contract,
    topics: [
      payments.TRANSFER_TOPIC,
      "0x" + Buffer.alloc(32).toString("hex"), // from — irrelevant to verification
      "0x" + payments.pad32(payments.hexToBuffer(to)).toString("hex")
    ],
    data: "0x" + payments.amountTo32Bytes(microUsdc).toString("hex")
  };
}

// A fetch replacement that answers JSON-RPC without touching a network.
function stubFetch({ chainId = payments.CHAIN_ID, receipt = null } = {}) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const result = body.method === "eth_chainId"
      ? "0x" + BigInt(chainId).toString(16)
      : body.method === "eth_getTransactionReceipt" ? receipt : null;
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
}

test("receiving addresses are valid, checksum-free hex and never repeat", () => {
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const address = payments.newReceivingAddress();
    assert.match(address, /^0x[0-9a-f]{40}$/);
    assert.ok(!seen.has(address));
    seen.add(address);
  }
});

test("a receipt with the exact transfer verifies; the near misses do not", () => {
  const to = payments.newReceivingAddress();
  const expected = { contract: payments.USDC_CONTRACT, toAddress: to, topic0: payments.TRANSFER_TOPIC, expectedMicroUsdc: 10_000_000n };
  const right = { status: "0x1", logs: [transferLog({ contract: payments.USDC_CONTRACT, to, microUsdc: 10_000_000n })] };
  assert.equal(payments.judgeReceipt(right, expected), "verified");
  assert.equal(payments.judgeReceipt({ status: "0x1", logs: [transferLog({ contract: payments.USDC_CONTRACT, to, microUsdc: 9_999_999n })] }, expected), "wrong-amount");
  assert.equal(payments.judgeReceipt({ status: "0x1", logs: [transferLog({ contract: payments.USDC_CONTRACT, to: payments.newReceivingAddress(), microUsdc: 10_000_000n })] }, expected), "unrelated");
  assert.equal(payments.judgeReceipt({ status: "0x1", logs: [transferLog({ contract: "0x" + "ab".repeat(20), to, microUsdc: 10_000_000n })] }, expected), "unrelated");
  assert.equal(payments.judgeReceipt({ status: "0x0", logs: [transferLog({ contract: payments.USDC_CONTRACT, to, microUsdc: 10_000_000n })] }, expected), "failed");
  assert.equal(payments.judgeReceipt(null, expected), "pending");
  // a transfer of a different token shape — two indexed topics but no data — is not matched
  assert.equal(payments.judgeReceipt({ status: "0x1", logs: [{ address: payments.USDC_CONTRACT, topics: [payments.TRANSFER_TOPIC, "0x" + "11".repeat(32), "0x" + "22".repeat(32)] }] }, expected), "unrelated");
});

test("verification refuses a receipt from the wrong chain without asking for it", async () => {
  const invoice = { address: payments.newReceivingAddress(), amountMicroUsdc: "10000000" };
  const outcome = await payments.verifyPayment({ fetchImpl: stubFetch({ chainId: 1 }), rpcUrl: "http://localhost:1", txHash: "0x" + "ab".repeat(32), invoice });
  assert.equal(outcome, "wrong-chain");
});

test("limits follow the account's paid state and degrade back to free", () => {
  const now = 1_700_000_000_000;
  const free = { id: "a" };
  assert.equal(payments.limitsFor(free, now).tier, "free");
  const paid = { id: "b", plan: { tier: "paid", paidUntil: now + 1000 } };
  const lifted = payments.limitsFor(paid, now);
  assert.equal(lifted.tier, "paid");
  assert.equal(lifted.totalBytes, payments.PLANS.paid.totalBytes);
  // 30 days after the payment, the same account reads as free again
  assert.equal(payments.limitsFor(paid, now + 1001).tier, "free");
  // a malformed record degrades to free instead of crashing or lying
  assert.equal(payments.limitsFor({ id: "c", plan: { tier: "paid", paidUntil: "soon" } }, now).tier, "free");
  // paying again stacks 30 days on top of what is left, not on top of now
  const renewed = { id: "d", plan: { tier: "paid", paidUntil: now + 10 * 24 * 60 * 60 * 1000 } };
  assert.equal(payments.extendPaid(renewed, now), now + 40 * 24 * 60 * 60 * 1000);
});

test("invoices: one transaction pays one invoice, stale ones expire", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-invoices-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new payments.Invoices(dir);
  await ledger.init();
  const invoice = await ledger.create("account-1");
  assert.equal(invoice.status, "pending");
  assert.match(invoice.address, /^0x[0-9a-f]{40}$/);
  assert.equal(ledger.find(invoice.id).accountId, "account-1");
  // replay protection across accounts
  invoice.txHash = "0x" + "cd".repeat(32);
  await ledger.save();
  // a fresh module reads the same invoice — and its transaction — back from disk
  const reopened = new payments.Invoices(dir);
  await reopened.init();
  assert.equal(reopened.find(invoice.id).address, invoice.address);
  assert.equal(reopened.findByTx(invoice.txHash).id, invoice.id);
  assert.equal(reopened.findByTx("0x" + "ee".repeat(32)), null);
  // staleness
  invoice.expiresAt = 1; // long past
  const other = await ledger.create("account-2");
  await ledger.expireStale(Date.now());
  assert.equal(ledger.find(invoice.id).status, "expired");
  assert.equal(ledger.find(other.id).status, "pending");
});

// --- payments: through the API ---------------------------------------------

const TX_HASH = "0x" + "a7".repeat(32);

async function payInvoice(token, invoice, { receipt, chainId, txHash = TX_HASH } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({ receipt, chainId });
  try {
    return await request("POST", "/api/billing/verify", {
      body: JSON.stringify({ invoiceId: invoice.invoiceId, txHash }),
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` }
    });
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a verified test-USDC payment lifts the account to the paid plan", async () => {
  const acct = await makeAccount("payer@example.com");

  // the free cap bites first: this suite's free plan holds 2 clips
  await uploadClip(acct.token, { bytes: 4096 });
  await uploadClip(acct.token, { bytes: 4096 });
  assert.equal((await uploadClip(acct.token, { bytes: 4096 })).res.status, 403);

  // an invoice names a fresh address, the exact price and the test network
  const invRes = await request("POST", "/api/billing/invoices", { headers: { authorization: `Bearer ${acct.token}` } });
  assert.equal(invRes.status, 201);
  const invoice = JSON.parse(invRes.body);
  assert.match(invoice.payTo, /^0x[0-9a-f]{40}$/);
  assert.equal(invoice.amountMicroUsdc, "10000000");
  assert.equal(invoice.amountUsdc, "10.00");
  assert.equal(invoice.test, true);
  assert.equal(invoice.chainId, payments.CHAIN_ID);
  assert.equal(invoice.contract, payments.USDC_CONTRACT);

  // malformed hashes are refused before any network call
  const bad = await request("POST", "/api/billing/verify", {
    body: JSON.stringify({ invoiceId: invoice.invoiceId, txHash: "0x1234" }),
    headers: { "content-type": "application/json", authorization: `Bearer ${acct.token}` }
  });
  assert.equal(bad.status, 400);

  // another account's invoice is not mine to verify
  const other = await makeAccount("other-payer@example.com");
  const otherInv = JSON.parse((await request("POST", "/api/billing/invoices", { headers: { authorization: `Bearer ${other.token}` } })).body);
  assert.equal((await payInvoice(acct.token, otherInv, { receipt: {} })).status, 404);

  // not mined yet: answered as pending, the plan does not move
  const pending = await payInvoice(acct.token, invoice, { receipt: null });
  assert.equal(pending.status, 200);
  assert.equal(JSON.parse(pending.body).status, "pending");

  // mined but reverted
  assert.equal((await payInvoice(acct.token, invoice, { receipt: { status: "0x0", logs: [] } })).status, 402);
  // the right shape, the wrong amount
  const shortPaid = { status: "0x1", logs: [transferLog({ contract: payments.USDC_CONTRACT, to: invoice.payTo, microUsdc: 5_000_000n })] };
  const short = await payInvoice(acct.token, invoice, { receipt: shortPaid });
  assert.equal(short.status, 402);
  assert.match(JSON.parse(short.body).error, /amount/i);
  // money to the wrong address
  const elsewhere = { status: "0x1", logs: [transferLog({ contract: payments.USDC_CONTRACT, to: payments.newReceivingAddress(), microUsdc: 10_000_000n })] };
  assert.equal((await payInvoice(acct.token, invoice, { receipt: elsewhere })).status, 402);

  // the real thing
  const receipt = { status: "0x1", logs: [transferLog({ contract: payments.USDC_CONTRACT, to: invoice.payTo, microUsdc: 10_000_000n })] };
  const paid = await payInvoice(acct.token, invoice, { receipt });
  assert.equal(paid.status, 200);
  const paidBody = JSON.parse(paid.body);
  assert.equal(paidBody.status, "paid");
  assert.equal(paidBody.tier, "paid");
  assert.ok(paidBody.paidUntil > Date.now() + 29 * 24 * 60 * 60 * 1000);

  // the plan reads back as paid with the paid limits
  const mine = JSON.parse((await request("GET", "/api/me", { headers: { authorization: `Bearer ${acct.token}` } })).body);
  assert.equal(mine.plan, "paid");
  assert.equal(mine.limits.maxClips, 50); // as shrunk by env for this suite
  assert.equal(mine.limits.totalBytes, 13 * 1024);

  // recording works again: two more clips fit in the paid total, the third hits it
  assert.equal((await uploadClip(acct.token, { bytes: 2048 })).res.status, 201);
  assert.equal((await uploadClip(acct.token, { bytes: 2048 })).res.status, 201);
  const fifth = await uploadClip(acct.token, { bytes: 2048 });
  // 2 × 4096 + 3 × 2048 = 14336 bytes would exceed the 13312-byte paid total in this suite
  assert.equal(fifth.res.status, 413);
  assert.match(JSON.parse(fifth.res.body).error, /total/i);

  // the plan survives a fresh session token (it lives on the account)
  const again = JSON.parse((await request("POST", "/api/sessions", {
    body: JSON.stringify({ email: "payer@example.com", password: "correct horse battery" }),
    headers: { "content-type": "application/json" }
  })).body);
  const reMe = JSON.parse((await request("GET", "/api/me", { headers: { authorization: `Bearer ${again.token}` } })).body);
  assert.equal(reMe.plan, "paid");

  // idempotent re-verify of the same invoice answers with the plan, not an error
  const twice = await payInvoice(acct.token, invoice, { receipt });
  assert.equal(twice.status, 200);
  assert.equal(JSON.parse(twice.body).alreadyPaid, true);

  // replay protection: the same transaction cannot pay a second invoice
  const inv2 = JSON.parse((await request("POST", "/api/billing/invoices", { headers: { authorization: `Bearer ${acct.token}` } })).body);
  const replay = await payInvoice(acct.token, inv2, { receipt });
  assert.equal(replay.status, 402);
  assert.match(JSON.parse(replay.body).error, /already used/i);
});

test("billing routes need an account", async () => {
  assert.equal((await request("POST", "/api/billing/invoices")).status, 401);
  assert.equal((await request("POST", "/api/billing/verify", { body: JSON.stringify({}), headers: { "content-type": "application/json" } })).status, 401);
  assert.equal((await request("GET", "/api/billing/status")).status, 401);
  // but the public overview needs nobody
  assert.equal((await request("GET", "/api/billing")).status, 200);
});

// --- concurrency: serialized persistence ------------------------------------
// These pin the review findings: shared temporary filenames and unsynchronized
// writes used to let overlapping operations corrupt accounts.json and
// invoices.json, and a rejected upload used to delete every other upload's
// staging file with the shared tmp directory.

test("concurrent account operations persist one consistent store", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-acct-conc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new Accounts(dir);
  await ledger.init();

  // 12 sign-ups, logins for those already made, and logouts, all fired at once.
  const emails = Array.from({ length: 12 }, (_, i) => `concurrent-${i}@example.com`);
  const jobs = emails.map((email) => ledger.create(email, "correct horse battery"));
  const created = await Promise.all(jobs);
  const tokens = created.map((made) => made.token);
  // now logins and logouts over the live accounts, all at once
  const overlapping = [
    ...emails.slice(1).map((email) => ledger.login(email, "correct horse battery")),
    ...tokens.slice(0, 4).map((token) => ledger.logout(token))
  ];
  const settled = await Promise.allSettled([...jobs, ...overlapping]);
  for (const s of settled) assert.equal(s.status, "fulfilled", "no concurrent operation may fail: " + (s.reason && s.reason.message));

  // A fresh instance reloads the same file: valid JSON, every account there.
  const reopened = new Accounts(dir);
  await reopened.init();
  for (const email of emails) {
    assert.ok(reopened.data.accounts.some((a) => a.email === email), `${email} survived`);
  }
  // every session on disk still authenticates its account
  const raw = fs.readFileSync(path.join(dir, "accounts.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(raw), "the persisted file is valid JSON");
  for (const token of tokens.slice(4)) {
    assert.ok(await reopened.auth(token), "a live session still authenticates after the storm");
  }
  // and the logged-out ones no longer do
  for (const token of tokens.slice(0, 4)) {
    assert.equal(await reopened.auth(token), null);
  }
  // no temporary files were left behind
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("concurrent account operations survive a failing commit with state intact", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-acct-fail-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new Accounts(dir);
  await ledger.init();
  const made = await ledger.create("first@example.com", "correct horse battery");

  // the next commits fail, as a full disk would
  const realCommit = ledger.commit;
  ledger.commit = async () => { throw new Error("disk full"); };
  const signup = await ledger.create("second@example.com", "correct horse battery").then(() => null, (err) => err);
  assert.ok(signup, "the sign-up fails when its commit fails");
  const logout = await ledger.logout(made.token).then(() => "changed", (err) => err);
  assert.notEqual(logout, "changed", "the logout fails when its commit fails");

  // memory rolled back to what is on disk, and the queue still works
  assert.equal(ledger.data.accounts.length, 1, "the failed sign-up left no half-account");
  ledger.commit = realCommit;
  const third = await ledger.create("third@example.com", "correct horse battery");
  assert.ok(third.token, "operations queued behind a failure still run");

  const reopened = new Accounts(dir);
  await reopened.init();
  assert.deepEqual(reopened.data.accounts.map((a) => a.email), ["first@example.com", "third@example.com"]);
  assert.ok(await reopened.auth(made.token), "the failed logout did not drop the session on disk");
});

test("concurrent invoice creation and expiry persist every committed state", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-inv-conc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new payments.Invoices(dir);
  await ledger.init();

  // two stale invoices to expire, then a storm of creations and expiries at once
  const stale1 = await ledger.create("stale-account", Date.now() - 2 * payments.INVOICE_TTL_MS);
  const stale2 = await ledger.create("stale-account", Date.now() - 2 * payments.INVOICE_TTL_MS);
  const creations = Array.from({ length: 20 }, (_, i) => ledger.create(`account-${i % 3}`, Date.now() + i));
  const expiries = Array.from({ length: 6 }, () => ledger.expireStale(Date.now()));
  const settled = await Promise.allSettled([...creations, ...expiries]);
  for (const s of settled) assert.equal(s.status, "fulfilled", "no concurrent invoice operation may fail: " + (s.reason && s.reason.message));

  const created = (await Promise.all(creations)).map((i) => i.id);
  const reopened = new payments.Invoices(dir);
  await reopened.init();
  const raw = fs.readFileSync(path.join(dir, "invoices.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(raw), "the persisted file is valid JSON");
  assert.equal(reopened.data.invoices.length, created.length + 2, "no invoice was lost across the restart");
  for (const id of created) {
    assert.ok(reopened.find(id), `invoice ${id} survived`);
  }
  // the two stale ones ended expired, exactly once, and nothing else moved
  assert.equal(reopened.find(stale1.id).status, "expired");
  assert.equal(reopened.find(stale2.id).status, "expired");
  for (const id of created) {
    assert.equal(reopened.find(id).status, "pending", "a fresh invoice is still pending");
  }
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("a failing invoice commit rolls back and the queue keeps working", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-inv-fail-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new payments.Invoices(dir);
  await ledger.init();

  const realCommit = ledger.commit;
  ledger.commit = async () => { throw new Error("disk full"); };
  const failed = await ledger.create("account-x").then(() => null, (err) => err);
  assert.ok(failed, "creation fails when its commit fails");
  assert.equal(ledger.data.invoices.length, 0, "the failed creation left no half-invoice");

  ledger.commit = realCommit;
  const ok = await ledger.create("account-x");
  assert.ok(ok.id, "operations queued behind a failure still run");
  const reopened = new payments.Invoices(dir);
  await reopened.init();
  assert.equal(reopened.data.invoices.length, 1);
  assert.equal(reopened.find(ok.id).id, ok.id);
});

test("a valid upload survives concurrent empty and oversized uploads", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-store-conc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  await store.init();

  const maxBytes = 16 * 1024;
  const { PassThrough } = require("node:stream");

  // A request whose body arrives in chunks with gaps, so it is still writing
  // while the failures below finish — exactly the overlap that used to delete
  // its staging file along with the shared tmp directory.
  const payload = crypto.randomBytes(12 * 1024);
  const validReq = new PassThrough();
  (async () => {
    for (let i = 0; i < payload.length; i += 2048) {
      validReq.write(payload.subarray(i, i + 2048));
      await new Promise((r) => setTimeout(r, 2));
    }
    validReq.end();
  })();

  const emptyReq = new PassThrough();
  emptyReq.end();

  const bigReq = new PassThrough();
  (async () => {
    bigReq.write(Buffer.alloc(maxBytes)); // at the cap…
    bigReq.write(Buffer.alloc(1024)); // …then over it: the transform rejects
    bigReq.end();
  })();

  const [valid, empty, big] = await Promise.allSettled([
    store.createFromStream(validReq, { maxBytes, contentType: "video/webm", filename: "ok.webm", accountId: "acc-1" }),
    store.createFromStream(emptyReq, { maxBytes, contentType: "video/webm", filename: "empty.webm", accountId: "acc-1" }),
    store.createFromStream(bigReq, { maxBytes, contentType: "video/webm", filename: "big.webm", accountId: "acc-1" })
  ]);

  // the failures failed for the right reasons
  assert.equal(empty.status, "rejected");
  assert.equal(empty.reason.status, 400, "the empty upload is refused as empty");
  assert.equal(big.status, "rejected");
  const { UploadTooLarge } = require("../lib/store");
  assert.ok(big.reason instanceof UploadTooLarge, "the oversized upload is refused as too large");

  // the valid one made it — and intact
  assert.equal(valid.status, "fulfilled", "the valid upload must survive: " + (valid.reason && valid.reason.stack));
  const { meta, manageToken } = valid.value;
  assert.equal(meta.bytes, payload.length);
  assert.deepEqual(fs.readFileSync(store.videoPath(meta.id)), payload, "the recording on disk is byte-identical");
  const reMeta = await store.get(meta.id);
  assert.equal(reMeta.accountId, "acc-1");
  assert.ok(reMeta.tokenHash, "the manage token hash is recorded");
  assert.notEqual(reMeta.tokenHash, manageToken, "only the hash is stored");

  // the shared tmp directory is intact and holds no leftover staging files
  assert.deepEqual(fs.readdirSync(path.join(dir, "tmp")), [], "no staging files were left behind");
});

test("two concurrent verifies of the same receipt extend the plan once", { timeout: 8000 }, async () => {
  const acct = await makeAccount("race-payer@example.com");
  const invoice = JSON.parse((await request("POST", "/api/billing/invoices", { headers: { authorization: `Bearer ${acct.token}` } })).body);
  // a tx hash of this test's own — TX_HASH was already spent on another invoice
  const raceHash = "0x" + "b7".repeat(32);
  const receipt = { status: "0x1", logs: [transferLog({ contract: payments.USDC_CONTRACT, to: invoice.payTo, microUsdc: 10_000_000n })] };

  // Both verifies wait on the (stubbed) network before either commits, so the
  // serialization point is markPaid, not the HTTP handler: the stub holds
  // every answer until both requests are in flight.
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const slowFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const result = body.method === "eth_chainId"
      ? "0x" + BigInt(payments.CHAIN_ID).toString(16)
      : body.method === "eth_getTransactionReceipt" ? receipt : null;
    await gate; // both requests are in flight before either returns
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = slowFetch;
  // launch both, give them time to reach the stubbed chain, then release them
  const pending = [
    request("POST", "/api/billing/verify", {
      body: JSON.stringify({ invoiceId: invoice.invoiceId, txHash: raceHash }),
      headers: { "content-type": "application/json", authorization: `Bearer ${acct.token}` }
    }),
    request("POST", "/api/billing/verify", {
      body: JSON.stringify({ invoiceId: invoice.invoiceId, txHash: raceHash }),
      headers: { "content-type": "application/json", authorization: `Bearer ${acct.token}` }
    })
  ];
  await new Promise((r) => setTimeout(r, 100));
  openGate();
  globalThis.fetch = realFetch;
  const [first, second] = await Promise.allSettled(pending);

  // both succeed, but the plan runs 30 days from now, not 60
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "fulfilled");
  const a = JSON.parse(first.value.body);
  const b = JSON.parse(second.value.body);
  assert.equal(a.status, "paid");
  assert.equal(b.status, "paid");
  const onePaidUntil = Math.max(a.paidUntil, b.paidUntil);
  assert.ok(onePaidUntil < Date.now() + 30 * 24 * 60 * 60 * 1000 + 5000, "one payment, one 30-day extension");
  assert.ok(onePaidUntil > Date.now() + 29 * 24 * 60 * 60 * 1000, "and it is a full 30 days");
  const oneWasIdempotent = a.alreadyPaid === true || b.alreadyPaid === true;
  assert.ok(oneWasIdempotent, "the second verify reported the plan rather than paying twice");

  // and the invoice ledger holds exactly one paid record for the transaction
  const raw = fs.readFileSync(path.join(process.env.DATA_DIR, "invoices.json"), "utf8");
  const stored = JSON.parse(raw).invoices.filter((i) => i.txHash === raceHash);
  assert.equal(stored.length, 1, "the transaction is recorded exactly once");
  assert.equal(stored[0].status, "paid");
});

// --- concurrency: finalization and publication ------------------------------
// These pin review round 2: invoice finalization must re-check replay and
// expiry inside its mutation lock, and account mutations must publish
// nothing until their persistence commit has landed.

test("an invoice that expires during verification is never finalized", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-inv-exp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new payments.Invoices(dir);
  await ledger.init();

  // An invoice with 50 ms to live: a verify's preliminary checks run while
  // it is pending, the (stubbed) chain answers after it has expired, and
  // finalization — whose checks run inside the mutation lock, at the clock
  // of that moment — must refuse a dead request.
  const invoice = await ledger.create("account-1", Date.now() - payments.INVOICE_TTL_MS + 50);
  await new Promise((r) => setTimeout(r, 80));
  const txHash = "0x" + "d4".repeat(32);
  const failed = await ledger.markPaid(invoice.id, { txHash, paidAt: Date.now() }).then(() => null, (err) => err);
  assert.ok(failed, "the expired invoice is not paid");
  assert.equal(failed.status, 410);
  assert.equal(ledger.find(invoice.id).status, "pending", "the invoice is left as it was");
  assert.equal(ledger.findByTx(txHash), null, "the transaction is not recorded against it");

  // the refusal holds on disk too
  const reopened = new payments.Invoices(dir);
  await reopened.init();
  assert.equal(reopened.find(invoice.id).status, "pending");
  assert.equal(reopened.findByTx(txHash), null);

  // a live invoice finalizes under the same clock — the letters of the
  // hash must not matter
  const live = await ledger.create("account-1");
  const paid = await ledger.markPaid(live.id, { txHash: txHash.toUpperCase().replace(/^0X/, "0x"), paidAt: Date.now() });
  assert.equal(paid.already, false);
  assert.equal(ledger.find(live.id).status, "paid");
  assert.equal(ledger.find(live.id).txHash, txHash, "the hash is stored normalized");

  // the same transaction again on the paid invoice is idempotent…
  const sameTx = await ledger.markPaid(live.id, { txHash, paidAt: Date.now() });
  assert.equal(sameTx.already, true);
  // …a second invoice cannot take the spent hash…
  const second = await ledger.create("account-2");
  const spent = await ledger.markPaid(second.id, { txHash, paidAt: Date.now() }).then(() => null, (err) => err);
  assert.ok(spent, "the spent hash is refused on a second invoice");
  assert.equal(spent.status, 402);
  // …and neither a malformed hash nor a foreign hash passes the lock
  const malformed = await ledger.markPaid(second.id, { txHash: "0x1234", paidAt: Date.now() }).then(() => null, (err) => err);
  assert.equal(malformed.status, 400);
  assert.equal(ledger.find(second.id).status, "pending");
});

test("one transaction cannot pay two invoices verified concurrently", { timeout: 8000 }, async () => {
  const a = await makeAccount("dual-a@example.com");
  const b = await makeAccount("dual-b@example.com");
  const invA = JSON.parse((await request("POST", "/api/billing/invoices", { headers: { authorization: `Bearer ${a.token}` } })).body);
  const invB = JSON.parse((await request("POST", "/api/billing/invoices", { headers: { authorization: `Bearer ${b.token}` } })).body);

  // One transaction whose receipt carries a transfer to BOTH invoice
  // addresses: judged on its own, each verification looks like the exact
  // payment for its invoice. Both verifies sit on the stubbed chain before
  // either can finalize, so both pass the route's preliminary replay check
  // — the race only the lock's own check can settle.
  const sharedHash = "0x" + "c9".repeat(32);
  const receipt = {
    status: "0x1",
    logs: [
      transferLog({ contract: payments.USDC_CONTRACT, to: invA.payTo, microUsdc: 10_000_000n }),
      transferLog({ contract: payments.USDC_CONTRACT, to: invB.payTo, microUsdc: 10_000_000n })
    ]
  };
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const slowFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const result = body.method === "eth_chainId"
      ? "0x" + BigInt(payments.CHAIN_ID).toString(16)
      : body.method === "eth_getTransactionReceipt" ? receipt : null;
    await gate;
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = slowFetch;
  const attempts = [
    { inv: invA, token: a.token },
    { inv: invB, token: b.token }
  ].map(({ inv, token }) => request("POST", "/api/billing/verify", {
    body: JSON.stringify({ invoiceId: inv.invoiceId, txHash: sharedHash }),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }
  }));
  await new Promise((r) => setTimeout(r, 100));
  openGate();
  globalThis.fetch = realFetch;
  const settled = await Promise.allSettled(attempts);
  const statuses = settled.map((s) => s.value.status).sort();
  assert.deepEqual(statuses, [200, 402], "exactly one verification may finalize");

  const answers = settled.map((s) => JSON.parse(s.value.body));
  const paidOnes = answers.filter((x) => x.status === "paid");
  assert.equal(paidOnes.length, 1, "one transaction pays one invoice");
  assert.ok(paidOnes[0].paidUntil > Date.now() + 29 * 24 * 60 * 60 * 1000, "the winner holds a full 30 days");
  const refused = answers.find((x) => x.status !== "paid");
  assert.match(refused.error, /already used/i);

  // the ledger records the transaction exactly once, on the paid invoice
  const raw = fs.readFileSync(path.join(process.env.DATA_DIR, "invoices.json"), "utf8");
  const withHash = JSON.parse(raw).invoices.filter((i) => i.txHash === sharedHash);
  assert.equal(withHash.length, 1, "the shared transaction is recorded once");
  assert.equal(withHash[0].status, "paid");

  // and exactly one of the two accounts holds the plan
  const plans = [];
  for (const who of [a, b]) {
    const mine = JSON.parse((await request("GET", "/api/me", { headers: { authorization: `Bearer ${who.token}` } })).body);
    plans.push(mine.plan);
  }
  assert.deepEqual(plans.sort(), ["free", "paid"]);
});

test("a plan upgrade is invisible to readers until its commit lands", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-acct-plan-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new Accounts(dir);
  await ledger.init();
  const made = await ledger.create("reader@example.com", "correct horse battery");

  // Hold the plan's commit on the wire, the way a slow or failing disk would.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let holding = true;
  const realCommit = ledger.commit.bind(ledger);
  ledger.commit = async (state) => {
    if (!holding) return realCommit(state);
    await held;
    holding = false;
    throw new Error("disk full");
  };

  // The upgrade starts and its commit hangs; meanwhile readers authenticate.
  const upgrade = ledger.setPlan(made.id, payments.extendPaid);
  await new Promise((r) => setTimeout(r, 20));
  const whilePending = await ledger.auth(made.token);
  assert.equal(whilePending.plan, undefined, "no uncommitted plan reaches a reader while the write runs");

  // The write fails: the reader still sees exactly what the disk holds.
  release();
  const failed = await upgrade.then(() => null, (err) => err);
  assert.ok(failed, "the upgrade fails when its commit fails");
  assert.equal((await ledger.auth(made.token)).plan, undefined, "still free after the failed commit");
  const raw = fs.readFileSync(path.join(dir, "accounts.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(raw), "the persisted file is valid JSON");
  assert.ok(!raw.includes("paidUntil"), "the uncommitted plan never reached the disk");

  // and a later upgrade commits, becomes visible, and survives a restart
  ledger.commit = realCommit;
  const paidUntil = await ledger.setPlan(made.id, payments.extendPaid);
  assert.ok(paidUntil > Date.now() + 29 * 24 * 60 * 60 * 1000);
  assert.equal((await ledger.auth(made.token)).plan.tier, "paid");
  const reopened = new Accounts(dir);
  await reopened.init();
  assert.equal((await reopened.auth(made.token)).plan.tier, "paid");
});

// --- recovery: the crash window between the two commits ---------------------
// A verified payment is two durable commits: the invoice is marked paid,
// then the account's plan is extended. These pin the round-3 review change:
// the account snapshot records every invoice it applied next to the
// paidUntil it bought, and a retry or a restart finishes a grant a crash
// interrupted — exactly once, with the payment's original timing.

test("a paid invoice stranded by a failed plan commit heals on retry, exactly once", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-heal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new Accounts(dir);
  const notes = new payments.Invoices(dir);
  await ledger.init();
  await notes.init();
  const made = await ledger.create("stranded@example.com", "correct horse battery");
  const invoice = await notes.create(made.id);
  // the payment verified five days ago: the invoice committed, the plan did not
  const paidAt = Date.now() - 5 * 24 * 60 * 60 * 1000;
  const txHash = "0x" + "e1".repeat(32);
  await notes.markPaid(invoice.id, { txHash, paidAt });

  // the account commit fails the way a crash or a full disk would
  const realCommit = ledger.commit.bind(ledger);
  ledger.commit = async () => { throw new Error("disk full"); };
  const failed = await payments.ensureEntitlement({ accounts: ledger, invoice: notes.find(invoice.id) })
    .then(() => null, (err) => err);
  assert.ok(failed, "the grant fails with its commit");
  assert.equal(failed.message, "disk full");
  ledger.commit = realCommit;
  assert.equal((await ledger.auth(made.token)).plan, undefined, "no plan after the failed grant");

  // a restart between the two commits: fresh instances read the same files
  const accounts2 = new Accounts(dir);
  const invoices2 = new payments.Invoices(dir);
  await accounts2.init();
  await invoices2.init();
  assert.equal(invoices2.find(invoice.id).status, "paid", "the invoice survived as paid");
  assert.equal((await accounts2.auth(made.token)).plan, undefined, "the plan did not");
  assert.equal(invoices2.findByTx(txHash).id, invoice.id, "replay protection survives the crash too");

  // recovery grants the entitlement with its original timing — five of the
  // thirty days have run, they are not restarted
  const paidUntil = await payments.ensureEntitlement({ accounts: accounts2, invoice: invoices2.find(invoice.id) });
  assert.ok(Math.abs(paidUntil - (paidAt + payments.MONTH_MS)) < 1000, "the 30 days run from the payment, not from the recovery");
  assert.ok(paidUntil < Date.now() + 26 * 24 * 60 * 60 * 1000, "recovery does not hand out fresh days");

  // a second recovery — and two concurrent ones — grant nothing extra
  const [again, racing] = await Promise.all([
    payments.ensureEntitlement({ accounts: accounts2, invoice: invoices2.find(invoice.id) }),
    payments.ensureEntitlement({ accounts: accounts2, invoice: invoices2.find(invoice.id) })
  ]);
  assert.equal(again, paidUntil);
  assert.equal(racing, paidUntil);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, "accounts.json"), "utf8"));
  const plan = stored.accounts.find((a) => a.id === made.id).plan;
  assert.equal(plan.paidUntil, paidUntil, "the paidUntil and the applied invoice committed together");
  assert.deepEqual(plan.appliedInvoices.map((a) => a.invoiceId), [invoice.id], "the invoice is recorded as applied exactly once");

  // the spent hash still cannot pay a fresh invoice
  const fresh = await invoices2.create(made.id);
  const replay = await invoices2.markPaid(fresh.id, { txHash, paidAt: Date.now() }).then(() => null, (err) => err);
  assert.equal(replay.status, 402);
});

test("startup reconciliation heals stranded payments once and skips ambiguous plans", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-reconcile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new Accounts(dir);
  const notes = new payments.Invoices(dir);
  await ledger.init();
  await notes.init();

  // account A: the classic crash window — a paid invoice and no plan at all
  const a = await ledger.create("stranded-a@example.com", "correct horse battery");
  const invoiceA = await notes.create(a.id);
  const paidAtA = Date.now() - 2 * 24 * 60 * 60 * 1000;
  await notes.markPaid(invoiceA.id, { txHash: "0x" + "e2".repeat(32), paidAt: paidAtA });

  // account B: a live plan recorded before applications were tracked, and a
  // paid invoice that may or may not be the reason the plan exists
  const b = await ledger.create("legacy@example.com", "correct horse battery");
  await ledger.setPlan(b.id, (copy) => {
    copy.plan = { tier: "paid", paidUntil: Date.now() + 10 * 24 * 60 * 60 * 1000 };
    return copy.plan;
  });
  const invoiceB = await notes.create(b.id);
  await notes.markPaid(invoiceB.id, { txHash: "0x" + "e3".repeat(32), paidAt: Date.now() - 1 * 24 * 60 * 60 * 1000 });

  const healed = await payments.reconcileEntitlements({ invoices: notes, accounts: ledger });
  assert.deepEqual(healed.sort(), [invoiceA.id], "only the provably stranded payment is healed");

  // A holds its plan, timed from its payment, with the invoice recorded
  const planA = (await ledger.auth(a.token)).plan;
  assert.equal(planA.tier, "paid");
  assert.ok(Math.abs(planA.paidUntil - (paidAtA + payments.MONTH_MS)) < 1000);
  assert.deepEqual(planA.appliedInvoices.map((x) => x.invoiceId), [invoiceA.id]);
  // B is untouched: granting there could double-count a payment already honored
  const planB = (await ledger.auth(b.token)).plan;
  assert.ok(planB.paidUntil > Date.now() + 9 * 24 * 60 * 60 * 1000, "the legacy plan keeps its own timing");
  assert.equal(planB.appliedInvoices, undefined, "nothing was recorded against the ambiguous plan");
  assert.equal(notes.find(invoiceB.id).status, "paid", "the ambiguous invoice is not lost — a retry heals it");

  // running again heals nothing — exactly once
  assert.deepEqual(await payments.reconcileEntitlements({ invoices: notes, accounts: ledger }), []);
});

// --- round 4: the entitlement adds up in payment order ----------------------
// The subscription a set of payments buys must not depend on the order the
// payments were applied or recovered in: an older stranded payment recovered
// after a later one covers its own window instead of stacking a month onto
// the later subscription, gaps between subscriptions stay gaps, and
// reconciliation reads the ledger in payment order.

test("an older stranded payment recovered after a later one covers its own window", async (t) => {
  const DAY = 24 * 60 * 60 * 1000;

  // One scenario, parameterized by which payment is applied first. Both
  // orders must add up to the same subscription: the day-0 payment covers
  // days 0–30, the day-60 payment covers days 60–90, the gap stays a gap.
  async function scenario({ recoverOldFirst }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-gap-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const ledger = new Accounts(dir);
    const notes = new payments.Invoices(dir);
    await ledger.init();
    await notes.init();
    const made = await ledger.create("gap@example.com", "correct horse battery");

    // day 0: the payment verifies, the invoice commit lands, the account
    // commit fails — the payment is stranded and the account has no plan
    const oldInvoice = await notes.create(made.id);
    const paidAtOld = Date.now() - 60 * DAY;
    await notes.markPaid(oldInvoice.id, { txHash: "0x" + "a1".repeat(32), paidAt: paidAtOld });
    const realCommit = ledger.commit.bind(ledger);
    ledger.commit = async () => { throw new Error("disk full"); };
    const failed = await payments
      .ensureEntitlement({ accounts: ledger, invoice: notes.find(oldInvoice.id) })
      .then(() => null, (err) => err);
    assert.ok(failed, "the day-0 grant fails with its commit");
    ledger.commit = realCommit;

    // day 60: a later payment lands cleanly. Nothing was live when it was
    // made — the day-0 payment never landed — so it starts a fresh window.
    const laterInvoice = await notes.create(made.id);
    const paidAtLater = Date.now();
    await notes.markPaid(laterInvoice.id, { txHash: "0x" + "a2".repeat(32), paidAt: paidAtLater });

    const oldPaid = notes.find(oldInvoice.id);
    const laterPaid = notes.find(laterInvoice.id);
    const first = recoverOldFirst ? oldPaid : laterPaid;
    const second = recoverOldFirst ? laterPaid : oldPaid;
    const firstUntil = await payments.ensureEntitlement({ accounts: ledger, invoice: first });
    const secondUntil = await payments.ensureEntitlement({ accounts: ledger, invoice: second });
    return { made, dir, oldInvoice, laterInvoice, paidAtOld, paidAtLater, firstUntil, secondUntil };
  }

  // The later payment applied first starts its own fresh window (days 60–90);
  // recovering the day-0 payment then covers its own already-spent days 0–30
  // instead of adding a month on top of the later subscription.
  const laterFirst = await scenario({ recoverOldFirst: false });
  assert.ok(Math.abs(laterFirst.firstUntil - (laterFirst.paidAtLater + payments.MONTH_MS)) < 1000,
    "the later payment starts a fresh window — nothing came before it");
  assert.equal(laterFirst.secondUntil, laterFirst.firstUntil,
    "recovering the older payment does not extend the later subscription");

  // The same two payments, recovered in the other order, add up to the same
  // subscription: the day-0 window runs from the payment (already spent) and
  // the day-60 payment still owns a fresh 30 days of its own.
  const oldFirst = await scenario({ recoverOldFirst: true });
  assert.ok(Math.abs(oldFirst.firstUntil - (oldFirst.paidAtOld + payments.MONTH_MS)) < 1000,
    "the day-0 window runs from the payment, not the recovery");
  assert.ok(oldFirst.firstUntil < Date.now(), "and it has already run out — no fresh days");
  assert.ok(Math.abs(oldFirst.secondUntil - (oldFirst.paidAtLater + payments.MONTH_MS)) < 1000,
    "the two payments add up to the same subscription either way");

  for (const run of [laterFirst, oldFirst]) {
    const stored = JSON.parse(fs.readFileSync(path.join(run.dir, "accounts.json"), "utf8"));
    const plan = stored.accounts.find((a) => a.id === run.made.id).plan;
    assert.equal(plan.paidUntil, run.secondUntil);
    assert.deepEqual(plan.appliedInvoices.map((a) => a.invoiceId).sort(),
      [run.oldInvoice.id, run.laterInvoice.id].sort());
    assert.deepEqual(plan.appliedInvoices.map((a) => a.paidAt).sort((a, b) => a - b),
      [run.paidAtOld, run.paidAtLater], "the ledger records when each payment was made");
  }
});

test("reconciliation adds up invoices in payment order, not creation order", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-reconcile-order-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const DAY = 24 * 60 * 60 * 1000;
  const ledger = new Accounts(dir);
  const notes = new payments.Invoices(dir);
  await ledger.init();
  await notes.init();
  const made = await ledger.create("order@example.com", "correct horse battery");

  // created in one order, paid in the other: the invoice created second was
  // paid a day earlier, and neither payment ever granted its entitlement
  const createdFirst = await notes.create(made.id);
  const createdSecond = await notes.create(made.id);
  const paidEarlier = Date.now() - 3 * DAY; // created second, paid first
  const paidLater = Date.now() - 2 * DAY; // created first, paid second
  await notes.markPaid(createdSecond.id, { txHash: "0x" + "b1".repeat(32), paidAt: paidEarlier });
  await notes.markPaid(createdFirst.id, { txHash: "0x" + "b2".repeat(32), paidAt: paidLater });

  const healed = await payments.reconcileEntitlements({ invoices: notes, accounts: ledger });
  assert.deepEqual(healed.sort(), [createdFirst.id, createdSecond.id].sort(), "both stranded payments heal");

  // In payment order: the earlier payment covers its own 30 days and the
  // later one is made while that coverage is live, so it stacks on top of
  // what is left. Creation order would stack the other way and land a day off.
  const plan = (await ledger.auth(made.token)).plan;
  assert.ok(Math.abs(plan.paidUntil - (paidEarlier + 2 * payments.MONTH_MS)) < 1000,
    "the subscription adds up in payment order");

  // and a second reconciliation changes nothing — exactly once
  assert.deepEqual(await payments.reconcileEntitlements({ invoices: notes, accounts: ledger }), []);
  assert.equal((await ledger.auth(made.token)).plan.paidUntil, plan.paidUntil);
});

test("a recovered payment whose window ran out grants no live days and keeps the gap", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-expired-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const DAY = 24 * 60 * 60 * 1000;
  const ledger = new Accounts(dir);
  const notes = new payments.Invoices(dir);
  await ledger.init();
  await notes.init();
  const made = await ledger.create("expired@example.com", "correct horse battery");

  // the payment was made 40 days ago: its 30 days ran out 10 days ago
  const invoice = await notes.create(made.id);
  const paidAt = Date.now() - 40 * DAY;
  await notes.markPaid(invoice.id, { txHash: "0x" + "c1".repeat(32), paidAt });
  const paidUntil = await payments.ensureEntitlement({ accounts: ledger, invoice: notes.find(invoice.id) });
  assert.ok(Math.abs(paidUntil - (paidAt + payments.MONTH_MS)) < 1000, "the window runs from the payment");
  assert.ok(paidUntil < Date.now(), "it is not restarted from the recovery");
  const held = await ledger.auth(made.token);
  assert.equal(payments.activePaidUntil(held), null, "a spent window buys no live plan");
  assert.equal(payments.limitsFor(held).tier, "free");

  // retries stay exactly once and never shift the expired window
  assert.equal(await payments.ensureEntitlement({ accounts: ledger, invoice: notes.find(invoice.id) }), paidUntil);

  // a fresh payment today starts its own window — the gap stays a gap
  const fresh = await notes.create(made.id);
  await notes.markPaid(fresh.id, { txHash: "0x" + "c2".repeat(32), paidAt: Date.now() });
  const freshUntil = await payments.ensureEntitlement({ accounts: ledger, invoice: notes.find(fresh.id) });
  assert.ok(Math.abs(freshUntil - (Date.now() + payments.MONTH_MS)) < 1000,
    "the fresh window starts now, not on top of the expired one");
});

test("a plan with a pre-timestamp ledger keeps its entitlement when a new payment lands", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openloom-legacy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const DAY = 24 * 60 * 60 * 1000;
  const ledger = new Accounts(dir);
  const notes = new payments.Invoices(dir);
  await ledger.init();
  await notes.init();
  const made = await ledger.create("legacy-ledger@example.com", "correct horse battery");

  // a plan written by the previous revision: a ledger of {invoiceId,
  // paidUntil} entries with no payment timestamps and no recorded baseline
  const legacyUntil = Date.now() + 10 * DAY;
  await ledger.setPlan(made.id, (copy) => {
    copy.plan = {
      tier: "paid",
      paidUntil: legacyUntil,
      appliedInvoices: [{ invoiceId: "legacy-invoice", paidUntil: legacyUntil }]
    };
    return copy.plan;
  });

  const fresh = await notes.create(made.id);
  await notes.markPaid(fresh.id, { txHash: "0x" + "d1".repeat(32), paidAt: Date.now() });
  const until = await payments.ensureEntitlement({ accounts: ledger, invoice: notes.find(fresh.id) });
  assert.ok(Math.abs(until - (legacyUntil + payments.MONTH_MS)) < 1000,
    "the new payment stacks on the legacy plan instead of shortening it");
  const plan = (await ledger.auth(made.token)).plan;
  assert.equal(plan.baselineUntil, legacyUntil, "the legacy entitlement is recorded as the explicit baseline");
  assert.deepEqual(plan.appliedInvoices.map((a) => a.invoiceId), ["legacy-invoice", fresh.id],
    "the pre-timestamp entry is kept, so its payment still applies exactly once");
});

test("a verify whose plan commit fails answers honestly and heals on retry", async (t) => {
  const acct = await makeAccount("heal-payer@example.com");
  const invoice = JSON.parse((await request("POST", "/api/billing/invoices", { headers: { authorization: `Bearer ${acct.token}` } })).body);
  const receipt = { status: "0x1", logs: [transferLog({ contract: payments.USDC_CONTRACT, to: invoice.payTo, microUsdc: 10_000_000n })] };
  const healHash = "0x" + "f2".repeat(32);

  // fail every account commit that would land a paid plan, the way a crash
  // between the invoice commit and the account commit would
  let failPlanCommits = true;
  const realCommit = Accounts.prototype.commit;
  Accounts.prototype.commit = async function (state) {
    if (failPlanCommits && state.accounts.some((a) => a.plan && a.plan.tier === "paid")) {
      throw new Error("disk full");
    }
    return realCommit.call(this, state);
  };
  t.after(() => { Accounts.prototype.commit = realCommit; });

  // the verify records the payment but cannot grant the plan: 503, honestly
  const first = await payInvoice(acct.token, invoice, { receipt, txHash: healHash });
  assert.equal(first.status, 503);
  assert.match(JSON.parse(first.body).error, /recorded/i);

  // the payment is durably on disk even though the plan never landed
  const rawInvoices = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, "invoices.json"), "utf8"));
  const stranded = rawInvoices.invoices.find((i) => i.id === invoice.invoiceId);
  assert.equal(stranded.status, "paid");
  const mine = JSON.parse((await request("GET", "/api/me", { headers: { authorization: `Bearer ${acct.token}` } })).body);
  assert.equal(mine.plan, "free");

  // the retry — the same payment verified again — applies the plan once
  failPlanCommits = false;
  const second = await payInvoice(acct.token, invoice, { receipt, txHash: healHash });
  assert.equal(second.status, 200);
  const healed = JSON.parse(second.body);
  assert.equal(healed.status, "paid");
  assert.equal(healed.alreadyPaid, true);
  assert.ok(healed.paidUntil > Date.now() + 29 * 24 * 60 * 60 * 1000, "one payment, one 30-day window");
  assert.ok(healed.paidUntil < Date.now() + 30 * 24 * 60 * 60 * 1000 + 5000, "and not a day more");
  const stored = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, "accounts.json"), "utf8"));
  const mineAfter = stored.accounts.find((a) => a.email === "heal-payer@example.com");
  assert.equal(mineAfter.plan.appliedInvoices.length, 1, "the retry granted the entitlement exactly once");
  const [applied] = mineAfter.plan.appliedInvoices;
  assert.ok(Math.abs(applied.paidAt - Date.now()) < 60_000, "the ledger records when the payment was made");

  // and replay protection held through the crash: the same transaction
  // cannot pay a new invoice
  const inv2 = JSON.parse((await request("POST", "/api/billing/invoices", { headers: { authorization: `Bearer ${acct.token}` } })).body);
  const replay = await payInvoice(acct.token, inv2, { receipt, txHash: healHash });
  assert.equal(replay.status, 402);
  assert.match(JSON.parse(replay.body).error, /already used/i);
});

// --- concurrent uploads -----------------------------------------------------
// A failed upload must clean up only its own staging file. The shared tmp
// directory and every other upload in flight must survive it untouched.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits until cond() is true, so cleanup that races the response can be
// waited for instead of guessed at.
async function waitFor(cond, timeoutMs, everyMs = 25) {
  for (let waited = 0; waited < timeoutMs; waited += everyMs) {
    if (cond()) return true;
    await sleep(everyMs);
  }
  return false;
}

// An upload whose body arrives in a first burst and then stops — the server
// is mid-save and holds a staging file — until finish() sends the rest.
function gatedUpload(payload, token) {
  const req = http.request(base + "/api/clips", {
    method: "POST",
    headers: {
      "content-type": "video/webm",
      "content-length": String(payload.length),
      authorization: `Bearer ${token}`
    }
  });
  const done = new Promise((resolve, reject) => {
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
  });
  req.write(payload.subarray(0, 8192));
  return {
    req,
    done,
    finish: () => req.end(payload.subarray(8192))
  };
}

test("empty, aborted and oversized uploads cannot disturb a concurrent save", async () => {
  const account = await makeAccount("concurrent-save@example.com");
  const clipsBefore = fs.readdirSync(path.join(process.env.DATA_DIR, "clips")).length;
  // below the free clip cap (16 KB here) but past the gated first burst; a
  // real webm timeline, since the server verifies every upload's duration
  // from the file itself and refuses anything it cannot verify
  const payload = webmPayload(12 * 1024, 3000);
  const good = gatedUpload(payload, account.token);
  await sleep(100); // its staging file now exists on the server

  // an empty upload alongside
  const empty = await request("POST", "/api/clips", {
    body: Buffer.alloc(0),
    headers: { "content-type": "video/webm", authorization: `Bearer ${account.token}` }
  });
  assert.equal(empty.status, 400);

  // an aborted upload: bytes first, then the client walks away mid-stream
  const aborted = await new Promise((resolve) => {
    const req = http.request(base + "/api/clips", {
      method: "POST",
      headers: { "content-type": "video/webm", authorization: `Bearer ${account.token}` }
    });
    req.on("error", () => resolve("client saw the reset")); // the outcome we asked for
    req.on("response", () => resolve("got a response"));
    req.write(crypto.randomBytes(8192));
    setTimeout(() => req.destroy(), 50);
  });
  assert.match(aborted, /reset|response/);

  // an oversized upload alongside
  const oversized = await request("POST", "/api/clips", {
    body: crypto.randomBytes(64 * 1024 + 100),
    headers: { "content-type": "video/webm", authorization: `Bearer ${account.token}` }
  });
  assert.equal(oversized.status, 413);
  assert.equal(JSON.parse(oversized.body).error, "recording is too large to store");

  // none of the three failures may have wiped the good upload's staging
  // file (or each other's leftovers): exactly it remains in tmp
  assert.ok(await waitFor(() => fs.readdirSync(path.join(process.env.DATA_DIR, "tmp")).length === 1, 3000),
    "tmp should hold exactly the good upload's staging file");
  // and none of them may have published a clip either
  const clipsDir = path.join(process.env.DATA_DIR, "clips");
  assert.equal(fs.readdirSync(clipsDir).length, clipsBefore, "no new clip published by the failures");

  // the good upload finishes unharmed, byte for byte
  good.finish();
  const saved = await good.done;
  assert.equal(saved.status, 201);
  const clip = JSON.parse(saved.body);
  const file = await request("GET", `/api/clips/${clip.id}/file`);
  assert.deepEqual(file.body, payload);

  const gone = await request("DELETE", `/api/clips/${clip.id}`, {
    headers: { authorization: `Bearer ${clip.manageToken}` }
  });
  assert.equal(gone.status, 204);

  // nothing leaks afterwards either
  assert.ok(await waitFor(() => fs.readdirSync(path.join(process.env.DATA_DIR, "tmp")).length === 0, 3000),
    "tmp should be empty after the uploads settle");
  assert.ok(!fs.existsSync(path.join(process.env.DATA_DIR, "clips", clip.id)),
    "the good upload's clip is gone after its delete");

  const healthy = await request("GET", "/healthz");
  assert.equal(healthy.status, 200);
});

test("an oversized streaming upload gets its 413 and lets the connection go", async () => {
  const account = await makeAccount("streaming-413@example.com");
  // no content-length: the cap is hit mid-stream, the way a long recording
  // would actually trip it
  const res = await new Promise((resolve, reject) => {
    const req = http.request(base + "/api/clips", { method: "POST", headers: { "content-type": "video/webm", authorization: `Bearer ${account.token}` } });
    req.on("response", (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => resolve({ status: r.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    // twice the cap in small chunks, then a normal end
    const chunk = crypto.randomBytes(8 * 1024);
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= 128 * 1024) {
        clearInterval(timer);
        req.end();
        return;
      }
      req.write(chunk);
      sent += chunk.length;
    }, 1);
  });
  assert.equal(res.status, 413);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "tmp")), []);
});

test("clips survive a fresh server generation on the same data directory", async () => {
  // the stand-in for a container replacement: a brand-new store opening the
  // same data dir must serve the same bytes and honour the same manage key
  const account = await makeAccount("restart-survivor@example.com");
  // a real webm timeline: the server verifies every upload's duration from
  // the file itself and refuses anything it cannot verify
  const payload = webmPayload(1024, 2000);
  const create = await request("POST", "/api/clips", {
    body: payload,
    headers: {
      "content-type": "video/webm",
      "x-title": encodeURIComponent("restart survivor"),
      authorization: `Bearer ${account.token}`
    }
  });
  assert.equal(create.status, 201);
  const clip = JSON.parse(create.body);

  const reborn = new Store(process.env.DATA_DIR);
  await reborn.init();
  const meta = await reborn.get(clip.id);
  assert.ok(meta, "metadata readable after restart");
  assert.equal(meta.title, "restart survivor");
  assert.deepEqual(fs.readFileSync(reborn.videoPath(clip.id)), payload);
  assert.equal(await reborn.remove(clip.id, { token: clip.manageToken }), "deleted");
  assert.equal(await reborn.get(clip.id), null);
});

after(() => new Promise((resolve) => server.close(() => resolve())));
