#!/usr/bin/env node
// Restore OpenLoom's data directory from a backup made by scripts/backup.mjs.
// Every file is verified against the backup's manifest checksums before
// anything is overwritten; a mismatch aborts with nothing changed.
//
//   node scripts/restore.mjs <backup-dir> | --latest
//
// DATA_DIR (default ./data) is read from the environment, same as the server.
// The pre-restore state is moved aside to <DATA_DIR>-pre-restore-<stamp>.

import { cp, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const dataDir = process.env.DATA_DIR || path.resolve("data");
const backupRoot = process.env.OPENLOOM_BACKUP_DIR || dataDir + "-backups";

let backupDir = null;
if (process.argv[2] === "--latest") {
  const candidates = (await readdir(backupRoot)).filter((n) => !n.startsWith(".")).sort();
  if (!candidates.length) {
    console.error(`no backups in ${backupRoot}`);
    process.exit(1);
  }
  backupDir = path.join(backupRoot, candidates[candidates.length - 1]);
} else if (process.argv[2]) {
  backupDir = path.resolve(process.argv[2]);
} else {
  console.error("usage: node scripts/restore.mjs <backup-dir> | --latest");
  process.exit(1);
}

const manifest = JSON.parse(await readFile(path.join(backupDir, "manifest.json"), "utf8"));

// verify first: every manifest file present, sized and checksummed right
let verified = 0;
for (const entry of manifest.files) {
  const body = await readFile(path.join(backupDir, entry.path));
  const digest = createHash("sha256").update(body).digest("hex");
  if (body.length !== entry.bytes || digest !== entry.sha256) {
    console.error(`backup is corrupt at ${entry.path} — nothing was changed`);
    process.exit(1);
  }
  verified++;
}
console.log(`verified ${verified}/${manifest.files.length} files in ${backupDir}`);

// move the current state aside, then copy the backup into place
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
for (const source of ["accounts.json", "clips"]) {
  try {
    const existing = path.join(dataDir, source);
    await stat(existing);
    const aside = path.join(dataDir + "-pre-restore-" + stamp, source);
    await mkdir(path.dirname(aside), { recursive: true });
    await rename(existing, aside);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  try {
    await cp(path.join(backupDir, source), path.join(dataDir, source), { recursive: true });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

console.log(`restored ${verified} files into ${dataDir} (previous state moved to ${dataDir}-pre-restore-${stamp})`);
