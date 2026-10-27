"use strict";
// Measure the duration of a webm/matroska file from its actual media
// timeline: the Cluster timestamps plus the block timecodes inside them,
// finished with the last frame's length (its BlockDuration when the file
// gives one, otherwise the gap to the previous block).
//
// The Info.Duration element is deliberately ignored: it is a plain float
// sitting in the file, the uploading client can write anything into it — a
// five-minute video claiming to be one second long passes every check that
// reads only Duration. Block timecodes are part of the interleaved media
// data; faking them means remuxing the whole file.
//
// This is a narrow EBML walker, not a general parser. It streams: the server
// feeds it the file chunk by chunk, so a 100 MB recording never sits in
// memory. Anything it cannot make sense of stops the walk and reports the
// timeline seen so far; a file from which no timeline can be read at all
// yields null, and the caller must fail closed on that.

const fs = require("node:fs");

const EBML_HEADER_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const INFO_ID = 0x1549a966;
const TIMESTAMP_SCALE_ID = 0x2ad7b1;
const CLUSTER_ID = 0x1f43b675;
const CLUSTER_TIMESTAMP_ID = 0xe7;
const SIMPLE_BLOCK_ID = 0xa3;
const BLOCK_ID = 0xa1;
const BLOCK_GROUP_ID = 0xa0;
const BLOCK_DURATION_ID = 0x9b;

// Segment-level siblings. Meeting one while inside an unknown-size Cluster
// (how live recordings are written) means that cluster is over. Cluster
// children all have short ids, so no collision is possible.
const SEGMENT_SIBLINGS = new Set([
    CLUSTER_ID, INFO_ID,
    0x114d9b74, // SeekHead
    0x1c53bb6b, // Cues
    0x1941a069, // Attachments
    0x1043a770, // Chapters
    0x1254c36f  // Tags
]);

// Returns {value, length, unknown} for a vint, {needMore: true} when the
// bytes are not in the buffer yet, or null when malformed. ids keep the
// marker bit set.
function readVint(buf, offset, keepMarker) {
    if (offset >= buf.length) return { needMore: true };
    const first = buf[offset];
    if (first === 0) return null; // the standard forbids a padded id vint
    let length = 1;
    let mask = 0x80;
    while (!(first & mask)) {
        mask >>= 1;
        length++;
        if (length > 8) return null;
    }
    if (offset + length > buf.length) return { needMore: true };
    // an "unknown" size vint has every data bit set to 1
    const dataMask = 0xff >> Math.min(length, 8);
    let value = keepMarker ? first : first & dataMask;
    let allOnes = !keepMarker && (first & dataMask) === dataMask;
    for (let i = 1; i < length; i++) {
        const byte = buf[offset + i];
        if (byte !== 0xff) allOnes = false;
        value = value * 256 + byte;
    }
    return { value, length, unknown: allOnes };
}

// Records one block's media timestamp. layout: track-number vint, then a
// signed 16-bit timecode (scaled by TimestampScale). Returns the number of
// body bytes consumed, or null when the bytes are not in the buffer yet.
function readBlockTimecode(buf, offset, clusterTimeTicks, scale, scanner) {
    const track = readVint(buf, offset, false);
    if (!track || track.needMore || track.unknown) return null;
    const timecodeAt = offset + track.length;
    if (timecodeAt + 2 > buf.length) return null;
    const rel = buf.readInt16BE(timecodeAt);
    scanner.sawBlocks = true;
    const absNs = (clusterTimeTicks + rel) * scale;
    if (scanner.maxAbsNs === null || absNs > scanner.maxAbsNs) scanner.maxAbsNs = absNs;
    if (scanner.lastAbsNs !== null && absNs > scanner.lastAbsNs) {
        scanner.lastGapNs = absNs - scanner.lastAbsNs;
    }
    scanner.lastAbsNs = absNs;
    return track.length + 2;
}

