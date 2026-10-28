"use strict";
// Measure the duration of a webm/matroska file from its actual media
// timeline: the Cluster timestamps plus the block timecodes inside them,
// finished with the last frame's length.
//
// The Info.Duration element is deliberately ignored: it is a plain float
// sitting in the file, the uploading client can write anything into it — a
// five-minute video claiming to be one second long passes every check that
// reads only Duration. Block timecodes are part of the interleaved media
// data; faking them means remuxing the whole file.
//
// The last frame's length comes from what the file itself asserts, in
// whatever form it uses:
//   - an explicit BlockDuration on a BlockGroup (honoured verbatim, however
//     long — never discarded or capped, which would shorten the report),
//   - the track's DefaultDuration (Tracks > TrackEntry > DefaultDuration),
//     which also covers laced blocks: a lace of N frames is measured as
//     N default frame lengths,
//   - otherwise, for the latest block only, the gap to the block before it
//     — the observed frame pacing, the same evidence a player uses to pace
//     frames when no duration is asserted. Real MediaRecorder output
//     asserts no per-frame durations at all, so this fallback is what keeps
//     genuine recordings verifiable.
// A block at timestamp zero with a ten-minute BlockDuration, or a track
// whose DefaultDuration is ten minutes, is therefore reported as ten
// minutes — the cap rejects it, instead of the file sliding under it.
//
// This is a narrow EBML walker, not a general parser. It streams: the server
// feeds it the file chunk by chunk, so a 100 MB recording never sits in
// memory. Verification fails closed — the walker returns null, never a
// partial timeline — whenever the complete media timeline cannot be
// established:
//   - the walk stops on malformed or unsupported input,
//   - the file ends inside an element or a known-size context (truncated),
//   - an element claims to extend past the boundary of any bounded context
//     it sits in, however far up the stack that boundary lives — and a
//     bounded ancestor, once reached, ends every unknown-size child above
//     it (invalid container structure),
//   - Tracks or Info appear after a cluster: metadata that shapes the
//     timeline must be known before blocks are measured, not after,
//   - a track carries TrackTimestampScale, a playback-timing feature the
//     scanner does not verify,
//   - an element the scanner has no ending rule for (Info, Tracks,
//     TrackEntry, BlockGroup) claims an unknown size,
//   - a block's declared body cannot hold the block's own header (timecode,
//     flags, lace count), however much of it is already buffered,
//   - a laced block names a track that asserts no frame duration,
//   - the file carries no block timecodes at all.

const fs = require("node:fs");

const EBML_HEADER_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const INFO_ID = 0x1549a966;
const TIMESTAMP_SCALE_ID = 0x2ad7b1;
const TRACKS_ID = 0x1654ae6b;
const TRACK_ENTRY_ID = 0xae;
const TRACK_NUMBER_ID = 0xd7;
const DEFAULT_DURATION_ID = 0x23e383;
const TRACK_TIMESTAMP_SCALE_ID = 0x23314f;
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
    CLUSTER_ID, INFO_ID, TRACKS_ID,
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

// Reads a big-endian unsigned integer of `size` bytes at `offset` when the
// bytes are in the buffer, else null. Full-width (8-byte) values lose
// precision past 2^53 — irrelevant here: only their magnitude matters, and
// the cap decides long before decades of nanoseconds do.
function readUint(buf, offset, size) {
    if (size < 1 || size > 8 || offset + size > buf.length) return null;
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + buf[offset + i];
    return value;
}

