"use strict";
// Read the duration out of a webm/matroska file. MediaRecorder leaves the
// Duration element out of live recordings, but the recorder page patches it
// in before upload; when it is there we can verify the free-plan duration
// cap server-side instead of trusting a header the client could omit.
//
// This is a narrow EBML walker, not a general parser: EBML header, Segment
// (possibly of unknown size, as live recordings are), then the first Info
// child, reading Duration and TimestampScale from it. Anything unexpected
// returns null and the caller falls back to the declared duration.

const SEGMENT_ID = 0x18538067;
const INFO_ID = 0x1549a966;
const DURATION_ID = 0x4489;
const TIMESTAMP_SCALE_ID = 0x2ad7b1;

// Returns {value, length} for a vint. ids keep the marker bit set.
function readVint(buf, offset, keepMarker) {
    if (offset >= buf.length) return null;
    const first = buf[offset];
    if (first === 0) return null; // the standard forbids a padded id vint
    let length = 1;
    let mask = 0x80;
    while (!(first & mask)) {
        mask >>= 1;
        length++;
        if (length > 8) return null;
    }
    if (offset + length > buf.length) return null;
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

function readFloat(buf, offset, size) {
    if (size === 4) return buf.readFloatBE(offset);
    if (size === 8) return buf.readDoubleBE(offset);
    return null;
}

// Iterates the children of a master element from start to end; callback gets
// (id, bodyStart, bodySize) and returning true stops the walk. Children with
// an unknown size cannot be skipped, so the walk gives up on them.
function forEachChild(buf, start, end, callback) {
    let pos = start;
    while (pos < end) {
        const id = readVint(buf, pos, true);
        if (!id) return false;
        const size = readVint(buf, pos + id.length, false);
        if (!size) return false;
        const bodyStart = pos + id.length + size.length;
        if (size.unknown) {
            // treat an unknown-size child as running to the end of its parent
            if (callback(id.value, bodyStart, end - bodyStart)) return true;
            return false;
        }
        if (bodyStart + size.value > end) return false;
        if (callback(id.value, bodyStart, size.value)) return true;
        pos = bodyStart + size.value;
    }
    return false;
}

// Returns the duration in milliseconds, or null when it cannot be read.
function readWebmDurationMs(buf) {
    let pos = 0;
    // the EBML header element comes first; skip it
    const headerId = readVint(buf, pos, true);
    if (!headerId) return null;
    const headerSize = readVint(buf, pos + headerId.length, false);
    if (!headerSize || headerSize.unknown) return null;
    pos += headerId.length + headerSize.length + headerSize.value;

    // find the Segment
    let segment = null;
    {
        const id = readVint(buf, pos, true);
        if (!id || id.value !== SEGMENT_ID) return null;
        const size = readVint(buf, pos + id.length, false);
        if (!size) return null;
        segment = { start: pos + id.length + size.length, size: size.unknown ? null : size.value };
    }
    const segmentEnd = segment.size === null ? buf.length : segment.start + segment.size;

    // the first Info child holds Duration
    let info = null;
    forEachChild(buf, segment.start, segmentEnd, (id, bodyStart, bodySize) => {
        if (id === INFO_ID) {
            info = { start: bodyStart, end: bodyStart + bodySize };
            return true;
        }
        return false;
    });
    if (!info) return null;

    // TimestampScale is nanoseconds per tick; the default is 1e6 (1 ms)
    let scale = 1000000;
    forEachChild(buf, info.start, info.end, (id, bodyStart, bodySize) => {
        if (id === TIMESTAMP_SCALE_ID && bodySize > 0 && bodySize <= 8) {
            let value = 0;
            for (let i = 0; i < bodySize; i++) value = value * 256 + buf[bodyStart + i];
            if (value > 0) scale = value;
            return true;
        }
        if (id === DURATION_ID) {
            return false; // keep looking: TimestampScale may come after Duration
        }
        return false;
    });

    let duration = null;
    forEachChild(buf, info.start, info.end, (id, bodyStart, bodySize) => {
        if (id === DURATION_ID) {
            const value = readFloat(buf, bodyStart, bodySize);
            if (value !== null && Number.isFinite(value) && value >= 0) {
                duration = (value * scale) / 1e6; // ticks * ns-per-tick -> ms
                return true;
            }
        }
        return false;
    });
    if (duration === null) return null;
    return Math.round(duration);
}

module.exports = { readWebmDurationMs };
