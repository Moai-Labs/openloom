"use strict";
// Creator accounts: email + password sign-up, bearer sessions, all in one
// JSON file with atomic writes. Passwords are scrypt-hashed; only the SHA-256
// hash of a session token is stored, so a leaked file grants no sessions.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function newToken() {
    return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("base64url");
}

function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString("base64");
}

function passwordsMatch(password, stored) {
    const [salt, digest] = String(stored).split(":");
    if (!salt || !digest) return false;
    const candidate = hashPassword(password, salt);
    const a = Buffer.from(candidate, "base64");
    const b = Buffer.from(digest, "base64");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class Accounts {
    constructor(root) {
        this.filePath = path.join(root, "accounts.json");
        this.data = { accounts: [], sessions: [] };
    }

    async init() {
        try {
            const raw = await fsp.readFile(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed.accounts)) this.data.accounts = parsed.accounts;
            if (Array.isArray(parsed.sessions)) this.data.sessions = parsed.sessions;
        } catch (err) {
            if (err.code !== "ENOENT") throw err;
        }
    }

    async save() {
        const tmp = this.filePath + ".tmp";
        await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2));
        await fsp.rename(tmp, this.filePath);
    }

    // Returns {id, email} or throws {status, message}.
    async create(email, password) {
        const normalized = String(email || "").trim().toLowerCase();
        if (!EMAIL_PATTERN.test(normalized) || normalized.length > 200) {
            const err = new Error("enter a valid email address");
            err.status = 400;
            throw err;
        }
        if (typeof password !== "string" || password.length < 8 || password.length > 200) {
            const err = new Error("password must be at least 8 characters");
            err.status = 400;
            throw err;
        }
        if (this.data.accounts.some((a) => a.email === normalized)) {
            const err = new Error("that email already has an account — sign in instead");
            err.status = 409;
            throw err;
        }
        const salt = crypto.randomBytes(16).toString("base64");
        const account = {
            id: crypto.randomBytes(12).toString("base64url"),
            email: normalized,
            passwordHash: salt + ":" + hashPassword(password, salt),
            createdAt: new Date().toISOString()
        };
        this.data.accounts.push(account);
        await this.pruneSessions();
        const token = newToken();
        this.data.sessions.push({
            hash: hashToken(token),
            accountId: account.id,
            expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
        });
        await this.save();
        return { id: account.id, email: account.email, token };
    }

    async login(email, password) {
        const normalized = String(email || "").trim().toLowerCase();
        const account = this.data.accounts.find((a) => a.email === normalized);
        // the same slow path either way, so a wrong email is not faster to probe
        const stored = account ? account.passwordHash : "x:" + Buffer.alloc(32).toString("base64");
        const ok = passwordsMatch(password, stored);
        if (!account || !ok) {
            const err = new Error("email or password is wrong");
            err.status = 401;
            throw err;
        }
        await this.pruneSessions();
        const token = newToken();
        this.data.sessions.push({
            hash: hashToken(token),
            accountId: account.id,
            expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
        });
        await this.save();
        return { id: account.id, email: account.email, token };
    }

    // Returns the account for a live bearer token, or null.
    async auth(token) {
        if (typeof token !== "string" || token.length < 20) return null;
        const hash = hashToken(token);
        const session = this.data.sessions.find((s) => s.hash === hash);
        if (!session) return null;
        if (new Date(session.expiresAt).getTime() < Date.now()) return null;
        return this.data.accounts.find((a) => a.id === session.accountId) || null;
    }

    async logout(token) {
        const hash = hashToken(token);
        const before = this.data.sessions.length;
        this.data.sessions = this.data.sessions.filter((s) => s.hash !== hash);
        if (this.data.sessions.length !== before) await this.save();
    }

    // Drops every session of an account (used when the account is deleted).
    async dropSessionsOf(accountId) {
        this.data.sessions = this.data.sessions.filter((s) => s.accountId !== accountId);
        await this.save();
    }

    async pruneSessions() {
        const now = Date.now();
        const before = this.data.sessions.length;
        this.data.sessions = this.data.sessions.filter((s) => new Date(s.expiresAt).getTime() > now);
        if (this.data.sessions.length !== before) await this.save();
    }

    async remove(accountId) {
        this.data.accounts = this.data.accounts.filter((a) => a.id !== accountId);
        await this.dropSessionsOf(accountId);
    }
}

module.exports = { Accounts, hashToken, newToken, EMAIL_PATTERN };