// Records one block's media timestamp and, when the file asserts a frame
// duration for it, the block's end time. layout: track-number vint, a
// signed 16-bit timecode (scaled by TimestampScale), a flags byte whose
// bits 1–2 name the lacing, and — for a laced block — the lace frame
// count. Returns the number of body bytes consumed, or null when the bytes
// are not in the buffer yet (the caller waits for more).
// bodyEndRel: how far the block body reaches, relative to the buffer start.
// Every header field is checked against that declared end first, whether or
// not the bytes happen to be buffered: a block whose body cannot hold its
// own header is malformed even when the following element's bytes sit right
// there — they are not the header, and reading them as it would let a short
// block consume structure that belongs to the element after it.
function readBlockHeader(buf, offset, bodyEndRel, clusterTimeTicks, scale, scanner) {
    const track = readVint(buf, offset, false);
    if (track === null || track.unknown) { scanner.fail(); return null; }
    if (track.needMore) return null; // the header may straddle chunks
    if (offset + track.length > bodyEndRel) { scanner.fail(); return null; }
    const timecodeAt = offset + track.length;
    if (timecodeAt + 2 > bodyEndRel) { scanner.fail(); return null; }
    if (timecodeAt + 2 > buf.length) return null; // the body carries them: wait
    const flagsAt = timecodeAt + 2;
    if (flagsAt + 1 > bodyEndRel) { scanner.fail(); return null; }
    if (flagsAt + 1 > buf.length) return null;
    const rel = buf.readInt16BE(timecodeAt);
    const laceKind = (buf[flagsAt] >> 1) & 3;
    const defaultNs = scanner.trackDefaultsNs.get(track.value) ?? null;
    let assertedEndNs = null;
    if (laceKind !== 0) {
        // a lace of N frames plays for N frame lengths, which only the
        // track's DefaultDuration can assert; without one the block's real
        // length is unknowable, so the file is refused
        const countAt = flagsAt + 1;
        if (countAt + 1 > bodyEndRel) { scanner.fail(); return null; }
        if (countAt + 1 > buf.length) return null;
        const frames = buf[countAt] + 1;
        if (!defaultNs || defaultNs <= 0) {
            scanner.fail(); // laced block with no assertable frame duration
            return null;
        }
        assertedEndNs = frames * defaultNs;
    } else if (defaultNs !== null && defaultNs > 0) {
        // a plain block lasts one DefaultDuration, when the track says so
        assertedEndNs = defaultNs;
    }
    scanner.sawBlocks = true;
    const absNs = (clusterTimeTicks + rel) * scale;
    if (scanner.maxAbsNs === null || absNs > scanner.maxAbsNs) {
        scanner.maxAbsNs = absNs;
        scanner.maxAbsAssertedNs = assertedEndNs;
    } else if (absNs === scanner.maxAbsNs && assertedEndNs !== null &&
               scanner.maxAbsAssertedNs === null) {
        scanner.maxAbsAssertedNs = assertedEndNs;
    }
    if (assertedEndNs !== null) {
        const end = absNs + assertedEndNs;
        if (scanner.maxEndNs === null || end > scanner.maxEndNs) scanner.maxEndNs = end;
    }
    if (scanner.lastAbsNs !== null && absNs > scanner.lastAbsNs) {
        scanner.lastGapNs = absNs - scanner.lastAbsNs;
    }
    scanner.lastAbsNs = absNs;
    // consumed: track vint + 2-byte timecode + flags byte + (lace count byte)
    return (flagsAt + 1 + (laceKind !== 0 ? 1 : 0)) - offset;
}

// A scanner over a stream of chunks. push(chunk) feeds it; end() finishes
// and returns the duration in milliseconds, or null when the complete media
// timeline could not be established from the file — never a partial one.
class WebmDurationScanner {
    constructor() {
        this.buf = Buffer.alloc(0);
        this.pos = 0; // absolute stream offset of this.buf's first byte
        this.stack = [{ type: "root", end: null }];
        this.scale = 1000000; // nanoseconds per tick; the EBML default
        this.skip = 0; // bytes of a known-size element left to discard
        this.stopped = false; // malformed or unsupported: the walk gives up
        this.eof = false; // set by end(): no more bytes will ever come
        this.truncated = false; // the input ended inside an element
        this.sawCluster = false; // a cluster has been entered: timeline metadata is too late now
        // duration state
        this.trackDefaultsNs = new Map(); // track number -> default ns/frame
        this.maxAbsNs = null; // the latest block timestamp seen
        this.maxAbsAssertedNs = null; // that same block's asserted length
        this.maxEndNs = null; // the latest asserted end over all blocks
        this.lastAbsNs = null;
        this.lastGapNs = null;
        this.sawBlocks = false;
    }

