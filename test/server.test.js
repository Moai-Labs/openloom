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
process.env.MAX_UPLOAD_BYTES = String(64 * 1024); // small so the cap is easy to hit

const server = require("../server.js");
const { Store } = require("../lib/store");

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

test("watch page is served at /v/<id>", async () => {
  const res = await request("GET", "/v/ABCDEFGHIJKLMNOPQR");
  assert.equal(res.status, 200);
  assert.ok(res.body.toString().includes("watch"));
});

test("full clip lifecycle: create, metadata, play, download, delete", async () => {
  const payload = crypto.randomBytes(2048);
  const create = await request("POST", "/api/clips", {
    body: payload,
    headers: {
      "content-type": "video/webm",
      "x-title": encodeURIComponent("Sprint demo #1"),
      "x-duration-ms": "4200"
    }
  });
  assert.equal(create.status, 201);
  const clip = JSON.parse(create.body);
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

  // deletion needs the token
  const wrong = await request("DELETE", `/api/clips/${clip.id}`, {
    headers: { authorization: "Bearer not-the-token" }
  });
  assert.equal(wrong.status, 403);
  const noAuth = await request("DELETE", `/api/clips/${clip.id}`);
  assert.equal(noAuth.status, 403);

  const right = await request("DELETE", `/api/clips/${clip.id}`, {
    headers: { authorization: `Bearer ${clip.manageToken}` }
  });
  assert.equal(right.status, 204);

  const gone = await request("GET", `/api/clips/${clip.id}`);
  assert.equal(gone.status, 404);
  const fileGone = await request("GET", `/api/clips/${clip.id}/file`);
  assert.equal(fileGone.status, 404);
  const again = await request("DELETE", `/api/clips/${clip.id}`, {
    headers: { authorization: `Bearer ${clip.manageToken}` }
  });
  assert.equal(again.status, 404);
});

test("untitled uploads get a default filename and null title", async () => {
  const create = await request("POST", "/api/clips", {
    body: crypto.randomBytes(64),
    headers: { "content-type": "video/webm" }
  });
  assert.equal(create.status, 201);
  const clip = JSON.parse(create.body);
  const meta = JSON.parse((await request("GET", `/api/clips/${clip.id}`)).body);
  assert.equal(meta.title, null);
  assert.equal(meta.filename, "recording.webm");
  await request("DELETE", `/api/clips/${clip.id}`, {
    headers: { authorization: `Bearer ${clip.manageToken}` }
  });
});

test("non-video content types are refused", async () => {
  const res = await request("POST", "/api/clips", {
    body: Buffer.from("hello"),
    headers: { "content-type": "text/plain" }
  });
  assert.equal(res.status, 415);
});

test("oversized uploads are refused and leave nothing behind", async () => {
  const res = await request("POST", "/api/clips", {
    body: crypto.randomBytes(64 * 1024 + 100),
    headers: { "content-type": "video/webm" }
  });
  assert.equal(res.status, 413);
  // no clip directories other than the ones earlier tests cleaned up
  const storeDir = path.join(process.env.DATA_DIR, "clips");
  assert.deepEqual(fs.readdirSync(storeDir), []);
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "tmp")), []);
});

test("empty uploads are refused", async () => {
  const res = await request("POST", "/api/clips", {
    body: Buffer.alloc(0),
    headers: { "content-type": "video/webm" }
  });
  assert.equal(res.status, 400);
});

test("unknown ids answer 404 everywhere", async () => {
  assert.equal((await request("GET", "/api/clips/AAAAAAAAAAAAAAAAAA")).status, 404);
  assert.equal((await request("GET", "/api/clips/AAAAAAAAAAAAAAAAAA/file")).status, 404);
  assert.equal((await request("DELETE", "/api/clips/AAAAAAAAAAAAAAAAAA")).status, 404);
});

test("malformed ids are treated as unknown, not as paths", async () => {
  assert.equal((await request("GET", "/api/clips/..%2f..%2fetc")).status, 404);
  assert.equal((await request("GET", "/api/clips/short")).status, 404);
});

test("store rejects invalid ids and survives a fresh init", async () => {
  const store = new Store(process.env.DATA_DIR);
  assert.equal(store.isValidId("../etc/passwd"), false);
  assert.equal(store.isValidId("ABCDEFGHIJKLMNOPQR"), true);
  await store.init(); // idempotent
});

test("the manage token is not stored in plaintext", async () => {
  const create = await request("POST", "/api/clips", {
    body: crypto.randomBytes(32),
    headers: { "content-type": "video/webm" }
  });
  const clip = JSON.parse(create.body);
  const metaRaw = fs.readFileSync(path.join(process.env.DATA_DIR, "clips", clip.id, "meta.json"), "utf8");
  assert.ok(!metaRaw.includes(clip.manageToken));
  await request("DELETE", `/api/clips/${clip.id}`, {
    headers: { authorization: `Bearer ${clip.manageToken}` }
  });
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
function gatedUpload(payload) {
  const req = http.request(base + "/api/clips", {
    method: "POST",
    headers: {
      "content-type": "video/webm",
      "content-length": String(payload.length)
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
  const payload = crypto.randomBytes(24 * 1024);
  const good = gatedUpload(payload);
  await sleep(100); // its staging file now exists on the server

  // an empty upload alongside
  const empty = await request("POST", "/api/clips", {
    body: Buffer.alloc(0),
    headers: { "content-type": "video/webm" }
  });
  assert.equal(empty.status, 400);

  // an aborted upload: bytes first, then the client walks away mid-stream
  const aborted = await new Promise((resolve) => {
    const req = http.request(base + "/api/clips", {
      method: "POST",
      headers: { "content-type": "video/webm" }
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
    headers: { "content-type": "video/webm" }
  });
  assert.equal(oversized.status, 413);
  assert.equal(JSON.parse(oversized.body).error, "recording is too large to store");

  // none of the three failures may have wiped the good upload's staging
  // file (or each other's leftovers): exactly it remains in tmp
  assert.ok(await waitFor(() => fs.readdirSync(path.join(process.env.DATA_DIR, "tmp")).length === 1, 3000),
    "tmp should hold exactly the good upload's staging file");
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);

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
  assert.deepEqual(fs.readdirSync(path.join(process.env.DATA_DIR, "clips")), []);

  const healthy = await request("GET", "/healthz");
  assert.equal(healthy.status, 200);
});

test("an oversized streaming upload gets its 413 and lets the connection go", async () => {
  // no content-length: the cap is hit mid-stream, the way a long recording
  // would actually trip it
  const res = await new Promise((resolve, reject) => {
    const req = http.request(base + "/api/clips", { method: "POST", headers: { "content-type": "video/webm" } });
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
  const payload = crypto.randomBytes(1024);
  const create = await request("POST", "/api/clips", {
    body: payload,
    headers: { "content-type": "video/webm", "x-title": encodeURIComponent("restart survivor") }
  });
  assert.equal(create.status, 201);
  const clip = JSON.parse(create.body);

  const reborn = new Store(process.env.DATA_DIR);
  await reborn.init();
  const meta = await reborn.get(clip.id);
  assert.ok(meta, "metadata readable after restart");
  assert.equal(meta.title, "restart survivor");
  assert.deepEqual(fs.readFileSync(reborn.videoPath(clip.id)), payload);
  assert.equal(await reborn.remove(clip.id, clip.manageToken), "deleted");
  assert.equal(await reborn.get(clip.id), null);
});

after(() => new Promise((resolve) => server.close(() => resolve())));
