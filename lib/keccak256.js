"use strict";
// Keccak-256 — the original Keccak padding Ethereum uses (not SHA3-256, which
// pads differently). Node's crypto has no keccak, and the payment flow needs
// it for two things: deriving an Ethereum address from a fresh secp256k1 key,
// and rendering addresses in the EIP-55 checksum form. Fixed test vectors in
// test/server.test.js pin this implementation.

const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
// Rotation offsets, indexed [x][y].
const ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14]
];
const MASK = 0xffffffffffffffffn;

function rotl(v, n) {
    const b = BigInt(n);
    return ((v << b) | (v >> (64n - b))) & MASK;
}

function keccakF(lanes) {
    for (let round = 0; round < 24; round++) {
        // theta
        const c = [];
        for (let x = 0; x < 5; x++) {
            c[x] = lanes[x][0] ^ lanes[x][1] ^ lanes[x][2] ^ lanes[x][3] ^ lanes[x][4];
        }
        const d = [];
        for (let x = 0; x < 5; x++) {
            d[x] = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
        }
        for (let x = 0; x < 5; x++) {
            for (let y = 0; y < 5; y++) lanes[x][y] ^= d[x];
        }
        // rho and pi: B[y][(2x+3y) mod 5] = rotl(A[x][y], r[x][y])
        const b = [];
        for (let y = 0; y < 5; y++) b.push([0n, 0n, 0n, 0n, 0n]);
        for (let x = 0; x < 5; x++) {
            for (let y = 0; y < 5; y++) b[y][(2 * x + 3 * y) % 5] = rotl(lanes[x][y], ROT[x][y]);
        }
        // chi
        for (let x = 0; x < 5; x++) {
            for (let y = 0; y < 5; y++) {
                lanes[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]);
            }
        }
        // iota
        lanes[0][0] ^= RC[round];
    }
}

// keccak256(data) -> 32-byte Buffer.
function keccak256(data) {
    const rate = 136; // bytes; capacity 1600 - 1088
    const blocks = [];
    for (let i = 0; i < data.length; i += rate) blocks.push(data.subarray(i, i + rate));
    if (!blocks.length || blocks[blocks.length - 1].length === rate) blocks.push(null); // padding-only block

    const lanes = [];
    for (let x = 0; x < 5; x++) lanes.push([0n, 0n, 0n, 0n, 0n]);

    for (let b = 0; b < blocks.length; b++) {
        const block = blocks[b];
        const padded = Buffer.alloc(rate);
        if (block) block.copy(padded);
        if (b === blocks.length - 1) {
            // Keccak padding: 0x01 then zeros, final byte 0x80
            const at = block ? block.length : 0;
            padded[at] = 0x01;
            padded[rate - 1] |= 0x80;
        }
        for (let i = 0; i < rate / 8; i++) {
            const lane = padded.readBigUInt64LE(i * 8);
            lanes[i % 5][Math.floor(i / 5)] ^= lane; // lane i sits at (x,y) = (i%5, i/5)
        }
        keccakF(lanes);
    }

    const out = Buffer.alloc(32);
    for (let i = 0; i < 4; i++) {
        out.writeBigUInt64LE(lanes[i % 5][Math.floor(i / 5)], i * 8);
    }
    return out;
}

// EIP-55 mixed-case checksum form of a 20-byte address hex (with or without 0x).
function toChecksumAddress(hex) {
    const lower = String(hex).toLowerCase().replace(/^0x/, "");
    const hash = keccak256(Buffer.from(lower, "utf8")).toString("hex");
    let out = "0x";
    for (let i = 0; i < 40; i++) {
        const nibble = parseInt(hash[i], 16);
        out += nibble >= 8 ? lower[i].toUpperCase() : lower[i];
    }
    return out;
}

module.exports = { keccak256, toChecksumAddress };
