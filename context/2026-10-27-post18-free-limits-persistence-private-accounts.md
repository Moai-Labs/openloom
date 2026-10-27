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

## Review round 1 (2026-10-27, later session): the four required changes

The platform review of 5fe5a2f asked for four changes. All four are made on
this branch; decisions taken:

- **accounts.js — serialized, copy-on-write persistence.** Every account
  mutation (create/login/logout/remove) and its persistence commit now runs
  through one queue (`runExclusive`), so two signups can no longer interleave
  writes into `accounts.json.tmp`. Each commit writes a uniquely owned temp
  file (`accounts.json.<pid>.<seq>.<rand>.tmp`), fsyncs, then atomically
  renames — a rename can no longer fail with ENOENT because another writer
  renamed the shared temp away. Mutations are copy-on-write: the new state is
  committed first and only then becomes live, and a failed commit rolls memory
  back, so no uncommitted account/session stays active. `save()` remains as a
  queued commit for outside callers; `pruneSessions`/`dropSessionsOf` were
  folded into create/login/remove (nothing external called them). New tests:
  8 concurrent signups + a duplicated-email race, verified after "restarting"
  (fresh `Accounts` over the same directory); 5 logins racing 5 logouts; a
  pre-restart session token still authenticating post-restart; no stray .tmp.
- **store.js — scoped cleanup, real teardown.** Failed/empty uploads now
  remove only their own staging file (the old `rm(path.dirname(staging),
  {recursive:true})` deleted the *shared* tmp directory and every in-flight
  upload with it). On failure the pipeline is torn down in flow order —
  unpipe, destroy counting and output streams, wait for the output file's
  `close` — and only then is the file removed; the request is drained (not
  destroyed) so the error response still reaches the client. New test: an
  oversized upload pushed past the cap mid-flight while a valid upload
  streams concurrently — the valid one survives with its file intact and the
  tmp dir ends empty.
- **webm-duration.js — duration from the media timeline, fail closed.** The
  old parser read only `Info.Duration` — a client-writable float, useless as
  enforcement (a 5-minute video claiming 1 s passed). It is now a streaming
  EBML scanner that measures the actual timeline: Cluster Timestamps plus
  SimpleBlock/Block timecodes, finished with the last frame's length (its
  BlockDuration, else the gap to the previous block, capped at 2 s).
  `Info.Duration` is deliberately never read. The server streams the whole
  stored file through the scanner (no 1 MB head cut, so nothing at the tail
  is missed) and: refuses any webm/matroska whose timeline cannot be verified
  at all (fail closed — no more client-declared fallback), refuses over-cap
  timelines, and records the *verified* duration even when the header
  disagrees. Known boundary: non-webm uploads (mp4) still carry only the
  declared header — noted in the thread. Tests: understated `Info.Duration`
  (1 s claimed, 40 s timeline → refused), missing Duration, unverifiable
  bytes → 413, streaming scanner fed at 1/3/7/4096-byte chunks equals the
  buffered read. Two scanner bugs found and fixed while testing: skip
  accounting after reading a block's timecode, and small elements (Cluster
  Timestamp, TimestampScale, BlockDuration) whose bodies span a chunk
  boundary being discarded as "unknown" instead of awaited.
- **recorder.html — the manage-key cache is account-scoped.** Previously
  *every* authenticated upload went into the global `openloom.recordings`
  list, which `deviceCard` renders signed out — handing the departing
  creator's clip list and deletion keys to whoever opens the browser next.
  Now: recordings made while signed in are cached under
  `openloom.recordings:<email>` and render only while that account is
  authenticated; the global key holds only genuine no-account recordings from
  the pre-accounts build, and the card's copy now says exactly that. Sign-out
  and account switches clear the rendered list at once, and a list response
  that was in flight during the switch is discarded (token captured before
  the fetch, compared after) so it cannot repopulate the page. Deleting the
  account removes its cache. The browser scenario in `e2e/record.mjs` signs
  out and signs in as another creator on the same profile and asserts no rows
  and no `?k=` manage links anywhere on the page.
- Related fix found while re-reading the path: the declared-duration
  prefilter refused at exactly the cap, but the recorder's auto-stop fires up
  to a timer tick *after* the cap — a legitimate 5-minute recording could be
  refused on its declared header. The prefilter now uses the same +2 s slop
  as the real (timeline) check.
