"use strict";
// Clip storage. One directory per clip under the data root: video.bin plus meta.json.
// Uploads stream straight to disk so a large recording never sits in memory.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Transform } = require("node:stream");

const ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;

function newId() {
    return crypto.randomBytes(12).toString("base64url");
}

function newManageToken() {
    return crypto.randomBytes(24).toString("base64url");
}

// Only the hash of the manage token is stored, so a leaked data directory
// does not hand out the keys to delete clips.
function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("base64url");
}

class UploadTooLarge extends Error {
    constructor(maxBytes) {
        super(`upload larger than the ${maxBytes} byte limit`);
        this.status = 413;
    }
}

class Store {
    constructor(root) {
        this.root = root;
        this.clipsDir = path.join(root, "clips");
        this.tmpDir = path.join(root, "tmp");
    }

    async init() {
        for (const dir of [this.root, this.clipsDir, this.tmpDir]) {
            await fsp.mkdir(dir, { recursive: true });
        }
    }

    isValidId(id) {
        return typeof id === "string" && ID_PATTERN.test(id);
    }

    videoPath(id) {
        return path.join(this.clipsDir, id, "video.bin");
    }

    metaPath(id) {
        return path.join(this.clipsDir, id, "meta.json");
    }

    // Streams req's body into a staging file, then moves it into place and
    // writes the metadata. Resolves with the clip's metadata and its manage
    // token; rejects with UploadTooLarge when the body runs past maxBytes.
    async createFromStream(req, { maxBytes, contentType, filename, title, durationMs, accountId }) {
        const id = newId();
        const manageToken = newManageToken();
        const staging = path.join(this.tmpDir, `upload-${id}.part`);
        let bytes = 0;
        let out = null;

        const counting = new Transform({
            transform(chunk, _enc, callback) {
                bytes += chunk.length;
                if (bytes > maxBytes) {
                    callback(new UploadTooLarge(maxBytes));
                    return;
                }
                callback(null, chunk);
            }
        });

        // Tear the pipeline down on failure: unpipe in flow order, close the
        // writers, then drain the request. Without this an aborted or
        // oversized upload leaves the socket and the counting transform
        // connected — the client keeps sending, the server keeps counting,
        // and a stalled transfer holds the connection open. Draining (rather
        // than destroying the socket) also lets the error response reach the
        // client: the request still finishes, the handler still answers.
        const teardown = () => {
            req.unpipe(counting);
            counting.unpipe(out);
            counting.destroy();
            if (out) out.destroy();
            req.resume(); // discard the rest of the body, at socket speed
        };

        try {
            await fsp.mkdir(this.tmpDir, { recursive: true });
            out = fs.createWriteStream(staging);
            await new Promise((resolve, reject) => {
                req.on("error", reject);
                out.on("error", reject);
                counting.on("error", reject);
                req.pipe(counting).pipe(out);
                out.on("finish", resolve);
            });
        } catch (err) {
            teardown();
            await fsp.rm(staging, { force: true }).catch(() => {}); // only this upload's staging file
            throw err;
        }

        if (bytes === 0) {
            await fsp.rm(staging, { force: true }).catch(() => {}); // only this upload's staging file
            const err = new Error("empty upload");
            err.status = 400;
            throw err;
        }

        const meta = {
            id,
            title: title || null,
            filename,
            contentType,
            bytes,
            durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
            createdAt: new Date().toISOString(),
            accountId: accountId || null,
            tokenHash: hashToken(manageToken)
        };

        try {
            const clipDir = path.join(this.clipsDir, id);
            await fsp.mkdir(clipDir, { recursive: true });
            await fsp.rename(staging, this.videoPath(id));
            await fsp.writeFile(path.join(clipDir, "meta.json.tmp"), JSON.stringify(meta, null, 2));
            await fsp.rename(path.join(clipDir, "meta.json.tmp"), this.metaPath(id));
        } catch (err) {
            await fsp.rm(path.join(this.clipsDir, id), { recursive: true, force: true }).catch(() => {});
            throw err;
        }

        return { meta, manageToken };
    }

    // Returns the metadata, or null when the clip does not exist.
    async get(id) {
        if (!this.isValidId(id)) return null;
        try {
            const raw = await fsp.readFile(this.metaPath(id), "utf8");
            return JSON.parse(raw);
        } catch (err) {
            if (err.code === "ENOENT") return null;
            throw err;
        }
    }

    // Rewrites an existing clip's metadata in place (atomic swap).
    async updateMeta(meta) {
        const clipDir = path.join(this.clipsDir, meta.id);
        await fsp.writeFile(path.join(clipDir, "meta.json.tmp"), JSON.stringify(meta, null, 2));
        await fsp.rename(path.join(clipDir, "meta.json.tmp"), this.metaPath(meta.id));
    }

    async getStat(id) {
        if (!this.isValidId(id)) return null;
        try {
            return await fsp.stat(this.videoPath(id));
        } catch (err) {
            if (err.code === "ENOENT") return null;
            throw err;
        }
    }

    // Returns "deleted", "missing", or "forbidden". A clip is managed by its
    // manage token (the author's offline key) or by the session of the
    // account that recorded it.
    async remove(id, { token, accountId } = {}) {
        const meta = await this.get(id);
        if (!meta) return "missing";
        const byToken = typeof token === "string" && hashToken(token) === meta.tokenHash;
        const byOwner = meta.accountId && accountId && meta.accountId === accountId;
        if (!byToken && !byOwner) return "forbidden";
        await fsp.rm(path.join(this.clipsDir, id), { recursive: true, force: true });
        return "deleted";
    }

    // All clips owned by an account, newest first.
    async listByAccount(accountId) {
        const clips = [];
        let entries;
        try {
            entries = await fsp.readdir(this.clipsDir, { withFileTypes: true });
        } catch {
            return clips;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || !this.isValidId(entry.name)) continue;
            try {
                const meta = JSON.parse(await fsp.readFile(this.metaPath(entry.name), "utf8"));
                if (meta.accountId === accountId) clips.push(meta);
            } catch {
                // a half-written or corrupt meta never blocks the rest of the list
            }
        }
        clips.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return clips;
    }

    async countByAccount(accountId) {
        return (await this.listByAccount(accountId)).length;
    }

    // Deletes every clip of an account; returns how many went away.
    async removeAllFor(accountId) {
        let removed = 0;
        for (const meta of await this.listByAccount(accountId)) {
            await fsp.rm(path.join(this.clipsDir, meta.id), { recursive: true, force: true });
            removed++;
        }
        return removed;
    }
}

module.exports = { Store, UploadTooLarge, newId, newManageToken, hashToken, ID_PATTERN };
