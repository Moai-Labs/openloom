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
const { readTar } = require("../lib/tar");
const { readWebmDurationMs } = require("../lib/webm-duration");
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
  const body = payload || crypto.randomBytes(bytes);
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
  const payload = crypto.randomBytes(2048);
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
  const { res } = await uploadClip(token, { bytes: 1024, durationMs: 30001 });
  assert.equal(res.status, 413);
  assert.match(JSON.parse(res.body).error, /free plan/i);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);
});

test("a webm whose real duration exceeds the cap is refused even when the header lies", async () => {
  const { token } = await makeAccount("webmcap@example.com");
  const webm = minimalWebm(40000); // 40 s inside the file, 1 s declared
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

test("the parser reads real durations", () => {
  assert.equal(readWebmDurationMs(minimalWebm(6500)), 6500);
  assert.equal(readWebmDurationMs(Buffer.from("not a webm")), null);
  assert.equal(readWebmDurationMs(Buffer.alloc(0)), null);
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
  const payload = crypto.randomBytes(1000);
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

// --- helpers ---------------------------------------------------------------

// A minimal but structurally honest webm: EBML header, Segment of unknown
// size, Info with TimestampScale and Duration, then a Cluster of unknown size.
function minimalWebm(durationMs) {
  const parts = [];
  // EBML header: DocType "webm"
  parts.push(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]));
  // Segment, unknown size (what MediaRecorder emits for live recordings)
  parts.push(Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  // Info, known size 17: TimestampScale (1e6) + Duration (double)
  const infoBody = Buffer.concat([
    Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]),
    Buffer.from([0x44, 0x89, 0x88]),
    (() => { const b = Buffer.alloc(8); b.writeDoubleBE(durationMs, 0); return b; })()
  ]);
  parts.push(Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x80 | infoBody.length]), infoBody);
  // Cluster, unknown size, with a little payload
  parts.push(Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  parts.push(Buffer.from([0xa3, 0x84, 0x01, 0x02, 0x03, 0x04])); // a SimpleBlock-ish blob
  return Buffer.concat(parts);
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

async function payInvoice(token, invoice, { receipt, chainId } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({ receipt, chainId });
  try {
    return await request("POST", "/api/billing/verify", {
      body: JSON.stringify({ invoiceId: invoice.invoiceId, txHash: TX_HASH }),
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

const { Accounts } = require("../lib/accounts");

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

after(() => new Promise((resolve) => server.close(() => resolve())));
