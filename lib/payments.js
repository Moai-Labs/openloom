"use strict";
// The paid plan: $10/month for 2 GB, paid in test USDC on Base Sepolia, with
// every payment verified on-chain before the upgrade applies. This module
// only verifies: the product talks about test tokens with no real value, and
// every page and route that touches it says "test payment".
//
// Why on-chain verification: a transaction hash is not proof, and neither is
// a claim in a request body. Verification is a `Transfer` event (ERC-20
// Transfer(address,address,uint256), the keccak hash of that signature,
// computed by the keccak-256 module pinned to test vectors) emitted by the
// USDC contract, on the right chain, to the receiving address of an invoice
// the server itself created, for the right amount. The receiving address is
// derived from a fresh key held in memory only: a leaked data directory
// still holds no key that can move funds.
//
// Nothing here signs, broadcasts or holds a balance. The product is a
// verifier of receipts, not a wallet.

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { keccak256 } = require("./keccak256");

const USDC_CONTRACT = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"; // USDC on Base Sepolia, chain 84532 — verified on-chain this session: symbol/decimals/name answer USDC/6/USDC
const CHAIN_ID = 84532;
const TRANSFER_TOPIC =
    "0x" + keccak256(Buffer.from("Transfer(address,address,uint256)")).toString("hex");
const DECIMALS = 6; // USDC uses 6 decimals on every chain

