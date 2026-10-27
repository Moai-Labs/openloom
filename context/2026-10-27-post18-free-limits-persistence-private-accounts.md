# Post #18 — Free limits, persistence and private accounts

Date: 2026-10-27. Branch: `post-18` (on top of `post-17`).

## What was built

The second working slice of OpenLoom: private creator accounts, published and
server-enforced free limits, export/deletion of real data, and persistence
with a demonstrated backup → wipe → restore cycle. Still zero runtime
dependencies — Node stdlib only.

- **Accounts** (`lib/accounts.js`): email + password (scrypt N=16384), bearer
  sessions valid 30 days. `accounts.json` stores only hashes: the scrypt
  password hash and SHA-256 hashes of session tokens — no plaintext secrets
  at rest (a test asserts this). A failed login walks the same slow scrypt
  path as a successful one (no email enumeration timing signal). The manage
  token from step 1 stays as an offline delete key: it works signed out.
- **Privacy**: `GET /api/my/clips` returns only the caller's clips; another
  account's session cannot delete someone else's clip (403). Watching share
  links still needs no account.
- **Free limits** (single source of truth in `server.js`, env-overridable for
  tests): 3 stored clips per account, 5 minutes and 100 MB per clip. The
  server counts clips before and after the upload (guards against parallel
  uploads) and verifies duration **from the file itself**:
  `lib/webm-duration.js` is a narrow EBML walk (EBML header → Segment, which
  MediaRecorder leaves unknown-size → Info → TimecodeScale + Duration). The
  parser returns null on anything it does not understand and the server falls
  back to the declared duration. Grace +2 s for encoder slop. The limits are
  published on `/limits` and in the recorder UI (usage meter "N of 3", the
  start button reads "Free limit reached" when full).
- **Export / deletion**: `POST /api/my/export` issues a one-time link
  (10 minutes) to `GET /api/my/export/<token>` — an ordinary browser
  navigation downloads a tar (`lib/tar.js`, ustar; files stream from disk,
  nothing large is held in memory): manifest + meta.json + video.bin of every
  clip. `DELETE /api/my/clips` deletes everything, `DELETE /api/my/account`
  deletes the account with its clips and sessions; the email frees up at
  once.
- **Persistence**: `deploy.json` gained `volume_gb: 5` and `DATA_DIR=/data`.
  `scripts/backup.mjs` copies `accounts.json` + `clips/` into a timestamped
  backup with a SHA-256 manifest; `scripts/restore.mjs` verifies every file
  against the manifest BEFORE overwriting anything (a corrupt backup changes
  nothing) and moves the pre-restore state aside to
  `<DATA_DIR>-pre-restore-<stamp>`.
- **E2E** (`e2e/record.mjs`): real headless Chrome — sign-up through the UI,
  three clips up to the cap (the start button disables with a clear
  message), a second account sees nothing, a viewer plays a share link with
  no account, the export downloads a tar holding the manifest and clips, a
  full backup → wipe → restore cycle brings the clips and the account back,
  delete-everything empties the list.

## Decisions and why

- **Uploads require an account.** A "3 clips" cap is meaningless without
  identity. Watching stays account-free (the product's principle). The
  manage token from step 1 remains — an offline delete key for when the
  session expired.
- **Duration is verified from the file, not the header.** `X-Duration-Ms` is
  client-controlled — not an enforcement point. When fix-webm-duration has
  patched the webm, the server reads the real Duration; when it has not, the
  server falls back to the declared header. Without this, "5 minutes" would
  be an honour system.
- **One-time export links instead of cookies or a session token in the URL**:
  the browser downloads via plain navigation (the archive never sits in page
  memory), the token is single-use and short-lived, and the session does not
  leak into logs or history.
- **accounts.json as one atomically-replaced file** — at the current scale
  (hundreds of accounts) whole-file read/write is simpler and safer than a
  database; a later migration to a DB would not change the API.
- **The volume mount is a documented assumption.** `deploy.json` now declares
  a 5 GB volume and `DATA_DIR=/data`, but the platform's actual mount path is
  not known — a request is recorded in the post thread (attention): if the
  platform mounts elsewhere, the env needs adjusting. Backup/restore works
  either way.

## Verification

- `npm test` — 27 API tests against a real server (ephemeral port, throwaway
  DATA_DIR): clip lifecycle, accounts (sign-up/login/logout, duplicates,
  validation), tokens not stored in plaintext, foreign sessions rejected,
  limits (size/duration/count, real webm parsing, a lying header is cut
  off), export (tar + one-time link), delete-all/account, malformed ids,
  pages/limits. All pass.
- `node e2e/record.mjs` — the full scenario in real Chrome (see above):
  14 checks, all pass. Two environment notes from running it headless in a
  bare container: headless-shell delivers clicks but not real keyboard
  events (text goes in as value + input event), and with no font installed
  the renderer dies on the first new text render after a recording stops —
  the container needs at least one font behind fontconfig.

## Known limits

- Accounts are a single JSON file; hundreds of thousands of users would need
  a database.
- Restore expects the server to be stopped (the script moves files).

## Session 3 (2026-10-27, ~17:20 UTC)

Delivery session. The previous session's queued push had not landed (no
post-18 ref on origin, no CI verdict), so this session re-verified and
re-queued:

- Merged origin/main (6646234: CI now builds to the app's fly registry;
  deploy.json image field changed by the platform). Merge is clean;
  `volume_gb: 5` and `DATA_DIR=/data` survive alongside it.
- `npm test`: 27/27 pass on the merged head.
- E2E re-run NOT possible on this machine: fresh container, no Chrome system
  libraries, no root to install them. The merged diff contains no product
  code, so the previous session's full green E2E run on identical code stands.
- Committed the e2e toolchain as devDependencies (puppeteer@23, yauzl) plus
  package-lock, so the E2E is installable from the repo on any machine with
  Chrome's system libs.
- Push queued via request_push. Remaining: CI verdict + preview link (next
  session's first job), and the open platform question on the real volume
  mount path for DATA_DIR.
