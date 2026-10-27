"use strict";
// OpenLoom server: a browser screen+mic recorder, a clip API, creator
// accounts with published free limits, and account-free share pages.
// Node's standard library only.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Store, UploadTooLarge } = require("./lib/store");
const { Accounts } = require("./lib/accounts");
const { createTar } = require("./lib/tar");
const { readWebmDurationMs } = require("./lib/webm-duration");
const payments = require("./lib/payments");

const port = Number(process.env.PORT ?? 3000); // 0 is allowed: tests pick an ephemeral port
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES) || 200 * 1024 * 1024;

// The plans and their limits live in lib/payments.js — the free plan is what
// the product enforces today, the paid plan is what a verified test-USDC
// payment buys. Env overrides for tests live there too.
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

const store = new Store(dataDir);
const accounts = new Accounts(dataDir);
const invoices = new payments.Invoices(dataDir);

// ---------------------------------------------------------------------------
// Small helpers

function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
        "cache-control": "no-store"
    });
    res.end(text);
}

function sendError(res, status, message) {
    sendJson(res, status, { error: message });
}

// A storage cap in words, the way the product publishes it: "2 GB", not a
// raw byte count. Small values round up so a test-sized cap never reads "0 MB".
function storageCap(bytes) {
    if (bytes >= 1024 ** 3) {
        const gb = Math.round((bytes / 1024 ** 3) * 10) / 10;
        return `${gb} GB`;
    }
    return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

// Reads a small JSON body (accounts, never uploads).
function readJsonBody(req, maxBytes = 10 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        req.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                const err = new Error("body too large");
                err.status = 413;
                req.destroy();
                reject(err);
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (!chunks.length) {
                resolve(null);
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                const err = new Error("expected JSON");
                err.status = 400;
                reject(err);
            }
        });
        req.on("error", reject);
    });
}

function bearerToken(req) {
    const match = /^Bearer (.+)$/.exec(String(req.headers.authorization || ""));
    return match ? match[1] : null;
}

// Titles come in as an encoded header; keep them to one sane line.
function decodeTitle(raw) {
    if (!raw) return null;
    try {
        let title = decodeURIComponent(String(raw)).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
        if (title.length > 120) title = title.slice(0, 120);
        return title || null;
    } catch {
        return null;
    }
}

function extensionFor(contentType) {
    if (contentType.includes("mp4")) return ".mp4";
    if (contentType.includes("matroska")) return ".mkv";
    return ".webm";
}

