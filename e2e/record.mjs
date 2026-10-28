#!/usr/bin/env node
// End-to-end check in a real (headless) Chrome: sign up, record, hit the free
// cap with a clear message, export, delete everything, and a full
// backup -> wipe -> restore -> playback cycle on the server.
// Run with the repo root as cwd:
//
//   npm i puppeteer   # once, outside CI (downloads a Chrome)
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

async function signUp(page, email) {
  await page.goto(baseUrl + "/", { waitUntil: "networkidle0" });
  await page.waitForSelector("#auth:not(.hidden)", { timeout: 10000 });
  await fill(page, "#email", email);
  await fill(page, "#password", "correct horse battery");
  await page.click("#authBtn");
  await page.waitForFunction(() =>
    !document.getElementById("whoami").classList.contains("hidden"), { timeout: 10000 });
  return page.$eval("#whoami", (el) => el.textContent);
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
  await page.click("#startBtn");
  try {
    await page.waitForSelector("#recording:not(.hidden)", { timeout: 8000 });
  } catch {
    await page.evaluate(FAKE_GET_DISPLAY_MEDIA);
    await page.click("#startBtn");
    await page.waitForSelector("#recording:not(.hidden)", { timeout: 8000 });
  }
  await new Promise((r) => setTimeout(r, settleMs));
  await page.click("#stopBtn");
}

