#!/usr/bin/env node
// End-to-end check in a real (headless) Chrome: record, upload, share-link
// playback, download, and deletion. Run with the repo root as cwd:
//
//   npm i puppeteer   # once, outside CI (downloads a Chrome)
//   npm i yauzl       # needed where no `unzip` exists, to extract it
//   node e2e/record.mjs [baseUrl]
//
// Without a baseUrl it starts the server itself on an ephemeral port with a
// throwaway data directory. Headless Chrome has no screen to pick, so when the
// real getDisplayMedia picker cannot open the script installs a synthetic
// capture (canvas + oscillator) for the *source only*; everything past that —
// MediaRecorder encoding, upload, playback, download, deletion — is the real
// product path.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";

const REPO = path.resolve(new URL("..", import.meta.url).pathname);
let baseUrl = process.argv[2] || "";
let child = null;
let dataDir = null;

async function startServerIfLocal() {
  if (baseUrl) return;
  dataDir = mkdtempSync(path.join(tmpdir(), "openloom-e2e-"));
  child = spawn(process.execPath, ["server.js"], {
    cwd: REPO,
    env: { ...process.env, PORT: "0", DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 10000);
    child.stdout.on("data", (d) => {
      const match = /listening on (\d+)/.exec(String(d));
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.on("exit", (code) => reject(new Error(`server exited early (${code})`)));
  });
}

// Rendered visibility, not a class name: the delete button must be styled
// out of the page for viewers and actually shown for the manage key.
const DELETE_VISIBLE = (el) =>
  !!el && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0;

const BROWSER_FLAGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--auto-select-desktop-capture-source=Entire screen",
  // running inside a container
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu"
];

// Synthetic capture source, injected only when the real picker fails.
const FAKE_GET_DISPLAY_MEDIA = `
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext("2d");
    let frame = 0;
    setInterval(() => {
      frame++;
      ctx.fillStyle = ["#132038", "#1c2f52", "#253e6c"][frame % 3];
      ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = "#e8eaf0";
      ctx.font = "44px sans-serif";
      ctx.fillText("OpenLoom synthetic screen — frame " + frame, 80, 360);
    }, 100);
    const video = canvas.captureStream(15);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const gain = ac.createGain(); gain.gain.value = 0.08;
    const dst = ac.createMediaStreamDestination();
    osc.connect(gain).connect(dst); osc.start();
    return new MediaStream([...video.getVideoTracks(), ...dst.stream.getAudioTracks()]);
  };
`;

async function recordAClip(browser, title, opts = {}) {
  const page = await browser.newPage();
  let usedSyntheticSource = false;

  page.on("pageerror", (err) => console.error("  [pageerror]", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.error("  [console.error]", msg.text()); });
  page.on("requestfailed", (r) => console.error("  [requestfailed]", r.url(), r.failure()?.errorText));

  await page.goto(baseUrl + "/", { waitUntil: "networkidle0" });
  await page.type("#title", title);

  if (opts.forceSyntheticDisplay) {
    // used for the display-audio + microphone regression: the synthetic
    // source carries display audio, the fake device provides the microphone
    await page.evaluate(FAKE_GET_DISPLAY_MEDIA);
    usedSyntheticSource = true;
  }

  await page.click("#startBtn");
  try {
    await page.waitForSelector("#recording:not(.hidden)", { timeout: 8000 });
  } catch {
    if (opts.forceSyntheticDisplay) throw new Error("recording did not start with both audio sources");
    // headless Chrome often cannot open the real picker: inject a synthetic
    // capture source and record again
    usedSyntheticSource = true;
    await page.evaluate(FAKE_GET_DISPLAY_MEDIA);
    await page.click("#startBtn");
    await page.waitForSelector("#recording:not(.hidden)", { timeout: 8000 });
  }

  // record ~4 seconds of real MediaRecorder encoding
  const mime = await page.evaluate(() => window.__mime || null);
  await new Promise((r) => setTimeout(r, 4000));
  const timerText = await page.$eval("#timer", (el) => el.textContent);
  if (!/0:0[34]/.test(timerText)) throw new Error(`timer looks wrong: ${timerText}`);

  await page.click("#stopBtn");
  await page.waitForSelector("#result:not(.hidden)", { timeout: 60000 });
  const result = await page.evaluate(() => ({
    share: document.getElementById("shareLink").value,
    manage: document.getElementById("manageLink").value,
    note: document.getElementById("resultNote").textContent,
    blobHash: null
  }));
  result.blobHash = await page.evaluate(async () => {
    const buf = await pendingBlob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  });
  result.usedSyntheticSource = usedSyntheticSource;
  result.mime = await page.evaluate(() => (typeof pendingBlob !== "undefined" ? pendingBlob.type : ""));
  if (opts.expectAudio) {
    // the recorded clip must actually carry an audio track: decode it in the
    // page and require a non-empty audio stream
    result.hasAudio = await page.evaluate(async () => {
      try {
        const buf = await pendingBlob.arrayBuffer();
        const ctx = new AudioContext();
        const decoded = await ctx.decodeAudioData(buf);
        const ok = decoded.duration > 0 && decoded.numberOfChannels >= 1;
        await ctx.close();
        return ok;
      } catch { return false; }
    });
  }
  await page.close();
  return result;
}

// Regression harness for the startup lifecycle guards. The real picker cannot
// be scripted, so the capture entry points are replaced with manually
// resolved promises; the guards themselves — the synchronous re-entry check,
// the disabled Start button, the live-display-track verification and the
// cleanup of a dead attempt — are the product code under test.
const STARTUP_RACE_HARNESS = `
  window.__race = { calls: [], gdm: null, um: null };
  navigator.mediaDevices.getDisplayMedia = async () => {
    window.__race.calls.push("display");
    return new Promise((res, rej) => { window.__race.gdm = { res, rej }; });
  };
  navigator.mediaDevices.getUserMedia = async () => {
    window.__race.calls.push("mic");
    return new Promise((res) => { window.__race.um = { res }; });
  };
`;

async function main() {
  await startServerIfLocal();
  const browser = await puppeteer.launch({ headless: true, args: BROWSER_FLAGS });

  const failures = [];
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures.push(name);
  };

  // 1. the author records and saves
  const author = await recordAClip(browser, "E2E demo recording");
  check("recording produced a share link", /^http.*\/v\/[A-Za-z0-9_-]+$/.test(author.share), author.share);
  check("recording produced a manage link", author.manage.includes(author.share.split("/v/")[1]), author.manage);
  console.log("INFO  recording used " + (author.usedSyntheticSource
    ? "the synthetic capture source (the real picker did not open here)"
    : "the real getDisplayMedia path"));

  // 1b. regression: Chrome's picker can supply display audio while the
  // microphone is also on — the two must be mixed into one track, recording
  // must start, and the resulting clip must carry audio
  const dual = await recordAClip(browser, "Dual audio regression", {
    forceSyntheticDisplay: true,
    expectAudio: true
  });
  check("recording starts with display audio and microphone together",
    /^http.*\/v\/[A-Za-z0-9_-]+$/.test(dual.share), dual.share);
  check("the dual-source clip contains audio", dual.hasAudio === true, String(dual.hasAudio));

  // 1c. regression: repeated Start clicks during the asynchronous picker and
  // permission flow must not start overlapping captures — the first click
  // guards synchronously, disables the button, and later clicks are ignored.
  const racePage = await browser.newPage();
  await racePage.goto(baseUrl + "/", { waitUntil: "networkidle0" });
  await racePage.evaluate(STARTUP_RACE_HARNESS);
  await racePage.click("#startBtn");
  await racePage.click("#startBtn");
  await racePage.click("#startBtn");
  const race = await racePage.evaluate(() => ({
    calls: window.__race.calls,
    startDisabled: document.getElementById("startBtn").disabled
  }));
  check("repeated Start clicks start exactly one capture flow",
    race.calls.join("|") === "display", JSON.stringify(race.calls));
  check("Start recording is disabled while startup is pending", race.startDisabled === true);

  // 1d. regression: the user stops screen sharing while the microphone
  // permission is still pending — the attempt must abort (no recording with
  // an ended display track), release the microphone it was given, and
  // re-enable Start recording.
  await racePage.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const track = canvas.captureStream(10).getVideoTracks()[0];
    track.stop(); // "Stop sharing" clicked while mic permission was pending
    window.__race.gdm.res(new MediaStream([track]));
  });
  await racePage.evaluate(() => {
    const ac = new AudioContext();
    const dst = ac.createMediaStreamDestination();
    const micStream = new MediaStream(dst.stream.getAudioTracks());
    window.__race.micTrack = micStream.getAudioTracks()[0];
    window.__race.um.res(micStream);
  });
  const aborted = await racePage.waitForFunction(
    () => !document.getElementById("setup").classList.contains("hidden"),
    { timeout: 5000 }
  ).then(() => racePage.evaluate(() => ({
    note: document.getElementById("setupStatus").textContent,
    micTrack: window.__race.micTrack.readyState,
    startEnabled: !document.getElementById("startBtn").disabled
  })), () => null);
  check("display capture ending during mic permission aborts startup",
    !!aborted && /ended/i.test(aborted.note), aborted ? aborted.note : "no failure reported");
  check("the pending attempt's microphone is released",
    !!aborted && aborted.micTrack === "ended", aborted ? "mic track " + aborted.micTrack : "no outcome");
  check("Start recording is enabled again after a failed attempt",
    !!aborted && aborted.startEnabled === true);

  // 1e. regression: finalization runs exactly once. Chrome dispatches an
  // error event, then a final dataavailable, then stop — finalizing on the
  // error used to save that trailing data as a "successful" clip. The page's
  // MediaRecorder is wrapped so the sequence can be dispatched by hand.
  await racePage.evaluate(() => {
    const Real = window.MediaRecorder;
    window.__madeRecorders = [];
    window.MediaRecorder = class extends Real {
      constructor(...args) { super(...args); window.__madeRecorders.push(this); }
    };
  });
  await racePage.evaluate(STARTUP_RACE_HARNESS);
  await racePage.click("#startBtn");
  await racePage.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    let f = 0;
    setInterval(() => { f++; ctx.fillRect(0, f % 180, 320, 2); }, 100);
    window.__race.gdm.res(new MediaStream([canvas.captureStream(10).getVideoTracks()[0]]));
  });
  await racePage.evaluate(() => {
    const ac = new AudioContext();
    const dst = ac.createMediaStreamDestination();
    window.__race.um.res(new MediaStream(dst.stream.getAudioTracks()));
  });
  await racePage.waitForSelector("#recording:not(.hidden)", { timeout: 5000 });
  const clipsBefore = await racePage.evaluate(() => JSON.parse(localStorage.getItem("openloom.recordings") || "[]").length);
  await racePage.evaluate(() => {
    const rec = window.__madeRecorders[window.__madeRecorders.length - 1];
    rec.onerror({ error: Object.assign(new Error("synthetic recorder failure"), { name: "SyntheticError" }) });
    rec.ondataavailable({ data: new Blob(["trailing-data-after-error"], { type: "video/webm" }) });
    rec.onstop();
  });
  const errored = await racePage.waitForFunction(
    () => !document.getElementById("setup").classList.contains("hidden"),
    { timeout: 5000 }
  ).then(() => racePage.evaluate(() => ({
    note: document.getElementById("setupStatus").textContent,
    savedSection: !document.getElementById("result").classList.contains("hidden"),
    clips: JSON.parse(localStorage.getItem("openloom.recordings") || "[]").length
  })), () => null);
  check("a recorder error finalizes exactly once, as a failure",
    !!errored && /failed/i.test(errored.note), errored ? errored.note : "no failure reported");
  check("trailing data after a recorder error is not uploaded as a clip",
    !!errored && !errored.savedSection && errored.clips === clipsBefore,
    errored ? `saved section shown=${errored.savedSection}, clips ${clipsBefore} -> ${errored.clips}` : "no outcome");

  await racePage.close();

  // 2. a viewer without any cookies or storage opens the share link
  const viewerContext = await browser.createBrowserContext();
  const viewer = await viewerContext.newPage();
  await viewer.goto(author.share, { waitUntil: "networkidle0" });
  const meta = await viewer.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
  }, { timeout: 30000 }).then(async () => ({
    duration: await viewer.evaluate(() => document.querySelector("video").duration),
    title: await viewer.evaluate(() => document.getElementById("clipTitle").textContent),
    deleteVisible: await viewer.evaluate(DELETE_VISIBLE, await viewer.$("#deleteBtn"))
  }), () => null);
  check("share link resolves video metadata for a viewer", !!meta, meta ? `${meta.duration.toFixed(1)}s, "${meta.title}"` : "video metadata never resolved");
  if (meta) check("viewer does not see a delete button", !meta.deleteVisible);

  // 2b. metadata is not playback: start the video and require time to advance
  // without a media error — this is what "plays for a viewer" means.
  const played = await viewer.evaluate(async () => {
    const v = document.querySelector("video");
    v.muted = true;
    try { await v.play(); } catch (err) { return { ok: false, why: "play() rejected: " + err.message }; }
    const from = v.currentTime;
    await new Promise((r) => setTimeout(r, 2000));
    if (v.error) return { ok: false, why: "media error " + v.error.code + " (" + (v.error.message || "") + ")" };
    return {
      ok: !v.paused && !v.ended && v.currentTime > from,
      why: `currentTime ${from.toFixed(2)}s -> ${v.currentTime.toFixed(2)}s, paused=${v.paused}, ended=${v.ended}`
    };
  });
  check("video actually plays for the viewer", played.ok === true, played.why);

  // 3. the original downloads byte-identical
  const downloaded = await viewer.evaluate(async () => {
    const res = await fetch(document.getElementById("downloadBtn").href);
    const buf = await res.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return {
      status: res.status,
      type: res.headers.get("content-type"),
      disposition: res.headers.get("content-disposition"),
      bytes: buf.byteLength,
      hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
    };
  });
  check("download returns 200", downloaded.status === 200, `type ${downloaded.type}`);
  check("download is byte-identical to what was recorded",
    downloaded.hash === author.blobHash,
    `${downloaded.bytes} bytes, hashes ${downloaded.hash === author.blobHash ? "match" : "differ"}`);
  check("download has an attachment filename", /attachment/.test(downloaded.disposition || ""), downloaded.disposition);

  // 4. the manage link deletes from a completely different browser session
  const managerContext = await browser.createBrowserContext();
  const manager = await managerContext.newPage();
  await manager.goto(author.manage, { waitUntil: "networkidle0" });
  manager.on("dialog", (d) => d.accept());
  // the manage key must render the delete button, not merely carry the class
  const managerSeesDelete = await manager.waitForFunction(() => {
    const el = document.getElementById("deleteBtn");
    return !!el && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0;
  }, { timeout: 10000 }).then(() => true, () => false);
  check("manage key shows a clickable delete button", managerSeesDelete);
  await manager.click("#deleteBtn");
  await manager.waitForFunction(() => document.getElementById("note")?.textContent.includes("deleted"), { timeout: 15000 })
    .then(() => check("manage link deletes the clip", true))
    .catch(() => check("manage link deletes the clip", false));

  const after = await viewer.evaluate(async (url) => (await fetch(url)).status,
    new URL(author.share).pathname.replace("/v/", "/api/clips/") );
  check("clip is gone after deletion", after === 404, `meta now returns ${after}`);

  // share link now explains itself (fresh page, plain load: the old tab's
  // media loader may keep retrying after the deletion and never go idle)
  const gonePage = await browser.newPage();
  await gonePage.goto(author.share, { waitUntil: "domcontentloaded" });
  const gone = await gonePage.waitForFunction(() =>
    document.getElementById("note").textContent.length > 0, { timeout: 10000 })
    .then(() => gonePage.evaluate(() => document.getElementById("note").textContent));
  check("deleted share link explains itself", /deleted/i.test(gone), gone);

  await browser.close();
  if (child) child.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });

  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error("E2E failed:", err);
  if (child) child.kill();
  process.exit(1);
});
