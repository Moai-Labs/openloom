"use strict";
// OpenLoom server: a browser screen+mic recorder, a clip API, and
// account-free share pages. Node's standard library only.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { Store, UploadTooLarge } = require("./lib/store");

const port = Number(process.env.PORT ?? 3000); // 0 is allowed: tests pick an ephemeral port
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES) || 200 * 1024 * 1024;

const store = new Store(dataDir);

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

    const title = decodeTitle(req.headers["x-title"]);
    const durationMs = Number(req.headers["x-duration-ms"]);
    const filename = safeFilename(title, contentType);

    const { meta, manageToken } = await store.createFromStream(req, {
        maxBytes: maxUploadBytes,
        contentType,
        filename,
        title,
        durationMs: Number.isFinite(durationMs) ? durationMs : null
    });

    sendJson(res, 201, {
        id: meta.id,
        title: meta.title,
        bytes: meta.bytes,
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
    const auth = String(req.headers.authorization || "");
    const match = /^Bearer (.+)$/.exec(auth);
    const outcome = await store.remove(id, match ? match[1] : "");
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
// Pages and routing

const publicDir = path.join(__dirname, "public");
const pages = new Map(); // name -> { body, contentHash }
const pagePolicy = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; media-src 'self'";

function loadPage(name, type) {
    const body = fs.readFileSync(path.join(publicDir, name));
    pages.set(name, { body, type });
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

    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
        sendPage(res, "recorder.html");
        return;
    }

    if (req.method === "GET" && parts[0] === "v" && parts.length === 2) {
        if (!store.isValidId(parts[1])) {
            sendPage(res, "watch.html"); // the page itself explains a bad or missing clip
            return;
        }
        sendPage(res, "watch.html");
        return;
    }

    if (parts[0] === "api" && parts[1] === "clips") {
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
    loadPage("recorder.html", "text/html; charset=utf-8");
    loadPage("watch.html", "text/html; charset=utf-8");
    server.listen(port, () => console.log(`listening on ${port}`));
})().catch((err) => {
    console.error("failed to start:", err);
    process.exit(1);
});

module.exports = server;
