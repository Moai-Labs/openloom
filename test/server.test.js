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

const server = require("../server.js");
const { Store } = require("../lib/store");
const { Accounts } = require("../lib/accounts");
const { readTar } = require("../lib/tar");
const { readWebmDurationMs, WebmDurationScanner } = require("../lib/webm-duration");

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
  assert.ok(html.includes("not available yet"), "no upgrade is sold before it exists");
});

test("the limits API states the free plan", async () => {
  const res = await request("GET", "/api/limits");
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.plan, "free");
  assert.equal(data.maxClips, 2); // as shrunk by env for this suite
  assert.equal(data.maxDurationMs, 30000);
  assert.equal(data.maxClipBytes, 16 * 1024);
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

function webmFile({ spans = [], declaredDurationMs = null, padTo = 0 } = {}) {
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

after(() => new Promise((resolve) => server.close(() => resolve())));
