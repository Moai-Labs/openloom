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
const { scanWebmDurationFile } = require("./lib/webm-duration");

const port = Number(process.env.PORT ?? 3000); // 0 is allowed: tests pick an ephemeral port
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES) || 200 * 1024 * 1024;

// The free plan, published in the product before any upgrade exists.
// Env overrides exist so tests can exercise the limits without real payloads.
const limits = {
    maxClips: Number(process.env.FREE_MAX_CLIPS) || 3,
    maxDurationMs: Number(process.env.FREE_MAX_DURATION_MS) || 5 * 60 * 1000,
    maxClipBytes: Number(process.env.FREE_MAX_CLIP_BYTES) || 100 * 1024 * 1024
};

const store = new Store(dataDir);
const accounts = new Accounts(dataDir);

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

    const lengthHeader = Number(req.headers["content-length"]);
    if (Number.isFinite(lengthHeader) && lengthHeader > maxUploadBytes) {
        sendError(res, 413, "recording is too large to store");
        return;
    }
    if (Number.isFinite(lengthHeader) && lengthHeader > limits.maxClipBytes) {
        sendError(res, 413, `the free plan stores clips up to ${Math.floor(limits.maxClipBytes / (1024 * 1024))} MB — this one is larger`);
        return;
    }

    const used = await store.countByAccount(account.id);
    if (used >= limits.maxClips) {
        sendError(res, 403, `the free plan holds ${limits.maxClips} clips — delete one to record another`);
        return;
    }

    const title = decodeTitle(req.headers["x-title"]);
    const durationMs = Number(req.headers["x-duration-ms"]);
    const declaredDuration = Number.isFinite(durationMs) ? durationMs : null;
    // a fast pre-upload rejection of grossly over-cap declarations; the
    // recorder's own auto-stop runs a beat past the cap (timer granularity),
    // so the same slop as the real check below applies here
    if (declaredDuration !== null && declaredDuration > limits.maxDurationMs + 2000) {
        sendError(res, 413, `the free plan stores clips up to ${Math.round(limits.maxDurationMs / 60000)} minutes — this one is longer`);
        return;
    }
    const filename = safeFilename(title, contentType);

    const { meta, manageToken } = await store.createFromStream(req, {
        maxBytes: Math.min(maxUploadBytes, limits.maxClipBytes),
        contentType,
        filename,
        title,
        durationMs: declaredDuration,
        accountId: account.id
    });

    // The duration is verified from the file's own media timeline — the
    // cluster/block timestamps, not the Info.Duration float, which is
    // client-writable text and no enforcement point. A webm whose timeline
    // cannot be read at all is refused: the cap is only as strong as the
    // verification behind it, so verification failing closes the door.
    if (contentType.includes("webm") || contentType.includes("matroska")) {
        let verified = null;
        try {
            verified = await scanWebmDurationFile(store.videoPath(meta.id));
        } catch {
            verified = null; // unreadable file: the same fail-closed path
        }
        if (verified === null) {
            await store.remove(meta.id, { token: manageToken });
            sendError(res, 413, "the recording's length could not be verified from the file itself, so the free plan cannot store it");
            return;
        }
        if (verified > limits.maxDurationMs + 2000) { // small encoder slop
            await store.remove(meta.id, { token: manageToken });
            sendError(res, 413, `the free plan stores clips up to ${Math.round(limits.maxDurationMs / 60000)} minutes — this one runs ${Math.round(verified / 60000)}`);
            return;
        }
        // the timeline is the truth, even when the declared header disagrees
        meta.durationMs = verified;
        await store.updateMeta(meta);
    }

    // Recount after the write: two concurrent uploads must not sneak past the cap.
    const afterCount = await store.countByAccount(account.id);
    if (afterCount > limits.maxClips) {
        await store.remove(meta.id, { token: manageToken });
        sendError(res, 403, `the free plan holds ${limits.maxClips} clips — delete one to record another`);
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
    sendJson(res, 200, {
        email: account.email,
        limits,
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

    if (req.method === "GET" && parts[0] === "v" && parts.length === 2) {
        sendPage(res, "watch.html"); // the page itself explains a bad or missing clip
        return;
    }

    if (parts[0] === "api") {
        if (parts[1] === "limits" && req.method === "GET") {
            sendJson(res, 200, { plan: "free", ...limits });
            return;
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
    server.listen(port, () => console.log(`listening on ${server.address().port} — data in ${dataDir}`));
})().catch((err) => {
    console.error("failed to start:", err);
    process.exit(1);
});

module.exports = server;
