"use strict";
// A small ustar (tar) writer so a creator can export everything as one
// archive without pulling in a dependency. Entries stream from disk; nothing
// large is ever held in memory.

const fs = require("node:fs");
const { Readable, PassThrough } = require("node:stream");
const path = require("node:path");

const BLOCK = 512;

function octal(value, length) {
    // size/mtime fields: zero-padded octal, NUL-terminated
    const text = Math.max(0, Math.round(value)).toString(8);
    return text.padStart(length - 1, "0") + "\0";
}

function stringField(value, length) {
    return Buffer.from(value.slice(0, length), "utf8");
}

// Builds one 512-byte ustar header. Names longer than 100 bytes are split
// with the prefix field (up to 155 + 100 more).
function headerFor(name, size, mtime, typeflag) {
    const header = Buffer.alloc(BLOCK, 0);
    let prefix = "";
    let entryName = name;
    if (Buffer.byteLength(name, "utf8") > 100) {
        const split = name.lastIndexOf("/", 100);
        if (split === -1 || Buffer.byteLength(name.slice(0, split), "utf8") > 155) {
            throw new Error(`tar entry name too long: ${name}`);
        }
        prefix = name.slice(0, split);
        entryName = name.slice(split + 1);
    }
    stringField(entryName, 100).copy(header, 0);
    header.write(octal(0o644, 8), 100, "ascii"); // mode
    header.write(octal(0, 8), 108, "ascii"); // uid
    header.write(octal(0, 8), 116, "ascii"); // gid
    header.write(octal(size, 12), 124, "ascii");
    header.write(octal(mtime, 12), 136, "ascii");
    header.write("        ", 148, "ascii"); // checksum placeholder: 8 spaces
    header.write(typeflag, 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    stringField(prefix, 155).copy(header, 345);

    let sum = 0;
    for (const byte of header) sum += byte;
    const checksum = sum.toString(8).padStart(6, "0") + "\0 ";
    header.write(checksum, 148, "ascii");
    return header;
}

// entries: [{ name, size, mtime?, filePath | file }] — every entry is a
// regular file, given either as a Buffer or as a path streamed from disk.
// Returns a Readable of the whole archive, ending with the two zero blocks.
function createTar(entries) {
    const out = new PassThrough();
    (async () => {
        for (const entry of entries) {
            out.write(headerFor(entry.name, entry.size, entry.mtime ?? Math.floor(Date.now() / 1000), "0"));
            if (Buffer.isBuffer(entry.file)) {
                out.write(entry.file);
            } else {
                await new Promise((resolve, reject) => {
                    const file = fs.createReadStream(entry.filePath);
                    file.on("error", reject);
                    file.on("data", (chunk) => {
                        if (!out.write(chunk)) {
                            file.pause();
                            out.once("drain", () => file.resume());
                        }
                    });
                    file.on("end", resolve);
                });
            }
            const padding = (BLOCK - (entry.size % BLOCK)) % BLOCK;
            if (padding) out.write(Buffer.alloc(padding));
        }
        out.write(Buffer.alloc(BLOCK * 2));
        out.end();
    })().catch((err) => out.destroy(err));
    return out;
}

// Reads a ustar archive back (used by tests and the restore tool): yields
// { name, content } for each entry, in order.
async function* readTar(buffer) {
    let pos = 0;
    while (pos + BLOCK <= buffer.length) {
        const header = buffer.subarray(pos, pos + BLOCK);
        if (header.every((b) => b === 0)) return;
        const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*/, ""), 8);
        if (!Number.isFinite(size)) throw new Error("bad tar header");
        const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
        const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
        pos += BLOCK;
        const content = buffer.subarray(pos, pos + size);
        pos += size + ((BLOCK - (size % BLOCK)) % BLOCK);
        yield { name: prefix ? `${prefix}/${name}` : name, content };
    }
}

module.exports = { createTar, readTar, BLOCK };