function envInt(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

// The published plans. Env overrides exist so tests can exercise the limits
// without real payloads; the shipped defaults are what the product publishes.
const PLANS = {
    free: {
        tier: "free",
        maxClips: envInt("FREE_MAX_CLIPS", 3),
        maxDurationMs: envInt("FREE_MAX_DURATION_MS", 5 * 60 * 1000),
        maxClipBytes: envInt("FREE_MAX_CLIP_BYTES", 100 * 1024 * 1024),
        totalBytes: envInt("FREE_MAX_TOTAL_BYTES", 3 * 100 * 1024 * 1024)
    },
    paid: {
        tier: "paid",
        maxClips: envInt("PAID_MAX_CLIPS", 2000),
        maxDurationMs: envInt("FREE_MAX_DURATION_MS", 5 * 60 * 1000),
        maxClipBytes: envInt("FREE_MAX_CLIP_BYTES", 100 * 1024 * 1024),
        totalBytes: envInt("PAID_MAX_TOTAL_BYTES", 2 * 1024 * 1024 * 1024)
    }
};

const PRICE_USDC = 10; // 10 USDC, 6 decimals
const PRICE_MICRO_USDC = 10_000_000n;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const INVOICE_TTL_MS = 24 * 60 * 60 * 1000; // an unpaid invoice request dies after a day

// --- plan helpers ----------------------------------------------------------

// The limits an account may use right now: paid while the subscription is
// live, free otherwise. Expiry is checked at read time, so a plan lapses on
// the 30-day mark even if no request comes in that minute.
function limitsFor(account, now = Date.now()) {
    const paid = activePaidUntil(account, now);
    if (paid) {
        return { ...PLANS.paid, paidUntil: paid };
    }
    return { ...PLANS.free };
}

// Timestamp the paid plan runs until, or null. A malformed or stale record
// degrades to free rather than crashing or lying.
function activePaidUntil(account, now = Date.now()) {
    const plan = account && account.plan;
    if (!plan || plan.tier !== "paid") return null;
    const until = Number(plan.paidUntil);
    if (!Number.isFinite(until) || until <= now) return null;
    return until;
}

// Add 30 days on top of whatever is already paid, so paying again extends a
// live subscription instead of eating the remaining days.
function extendPaid(account, now = Date.now()) {
    const start = activePaidUntil(account, now) || now;
    account.plan = { tier: "paid", paidUntil: start + MONTH_MS };
    return account.plan.paidUntil;
}

// --- entitlement recovery ---------------------------------------------------
//
// A verified payment is two durable commits: the invoice is marked paid,
// then the account's plan is extended. A crash or a failed commit between
// the two used to strand a paid invoice with no upgrade — the payment
// consumed, nothing granted, and a re-verification answered already-paid
// without repairing anything. The account snapshot now records every
// invoice it has applied next to the paidUntil it bought, so the question
// "has this payment been honored?" has one durable answer, and recovery can
// finish what a crash interrupted: on a retry of the payment, and once at
// startup for anything left over.

// Has this account's plan already applied this invoice? A plan without the
// list is a record written before applications were tracked; it proves
// nothing either way, and callers decide what to do about that.
function entitlementApplied(account, invoiceId) {
    const plan = account && account.plan;
    return Boolean(
        plan &&
        Array.isArray(plan.appliedInvoices) &&
        plan.appliedInvoices.some((applied) => applied && applied.invoiceId === invoiceId)
    );
}

// planOf for Accounts.setPlan: extend the plan by this payment's 30 days and
// record the invoice as applied in the same snapshot, so the entitlement and
// the proof that it was granted commit together. It runs inside the account
// mutation lock and is idempotent there: a plan that already carries this
// invoice is returned unchanged, so concurrent retries and a recovery
// racing a verification cannot stack extra months.
function applyInvoiceEntitlement(account, { invoiceId, paidAt, now = Date.now() }) {
    const existing = account.plan && Array.isArray(account.plan.appliedInvoices)
        ? account.plan.appliedInvoices
        : [];
    if (existing.some((applied) => applied && applied.invoiceId === invoiceId)) {
        return account.plan; // exactly once: a retry or a recovery changes nothing
    }
    // The 30 days run from the entitlement that was live when the payment
    // landed — not from the moment recovery happens — so a payment verified
    // at T keeps its original window even if its plan only lands days later,
    // and paying while a plan is live stacks on top of what is left.
    const paid = Number(paidAt) > 0 ? Number(paidAt) : now;
    let paidUntil = (activePaidUntil(account, paid) || paid) + MONTH_MS;
    const live = activePaidUntil(account, now);
    if (live && live > paidUntil) paidUntil = live; // never shorten a later extension
    account.plan = {
        tier: "paid",
        paidUntil,
        appliedInvoices: [...existing, { invoiceId, paidUntil }]
    };
    return account.plan;
}

// Grant one paid invoice's entitlement to its account — the single
// idempotent operation behind a fresh verification, a retry of an
// already-paid one, and startup reconciliation. Returns the plan's
// paidUntil, or null when the account no longer exists. If the account
// commit fails, the invoice is still durably paid and the next retry or
// boot finishes the grant.
async function ensureEntitlement({ accounts, invoice, now = Date.now() }) {
    if (!invoice || invoice.status !== "paid") {
        const err = new Error("only a paid invoice carries an entitlement");
        err.status = 409;
        throw err;
    }
    const account = accounts.peek(invoice.accountId);
    if (!account) return null; // the account is gone — there is nothing to grant
    if (entitlementApplied(account, invoice.id)) {
        return account.plan.paidUntil;
    }
    return accounts.setPlan(invoice.accountId, (copy) =>
        applyInvoiceEntitlement(copy, { invoiceId: invoice.id, paidAt: invoice.paidAt, now })
    );
}

// Heal every paid invoice whose entitlement never landed — the crash window
// between the invoice commit and the account commit. Run once at startup,
// after both stores have loaded; it is safe at any time, because each
// application is exactly once and the timing comes from the invoice's own
// paidAt, so a recovery days later neither restarts the 30 days nor
// shortens a later extension. A plan recorded before applications were
// tracked is skipped: for its invoices it cannot be proven whether the
// payment was honored, and the safe side of that doubt is granting nothing
// extra — a holder retrying the payment itself still heals, where the
// holder asked.
async function reconcileEntitlements({ invoices, accounts, now = Date.now() }) {
    const applied = [];
    for (const invoice of invoices.data.invoices) {
        if (invoice.status !== "paid") continue;
        const account = accounts.peek(invoice.accountId);
        if (!account) continue;
        if (account.plan && !Array.isArray(account.plan.appliedInvoices)) continue;
        if (entitlementApplied(account, invoice.id)) continue;
        const until = await ensureEntitlement({ accounts, invoice, now });
        if (until != null) applied.push(invoice.id);
    }
    return applied;
}

// --- keys and addresses ----------------------------------------------------

// A fresh secp256k1 key just to derive the receiving address. The private key
// stays inside this function; only the address is kept. Anything derived this
// way cannot sign the funds that arrive at it — by construction.
function newReceivingAddress() {
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "secp256k1" });
    const privateKeyBytes = privateKey.export({ type: "sec1", format: "der" }).subarray(7); // strip the SEC1 wrapper
    const publicKey = crypto.createPublicKey(privateKey);
    const raw = publicKey.export({ type: "spki", format: "der" });
    // uncompressed public key: 0x04 || X (32) || Y (32), the last 64 bytes
    const point = raw.subarray(raw.length - 64);
    const address = keccak256(point).subarray(12); // last 20 bytes
    return toHex(address);
}