// A scanner over a stream of chunks. push(chunk) feeds it; end() finishes
// and returns the duration in milliseconds, or null when no media timeline
// could be read from the file at all.
class WebmDurationScanner {
    constructor() {
        this.buf = Buffer.alloc(0);
        this.pos = 0; // absolute stream offset of this.buf's first byte
        this.stack = [{ type: "root", end: null }];
        this.scale = 1000000; // nanoseconds per tick; the EBML default
        this.skip = 0; // bytes of a known-size element left to discard
        this.stopped = false;
        // timeline state
        this.maxAbsNs = null;
        this.lastAbsNs = null;
        this.lastGapNs = null;
        this.lastBlockDurationNs = null;
        this.sawBlocks = false;
    }

    push(chunk) {
        if (this.stopped || !chunk || !chunk.length) return;
        this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
        this.drain();
    }

    end() {
        if (!this.stopped) this.drain();
        if (this.maxAbsNs === null) return null; // nothing verifiable: fail closed
        // duration = the last frame's start plus its length. The frame length
        // comes from a BlockDuration when one was attached to the final
        // block, else from the gap to the block before it, capped so that a
        // single odd gap cannot inflate the estimate.
        let frameNs = this.lastBlockDurationNs;
        if (frameNs === null || frameNs <= 0) frameNs = this.lastGapNs;
        if (frameNs === null || frameNs < 0 || frameNs > 2e9) frameNs = 0; // cap: 2 s
        return Math.round((this.maxAbsNs + frameNs) / 1e6);
    }

    consume(n) {
        this.pos += n;
        this.buf = n >= this.buf.length ? Buffer.alloc(0) : this.buf.subarray(n);
    }

    // When a bounded context runs out, remember what its children said.
    onExitContext(ctx) {
        if (ctx.type === "blockgroup" && ctx.blockDurationNs !== null &&
            ctx.blockAbsNs !== null && ctx.blockAbsNs === this.lastAbsNs) {
            this.lastBlockDurationNs = ctx.blockDurationNs;
        }
    }