// Only a safe subset of characters survives into download filenames.
function safeFilename(title, contentType) {
    const ext = extensionFor(contentType);
    const base = (title || "recording")
        .normalize("NFKD")
        .replace(/[^\w .#-]+/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\.+$/, "") || "recording";
    return base.slice(0, 80) + ext;
}

// Single-range parser. Returns {start, end}, {invalid: true}, or null.
function parseRange(header, size) {
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return { invalid: true };
    const [, rawStart, rawEnd] = match;
    if (rawStart === "" && rawEnd === "") return { invalid: true };
    if (size === 0) return { invalid: true };
    let start;
    let end;
    if (rawStart === "") {
        const suffixLength = Number(rawEnd);
        if (suffixLength === 0) return { invalid: true };
        start = Math.max(0, size - suffixLength);
        end = size - 1;
    } else {
        start = Number(rawStart);
        end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
        if (start > end || start >= size) return { invalid: true };
    }
    return { start, end };
}

// ---------------------------------------------------------------------------
// Clip API

async function createClip(req, res) {
    const account = await accounts.auth(bearerToken(req));
    if (!account) {
        sendError(res, 401, "sign up free to record — accounts keep your clip list private to you");
        return;
    }

    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("video/")) {
        sendError(res, 415, "expected a video/* upload");
        return;
    }

    const plan = payments.limitsFor(account);
    const tierName = plan.tier === "paid" ? "the paid plan" : "the free plan";

    const lengthHeader = Number(req.headers["content-length"]);
    if (Number.isFinite(lengthHeader) && lengthHeader > maxUploadBytes) {
        sendError(res, 413, "recording is too large to store");
        return;
    }
    if (Number.isFinite(lengthHeader) && lengthHeader > plan.maxClipBytes) {
        sendError(res, 413, `${tierName} stores clips up to ${Math.floor(plan.maxClipBytes / (1024 * 1024))} MB — this one is larger`);
        return;
    }

    const stored = await store.listByAccount(account.id);
    const used = stored.length;
    const usedBytes = stored.reduce((n, c) => n + (c.bytes || 0), 0);
    if (used >= plan.maxClips) {
        sendError(res, 403, `${tierName} holds ${plan.maxClips} clips — delete one to record another`);
        return;
    }
    if (Number.isFinite(lengthHeader) && usedBytes + lengthHeader > plan.totalBytes) {
        sendError(res, 413, `${tierName} stores up to ${storageCap(plan.totalBytes)} in total — delete clips or upgrade to make room`);
        return;
    }

    const title = decodeTitle(req.headers["x-title"]);
    const durationMs = Number(req.headers["x-duration-ms"]);
    const declaredDuration = Number.isFinite(durationMs) ? durationMs : null;
    if (declaredDuration !== null && declaredDuration > plan.maxDurationMs) {
        sendError(res, 413, `${tierName} stores clips up to ${Math.round(plan.maxDurationMs / 60000)} minutes — this one is longer`);
        return;
    }
    const filename = safeFilename(title, contentType);

    const { meta, manageToken } = await store.createFromStream(req, {
        maxBytes: Math.min(maxUploadBytes, plan.maxClipBytes),
        contentType,
        filename,
        title,
        durationMs: declaredDuration,
        accountId: account.id
    });

    // Verify the duration from the file itself when it is a webm: a header
    // the client controls is not an enforcement point.
    if (contentType.includes("webm") || contentType.includes("matroska")) {
        try {
            const head = Buffer.alloc(Math.min(1024 * 1024, meta.bytes));
            const file = await fs.promises.open(store.videoPath(meta.id), "r");
            try {
                const { bytesRead } = await file.read(head, 0, head.length, 0);
                const parsed = readWebmDurationMs(head.subarray(0, bytesRead));
                if (parsed !== null) {
                    if (parsed > plan.maxDurationMs + 2000) { // small encoder slop
                        await store.remove(meta.id, { token: manageToken });
                        sendError(res, 413, `${tierName} stores clips up to ${Math.round(plan.maxDurationMs / 60000)} minutes — this one runs ${Math.round(parsed / 60000)}`);
                        return;
                    }
                    if (meta.durationMs === null) {
                        meta.durationMs = parsed;
                        await store.updateMeta(meta);
                    }
                }
            } finally {
                await file.close();
            }
        } catch {
            // unreadable duration falls back to the declared one
        }
    }

    // Recount after the write: two concurrent uploads must not sneak past the cap.
    const after = await store.listByAccount(account.id);
    if (after.length > plan.maxClips) {
        await store.remove(meta.id, { token: manageToken });
        sendError(res, 403, `${tierName} holds ${plan.maxClips} clips — delete one to record another`);
        return;
    }
    const afterBytes = after.reduce((n, c) => n + (c.bytes || 0), 0);
    if (afterBytes > plan.totalBytes) {
        await store.remove(meta.id, { token: manageToken });
        sendError(res, 413, `${tierName} stores up to ${storageCap(plan.totalBytes)} in total — delete clips or upgrade to make room`);
        return;
    }

    sendJson(res, 201, {
        id: meta.id,
        title: meta.title,
        bytes: meta.bytes,
        durationMs: meta.durationMs,
        createdAt: meta.createdAt,
        sharePath: `/v/${meta.id}`,
        managePath: `/v/${meta.id}?k=${manageToken}`,
        manageToken
    });
}

async function getClipMeta(req, res, id) {
    const meta = await store.get(id);
    if (!meta) {
        sendError(res, 404, "no such clip");
        return;
    }
    sendJson(res, 200, {
        id: meta.id,
        title: meta.title,
        filename: meta.filename,
        contentType: meta.contentType,
        bytes: meta.bytes,
        durationMs: meta.durationMs,
        createdAt: meta.createdAt
    });
}

async function serveClipFile(req, res, id, download) {
    const meta = await store.get(id);
    if (!meta) {
        sendError(res, 404, "no such clip");
        return;
    }
    const stat = await store.getStat(id);
    if (!stat) {
        sendError(res, 404, "no such clip");
        return;
    }

    const size = stat.size;
    const range = parseRange(req.headers.range, size);
    if (range && range.invalid) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        res.end();
        return;
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const headers = {
        "content-type": meta.contentType || "video/webm",
        "accept-ranges": "bytes",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
    };
    if (download) {
        headers["content-disposition"] = `attachment; filename="${meta.filename.replace(/"/g, "")}"`;
    }
    if (range) {
        headers["content-range"] = `bytes ${start}-${end}/${size}`;
        headers["content-length"] = end - start + 1;
        res.writeHead(206, headers);
    } else {
        headers["content-length"] = size;
        res.writeHead(200, headers);
    }
    const stream = fs.createReadStream(store.videoPath(id), { start, end });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    req.on("close", () => stream.destroy());
}

async function deleteClip(req, res, id) {
    const token = bearerToken(req);
    const account = await accounts.auth(token);
    const outcome = await store.remove(id, { token, accountId: account ? account.id : null });
    if (outcome === "missing") {
        sendError(res, 404, "no such clip");
    } else if (outcome === "forbidden") {
        sendError(res, 403, "this key does not manage this clip");
    } else {
        res.writeHead(204);
        res.end();
    }
}

// ---------------------------------------------------------------------------
// Accounts and the private clip list

async function createAccount(req, res) {
    const body = await readJsonBody(req);
    const { email, password } = body || {};
    const result = await accounts.create(email, password);
    sendJson(res, 201, { email: result.email, token: result.token });
}

async function login(req, res) {
    const body = await readJsonBody(req);
    const { email, password } = body || {};
    const result = await accounts.login(email, password);
    sendJson(res, 200, { email: result.email, token: result.token });
}

async function logout(req, res) {
    const token = bearerToken(req);
    if (token) await accounts.logout(token);
    res.writeHead(204);
    res.end();
}

async function me(req, res, account) {
    const clips = await store.listByAccount(account.id);
    const plan = payments.limitsFor(account);
    sendJson(res, 200, {
        email: account.email,
        plan: plan.tier,
        paidUntil: plan.paidUntil || null,
        limits: plan,
        usage: {
            clips: clips.length,
            bytes: clips.reduce((n, c) => n + (c.bytes || 0), 0)
        }
    });
}

async function listMyClips(req, res, account) {
    const clips = (await store.listByAccount(account.id)).map((c) => ({
        id: c.id,
        title: c.title,
        bytes: c.bytes,
        durationMs: c.durationMs,
        createdAt: c.createdAt
    }));
    sendJson(res, 200, { clips });
}

// ---------------------------------------------------------------------------
// Billing: the paid plan, paid in test USDC on Base Sepolia

// What a payment buys, published in one place and served to every page. The
// free plan's limits stay at the top level, as they were before upgrades
// existed, so nothing that reads them has to change.
function billingInfo() {
    return {
        plan: "free",
        ...payments.PLANS.free,
        test: true,
        notice: "Payments are test USDC on a test network (Base Sepolia). Test tokens have no value and no real money is charged — this is a payment test.",
        priceUsd: payments.PRICE_USDC,
        priceMicroUsdc: payments.PRICE_MICRO_USDC.toString(),
        allowanceBytes: payments.PLANS.paid.totalBytes,
        daysPerPayment: 30,
        chainId: payments.CHAIN_ID,
        contract: payments.USDC_CONTRACT,
        paidPlan: {
            tier: "paid",
            maxClips: payments.PLANS.paid.maxClips,
            totalBytes: payments.PLANS.paid.totalBytes
        }
    };
}

async function billingOverview(req, res) {
    sendJson(res, 200, billingInfo());
}

async function createInvoice(req, res, account) {
    await invoices.expireStale();
    const invoice = await invoices.create(account.id);
    sendJson(res, 201, {
        invoiceId: invoice.id,
        test: true,
        notice: billingInfo().notice,
        payTo: invoice.address,
        amountUsdc: (Number(invoice.amountMicroUsdc) / 1e6).toFixed(2),
        amountMicroUsdc: invoice.amountMicroUsdc,
        chainId: payments.CHAIN_ID,
        contract: payments.USDC_CONTRACT,
        expiresAt: invoice.expiresAt
    });
}

async function verifyInvoicePayment(req, res, account) {
    const body = await readJsonBody(req);
    const invoiceId = body && body.invoiceId;
    const txHash = body && body.txHash;
    if (typeof txHash !== "string" || !payments.TX_HASH_PATTERN.test(txHash)) {
        sendError(res, 400, "paste the transaction hash — 0x followed by 64 hex characters");
        return;
    }
    const invoice = invoices.find(invoiceId);
    if (!invoice || invoice.accountId !== account.id) {
        sendError(res, 404, "no such payment request");
        return;
    }
    if (invoice.status === "paid") {
        // Idempotent: verifying the same invoice twice answers with the plan, not an error.
        sendJson(res, 200, { status: "paid", tier: "paid", paidUntil: payments.activePaidUntil(account), alreadyPaid: true });
        return;
    }
    if (invoice.status === "expired") {
        sendError(res, 410, "this payment request expired — start a new one");
        return;
    }
    const reused = invoices.findByTx(txHash);
    if (reused && reused.id !== invoice.id) {
        sendError(res, 402, "this transaction was already used for another payment request");
        return;
    }

    let outcome;
    try {
        outcome = await payments.verifyPayment({ fetchImpl: fetch, rpcUrl, txHash, invoice });
    } catch {
        sendError(res, 502, "could not reach the payment network — try again in a moment");
        return;
    }

    if (outcome !== "verified") {
        const reasons = {
            pending: { status: 200, text: "no receipt on-chain yet — wait for the transaction to be mined, then try again" },
            failed: { status: 402, text: "that transaction was mined but did not succeed" },
            unrelated: { status: 402, text: "that transaction does not send test USDC to this payment request's address" },
            "wrong-amount": { status: 402, text: "the amount does not match — the plan costs 10 test USDC" },
            "wrong-chain": { status: 402, text: "that transaction is on a different chain — pay on Base Sepolia" }
        };
        const reason = reasons[outcome] || { status: 402, text: "the payment could not be verified" };
        sendJson(res, reason.status, { status: outcome, error: reason.text, test: true });
        return;
    }

    // Verified: one transaction pays one invoice, and the plan starts now.
    invoice.txHash = txHash.toLowerCase();
    invoice.paidAt = Date.now();
    invoice.status = "paid";
    const paidUntil = payments.extendPaid(account);
    await invoices.save();
    await accounts.save();
    sendJson(res, 200, { status: "paid", tier: "paid", paidUntil, test: true });
}

// One-time, short-lived links let the browser download the export with an
// ordinary navigation instead of holding the whole archive in memory.
const exportLinks = new Map(); // token -> { accountId, expiresAt }

function pruneExportLinks() {
    const now = Date.now();
    for (const [token, entry] of exportLinks) {
        if (entry.expiresAt < now) exportLinks.delete(token);
    }
}

async function requestExport(req, res, account) {
    pruneExportLinks();
    const token = crypto.randomBytes(24).toString("base64url");
    exportLinks.set(token, { accountId: account.id, expiresAt: Date.now() + 10 * 60 * 1000 });
    sendJson(res, 201, { exportPath: `/api/my/export/${token}` });
}

async function serveExport(req, res, token) {
    pruneExportLinks();
    const entry = exportLinks.get(token);
    exportLinks.delete(token); // one download per link
    if (!entry) {
        sendError(res, 403, "this export link is unknown or already used — request a fresh one");
        return;
    }
    const clips = await store.listByAccount(entry.accountId);
    const manifest = {
        product: "OpenLoom",
        exportedAt: new Date().toISOString(),
        clipCount: clips.length,
        clips: clips.map((c) => ({
            id: c.id, title: c.title, filename: c.filename, contentType: c.contentType,
            bytes: c.bytes, durationMs: c.durationMs, createdAt: c.createdAt
        }))
    };
    const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    const entries = [
        { name: "openloom-export.json", size: manifestBody.length, mtime: Math.floor(Date.now() / 1000), file: manifestBody },
        ...clips.map((c) => ({
            name: `clips/${c.id}/meta.json`,
            size: Buffer.byteLength(JSON.stringify(c, null, 2)),
            mtime: Math.floor(new Date(c.createdAt).getTime() / 1000),
            file: Buffer.from(JSON.stringify(c, null, 2))
        })),
        ...clips.map((c) => ({
            name: `clips/${c.id}/video.bin`,
            size: c.bytes,
            mtime: Math.floor(new Date(c.createdAt).getTime() / 1000),
            filePath: store.videoPath(c.id)
        }))
    ];
    // tar needs every size up front: stat the videos rather than trusting meta
    for (const entry2 of entries) {
        if (entry2.filePath) {
            const stat = await store.getStat(entry2.name.split("/")[1]);
            if (!stat) {
                sendError(res, 500, "a clip file went missing mid-export");
                return;
            }
            entry2.size = stat.size;
        }
    }

    res.writeHead(200, {
        "content-type": "application/x-tar",
        "content-disposition": `attachment; filename="openloom-export-${new Date().toISOString().slice(0, 10)}.tar"`,
        "x-content-type-options": "nosniff"
    });
    const archive = createTar(entries);
    archive.on("error", () => res.destroy());
    req.on("close", () => archive.destroy());
    archive.pipe(res);
}

async function deleteAllMyClips(req, res, account) {
    const removed = await store.removeAllFor(account.id);
    sendJson(res, 200, { removed });
}

async function deleteMyAccount(req, res, account) {
    const removed = await store.removeAllFor(account.id);
    await accounts.remove(account.id);
    sendJson(res, 200, { removedClips: removed });
}

// ---------------------------------------------------------------------------
// Pages and routing

const publicDir = path.join(__dirname, "public");
const pages = new Map(); // name -> { body, type }
const staticFiles = new Map(); // url path -> { file, type }
const pagePolicy = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; media-src 'self'";

function loadPage(name, type) {
    const body = fs.readFileSync(path.join(publicDir, name));
    pages.set(name, { body, type });
}

// Third-party scripts live in public/vendor; only plain names are served.
function loadStatic(urlPath, name, type) {
    staticFiles.set(urlPath, { file: path.join(publicDir, "vendor", name), type });
}

function sendPage(res, name) {
    const page = pages.get(name);
    if (!page) {
        sendError(res, 500, "page missing");
        return;
    }
    res.writeHead(200, {
        "content-type": page.type,
        "content-length": page.body.length,
        "cache-control": "no-store",
        "content-security-policy": pagePolicy,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer"
    });
    res.end(page.body);
}

const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
        if (!res.headersSent) {
            const status = err instanceof UploadTooLarge ? 413 : (Number.isInteger(err.status) ? err.status : 500);
            sendError(res, status, status === 500 ? "something went wrong on our side" : err.message);
        } else {
            res.destroy();
        }
        console.error(`error handling ${req.method} ${req.url}:`, err.message);
    });
});