function toHex(bytes) {
    return "0x" + Buffer.from(bytes).toString("hex");
}

// hex string -> Buffer, tolerant of 0x and odd... no, strict: even-length only
function hexToBuffer(hex) {
    const text = String(hex).toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]*$/.test(text) || text.length % 2 !== 0) return null;
    return Buffer.from(text, "hex");
}

// --- amount and address encoding -------------------------------------------

// The ERC-20 Transfer event layout: topic0 = event signature hash, topic1 =
// from (padded to 32), topic2 = to (padded to 32), data = value (32).
function pad32(bytes) {
    if (bytes.length > 32) throw new Error("value too long for a 32-byte word");
    return Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
}

// USDC amounts are integers of 1e-6; $10 is 10000000.
function amountTo32Bytes(microUsdc) {
    if (typeof microUsdc !== "bigint" || microUsdc < 0n) throw new Error("amount must be a non-negative bigint");
    return pad32(hexToBuffer(microUsdc.toString(16)));
}

// --- invoices ---------------------------------------------------------------

// Unpaid payment requests, persisted so a restart does not strand one. The
// receiving address lives on the invoice, so verification needs no key — the
// key that derived it existed for one function call and is gone.
class Invoices {
    constructor(root) {
        this.filePath = path.join(root, "invoices.json");
        this.data = { invoices: [] };
        this.writeSeq = 0;
        // The tail of the mutation queue; never rejected, so one failed write
        // does not poison the operations queued behind it.
        this.queueTail = Promise.resolve();
    }