async function main() {
  await startServerIfLocal();
  const browser = await puppeteer.launch({ headless: "shell", args: BROWSER_FLAGS });

  const failures = [];
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures.push(name);
  };

  // 1. a new creator signs up
  const authorContext = await browser.createBrowserContext();
  const authorPage = await authorContext.newPage();
  const who = await signUp(authorPage, "author@example.com");
  check("new creator signs up and is signed in", who === "author@example.com", who);

  // 2. records three clips — the whole free allowance
  const signedInRecord = async (title) => {
    // recording happens on a fresh page in the same (signed-in) context
    const page = await authorContext.newPage();
    page.on("pageerror", (err) => console.error("  [pageerror]", err.message));
    await page.goto(baseUrl + "/", { waitUntil: "networkidle0" });
    await fill(page, "#title", title);
    await page.click("#startBtn");
    try {
      await page.waitForSelector("#recording:not(.hidden)", { timeout: 8000 });
    } catch {
      await page.evaluate(FAKE_GET_DISPLAY_MEDIA);
      await page.click("#startBtn");
      await page.waitForSelector("#recording:not(.hidden)", { timeout: 8000 });
    }
    await new Promise((r) => setTimeout(r, 4000));
    await page.click("#stopBtn");
    await page.waitForSelector("#result:not(.hidden)", { timeout: 60000 });
    const share = await page.$eval("#shareLink", (el) => el.value);
    await page.close();
    return share;
  };

  const shares = [];
  for (let i = 1; i <= 3; i++) shares.push(await signedInRecord(`Free-limit demo ${i}`));
  check("three clips recorded and saved", shares.every((s) => /^http.*\/v\/[A-Za-z0-9_-]+$/.test(s)), shares.join(", "));

  // 3. the usage meter shows the account is full and the button says so
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

  // 4. another account sees none of them
  const strangerContext = await browser.createBrowserContext();
  const stranger = await strangerContext.newPage();
  const strangerEmail = await signUp(stranger, "stranger@example.com");
  const strangerList = await stranger.waitForFunction(() =>
    /of 3/.test(document.getElementById("usageText").textContent), { timeout: 10000 })
    .then(() => stranger.$eval("#recList", (ul) => ul.children.length));
  check("a second account's list is private and empty", strangerEmail === "stranger@example.com" && strangerList === 0,
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
      && !document.body.innerHTML.includes("?k=")
  , { timeout: 10000 }).then(() => true, () => switcher.evaluate(() => ({
    rows: document.querySelectorAll("#recList li").length,
    clipsHidden: document.getElementById("clipsCard").classList.contains("hidden"),
    leaksKeys: document.body.innerHTML.includes("?k=")
  })));
  check("signing out empties the clip list and its manage keys",
    signedOutState === true, JSON.stringify(signedOutState));
  await fill(switcher, "#email", "successor@example.com");
  await fill(switcher, "#password", "correct horse battery");
  await switcher.click("#authBtn");
  await switcher.waitForFunction(() =>
    !document.getElementById("whoami").classList.contains("hidden")
      && /of 3/.test(document.getElementById("usageText").textContent), { timeout: 15000 });
  const successorState = await switcher.evaluate(() => ({
    email: document.getElementById("whoami").textContent,
    rows: document.querySelectorAll("#recList li").length,
    leaksKeys: document.body.innerHTML.includes("?k=")
  }));
  check("another creator on the same browser sees none of the first creator's clips",
    successorState.email === "successor@example.com" && successorState.rows === 0 && !successorState.leaksKeys,
    JSON.stringify(successorState));
  // hand the shared profile back to the original author for the later steps
  await switcher.click("#signOutLink");
  await switcher.waitForFunction(() => document.getElementById("whoami").classList.contains("hidden"), { timeout: 10000 });
  await switcher.click("#signInLink");
  await fill(switcher, "#email", "author@example.com");
  await fill(switcher, "#password", "correct horse battery");
  await switcher.click("#authBtn");
  await switcher.waitForFunction(() => !document.getElementById("whoami").classList.contains("hidden"), { timeout: 10000 });
  await switcher.close();

  // 4c. signing out from the saved-result screen must not leave the departing
  // creator's links behind, nor hand them to whoever signs in next
  const resultContext = await browser.createBrowserContext();
  const resultPage = await resultContext.newPage();
  resultPage.on("pageerror", (err) => console.error("  [pageerror]", err.message));
  await signUp(resultPage, "resultauthor@example.com");
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
    manage: document.getElementById("manageLink").value,
    leak: document.body.innerHTML.includes("?k=")
  }));
  check("signing out from the result screen clears its links",
    clearedResult.resultHidden && clearedResult.share === "" && clearedResult.manage === "" && !clearedResult.leak,
    JSON.stringify(clearedResult));
  await fill(resultPage, "#email", "resultnext@example.com");
  await fill(resultPage, "#password", "correct horse battery");
  await resultPage.click("#authBtn");
  await resultPage.waitForFunction(() => !document.getElementById("whoami").classList.contains("hidden"), { timeout: 10000 });
  const successorCache = await resultPage.evaluate((tok) => ({
    own: localStorage.getItem("openloom.recordings:resultnext@example.com"),
    legacy: localStorage.getItem("openloom.recordings"),
    leak: document.body.innerHTML.includes("?k="),
    ownerCacheKept: (localStorage.getItem("openloom.recordings:resultauthor@example.com") || "").includes(tok)
  }), manageToken);
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
  await signUp(switchPage, "switchauthor@example.com");
  await recordOnPage(switchPage, "Switch-during-upload", 2500);
  await withTimeout(uploadHeld, 30000, "the upload request was never issued");
  const switchAuthorToken = await switchPage.evaluate(() => localStorage.getItem("openloom.token"));
  await switchPage.click("#signOutLink");
  await switchPage.waitForFunction(() => document.getElementById("whoami").classList.contains("hidden"), { timeout: 10000 });
  await fill(switchPage, "#email", "switchnext@example.com");
  await fill(switchPage, "#password", "correct horse battery");
  await switchPage.click("#authBtn");
  await switchPage.waitForFunction(() =>
    !document.getElementById("whoami").classList.contains("hidden")
      && /of 3/.test(document.getElementById("usageText").textContent), { timeout: 15000 });
  await heldUpload.continue();
  const suppressed = await switchPage.waitForFunction(() =>
    document.getElementById("setupStatus").textContent.includes("changed accounts")
  , { timeout: 15000 }).then(() => switchPage.evaluate(() => ({
    who: document.getElementById("whoami").textContent,
    resultHidden: document.getElementById("result").classList.contains("hidden"),
    share: document.getElementById("shareLink").value,
    manage: document.getElementById("manageLink").value,
    leak: document.body.innerHTML.includes("?k="),
    ownCache: localStorage.getItem("openloom.recordings:switchnext@example.com"),
    nextToken: localStorage.getItem("openloom.token")
  })), () => null);
  check("an upload finishing under a switched-in account shows none of the owner's links",
    !!suppressed && suppressed.who === "switchnext@example.com" && suppressed.resultHidden
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
  }, "switchauthor@example.com", switchAuthorToken);
  check("the manage key from the switched upload lands in its owner's cache", ownerCacheHasIt);
  await switchPage.close();

  // 5. a viewer without any account opens a share link
  const viewerContext = await browser.createBrowserContext();
  const viewer = await viewerContext.newPage();
  await viewer.goto(shares[0], { waitUntil: "networkidle0" });
  const playback = await viewer.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
  }, { timeout: 30000 }).then(() => viewer.evaluate(() => ({
    duration: document.querySelector("video").duration,
    title: document.getElementById("clipTitle").textContent,
    deleteVisible: !document.getElementById("deleteBtn").classList.contains("hidden")
  })), () => null);
  check("share link plays for a viewer with no account", !!playback, playback ? `${playback.duration.toFixed(1)}s, "${playback.title}"` : "video metadata never resolved");
  if (playback) check("viewer does not see a delete button", !playback.deleteVisible);

  // 6. the export is one archive holding the manifest and the clips
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

  // 7. persistence: back up, wipe, restore — the clip list and files come back
  let authorToken = null;
  if (dataDir) {
    const metaPath = new URL(shares[1]).pathname.replace("/v/", "/api/clips/");
    const before = await (await fetch(baseUrl + metaPath)).json();
    authorToken = await authorPage.evaluate(() => localStorage.getItem("openloom.token"));
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
    // the pages still sit on the pre-restart origin, so these go through node
    const afterRes = await fetch(restarted + metaPath);
    const after = { status: afterRes.status, body: afterRes.status === 200 ? await afterRes.json() : null };
    check("a restored server serves the same clip",
      after.status === 200 && after.body.bytes === before.bytes,
      `status ${after.status}`);
    const stillSignedIn = (await fetch(restarted + "/api/me", {
      headers: { Authorization: "Bearer " + authorToken }
    })).status;
    check("accounts survive the restore too", stillSignedIn === 200, `me returned ${stillSignedIn}`);
  } else {
    check("backup/restore demonstration ran against a local server", false, "skipped: a remote baseUrl was given");
  }

  // 8. delete everything — on the restarted server, still signed in
  // (the restart moved ports, so the new origin gets the session back)
  await authorPage.goto(baseUrl + "/", { waitUntil: "networkidle0" });
  await authorPage.evaluate(([t, email]) => {
    localStorage.setItem("openloom.token", t);
    localStorage.setItem("openloom.email", email);
  }, [authorToken, "author@example.com"]);
  await authorPage.reload({ waitUntil: "networkidle0" });
  await authorPage.waitForFunction(() => /of 3/.test(document.getElementById("usageText").textContent), { timeout: 10000 });
  authorPage.on("dialog", (d) => d.accept());
  await authorPage.click("#deleteAllBtn");
  const emptied = await authorPage.waitForFunction(() =>
    document.querySelectorAll("#recList li").length === 0, { timeout: 10000 }).then(() => true, () => false);
  check("delete everything empties the list", emptied);
  const goneAfterPurge = (await fetch(baseUrl + new URL(shares[0]).pathname.replace("/v/", "/api/clips/"))).status;
  check("deleted clips stop playing for viewers", goneAfterPurge === 404, `meta now returns ${goneAfterPurge}`);

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