async function handle(req, res) {
    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const started = Date.now();

    res.on("finish", () => {
        console.log(`${req.method} ${u.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    });

    if (u.pathname === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
    }

    if (req.method === "GET" && staticFiles.has(u.pathname)) {
        const entry = staticFiles.get(u.pathname);
        try {
            const body = fs.readFileSync(entry.file);
            res.writeHead(200, {
                "content-type": entry.type,
                "content-length": body.length,
                "cache-control": "public, max-age=3600"
            });
            res.end(body);
        } catch {
            sendError(res, 404, "not found");
        }
        return;
    }

    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
        sendPage(res, "recorder.html");
        return;
    }

    if (req.method === "GET" && u.pathname === "/limits") {
        sendPage(res, "limits.html");
        return;
    }

    if (req.method === "GET" && u.pathname === "/upgrade") {
        sendPage(res, "upgrade.html");
        return;
    }

    if (req.method === "GET" && parts[0] === "v" && parts.length === 2) {
        sendPage(res, "watch.html"); // the page itself explains a bad or missing clip
        return;
    }

    if (parts[0] === "api") {
        if (parts[1] === "limits" && req.method === "GET") {
            sendJson(res, 200, billingInfo());
            return;
        }
        if (parts[1] === "billing") {
            if (req.method === "GET" && parts.length === 2) {
                await billingOverview(req, res);
                return;
            }
            const account = await accounts.auth(bearerToken(req));
            if (!account) {
                sendError(res, 401, "sign in first — the paid plan belongs to an account");
                return;
            }
            if (req.method === "POST" && parts[2] === "invoices" && parts.length === 3) {
                await createInvoice(req, res, account);
                return;
            }
            if (req.method === "POST" && parts[2] === "verify" && parts.length === 3) {
                await verifyInvoicePayment(req, res, account);
                return;
            }
            if (req.method === "GET" && parts[2] === "status" && parts.length === 3) {
                await me(req, res, account);
                return;
            }
        }
        if (parts[1] === "accounts" && req.method === "POST" && parts.length === 2) {
            await createAccount(req, res);
            return;
        }
        if (parts[1] === "sessions") {
            if (req.method === "POST" && parts.length === 2) {
                await login(req, res);
                return;
            }
            if (req.method === "DELETE" && parts.length === 3 && parts[2] === "current") {
                await logout(req, res);
                return;
            }
        }
        if (parts[1] === "me" && req.method === "GET") {
            const account = await accounts.auth(bearerToken(req));
            if (!account) {
                sendError(res, 401, "sign in first");
                return;
            }
            await me(req, res, account);
            return;
        }
        if (parts[1] === "my") {
            // the export download authenticates with its one-time link token,
            // not with a session
            if (req.method === "GET" && parts[2] === "export" && parts.length === 4) {
                await serveExport(req, res, parts[3]);
                return;
            }
            const account = await accounts.auth(bearerToken(req));
            if (!account) {
                sendError(res, 401, "sign in first");
                return;
            }
            if (req.method === "GET" && parts[2] === "clips" && parts.length === 3) {
                await listMyClips(req, res, account);
                return;
            }
            if (req.method === "POST" && parts[2] === "export" && parts.length === 3) {
                await requestExport(req, res, account);
                return;
            }
            if (req.method === "DELETE" && parts[2] === "clips" && parts.length === 3) {
                await deleteAllMyClips(req, res, account);
                return;
            }
            if (req.method === "DELETE" && parts[2] === "account" && parts.length === 3) {
                await deleteMyAccount(req, res, account);
                return;
            }
        }
        if (parts[1] === "clips") {
            if (req.method === "POST" && parts.length === 2) {
                await createClip(req, res);
                return;
            }
            if (parts.length >= 3 && store.isValidId(parts[2])) {
                const id = parts[2];
                if (req.method === "GET" && parts.length === 3) {
                    await getClipMeta(req, res, id);
                    return;
                }
                if (req.method === "GET" && parts.length === 4 && parts[3] === "file") {
                    await serveClipFile(req, res, id, u.searchParams.get("download") === "1");
                    return;
                }
                if (req.method === "DELETE" && parts.length === 3) {
                    await deleteClip(req, res, id);
                    return;
                }
            }
        }
        sendError(res, 404, "no such API route");
        return;
    }

    sendError(res, 404, "not found");
}

server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

(async () => {
    await store.init();
    await accounts.init();
    loadPage("recorder.html", "text/html; charset=utf-8");
    loadPage("watch.html", "text/html; charset=utf-8");
    loadPage("limits.html", "text/html; charset=utf-8");
    loadPage("upgrade.html", "text/html; charset=utf-8");
    loadStatic("/vendor/fix-webm-duration.js", "fix-webm-duration.js", "application/javascript; charset=utf-8");
    server.listen(port, () => console.log(`listening on ${server.address().port} — data in ${dataDir}`));
})().catch((err) => {
    console.error("failed to start:", err);
    process.exit(1);
});

module.exports = server;
