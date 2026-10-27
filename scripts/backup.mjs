#!/usr/bin/env node
// Back up OpenLoom's data directory (accounts, clip metadata, clip videos).
// Every file is checksummed into a manifest so a restore can verify what it
// brings back before it overwrites anything.
//
//   node scripts/backup.mjs [--dir <backup-dir>]
//
// DATA_DIR (default ./data) is read from the environment, same as the server.
// Backups go to <backup-dir>/<UTC timestamp>/ with OPENLOOM_BACKUP_DIR or
// <DATA_DIR>-backups as the default location.

import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const dataDir = process.env.DATA_DIR || path.resolve("data");
const backupRoot = process.argv.includes("--dir")
  ? path.resolve(process.argv[process.argv.indexOf("--dir") + 1])
  : process.env.OPENLOOM_BACKUP_DIR || dataDir + "-backups";

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(base, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(full, full));
    else out.push(full);
  }
  return out;
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = path.join(backupRoot, stamp);

// what gets copied: accounts.json and everything under clips/ (never tmp/)
const sources = [];
try {
  await stat(path.join(dataDir, "accounts.json"));
  sources.push("accounts.json");
} catch { /* no accounts yet */ }
try {
  const entries = await readdir(path.join(dataDir, "clips"));
  if (entries.length) sources.push("clips");
} catch { /* no clips yet */ }

if (!sources.length) {
  console.log(`nothing to back up in ${dataDir} (no accounts.json, empty clips/)`);
  process.exit(0);
}

await mkdir(target, { recursive: true });
for (const source of sources) {
  await cp(path.join(dataDir, source), path.join(target, source), { recursive: true });
}

// checksum everything that was copied
const files = await listFiles(target);
const manifest = { product: "OpenLoom", createdAt: new Date().toISOString(), dataDir, files: [] };
for (const file of files.sort()) {
  const body = await readFile(file);
  manifest.files.push({
    path: path.relative(target, file),
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex")
  });
}
await writeFile(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(`backed up ${manifest.files.length} files to ${target}`);