    async init() {
        try {
            const raw = await fsp.readFile(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed.invoices)) this.data.invoices = parsed.invoices;
        } catch (err) {
            if (err.code !== "ENOENT") throw err;
        }
    }

    // Every invoice mutation and its persistence commit run one at a time, so
    // concurrent creations and expiries cannot interleave two writes into one
    // corrupt invoices.json. A job that runs its own persistence must call
    // #commit(), never save() — save() re-enters this queue and would wait for
    // the very job that called it.
    runExclusive(job) {
        const run = this.queueTail.then(job, job); // the next job runs even if the last one failed
        this.queueTail = run.then(() => {}, () => {});
        return run;
    }

    // Write a state snapshot to a temporary file that only this commit owns,
    // then atomically replace invoices.json. A mutation passes the candidate
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
    save() {
        return this.runExclusive(() => this.commit());
    }

    // A new pending invoice for one account. Each one gets its own address, so
    // matching a payment to an invoice is exact. The new invoice is persisted
    // before it becomes visible, so a caller holding an invoice id knows the
    // file on disk already carries it.
    async create(accountId, now = Date.now()) {
        return this.runExclusive(async () => {
            const invoice = {
                id: crypto.randomBytes(12).toString("base64url"),
                accountId,
                address: newReceivingAddress(),
                amountMicroUsdc: PRICE_MICRO_USDC.toString(),
                createdAt: now,
                expiresAt: now + INVOICE_TTL_MS,
                status: "pending", // pending | paid | expired
                txHash: null,
                paidAt: null
            };
            const prev = this.data.invoices;
            const candidate = { invoices: [...prev, invoice] };
            await this.commit(candidate);
            this.data = candidate;
            return invoice;
        });
    }

    find(id) {
        return this.data.invoices.find((i) => i.id === id) || null;
    }

    // Replay protection: one transaction pays one invoice, ever. Checked
    // across every account, so a receipt cannot be replayed against a second
    // invoice or a second account.
    findByTx(txHash) {
        const normalized = String(txHash || "").toLowerCase();
        return this.data.invoices.find((i) => i.txHash === normalized) || null;
    }

    // Mark one invoice paid inside the mutation lock, so a concurrent verify
    // of the same or another invoice cannot interleave with the commit. Every
    // check that decides whether this transaction may pay this invoice runs
    // here, inside the lock: whatever the verify route checked before its
    // RPC wait is only a fast path, because a concurrent verification can
    // pass the same checks and still be on the wire when this one commits.
    //
    // Returns { invoice, already }: already is true when the invoice was
    // already paid with this same transaction (a concurrent verify of the
    // same receipt), which the caller treats as a no-op rather than paying
    // twice. Everything else that cannot be paid is refused with a
    // status-carrying error: a hash already spent on another invoice, an
    // invoice that is paid with a different transaction, one that expired —
    // before or during verification — and a malformed hash.
    async markPaid(id, opts) {
        return this.runExclusive(async () => {
            // The clock is read at lock entry, not at call time: the checks
            // below must judge the state as it stands when this mutation
            // finally runs, however long the verification before it took.
            const { txHash, paidAt, now = Date.now() } = opts || {};
            const normalized = String(txHash || "").toLowerCase();
            if (!TX_HASH_PATTERN.test(normalized)) {
                const err = new Error("paste the transaction hash — 0x followed by 64 hex characters");
                err.status = 400;
                throw err;
            }
            const index = this.data.invoices.findIndex((i) => i.id === id);
            if (index === -1) {
                const err = new Error("no such invoice");
                err.status = 404;
                throw err;
            }
            const invoice = this.data.invoices[index];
            if (invoice.status === "paid") {
                if (invoice.txHash === normalized) return { invoice, already: true };
                const err = new Error("this payment request is already paid");
                err.status = 409;
                throw err;
            }
            // Only a pending, unexpired invoice can change hands. An invoice
            // that expired while its verification was on the wire is dead —
            // its receiving address dies with it.
            if (invoice.status !== "pending" || invoice.expiresAt <= now) {
                const err = new Error("this payment request expired — start a new one");
                err.status = 410;
                throw err;
            }
            // One transaction pays one invoice, ever — checked here against
            // every other invoice, so a receipt whose transaction carries
            // transfers to two invoice addresses cannot pay both: whichever
            // finalize lands second finds the hash already taken.
            if (this.data.invoices.some((i) => i.id !== invoice.id && i.txHash === normalized)) {
                const err = new Error("this transaction was already used for another payment request");
                err.status = 402;
                throw err;
            }
            // Copy-on-write: the paid invoice replaces the old record only
            // once its commit has landed, so a failed commit leaves memory
            // equal to disk and readers hold objects that never change.
            const paid = { ...invoice, status: "paid", txHash: normalized, paidAt };
            const candidate = {
                invoices: this.data.invoices.map((i, k) => (k === index ? paid : i))
            };
            await this.commit(candidate);
            this.data = candidate;
            return { invoice: paid, already: false };
        });
    }

    // Expire stale pending invoices lazily, at read — serialized like every
    // other mutation, so the status flip and its persistence cannot interleave.
    async expireStale(now = Date.now()) {
        await this.runExclusive(async () => {
            let changed = false;
            const candidate = {
                invoices: this.data.invoices.map((invoice) => {
                    if (invoice.status === "pending" && invoice.expiresAt <= now) {
                        changed = true;
                        return { ...invoice, status: "expired" };
                    }
                    return invoice;
                })
            };
            if (!changed) return;
            await this.commit(candidate);
            this.data = candidate;
        });
    }
}

// --- on-chain verification --------------------------------------------------