    push(chunk) {
        if (this.stopped || !chunk || !chunk.length) return;
        this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
        this.drain();
    }

    fail() {
        this.stopped = true;
    }

    // A wait for bytes that never arrive is truncation, not patience.
    waitMore() {
        if (this.eof) this.truncated = true;
    }

    end() {
        this.eof = true;
        if (!this.stopped) this.drain();
        if (this.stopped || this.truncated) return null;
        if (this.skip > 0) return null; // a known-size element cut short
        // a known-size context that never reached its declared end
        for (const ctx of this.stack) {
            if (ctx.end !== null && this.pos < ctx.end) return null;
        }
        if (this.maxAbsNs === null) return null; // nothing verifiable: fail closed
        // duration = the end of the timeline the file asserts, or — when the
        // latest block asserts nothing — its start plus the observed gap to
        // the block before it. An asserted duration is never discarded.
        const assertedEnd = this.maxEndNs;
        const fallbackEnd = this.maxAbsNs +
            (this.maxAbsAssertedNs !== null ? this.maxAbsAssertedNs : (this.lastGapNs ?? 0));
        const endNs = Math.max(assertedEnd ?? -Infinity, fallbackEnd);
        if (!Number.isFinite(endNs)) return null;
        return Math.round(endNs / 1e6);
    }

    consume(n) {
        this.pos += n;
        this.buf = n >= this.buf.length ? Buffer.alloc(0) : this.buf.subarray(n);
    }

    // When a bounded context runs out, remember what its children said.
    onExitContext(ctx) {
        if (ctx.type === "trackentry") {
            if (ctx.trackNumber !== null && ctx.defaultNs !== null && ctx.defaultNs > 0) {
                const known = this.trackDefaultsNs.get(ctx.trackNumber);
                if (known === undefined || ctx.defaultNs > known) {
                    this.trackDefaultsNs.set(ctx.trackNumber, ctx.defaultNs);
                }
            }
            return;
        }
        if (ctx.type === "blockgroup" && ctx.blockDurationNs !== null &&
            ctx.blockAbsNs !== null) {
            // an explicit BlockDuration counts in full, however long
            const end = ctx.blockAbsNs + ctx.blockDurationNs;
            if (this.maxEndNs === null || end > this.maxEndNs) this.maxEndNs = end;
            if (ctx.blockAbsNs === this.maxAbsNs &&
                (this.maxAbsAssertedNs === null || ctx.blockDurationNs > this.maxAbsAssertedNs)) {
                this.maxAbsAssertedNs = ctx.blockDurationNs;
            }
        }
    }

