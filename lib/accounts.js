"use strict";
// Creator accounts: email + password sign-up, bearer sessions, all in one
// JSON file with atomic writes. Passwords are scrypt-hashed; only the SHA-256
// hash of a session token is stored, so a leaked file grants no sessions.

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
        this.writeSeq = 0;
        // The tail of the mutation queue; never rejected, so one failed write
        // does not poison the operations queued behind it.
        this.queueTail = Promise.resolve();
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

    // Every account mutation and its persistence commit run one at a time, so
    // overlapping sign-ups, logins, logouts and plan updates cannot interleave
    // two writes into one corrupt accounts.json. A job that runs its own
    // persistence must call #commit(), never save() — save() re-enters this
    // queue and would wait for the very job that called it.
    runExclusive(job) {
        const run = this.queueTail.then(job, job); // the next job runs even if the last one failed
        this.queueTail = run.then(() => {}, () => {});
        return run;
    }

    // Write a state snapshot to a temporary file that only this commit owns,
    // then atomically replace accounts.json. A mutation passes the candidate
    // it is about to publish; a bare commit() (save()) writes the live state.
    // The unique name means two commits can never rename each other's file
    // out from under them, and the fsync means a caller that has seen its
    // change answered can trust it is on disk.
    async commit(state = this.data) {
        const tmp = `${this.filePath}.${process.pid}.${++this.writeSeq}.${crypto.randomBytes(6).toString("hex")}.tmp`;
        try {
            const file = await fsp.open(tmp, "w");
            try {
                await file.write(JSON.stringify(state, null, 2));
                await file.sync();
            } finally {
                await file.close();
            }
            await fsp.rename(tmp, this.filePath);
        } catch (err) {
            await fsp.rm(tmp, { force: true }).catch(() => {});
            throw err;
        }
    }

    // Persist the current state, serialized against every other mutation.
    // Called on its own (the billing route saves after a plan update) or from
    // code that already holds the lock, which must call commit() instead.
    save() {
        return this.runExclusive(() => this.commit());
    }

    // Returns {id, email} or throws {status, message}.
    async create(email, password) {
        return this.runExclusive(async () => {
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
            const token = newToken();
            // Copy-on-write: the candidate state is persisted first and only
            // then becomes live, so a reader never sees — and a failed commit
            // never leaves behind — a state the disk does not hold.
            const candidate = {
                accounts: [...this.data.accounts, account],
                sessions: [
                    ...this.data.sessions.filter((s) => new Date(s.expiresAt).getTime() > Date.now()),
                    {
                        hash: hashToken(token),
                        accountId: account.id,
                        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
                    }
                ]
            };
            await this.commit(candidate);
            this.data = candidate;
            return { id: account.id, email: account.email, token };
        });
    }

    async login(email, password) {
        return this.runExclusive(async () => {
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
            const token = newToken();
            const candidate = {
                ...this.data,
                sessions: [
                    ...this.data.sessions.filter((s) => new Date(s.expiresAt).getTime() > Date.now()),
                    {
                        hash: hashToken(token),
                        accountId: account.id,
                        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
                    }
                ]
            };
            await this.commit(candidate);
            this.data = candidate;
            return { id: account.id, email: account.email, token };
        });
    }

    // Returns the account for a live bearer token, or null. It reads the
    // committed state without the mutation queue, so it answers while a write
    // is pending — which is only safe because mutations publish nothing
    // until their commit has landed: what auth() hands out is always what
    // the disk holds. The account objects it returns are treated as
    // immutable by every mutation (they are replaced, never edited).
    async auth(token) {
        if (typeof token !== "string" || token.length < 20) return null;
        const hash = hashToken(token);
        const session = this.data.sessions.find((s) => s.hash === hash);
        if (!session) return null;
        if (new Date(session.expiresAt).getTime() < Date.now()) return null;
        return this.data.accounts.find((a) => a.id === session.accountId) || null;
    }

    async logout(token) {
        await this.runExclusive(() => {
            const hash = hashToken(token);
            const sessions = this.data.sessions.filter((s) => s.hash !== hash);
            if (sessions.length === this.data.sessions.length) return; // nothing changed
            const candidate = { ...this.data, sessions };
            return this.commit(candidate).then(() => {
                this.data = candidate;
            });
        });
    }

    // A copy of an account's committed record, for callers that need the
    // plan as it stands now rather than the snapshot their request started
    // with. It never observes uncommitted state — mutations publish only
    // after their commit lands — and it changes nothing.
    peek(accountId) {
        const account = this.data.accounts.find((a) => a.id === accountId);
        return account ? { ...account } : null;
    }

    // Sets an account's plan inside the mutation lock — the billing route
    // calls this after a verified payment. planOf may set account.plan itself
    // (payments.extendPaid does) or return the new plan object; both work —
    // but it runs on a copy, never on the object readers already hold.
    // Returns the new paidUntil timestamp. The upgrade becomes visible only
    // once its commit has landed, so a failed commit leaves the account
    // exactly as it was, on disk and in memory.
    async setPlan(accountId, planOf) {
        return this.runExclusive(async () => {
            const index = this.data.accounts.findIndex((a) => a.id === accountId);
            if (index === -1) {
                const err = new Error("no such account");
                err.status = 404;
                throw err;
            }
            const updated = { ...this.data.accounts[index] };
            const returned = planOf(updated);
            if (returned && typeof returned === "object") updated.plan = returned;
            const candidate = {
                ...this.data,
                accounts: this.data.accounts.map((a, i) => (i === index ? updated : a))
            };
            await this.commit(candidate);
            this.data = candidate;
            return updated.plan ? updated.plan.paidUntil : null;
        });
    }

    async remove(accountId) {
        await this.runExclusive(async () => {
            const candidate = {
                accounts: this.data.accounts.filter((a) => a.id !== accountId),
                sessions: this.data.sessions.filter((s) => s.accountId !== accountId)
            };
            await this.commit(candidate);
            this.data = candidate;
        });
    }
}

module.exports = { Accounts, hashToken, newToken, EMAIL_PATTERN };
