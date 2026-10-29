#!/usr/bin/env node
// End-to-end check in a real (headless) Chrome: sign up, record and save,
// record another from the same page, stay usable after a recorder error,
// survive the startup races, hit the free cap with a clear message, export,
// play and download from a share link as a stranger, delete with the manage
// key from a fresh session, and a full backup -> wipe -> restore -> playback
// cycle on the server. Every account it needs is created under an identity
// generated for that run alone, and deleted again in a finally block, so a
// run against a shared dev stack leaves nothing behind — its own or anyone
// else's.
//
// Run with the repo root as cwd:
//
//   npm i puppeteer   # once, outside CI (downloads a Chrome)
//   npm i yauzl       # needed where no `unzip` exists, to extract it
//   node e2e/record.mjs [baseUrl]
//
// In a bare container the browser needs its shared libraries and at least one
// font (via fontconfig): without a font the renderer dies on the first new
// text render after a recording stops.
// Without a baseUrl it starts the server itself on an ephemeral port with a
// throwaway data directory. Headless Chrome has no screen to pick, so when the
// real getDisplayMedia picker cannot open the script installs a synthetic
// capture (canvas + oscillator) for the *source only*; everything past that —
// MediaRecorder encoding, upload, playback, download, deletion — is the real
// product path.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