// One JSON-RPC call. fetchImpl is injectable so tests run without a network.
async function rpcCall(fetchImpl, rpcUrl, method, params) {
    let response;
    try {
        response = await fetchImpl(rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
        });
    } catch (err) {
        const wrapped = new Error("could not reach the payment network");
        wrapped.cause = err;
        throw wrapped;
    }
    if (!response.ok) throw new Error("could not reach the payment network");
    const body = await response.json();
    if (body.error) {
        const wrapped = new Error("the payment network rejected the query");
        wrapped.cause = new Error(body.error.message || "rpc error");
        throw wrapped;
    }
    return body.result;
}

// Find the USDC Transfer to the invoice address inside a transaction receipt.
// Returns the transferred micro-USDC as a bigint, or null when no matching
// event is present. Everything is compared case-insensitively and in full
// bytes — no prefix or checksum shortcuts.
function extractTransferValue(receipt, { contract, toAddress, topic0 }) {
    const logs = Array.isArray(receipt && receipt.logs) ? receipt.logs : [];
    const wantContract = String(contract).toLowerCase();
    const wantTopic0 = String(topic0).toLowerCase();
    const wantTo = "0x" + pad32(hexToBuffer(toAddress)).toString("hex");
    for (const log of logs) {
        if (!log || typeof log.address !== "string") continue;
        if (log.address.toLowerCase() !== wantContract) continue;
        const topics = Array.isArray(log.topics) ? log.topics : [];
        if (topics.length !== 3) continue;
        if (String(topics[0]).toLowerCase() !== wantTopic0) continue;
        if (String(topics[2]).toLowerCase() !== wantTo) continue;
        const value = hexToBuffer(log.data);
        if (!value || value.length === 0 || value.length > 32) continue;
        return BigInt("0x" + value.toString("hex"));
    }
    return null;
}

// Judge a receipt against an invoice. Returns one of:
//   verified      — the exact payment, on-chain, success, right amount
//   pending       — no receipt yet (still mining or unknown hash)
//   failed        — the transaction was mined but reverted
//   unrelated     — mined, but no USDC transfer to this invoice's address
//   wrong-amount  — the right transfer, but not the exact price
function judgeReceipt(receipt, expected) {
    if (!receipt || typeof receipt !== "object") return "pending";
    if (String(receipt.status).toLowerCase() !== "0x1") return "failed";
    const value = extractTransferValue(receipt, expected);
    if (value === null) return "unrelated";
    return value === expected.expectedMicroUsdc ? "verified" : "wrong-amount";
}

// Full verification of one transaction hash against one invoice: right chain
// first, then the receipt. Never trusts anything the client said beyond the
// hash itself.
async function verifyPayment({ fetchImpl, rpcUrl, txHash, invoice }) {
    const chainIdHex = await rpcCall(fetchImpl, rpcUrl, "eth_chainId", []);
    if (BigInt(chainIdHex) !== BigInt(CHAIN_ID)) return "wrong-chain";
    const receipt = await rpcCall(fetchImpl, rpcUrl, "eth_getTransactionReceipt", [txHash]);
    return judgeReceipt(receipt, {
        contract: USDC_CONTRACT,
        toAddress: invoice.address,
        topic0: TRANSFER_TOPIC,
        expectedMicroUsdc: BigInt(invoice.amountMicroUsdc)
    });
}

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

module.exports = {
    USDC_CONTRACT,
    CHAIN_ID,
    TRANSFER_TOPIC,
    DECIMALS,
    PLANS,
    PRICE_USDC,
    PRICE_MICRO_USDC,
    MONTH_MS,
    INVOICE_TTL_MS,
    TX_HASH_PATTERN,
    limitsFor,
    activePaidUntil,
    extendPaid,
    entitlementApplied,
    applyInvoiceEntitlement,
    ensureEntitlement,
    reconcileEntitlements,
    newReceivingAddress,
    toHex,
    hexToBuffer,
    pad32,
    amountTo32Bytes,
    Invoices,
    rpcCall,
    extractTransferValue,
    judgeReceipt,
    verifyPayment
};