    drain() {
        for (;;) {
            if (this.stopped) return;

            if (this.skip > 0) {
                const n = Math.min(this.skip, this.buf.length);
                this.consume(n);
                this.skip -= n;
                if (this.skip > 0) { this.waitMore(); return; } // need more bytes to discard
            }

            // bounded contexts that ran out pop themselves — and so do
            // unknown-size contexts sitting on top of one: the ancestor's
            // boundary bounds everything inside it, so when that boundary is
            // reached, an unknown-size child (a live-written cluster, say)
            // is over, no matter that it never declared a size
            for (;;) {
                const top = this.stack[this.stack.length - 1];
                if (!top) break;
                if (top.end !== null && this.pos >= top.end) {
                    this.onExitContext(top);
                    this.stack.pop();
                    continue;
                }
                if (top.end === null) {
                    let boundedEnd = null;
                    for (let i = this.stack.length - 2; i >= 0; i--) {
                        if (this.stack[i].end !== null) { boundedEnd = this.stack[i].end; break; }
                    }
                    if (boundedEnd !== null && this.pos >= boundedEnd) {
                        this.onExitContext(top);
                        this.stack.pop();
                        continue;
                    }
                }
                break;
            }
            if (this.stack.length === 0 || this.buf.length === 0) return;

            const id = readVint(this.buf, 0, true);
            if (id === null) { this.fail(); return; } // malformed: refuse the file
            if (id.needMore) { this.waitMore(); return; }
            const size = readVint(this.buf, id.length, false);
            if (size === null) { this.fail(); return; }
            if (size.needMore) { this.waitMore(); return; }
            const headerLen = id.length + size.length;
            const bodyEnd = size.unknown ? null : this.pos + headerLen + size.value;
            const ctx = this.stack[this.stack.length - 1];
            const kind = id.value;

            // an element must fit inside every bounded context it opens in —
            // not just the nearest one: an unknown-size child still lives
            // inside its bounded ancestors, and an element that runs past
            // any of them is invalid container structure
            if (bodyEnd !== null) {
                for (const c of this.stack) {
                    if (c.end !== null && bodyEnd > c.end) {
                        this.fail(); // invalid container boundary: refuse the file
                        return;
                    }
                }
            }

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
                this.fail(); // not a webm we can read
                return;
            }

            if (ctx.type === "segment") {
                // Timeline metadata must come before the blocks it describes.
                // Tracks and TimestampScale take effect the moment a block is
                // measured, so a Tracks (a late DefaultDuration) or an Info
                // (a late TimestampScale) met after a cluster would be
                // measured before it was known — the timeline read so far
                // would stand while playback follows the new metadata, and
                // the two can disagree. Refuse the ordering instead of
                // guessing what the player will do.
                if ((kind === INFO_ID || kind === TRACKS_ID) && this.sawCluster) {
                    this.fail(); // metadata after blocks: refuse the file
                    return;
                }
                if (kind === INFO_ID) {
                    if (size.unknown) { this.fail(); return; } // no rule ends it
                    this.consume(headerLen);
                    this.stack.push({ type: "info", end: bodyEnd });
                    continue;
                }
                if (kind === TRACKS_ID) {
                    if (size.unknown) { this.fail(); return; } // no rule ends it
                    this.consume(headerLen);
                    this.stack.push({ type: "tracks", end: bodyEnd });
                    continue;
                }
                if (kind === CLUSTER_ID) {
                    this.consume(headerLen);
                    this.stack.push({ type: "cluster", end: bodyEnd, timeTicks: null });
                    this.sawCluster = true;
                    continue;
                }
                if (!size.unknown) {
                    this.skip = size.value;
                    this.consume(headerLen);
                    continue;
                }
                this.fail();
                return;
            }

            if (ctx.type === "info") {
                // Duration is read by nobody here: it is client-writable text.
                if (kind === TIMESTAMP_SCALE_ID && !size.unknown && size.value >= 1 && size.value <= 8) {
                    if (this.buf.length < headerLen + size.value) { this.waitMore(); return; }
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
                this.fail();
                return;
            }

            if (ctx.type === "tracks") {
                if (kind === TRACK_ENTRY_ID) {
                    if (size.unknown) { this.fail(); return; } // no rule ends it
                    this.consume(headerLen);
                    this.stack.push({ type: "trackentry", end: bodyEnd, trackNumber: null, defaultNs: null });
                    continue;
                }
                if (!size.unknown) {
                    this.skip = size.value;
                    this.consume(headerLen);
                    continue;
                }
                this.fail();
                return;
            }

            if (ctx.type === "trackentry") {
                // TrackTimestampScale changes how the track's own blocks map
                // onto the segment timeline — supported playback can run at
                // a different speed than the one measured here. The scanner
                // does not verify that clock, so a track carrying one is
                // refused rather than measured with the wrong timeline.
                if (kind === TRACK_TIMESTAMP_SCALE_ID) { this.fail(); return; }
                if (kind === TRACK_NUMBER_ID && !size.unknown && size.value >= 1 && size.value <= 8) {
                    if (this.buf.length < headerLen + size.value) { this.waitMore(); return; }
                    const value = readUint(this.buf, headerLen, size.value);
                    if (value === null) { this.fail(); return; }
                    ctx.trackNumber = value;
                    this.consume(headerLen + size.value);
                    continue;
                }
                if (kind === DEFAULT_DURATION_ID && !size.unknown && size.value >= 1 && size.value <= 8) {
                    if (this.buf.length < headerLen + size.value) { this.waitMore(); return; }
                    const value = readUint(this.buf, headerLen, size.value);
                    if (value === null) { this.fail(); return; }
                    ctx.defaultNs = value;
                    this.consume(headerLen + size.value);
                    continue;
                }
                if (!size.unknown) {
                    this.skip = size.value;
                    this.consume(headerLen);
                    continue;
                }
                this.fail();
                return;
            }

            if (ctx.type === "cluster") {
                // an unknown-size cluster ends where a segment sibling begins
                if (ctx.end === null && kind !== CLUSTER_TIMESTAMP_ID && SEGMENT_SIBLINGS.has(kind)) {
                    this.stack.pop();
                    continue; // re-read the same element at segment level
                }
                if (kind === CLUSTER_TIMESTAMP_ID && !size.unknown && size.value >= 1 && size.value <= 8) {
                    if (this.buf.length < headerLen + size.value) { this.waitMore(); return; }
                    let value = 0;
                    for (let i = 0; i < size.value; i++) value = value * 256 + this.buf[headerLen + i];
                    ctx.timeTicks = value;
                    this.consume(headerLen + size.value);
                    continue;
                }
                if ((kind === SIMPLE_BLOCK_ID || kind === BLOCK_ID) && !size.unknown) {
                    const cluster = ctx;
                    const used = readBlockHeader(
                        this.buf, headerLen,
                        headerLen + size.value, // where this block's body ends, buffer-relative
                        cluster.timeTicks ?? 0, this.scale, this
                    );
                    if (used === null) {
                        if (this.stopped) return;
                        this.waitMore(); // need the block header bytes first
                        return;
                    }
                    // the parsed prefix stays in the body: discard all of it
                    this.skip = size.value;
                    this.consume(headerLen);
                    continue;
                }
                if (kind === BLOCK_GROUP_ID) {
                    if (size.unknown) { this.fail(); return; } // no rule ends it
                    this.consume(headerLen);
                    this.stack.push({ type: "blockgroup", end: bodyEnd, blockAbsNs: null, blockDurationNs: null });
                    continue;
                }
                if (!size.unknown) {
                    this.skip = size.value;
                    this.consume(headerLen);
                    continue;
                }
                this.fail();
                return;
            }

            if (ctx.type === "blockgroup") {
                const cluster = this.stack[this.stack.length - 2];
                if ((kind === BLOCK_ID || kind === SIMPLE_BLOCK_ID) && !size.unknown) {
                    const used = readBlockHeader(
                        this.buf, headerLen,
                        headerLen + size.value,
                        (cluster && cluster.timeTicks) ?? 0, this.scale, this
                    );
                    if (used === null) {
                        if (this.stopped) return;
                        this.waitMore();
                        return;
                    }
                    ctx.blockAbsNs = this.lastAbsNs;
                    this.skip = size.value; // the parsed prefix stays in the body
                    this.consume(headerLen);
                    continue;
                }
                if (kind === BLOCK_DURATION_ID && !size.unknown && size.value >= 1 && size.value <= 8) {
                    if (this.buf.length < headerLen + size.value) { this.waitMore(); return; }
                    const value = readUint(this.buf, headerLen, size.value);
                    if (value === null) { this.fail(); return; }
                    ctx.blockDurationNs = value * this.scale;
                    this.consume(headerLen + size.value);
                    continue;
                }
                if (!size.unknown) {
                    this.skip = size.value;
                    this.consume(headerLen);
                    continue;
                }
                this.fail();
                return;
            }

            this.fail(); // unknown context: do not guess
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
// milliseconds, or null when the file's complete media timeline could not
// be established — the caller must refuse the file.
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