    drain() {
        for (;;) {
            if (this.stopped) return;

            if (this.skip > 0) {
                const n = Math.min(this.skip, this.buf.length);
                this.consume(n);
                this.skip -= n;
                if (this.skip > 0) return; // need more bytes to discard
            }

            // bounded contexts that ran out pop themselves
            for (;;) {
                const top = this.stack[this.stack.length - 1];
                if (top && top.end !== null && this.pos >= top.end) {
                    this.onExitContext(top);
                    this.stack.pop();
                } else break;
            }
            if (this.stack.length === 0 || this.buf.length === 0) return;

            const id = readVint(this.buf, 0, true);
            if (id === null) { this.stopped = true; return; } // malformed: keep the timeline so far
            if (id.needMore) return;
            const size = readVint(this.buf, id.length, false);
            if (size === null) { this.stopped = true; return; }
            if (size.needMore) return;
            const headerLen = id.length + size.length;
            const bodyEnd = size.unknown ? null : this.pos + headerLen + size.value;
            const ctx = this.stack[this.stack.length - 1];
            const kind = id.value;

            if (ctx.type === "root") {
                if (kind === EBML_HEADER_ID && !size.unknown) {
                    this.skip = size.value;
                    this.consume(headerLen);
                    continue;
                }
                if (kind === SEGMENT_ID) {
                    this.consume(headerLen);
                    this.stack.push({ type: "segment", end: bodyEnd });
                    continue;
                }
                this.stopped = true; // not a webm we can read
                return;
            }

            if (ctx.type === "segment") {
                if (kind === INFO_ID) {
                    this.consume(headerLen);
                    this.stack.push({ type: "info", end: bodyEnd });
                    continue;
                }
                if (kind === CLUSTER_ID) {
                    this.consume(headerLen);
                    this.stack.push({ type: "cluster", end: bodyEnd, timeTicks: null });
                    continue;
                }
                if (!size.unknown) {
                    this.skip = size.value;
                    this.consume(headerLen);
                    continue;
                }
                this.stopped = true;
                return;
            }

            if (ctx.type === "info") {
                // Duration is read by nobody here: it is client-writable text.
                if (kind === TIMESTAMP_SCALE_ID && !size.unknown && size.value >= 1 && size.value <= 8) {
                    if (this.buf.length < headerLen + size.value) return; // wait for the body
                    let value = 0;
                    for (let i = 0; i < size.value; i++) value = value * 256 + this.buf[headerLen + i];
                    if (value > 0) this.scale = value;
                    this.consume(headerLen + size.value);
                    continue;
                }
                if (!size.unknown) {
                    this.skip = size.value;
                    this.consume(headerLen);
                    continue;
                }
                this.stopped = true;
                return;
            }

            if (ctx.type === "cluster") {
                // an unknown-size cluster ends where a segment sibling begins
                if (ctx.end === null && kind !== CLUSTER_TIMESTAMP_ID && SEGMENT_SIBLINGS.has(kind)) {
                    this.stack.pop();
                    continue; // re-read the same element at segment level
                }
                if (kind === CLUSTER_TIMESTAMP_ID && !size.unknown && size.value >= 1 && size.value <= 8) {
                    if (this.buf.length < headerLen + size.value) return; // wait for the body
                    let value = 0;
                    for (let i = 0; i < size.value; i++) value = value * 256 + this.buf[headerLen + i];
                    ctx.timeTicks = value;
                    this.consume(headerLen + size.value);
                    continue;
                }
                if ((kind === SIMPLE_BLOCK_ID || kind === BLOCK_ID) && !size.unknown) {
                    const cluster = ctx;
                    const used = readBlockTimecode(
                        this.buf, headerLen,
                        cluster.timeTicks ?? 0, this.scale, this
                    );
                    if (used === null) return; // need the block header bytes first
                    // the parsed prefix stays in the body: discard all of it
                    this.skip = size.value;
                    this.consume(headerLen);
                    continue;
                }
                if (kind === BLOCK_GROUP_ID) {
                    this.consume(headerLen);
                    this.stack.push({ type: "blockgroup", end: bodyEnd, blockAbsNs: null, blockDurationNs: null });
                    continue;
                }
                if (!size.unknown) {
                    this.skip = size.value;
                    this.consume(headerLen);
                    continue;
                }
                this.stopped = true;
                return;
            }

            if (ctx.type === "blockgroup") {
                const cluster = this.stack[this.stack.length - 2];
                if ((kind === BLOCK_ID || kind === SIMPLE_BLOCK_ID) && !size.unknown) {
                    const used = readBlockTimecode(
                        this.buf, headerLen,
                        (cluster && cluster.timeTicks) ?? 0, this.scale, this
                    );
                    if (used === null) return;
                    ctx.blockAbsNs = this.lastAbsNs;
                    this.skip = size.value; // the parsed prefix stays in the body
                    this.consume(headerLen);
                    continue;
                }
                if (kind === BLOCK_DURATION_ID && !size.unknown && size.value >= 1 && size.value <= 8) {
                    if (this.buf.length < headerLen + size.value) return; // wait for the body
                    let value = 0;
                    for (let i = 0; i < size.value; i++) value = value * 256 + this.buf[headerLen + i];
                    ctx.blockDurationNs = value * this.scale;
                    this.consume(headerLen + size.value);
                    continue;
                }
                if (!size.unknown) {
                    this.skip = size.value;
                    this.consume(headerLen);
                    continue;
                }
                this.stopped = true;
                return;
            }

            this.stopped = true; // unknown context: do not guess
            return;
        }
    }
}

// Convenience wrapper for in-memory buffers (tests, small files).
function readWebmDurationMs(buf) {
    const scanner = new WebmDurationScanner();
    scanner.push(buf);
    return scanner.end();
}

// Streams a file from disk through the scanner. Returns the duration in
// milliseconds, or null when the file carries no readable media timeline.
function scanWebmDurationFile(filePath) {
    return new Promise((resolve, reject) => {
        const scanner = new WebmDurationScanner();
        const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
        stream.on("data", (chunk) => scanner.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => {
            try {
                resolve(scanner.end());
            } catch (err) {
                reject(err);
            }
        });
    });
}

module.exports = { WebmDurationScanner, readWebmDurationMs, scanWebmDurationFile };
