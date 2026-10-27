#!/usr/bin/env node
// End-to-end check in a real (headless) Chrome: sign up, record, hit the free
// cap with a clear message, export, delete everything, and a full
// backup -> wipe -> restore -> playback cycle on the server.
// Run with the repo root as cwd:
//
//   npm i puppeteer   # once, outside CI (downloads a Chrome)
//   node e2e/record.mjs [baseUrl]
//
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

async function signUp(page, email) {
  await page.goto(baseUrl + "/", { waitUntil: "networkidle0" });
  await page.waitForSelector("#auth:not(.hidden)", { timeout: 10000 });
  await page.type("#email", email);
  await page.type("#password", "correct horse battery");
  await page.click("#authBtn");
  await page.waitForFunction(() =>
    !document.getElementById("whoami").classList.contains("hidden"), { timeout: 10000 });
  return page.$eval("#whoami", (el) => el.textContent);
}

async function main() {
  await startServerIfLocal();
  const browser = await puppeteer.launch({ headless: true, args: BROWSER_FLAGS });

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
    await page.type("#title", title);
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
    const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 512)));
    return { ok: archive.status === 200, bytes: buf.byteLength, head, type: archive.headers.get("content-type") };
  });
  check("export downloads a tar archive", !!exported && exported.ok && /x-tar/.test(exported.type || ""),
    exported ? `${exported.bytes} bytes` : "no archive");
  check("export holds the manifest and both meta and video entries",
    !!exported && /openloom-export\.json/.test(exported.head) && /clips\//.test(exported.head),
    exported?.head?.slice(0, 60));

  // 7. persistence: back up, wipe, restore — the clip list and files come back
  if (dataDir) {
    const metaPath = new URL(shares[1]).pathname.replace("/v/", "/api/clips/");
    const before = await viewer.evaluate(async (url) => (await fetch(url)).json(), baseUrl + metaPath);
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
    const after = await viewer.evaluate(async (url) => {
      const res = await fetch(url);
      return { status: res.status, body: res.status === 200 ? await res.json() : null };
    }, restarted + metaPath);
    check("a restored server serves the same clip",
      after.status === 200 && after.body.bytes === before.bytes,
      `status ${after.status}`);
    const stillSignedIn = await authorPage.evaluate(async (url) => {
      const res = await fetch(url, { headers: { Authorization: "Bearer " + localStorage.getItem("openloom.token") } });
      return res.status;
    }, restarted + "/api/me");
    check("accounts survive the restore too", stillSignedIn === 200, `me returned ${stillSignedIn}`);
  } else {
    check("backup/restore demonstration ran against a local server", false, "skipped: a remote baseUrl was given");
  }

  // 8. delete everything — on the restarted server, still signed in
  await authorPage.goto(baseUrl + "/", { waitUntil: "networkidle0" });
  await authorPage.waitForFunction(() => /of 3/.test(document.getElementById("usageText").textContent), { timeout: 10000 });
  authorPage.on("dialog", (d) => d.accept());
  await authorPage.click("#deleteAllBtn");
  const emptied = await authorPage.waitForFunction(() =>
    document.querySelectorAll("#recList li").length === 0, { timeout: 10000 }).then(() => true, () => false);
  check("delete everything empties the list", emptied);
  const goneAfterPurge = await viewer.evaluate(async (url) => (await fetch(url)).status,
    baseUrl + new URL(shares[0]).pathname.replace("/v/", "/api/clips/"));
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