// Headless shells deliver clicks but not real keyboard events, so text goes
// in as a value + input event — the same thing a password manager would do.
async function fill(page, selector, value) {
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.$eval(selector, (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

import { randomBytes } from "node:crypto";

// Every account the suite touches is created by the run itself, under an
// identity generated for that run alone: a unique email and a unique random
// password, recorded in runAccounts the moment it is minted. Cleanup signs
// each recorded identity back in and deletes only accounts that accept those
// credentials — accounts that existed before the run (other suites' data,
// holders' real accounts on a shared dev stack) never match, so they are
// never touched. Cleanup runs in a finally block, so a run that throws part
// way through still removes the accounts it did create.
const runAccounts = [];
function newIdentity(role) {
  const id = randomBytes(8).toString("hex");
  const identity = {
    email: `${role}-${id}@example.com`,
    password: randomBytes(24).toString("base64url"),
  };
  runAccounts.push(identity);
  return identity;
}

async function deleteRunAccounts(label = "cleanup") {
  for (const { email, password } of runAccounts) {
    try {
      const login = await fetch(baseUrl + "/api/sessions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      if (!login.ok) continue; // never created, or already gone: leave it alone
      const { token } = await login.json();
      const gone = await fetch(baseUrl + "/api/my/account", {
        method: "DELETE", headers: { Authorization: "Bearer " + token }
      });
      console.log(`INFO  ${label} ${email}: ${gone.status}`);
    } catch (err) {
      console.log(`INFO  ${label} ${email} failed: ${err.message}`);
    }
  }
}

async function signUp(page, identity) {
  await page.goto(baseUrl + "/", { waitUntil: "networkidle0" });
  await page.waitForSelector("#auth:not(.hidden)", { timeout: 10000 });
  await fill(page, "#email", identity.email);
  await fill(page, "#password", identity.password);
  await page.click("#authBtn");
  // the identity is minted for this run alone, so signup must work; a sign-in
  // fallback here would silently adopt an account this run did not create
  await page.waitForFunction(() =>
    !document.getElementById("whoami").classList.contains("hidden"), { timeout: 10000 });
  return page.$eval("#whoami", (el) => el.textContent);
}

// Rendered visibility, not a class name: the delete button must be styled
// out of the page for viewers and actually shown for the manage key.
const DELETE_VISIBLE = (el) =>
  !!el && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0;

// A studio page with the console watched for errors.
async function openStudioPage(context) {
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("  [pageerror]", err.message));
  page.on("console", (msg) => { if (msg.type() === "error") console.error("  [console.error]", msg.text()); });
  page.on("requestfailed", (r) => console.error("  [requestfailed]", r.url(), r.failure()?.errorText));
  await page.goto(baseUrl + "/", { waitUntil: "networkidle0" });
  return page;
}

// Drives one real recording on a page already on the studio: Start (with the
// synthetic source pre-installed when asked), ~seconds of MediaRecorder
// encoding, Stop and save.
async function startRecordingOn(page, title, opts = {}) {
  await fill(page, "#title", title);
  if (opts.forceSyntheticDisplay) {
    // the synthetic source carries display audio; the fake device provides
    // the microphone — both must be mixed into one track by the page
    await page.evaluate(FAKE_GET_DISPLAY_MEDIA);
  }
  // the test's own clock, stamped before the click: the recording cannot be
  // older than the click that started it, and stamping only after the
  // recording state appears would let a busy session between the two make
  // the page's timer look falsely ahead of the test's clock
  page.__recStartedAt = Date.now();
  await page.click("#startBtn");
  try {
    await page.waitForSelector("#recording:not(.hidden)", { timeout: 8000 });
  } catch {
    if (opts.forceSyntheticDisplay) throw new Error("recording did not start with both audio sources");
    // headless Chrome often cannot open the real picker: inject a synthetic
    // capture source and record again
    await page.evaluate(FAKE_GET_DISPLAY_MEDIA);
    page.__recStartedAt = Date.now(); // the second click is the real start
    await page.click("#startBtn");
    await page.waitForSelector("#recording:not(.hidden)", { timeout: 8000 });
  }
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}

// Records on an already signed-in page and leaves it on the result screen
// (the caller decides whether to keep the page open or close it).
async function recordOnPage(page, title, settleMs = 4000) {
  await page.goto(baseUrl + "/", { waitUntil: "networkidle0" });
  await fill(page, "#title", title);
  page.__recStartedAt = Date.now(); // stamped before the click, as in startRecordingOn
  await page.click("#startBtn");
  try {
    await page.waitForSelector("#recording:not(.hidden)", { timeout: 8000 });
  } catch {
    // headless Chrome often cannot open the real picker: inject a synthetic
    // capture source and record again
    await page.evaluate(FAKE_GET_DISPLAY_MEDIA);
    page.__recStartedAt = Date.now(); // the second click is the real start
    await page.click("#startBtn");
    await page.waitForSelector("#recording:not(.hidden)", { timeout: 8000 });
  }
  await new Promise((r) => setTimeout(r, settleMs));
  await page.click("#stopBtn");
}



async function stopAndCollect(page, opts = {}) {
  const seconds = opts.recordSeconds ?? 4;
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const timer = await page.evaluate(() => ({
    text: document.getElementById("timer").textContent,
    age: Math.round(performance.now() - recordStart)
  }));
  // The timer must belong to THIS recording, not a stale one that never
  // reset (the round-3 regression this guards). A busy container can stall
  // the page's main thread for seconds, so the page's own elapsed time is
  // not trustworthy in either direction — but the page cannot run ahead of
  // the test's clock: an age far beyond the time since this recording
  // started means recordStart was never reset. A stale start carries the
  // previous recording's whole elapsed time and fails by many seconds.
  const sinceStart = Date.now() - page.__recStartedAt;
  if (!/^\d+:\d\d$/.test(timer.text) || timer.age > sinceStart + 1500) {
    throw new Error(`timer looks wrong: ${timer.text} (recording age ${timer.age} ms, ` +
      `${sinceStart} ms since Start on the test's clock)`);
  }
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

// A manage key must not appear anywhere rendered: no anchor points at a
// manage link and no input still carries one. (body.innerHTML would match
// this very script's own text — the page builds manage hrefs in JS — so the
// check looks at elements, not at markup.)
const PAGE_LEAKS_MANAGE_KEY = () =>
  !!document.querySelector('a[href*="?k="]') ||
  [...document.querySelectorAll("input")].some((i) => (i.value || "").includes("?k="));

async function main() {
  await startServerIfLocal();
  const browser = await puppeteer.launch({ headless: "shell", args: BROWSER_FLAGS });

  const failures = [];
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures.push(name);
  };

  try {
    await runSuite(browser, check, failures);
  } finally {
    // a remote run leaves only the accounts it created behind, and only until
    // this point: delete them even when a check threw. A local run's
    // throwaway data directory is removed below instead.
    if (!dataDir) await deleteRunAccounts();
    await browser.close().catch(() => {});
    if (child) child.kill();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
  process.exit(failures.length ? 1 : 0);
}

// one fresh identity per role the scenarios need; all minted before any step
// runs so cleanup can see them all even when a step throws before its account
// was ever created
const IDS = {
  author: newIdentity("author"),
  stranger: newIdentity("stranger"),
  successor: newIdentity("successor"),
  resultAuthor: newIdentity("resultauthor"),
  resultNext: newIdentity("resultnext"),
  switchAuthor: newIdentity("switchauthor"),
  switchNext: newIdentity("switchnext"),
  pendingOwner: newIdentity("pendingowner"),
  afterPending: newIdentity("afterpending"),
};

async function runSuite(browser, check, failures) {
  // 1. a new creator signs up
  const authorContext = await browser.createBrowserContext();
  const authorPage = await authorContext.newPage();
  const who = await signUp(authorPage, IDS.author);
  check("new creator signs up and is signed in", who === IDS.author.email, who);

  // 2. same-page lifecycle regression: record and save a clip, select
  // "Record another", and successfully start and save a second recording —
  // Start recording must be usable again after a recording is finalized.
  const flowPage = await openStudioPage(authorContext);
  await startRecordingOn(flowPage, "E2E demo recording");
  const author = await stopAndCollect(flowPage);
  check("recording produced a share link", /^http.*\/v\/[A-Za-z0-9_-]+$/.test(author.share), author.share);
  check("recording produced a manage link", author.manage.includes(author.share.split("/v/")[1]), author.manage);

  await flowPage.waitForSelector("#againBtn", { timeout: 5000 });
  await flowPage.click("#againBtn");
  await flowPage.waitForSelector("#setup:not(.hidden)");
  const startEnabled = await flowPage.evaluate(() => !document.getElementById("startBtn").disabled);
  check("Record another returns to setup with Start enabled", startEnabled === true);
  await startRecordingOn(flowPage, "Record another regression");
  await new Promise((r) => setTimeout(r, 1000));
  // the second recording's timer must be running from ITS start — a busy
  // container can display a lagging second, but not an age beyond the test's
  // clock (that would be a stale timer from the first recording)
  const secondTimer = await flowPage.evaluate(() => ({
    text: document.getElementById("timer").textContent,
    age: Math.round(performance.now() - recordStart)
  }));
  const secondTimerFresh = /^\d+:\d\d$/.test(secondTimer.text) &&
    secondTimer.age <= Date.now() - flowPage.__recStartedAt + 1500;
  const second = await stopAndCollect(flowPage, { recordSeconds: 2 });
  check("a second recording starts and runs after Record another",
    secondTimerFresh, JSON.stringify(secondTimer));
  check("the second recording saves its own clip",
    /Saved/.test(second.note) && /^video\//.test(second.mime), `${second.note} (${second.mime})`);

  // 3. regression: repeated Start clicks during the asynchronous picker and
  // permission flow must not start overlapping captures — the first click
  // guards synchronously, disables the button, and later clicks are ignored.
  const racePage = await openStudioPage(authorContext);
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

  // 4. regression: the user stops screen sharing while the microphone
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
  await racePage.waitForFunction(() => window.__race && window.__race.um, { timeout: 5000 });
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

  // 5. regression: finalization runs exactly once, and a recorder error
  // leaves a usable setup. Chrome dispatches an error event, then a final
  // dataavailable, then stop — finalizing on the error used to save that
  // trailing data as a "successful" clip. The page's MediaRecorder is wrapped
  // so the sequence can be dispatched by hand.
  await racePage.evaluate(() => {
    const Real = window.MediaRecorder;
    window.__madeRecorders = [];
    window.MediaRecorder = class extends Real {
      constructor(...args) { super(...args); window.__madeRecorders.push(this); }
    };
  });
  await racePage.evaluate(STARTUP_RACE_HARNESS);
  await racePage.click("#startBtn");
  // the page checks the clip limit over HTTP before it reaches for the
  // capture: wait for the harness promise to exist before resolving it
  await racePage.waitForFunction(() => window.__race && window.__race.gdm, { timeout: 5000 });
  await racePage.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    let f = 0;
    setInterval(() => { f++; ctx.fillRect(0, f % 180, 320, 2); }, 100);
    window.__race.gdm.res(new MediaStream([canvas.captureStream(10).getVideoTracks()[0]]));
  });
  await racePage.waitForFunction(() => window.__race && window.__race.um, { timeout: 5000 });
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
    () => !document.getElementById("setup").classList.contains("hidden") &&
      /failed/i.test(document.getElementById("setupStatus").textContent),
    { timeout: 5000 }
  ).then(() => racePage.evaluate(() => ({
    savedSection: !document.getElementById("result").classList.contains("hidden"),
    startEnabled: !document.getElementById("startBtn").disabled,
    clips: JSON.parse(localStorage.getItem("openloom.recordings") || "[]").length
  })), () => null);
  check("a recorder error finalizes exactly once, as a failure",
    !!errored && !errored.savedSection && errored.clips === clipsBefore,
    errored ? `saved section shown=${errored.savedSection}, clips ${clipsBefore} -> ${errored.clips}` : "no outcome");
  check("Start recording is usable again after a recorder error",
    !!errored && errored.startEnabled === true);

  await racePage.close();
  await flowPage.close();

  // 6. Chrome's picker can supply display audio while the microphone is also
  // on — the two must be mixed into one track, recording must start, and the
  // resulting clip must carry audio. This is the third and last free clip.
  const dualPage = await openStudioPage(authorContext);
  await startRecordingOn(dualPage, "Dual audio regression", { forceSyntheticDisplay: true });
  const dual = await stopAndCollect(dualPage, { expectAudio: true });
  check("recording starts with display audio and microphone together",
    /^http.*\/v\/[A-Za-z0-9_-]+$/.test(dual.share), dual.share);
  check("the dual-source clip contains audio", dual.hasAudio === true, String(dual.hasAudio));
  await dualPage.close();

  const shares = [author.share, second.share, dual.share];

  // 7. the usage meter shows the account is full and the button says so
  await authorPage.goto(baseUrl + "/", { waitUntil: "networkidle0" });
  const fullState = await authorPage.waitForFunction(() => {
    const bar = document.getElementById("usageBar");
    return bar.classList.contains("full");
  }, { timeout: 10000 }).then(() => authorPage.evaluate(() => ({
    usageText: document.getElementById("usageText").textContent,
    btn: document.getElementById("startBtn").textContent,
    disabled: document.getElementById("startBtn").disabled,
    listed: document.querySelectorAll("#recList li").length
  })), () => null);
  check("usage meter shows 3 of 3", !!fullState && /3 of 3/.test(fullState.usageText), fullState?.usageText);
  check("start button names the limit and refuses to start",
    !!fullState && fullState.disabled && /limit/i.test(fullState.btn),
    fullState ? `${fullState.btn} (disabled=${fullState.disabled})` : "meter never filled");
  check("the private clip list shows all three clips", !!fullState && fullState.listed === 3, String(fullState?.listed));

  // 8. another account sees none of them
  const strangerContext = await browser.createBrowserContext();
  const stranger = await strangerContext.newPage();
  const strangerEmail = await signUp(stranger, IDS.stranger);
  const strangerList = await stranger.waitForFunction(() =>
    /of 3/.test(document.getElementById("usageText").textContent), { timeout: 10000 })
    .then(() => stranger.$eval("#recList", (ul) => ul.children.length));
  check("a second account's list is private and empty", strangerEmail === IDS.stranger.email && strangerList === 0,
    `${strangerEmail}, ${strangerList} rows`);

  // 4b. signing out must hide the departing creator's clips; signing in as
  // somebody else on the same browser profile must expose none of them —
  // no rows, no manage links, and a stale in-flight list request must not
  // bring them back
  const switcher = await authorContext.newPage();
  switcher.on("dialog", (d) => d.accept());
  await switcher.goto(baseUrl + "/", { waitUntil: "networkidle0" });
  await switcher.waitForFunction(() => document.querySelectorAll("#recList li").length === 3, { timeout: 15000 });
  await switcher.click("#signOutLink");
  await switcher.waitForFunction(() => document.getElementById("whoami").classList.contains("hidden"), { timeout: 10000 });
  const signedOutState = await switcher.waitForFunction(() =>
    document.getElementById("clipsCard").classList.contains("hidden")
      && document.querySelectorAll("#recList li").length === 0
      && !document.querySelector('a[href*="?k="]')
  , { timeout: 10000 }).then(() => true, () => switcher.evaluate(() => ({
    rows: document.querySelectorAll("#recList li").length,
    clipsHidden: document.getElementById("clipsCard").classList.contains("hidden"),
    leaksKeys: !!document.querySelector('a[href*="?k="]')
  })));
  check("signing out empties the clip list and its manage keys",
    signedOutState === true, JSON.stringify(signedOutState));
  await fill(switcher, "#email", IDS.successor.email);
  await fill(switcher, "#password", IDS.successor.password);
  await switcher.click("#authBtn");
  await switcher.waitForFunction(() =>
    !document.getElementById("whoami").classList.contains("hidden")
      && /of 3/.test(document.getElementById("usageText").textContent), { timeout: 15000 });
  const successorState = await switcher.evaluate(() => ({
    email: document.getElementById("whoami").textContent,
    rows: document.querySelectorAll("#recList li").length,
    leaksKeys: !!document.querySelector('a[href*="?k="]')
  }));
  check("another creator on the same browser sees none of the first creator's clips",
    successorState.email === IDS.successor.email && successorState.rows === 0 && !successorState.leaksKeys,
    JSON.stringify(successorState));
  // hand the shared profile back to the original author for the later steps
  await switcher.click("#signOutLink");
  await switcher.waitForFunction(() => document.getElementById("whoami").classList.contains("hidden"), { timeout: 10000 });
  await switcher.click("#signInLink");
  await fill(switcher, "#email", IDS.author.email);
  await fill(switcher, "#password", IDS.author.password);
  await switcher.click("#authBtn");
  await switcher.waitForFunction(() => !document.getElementById("whoami").classList.contains("hidden"), { timeout: 10000 });
  await switcher.close();

  // 4c. signing out from the saved-result screen must not leave the departing
  // creator's links behind, nor hand them to whoever signs in next
  const resultContext = await browser.createBrowserContext();
  const resultPage = await resultContext.newPage();
  resultPage.on("pageerror", (err) => console.error("  [pageerror]", err.message));
  await signUp(resultPage, IDS.resultAuthor);
  await recordOnPage(resultPage, "Result-screen signout");
  await resultPage.waitForSelector("#result:not(.hidden)", { timeout: 60000 });
  const manageLinkValue = await resultPage.$eval("#manageLink", (el) => el.value);
  const manageToken = decodeURIComponent((manageLinkValue.split("?k=")[1] || ""));
  check("a saved result shows its manage link before sign-out", /^https?:\/\/.+/.test(manageLinkValue), manageLinkValue);
  await resultPage.click("#signOutLink");
  await resultPage.waitForFunction(() => document.getElementById("whoami").classList.contains("hidden"), { timeout: 10000 });
  const clearedResult = await resultPage.evaluate(() => ({
    resultHidden: document.getElementById("result").classList.contains("hidden"),
    share: document.getElementById("shareLink").value,
    manage: document.getElementById("manageLink").value
  }));
  clearedResult.leak = await resultPage.evaluate(PAGE_LEAKS_MANAGE_KEY);
  check("signing out from the result screen clears its links",
    clearedResult.resultHidden && clearedResult.share === "" && clearedResult.manage === "" && !clearedResult.leak,
    JSON.stringify(clearedResult));
  await fill(resultPage, "#email", IDS.resultNext.email);
  await fill(resultPage, "#password", IDS.resultNext.password);
  await resultPage.click("#authBtn");
  await resultPage.waitForFunction(() => !document.getElementById("whoami").classList.contains("hidden"), { timeout: 10000 });
  const successorCache = await resultPage.evaluate((tok, nextEmail, ownerEmail) => ({
    own: localStorage.getItem("openloom.recordings:" + nextEmail),
    legacy: localStorage.getItem("openloom.recordings"),
    ownerCacheKept: (localStorage.getItem("openloom.recordings:" + ownerEmail) || "").includes(tok)
  }), manageToken, IDS.resultNext.email, IDS.resultAuthor.email);
  successorCache.leak = await resultPage.evaluate(PAGE_LEAKS_MANAGE_KEY);
  check("the successor's UI and cache carry none of the departing creator's keys",
    successorCache.own === null && !successorCache.leak &&
      !(successorCache.legacy || "").includes(manageToken),
    JSON.stringify({ ...successorCache, ownerCacheKept: "checked-below" }));
  check("the departing creator's own cache survives for their next session",
    successorCache.ownerCacheKept);
  await resultPage.close();

  // 4d. an upload response that lands after an account switch belongs to the
  // account that submitted it: no links for the successor, the manage key
  // cached under its owner, the successor's session untouched
  const switchContext = await browser.createBrowserContext();
  const switchPage = await switchContext.newPage();
  switchPage.on("pageerror", (err) => console.error("  [pageerror]", err.message));
  await switchPage.setRequestInterception(true);
  let heldUpload = null;
  let releaseUpload = null;
  const uploadHeld = new Promise((r) => { releaseUpload = r; });
  switchPage.on("request", (req) => {
    if (!heldUpload && req.method() === "POST" && req.url().endsWith("/api/clips")) {
      heldUpload = req; // held: the response will only land after the switch
      releaseUpload();
      return;
    }
    if (req.method() === "DELETE" && req.url().includes("/api/sessions/current")) {
      // the sign-out call must not reach the server, so the departing session
      // stays valid and the held upload can complete for its owner
      req.respond({ status: 500 });
      return;
    }
    req.continue();
  });
  await signUp(switchPage, IDS.switchAuthor);
  await recordOnPage(switchPage, "Switch-during-upload", 2500);
  await withTimeout(uploadHeld, 30000, "the upload request was never issued");
  const switchAuthorToken = await switchPage.evaluate(() => localStorage.getItem("openloom.token"));
  await switchPage.click("#signOutLink");
  await switchPage.waitForFunction(() => document.getElementById("whoami").classList.contains("hidden"), { timeout: 10000 });
  await fill(switchPage, "#email", IDS.switchNext.email);
  await fill(switchPage, "#password", IDS.switchNext.password);
  await switchPage.click("#authBtn");
  await switchPage.waitForFunction(() =>
    !document.getElementById("whoami").classList.contains("hidden")
      && /of 3/.test(document.getElementById("usageText").textContent), { timeout: 15000 });
  await heldUpload.continue();
  // The reviewed stale-callback guard deliberately suppresses a departed
  // attempt's completion — sign-out set saveOp aside, so the late response
  // drops quietly instead of painting anything on the successor's page.
  // The clip itself is still saved to the account that submitted it (checked
  // below through the API and the owner's cache).
  await new Promise((r) => setTimeout(r, 1500));
  const suppressed = await switchPage.evaluate((nextEmail) => ({
    who: document.getElementById("whoami").textContent,
    resultHidden: document.getElementById("result").classList.contains("hidden"),
    share: document.getElementById("shareLink").value,
    manage: document.getElementById("manageLink").value,
    ownCache: localStorage.getItem("openloom.recordings:" + nextEmail),
    nextToken: localStorage.getItem("openloom.token")
  }), IDS.switchNext.email);
  suppressed.leak = await switchPage.evaluate(PAGE_LEAKS_MANAGE_KEY);
  check("an upload finishing under a switched-in account shows none of the owner's links",
    !!suppressed && suppressed.who === IDS.switchNext.email && suppressed.resultHidden
      && suppressed.share === "" && suppressed.manage === "" && !suppressed.leak
      && suppressed.ownCache === null && suppressed.nextToken !== switchAuthorToken,
    JSON.stringify(suppressed));
  const switchClips = await (await fetch(baseUrl + "/api/my/clips", {
    headers: { Authorization: "Bearer " + switchAuthorToken }
  })).json();
  check("the clip from the switched upload is saved to the account that submitted it",
    (switchClips.clips || []).length === 1, JSON.stringify((switchClips.clips || []).length));
  const ownerCacheHasIt = await switchPage.evaluate(async (email, token) => {
    const raw = localStorage.getItem("openloom.recordings:" + email);
    if (!raw) return false;
    const clips = (await (await fetch("/api/my/clips", { headers: { Authorization: "Bearer " + token } })).json()).clips;
    const cache = JSON.parse(raw);
    return clips.length === 1 && cache.some((r) => r.id === clips[0].id && r.token);
  }, IDS.switchAuthor.email, switchAuthorToken);
  check("the manage key from the switched upload lands in its owner's cache", ownerCacheHasIt);
  await switchPage.close();

  // 4e. the successor records a clip while the departing owner's upload is
  // still pending: the stale completion must not erase the successor's
  // pending blob, title or owner, and the successor can still save,
  // download and retry their own recording afterwards
  const staleContext = await browser.createBrowserContext();
  const stalePage = await staleContext.newPage();
  const staleErrors = [];
  stalePage.on("pageerror", (err) => staleErrors.push(err.message));
  await stalePage.setRequestInterception(true);
  let heldStaleUpload = null;
  let releaseStaleUpload = null;
  let failNextUpload = false;
  const staleUploadHeld = new Promise((r) => { releaseStaleUpload = r; });
  stalePage.on("request", (req) => {
    if (!heldStaleUpload && req.method() === "POST" && req.url().endsWith("/api/clips")) {
      heldStaleUpload = req; // the departing owner's upload: held past the switch
      releaseStaleUpload();
      return;
    }
    if (failNextUpload && req.method() === "POST" && req.url().endsWith("/api/clips")) {
      failNextUpload = false;
      req.respond({ status: 500, body: '{"error":"stubbed failure"}', contentType: "application/json" });
      return;
    }
    if (req.method() === "DELETE" && req.url().includes("/api/sessions/current")) {
      // the sign-out call must not reach the server, so the departing session
      // stays valid and the held upload can complete for its owner
      req.respond({ status: 500 });
      return;
    }
    req.continue();
  });
  await signUp(stalePage, IDS.pendingOwner);
  const staleOwnerToken = await stalePage.evaluate(() => localStorage.getItem("openloom.token"));
  await recordOnPage(stalePage, "Owner upload pending", 2500);
  await withTimeout(staleUploadHeld, 30000, "the owner's upload request was never issued");

  // the departure, then the successor on the same page
  await stalePage.click("#signOutLink");
  await stalePage.waitForFunction(() => document.getElementById("whoami").classList.contains("hidden"), { timeout: 10000 });
  await fill(stalePage, "#email", IDS.afterPending.email);
  await fill(stalePage, "#password", IDS.afterPending.password);
  await stalePage.click("#authBtn");
  await stalePage.waitForFunction(() =>
    !document.getElementById("whoami").classList.contains("hidden"), { timeout: 10000 });

  // the successor records while the owner's upload is still held — no
  // navigation in between, so the held request stays alive
  await fill(stalePage, "#title", "Successor clip one");
  await stalePage.click("#startBtn");
  await stalePage.waitForSelector("#recording:not(.hidden)", { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 2500));
  await stalePage.click("#stopBtn");
  await stalePage.waitForSelector("#result:not(.hidden)", { timeout: 60000 });
  const successorShare = await stalePage.$eval("#shareLink", (el) => el.value);

  // now the stale upload completes, under a page the successor owns
  await heldStaleUpload.continue();
  await new Promise((r) => setTimeout(r, 1000));
  const afterStale = await stalePage.evaluate(() => ({
    resultShown: !document.getElementById("result").classList.contains("hidden"),
    share: document.getElementById("shareLink").value,
    status: document.getElementById("setupStatus").textContent,
    rows: document.querySelectorAll("#recList li").length
  }));
  check("a stale upload completion leaves the successor's saved result alone",
    afterStale.resultShown && afterStale.share === successorShare
      && !/changed accounts|did not go through/.test(afterStale.status)
      && afterStale.rows === 1,
    JSON.stringify(afterStale));
  const staleOwnerClips = await (await fetch(baseUrl + "/api/my/clips", {
    headers: { Authorization: "Bearer " + staleOwnerToken }
  })).json();
  check("the held upload still saved to the account that submitted it",
    (staleOwnerClips.clips || []).length === 1, JSON.stringify((staleOwnerClips.clips || []).length));

  // the successor's second recording: the save fails once (stubbed 500), so
  // the failure screen offers download and retry on the successor's own blob
  failNextUpload = true;
  await stalePage.click("#againBtn"); // back from clip one's result screen
  await stalePage.waitForSelector("#setup:not(.hidden)", { timeout: 5000 });
  await fill(stalePage, "#title", "Successor clip two");
  await stalePage.click("#startBtn");
  await stalePage.waitForSelector("#recording:not(.hidden)", { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 2000));
  await stalePage.click("#stopBtn");
  await stalePage.waitForSelector("#failed:not(.hidden)", { timeout: 60000 });
  check("a failed save shows the retry screen for the successor's own recording",
    /Successor clip two|failed/i.test(await stalePage.$eval("#failNote", (el) => el.textContent)));

  // download a copy of the successor's pending recording. The behavior must
  // be scoped to this page's non-default browser context: Chrome 156 applies
  // an unscoped Browser.setDownloadBehavior to the default context only, so
  // a page launched in its own context would download to nowhere.
  const downloadDir = mkdtempSync(path.join(tmpdir(), "openloom-dl-"));
  await staleContext.setDownloadBehavior({ policy: "allow", downloadPath: downloadDir });
  await stalePage.click("#localBtn");
  let downloaded = false;
  for (let i = 0; i < 50 && !downloaded; i++) {
    await new Promise((r) => setTimeout(r, 200));
    downloaded = readdirSync(downloadDir).some((f) => f.startsWith("recording"));
  }
  check("the successor can download their own pending recording", downloaded,
    JSON.stringify(readdirSync(downloadDir)));

  // and the retry saves it
  await stalePage.click("#retryBtn");
  await stalePage.waitForSelector("#result:not(.hidden)", { timeout: 60000 });
  // the save-success path refreshes the private list in the background —
  // the result screen is not held hostage to it — so wait for the refreshed
  // row count rather than reading the list the instant the result shows
  await stalePage.waitForFunction(() => document.querySelectorAll("#recList li").length === 2,
    { timeout: 10000 }).catch(() => {});
  const retried = await stalePage.evaluate(() => ({
    share: document.getElementById("shareLink").value,
    rows: document.querySelectorAll("#recList li").length
  }));
  check("the successor can retry their own recording after a stale completion",
    /^http.*\/v\/[A-Za-z0-9_-]+$/.test(retried.share) && retried.rows === 2,
    JSON.stringify(retried));
  check("no page errors through the stale-completion scenario", staleErrors.length === 0,
    staleErrors.join(" | "));
  rmSync(downloadDir, { recursive: true, force: true });
  await stalePage.close();

  // 9. a viewer without any account opens a share link. Metadata is not
  // playback: start the video and require time to advance without a media
  // error — this is what "plays for a viewer" means.
  const viewerContext = await browser.createBrowserContext();
  const viewer = await viewerContext.newPage();
  await viewer.goto(shares[0], { waitUntil: "networkidle0" });
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

  // 10. the original downloads byte-identical
  const viewerDownload = await viewer.evaluate(async () => {
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
  check("download returns 200", viewerDownload.status === 200, `type ${viewerDownload.type}`);
  check("download is byte-identical to what was recorded",
    viewerDownload.hash === author.blobHash,
    `${viewerDownload.bytes} bytes, hashes ${viewerDownload.hash === author.blobHash ? "match" : "differ"}`);
  check("download has an attachment filename", /attachment/.test(viewerDownload.disposition || ""), viewerDownload.disposition);

  // 11. the manage link deletes from a completely different browser session
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

  const afterDelete = await viewer.evaluate(async (url) => (await fetch(url)).status,
    new URL(shares[0]).pathname.replace("/v/", "/api/clips/"));
  check("clip is gone after deletion", afterDelete === 404, `meta now returns ${afterDelete}`);

  // share link now explains itself (fresh page, plain load: the old tab's
  // media loader may keep retrying after the deletion and never go idle)
  const gonePage = await browser.newPage();
  await gonePage.goto(shares[0], { waitUntil: "domcontentloaded" });
  const gone = await gonePage.waitForFunction(() =>
    document.getElementById("note").textContent.length > 0, { timeout: 10000 })
    .then(() => gonePage.evaluate(() => document.getElementById("note").textContent));
  check("deleted share link explains itself", /deleted/i.test(gone), gone);

  // 12. the export is one archive holding the manifest and the clips
  const exported = await authorPage.evaluate(async () => {
    const res = await fetch("/api/my/export", { method: "POST", headers: { Authorization: "Bearer " + localStorage.getItem("openloom.token") } });
    if (!res.ok) return { ok: false, status: res.status };
    const { exportPath } = await res.json();
    const archive = await fetch(exportPath);
    const buf = await archive.arrayBuffer();
    const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 4096)));
    return { ok: archive.status === 200, bytes: buf.byteLength, head, type: archive.headers.get("content-type") };
  });
  check("export downloads a tar archive", !!exported && exported.ok && /x-tar/.test(exported.type || ""),
    exported ? `${exported.bytes} bytes` : "no archive");
  check("export holds the manifest and both meta and video entries",
    !!exported && /openloom-export\.json/.test(exported.head) && /clips\//.test(exported.head),
    exported?.head?.slice(0, 60));

  // 13. persistence: back up, wipe, restore — the clip list and files come back
  // the author's session, captured before any restart touches the page
  const authorSession = await authorPage.evaluate(() => ({
    token: localStorage.getItem("openloom.token"),
    email: localStorage.getItem("openloom.email")
  }));
  let originMoved = false;
  if (dataDir) {
    const metaPath = new URL(shares[1]).pathname.replace("/v/", "/api/clips/");
    const before = await (await fetch(baseUrl + metaPath)).json();
    const backupDir = dataDir + "-backups";
    execFileSync(process.execPath, ["scripts/backup.mjs", "--dir", backupDir], {
      cwd: REPO, env: { ...process.env, DATA_DIR: dataDir }, stdio: "inherit"
    });
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(dataDir, { recursive: true, force: true }); // the disaster itself
    execFileSync(process.execPath, ["scripts/restore.mjs", "--latest"], {
      cwd: REPO, env: { ...process.env, DATA_DIR: dataDir, OPENLOOM_BACKUP_DIR: backupDir }, stdio: "inherit"
    });
    child = spawn(process.execPath, ["server.js"], {
      cwd: REPO,
      env: { ...process.env, PORT: "0", DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const restarted = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not restart")), 10000);
      child.stdout.on("data", (d) => {
        const match = /listening on (\d+)/.exec(String(d));
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      });
      child.on("exit", (code) => reject(new Error(`server exited early (${code})`)));
    });
    baseUrl = restarted;
    originMoved = true;
    // the pages still sit on the pre-restart origin, so these go through node
    const afterRes = await fetch(restarted + metaPath);
    const after = { status: afterRes.status, body: afterRes.status === 200 ? await afterRes.json() : null };
    check("a restored server serves the same clip",
      after.status === 200 && after.body.bytes === before.bytes,
      `status ${after.status}`);
    const stillSignedIn = (await fetch(restarted + "/api/me", {
      headers: { Authorization: "Bearer " + authorSession.token }
    })).status;
    check("accounts survive the restore too", stillSignedIn === 200, `me returned ${stillSignedIn}`);
  } else {
    // a remote deployment owns its own data dir; backup/restore is exercised
    // by the local run, not by poking a shared dev stack
    console.log("INFO  backup/restore skipped: a remote baseUrl was given");
  }

  // 14. delete everything — still signed in
  if (originMoved) {
    // the restart moved ports, so the new origin gets the session back
    await authorPage.goto(baseUrl + "/", { waitUntil: "networkidle0" });
    await authorPage.evaluate(([t, email]) => {
      localStorage.setItem("openloom.token", t);
      localStorage.setItem("openloom.email", email);
    }, [authorSession.token, authorSession.email]);
  }
  // a remote baseUrl keeps its own origin and session; reseeding it here
  // would clobber the live session with a stale copy
  await authorPage.reload({ waitUntil: "networkidle0" });
  await authorPage.waitForFunction(() => /of 3/.test(document.getElementById("usageText").textContent), { timeout: 10000 });
  authorPage.on("dialog", (d) => d.accept());
  await authorPage.click("#deleteAllBtn");
  const emptied = await authorPage.waitForFunction(() =>
    document.querySelectorAll("#recList li").length === 0, { timeout: 10000 }).then(() => true, () => false);
  check("delete everything empties the list", emptied);
  const goneAfterPurge = (await fetch(baseUrl + new URL(shares[1]).pathname.replace("/v/", "/api/clips/"))).status;
  check("deleted clips stop playing for viewers", goneAfterPurge === 404, `meta now returns ${goneAfterPurge}`);

  // 15. cleanup is not a step any more: the finally block in main() deletes
  // exactly the accounts this run created (by signing each recorded identity
  // back in), on success and on failure alike, and a local run's throwaway
  // data directory is removed there too.
}

main().catch((err) => {
  console.error("E2E failed:", err);
  if (child) child.kill();
  process.exit(1);
});
