# Post #17 — Chrome recorder with account-free share links (first slice)

Date: 2026-10-27. Branch: `post-17`.

## What was built

The first working slice of OpenLoom: a browser screen+mic recorder and
account-free share links. Zero runtime dependencies — Node stdlib only.

- `server.js` — HTTP server: recorder page at `/`, share pages at `/v/<id>`,
  clip API under `/api/clips`, `/healthz`.
- `lib/store.js` — clip storage: `data/clips/<id>/video.bin` + `meta.json`.
  Uploads stream to a staging file then are renamed into place, so a failed
  upload never leaves a half-written clip. Only the SHA-256 hash of the manage
  token is stored, never the token itself.
- `public/recorder.html` — the studio: title, getDisplayMedia (screen/window/
  tab) + microphone via getUserMedia, MediaRecorder (vp9/opus → vp8/opus →
  webm → mp4 fallback), live timer/size, XHR upload with progress, retry and
  "download a local copy" on failure. Records made on the device are listed
  from localStorage with share/manage/delete.
- `public/watch.html` — the share page: plays the video, downloads the
  original with the author's filename, and shows Delete when the visitor holds
  the manage key (from the `?k=` manage link or the author's own localStorage).
- `public/vendor/fix-webm-duration.js` — vendored MIT library that patches the
  missing Duration element into MediaRecorder webm files client-side, before
  upload, so players show a real duration.

## Decisions and why

- **Raw-body upload, not multipart.** `POST /api/clips` takes the video bytes
  directly with `Content-Type: video/*`; no multipart parser needed, keeps the
  server dependency-free and streaming.
- **Manage token instead of accounts (for now).** Deletion needs a secret the
  author keeps: a `manageToken` from the create response, sent as
  `Authorization: Bearer` on DELETE, or embedded in the manage link
  `/v/<id>?k=...`. Accounts proper are post #18; this keeps the share link
  account-free while deletion stays author-only.
- **200 MB upload cap** (`MAX_UPLOAD_BYTES`) as a hard guard on the 512 MB
  dev container. The published free limits (5 min / 100 MB) are enforced in
  post #18, not here.
- **Duration patched client-side before upload** so the stored original is
  already correct for every viewer; the unpatched blob is uploaded if the
  patcher fails (try/catch + 5 s timeout race).
- **No volume in deploy.json yet** (superseded 2026-10-28, review round 1
  asked for durable storage now): `deploy.json` provisions a 5 GB volume
  mounted at `/data` and sets `DATA_DIR=/data` — the same convention the
  post-18 and post-19 branches use. The Dockerfile's `/app/data` is only the
  in-container fallback.

## Verification

- `npm test` — 13 API tests against a real server on an ephemeral port:
  lifecycle (create → metadata → full/range/download → delete), 415/413/400
  rejections, 404s, id/path-traversal hardening, token never stored in
  plaintext.
- `node e2e/record.mjs` — headless Chrome end-to-end: records ~4 s of real
  MediaRecorder output, uploads, then in separate browser contexts: a viewer
  plays it (finite duration after the patch), sees no delete button; the
  downloaded file is byte-identical (SHA-256) to what was recorded and has the
  attachment header; the manage link deletes from a fresh session; the clip
  and its share page afterwards report gone/deleted. All checks pass.
- Headless Chrome has no desktop to pick, so the E2E injects a synthetic
  capture source when the real picker cannot open (documented in the script);
  MediaRecorder, upload, playback, download and deletion are all the real
  product path. Real screen picking needs a human in desktop Chrome — the
  preview link is for that.

## Known limits, deliberately deferred

- No accounts, no published limits, no per-clip listing on the server — post #18.
- Seeking in unpatched webm (when the patcher fails) is limited; playback still
  works.

## Review round 1 changes (2026-10-28)

- `lib/store.js`: failure cleanup now removes only this upload's staging file
  (never the shared tmp dir), tears down its streams, and cleans staging up on
  publication failure too. Oversized bodies are drained up to 1 MB so the 413
  reaches the client, then the connection is cut. Three concurrent-upload
  tests (empty/aborted/oversized against a gated in-flight save) and a
  streaming-oversized test pin this down.
- `public/recorder.html`: display audio + microphone are mixed into one track
  via Web Audio (Chrome MediaRecorder cannot take two audio tracks); original
  streams and the AudioContext are released on success and failure alike, and
  `recorder.start()` failures are caught. E2E regression check records with
  both sources and verifies the clip contains audio (decodeAudioData).
- `public/watch.html`: real `.hidden` CSS; the E2E now asserts rendered
  visibility (computed style + client rects) for viewers (hidden) and the
  manage key (shown), not a class name.
- `deploy.json`: `volume_gb: 5`, `DATA_DIR=/data`; README updated. Verified
  locally that a clip survives killing the server and booting a fresh one on
  the same data dir (byte-identical download, original manage key deletes) —
  the same check on the deployed container happens via the dev preview.
- Tests: 16 API tests (was 13), all passing, stable across 5 runs. E2E:
  13 checks (was 10), all passing.

## Running the E2E in this dev container (2026-10-28)

The session container is Debian bookworm with almost no shared libraries, so
headless Chrome needs hand-setup before `node e2e/record.mjs` will run:

1. `npx puppeteer browsers install chrome` (binary lands in ~/.cache/puppeteer).
2. `apt-get` cannot install (no root), so download the debs into /tmp and
   extract them locally: `apt-get -o Dir::State::lists=/tmp/aptlists
   -o Dir::Cache=/tmp/aptcache update` then `... download <pkgs>` and
   `dpkg-deb -x <deb> /tmp/chrome-deps/` for each. Needed (incl. transitives):
   libglib2.0-0 libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0
   libcups2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1
   libxkbcommon0 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 libx11-6
   libxcb1 libxext6 libavahi-client3 libavahi-common3 libxau6 libxdmcp6
   libdrm2 libwayland-server0 libpixman-1-0 libfontconfig1 libfreetype6
   libpng16-16 libxcb-shm0 libxcb-render0 libxrender1 libfribidi0 libthai0
   libharfbuzz0b libxi6 libbsd0 libdatrie1 libgraphite2-3 libsqlite3-0,
   plus `fontconfig-config fonts-dejavu-core` for fonts.
3. Run with `LD_LIBRARY_PATH=/tmp/chrome-deps/usr/lib/x86_64-linux-gnu:/tmp/chrome-deps/lib/x86_64-linux-gnu`.
   Missing libsqlite3-0 shows up as a fatal NSS error (nss_error=-5925), not a
   loader error — that cost real time once.
4. Fontconfig finds no fonts by default and Chrome *aborts* (SIGABRT in Skia,
   "SkFontMgr_FontConfigInterface: Not implemented") when it must render text
   with none. Point it at extracted fonts: write a minimal fonts.conf listing
   `<dir>`/usr/share/fonts, and run with `FONTCONFIG_PATH` set to it.
5. CI does not need any of this: build.yml runs only `npm test` (the 13 API
   tests, no browser). The E2E is a dev-time gate before asking for a push.

## Review round 2 changes (2026-10-28)

- `public/recorder.html` — startup lifecycle races closed:
  - `startRecording` guards re-entry synchronously (a `starting` flag checked
    before the first await) and disables the Start button until the attempt
    succeeds or fails, so repeated clicks during the picker/permission flow
    cannot start overlapping captures.
  - Each attempt's capture resources (display, mic, AudioContext, mixed
    stream) stay in a local `attempt` object until the recording actually
    starts; every cancelled or failed path releases exactly those via
    `startupFailed`. Only a started recording is promoted to the shared
    state.
  - After the microphone permission resolves, the display video track's
    `readyState` is verified live — stopping screen sharing while the mic
    prompt is up aborts the attempt instead of handing an ended track to
    MediaRecorder.
  - Finalization runs exactly once per recorder: `onerror` only records
    `recorderError`; the stop event drives `finalizeRecording()`, which
    detaches the handlers and nulls `recorder` first. The final
    dataavailable that follows a recorder error can therefore never be
    uploaded as a "successful" clip after the failure UI is shown. The
    failed-synchronous-stop path finalizes inline, guarded by the same
    `if (!recorder) return`.
- `e2e/record.mjs` — new checks (21 total, up from 13 at round 0):
  - repeated Start clicks start exactly one capture flow and the button is
    disabled while startup is pending (driven by a stubbed getDisplayMedia
    whose promise the test resolves manually);
  - display capture ending during the pending microphone permission aborts
    startup with the failure note, releases the granted microphone track, and
    re-enables the button;
  - the error → dataavailable → stop sequence (dispatched by hand via a
    wrapped MediaRecorder) ends in the failure UI, saves nothing, and leaves
    the recordings list untouched;
  - the viewer check now actually plays the clip: `video.play()` is awaited
    and `currentTime` must advance with no `video.error`.

## Verification status after round 2 (2026-10-28)

- `npm test`: 16/16 pass (including "clips survive a fresh server generation
  on the same data directory" — the container-replacement persistence check
  at the server level).
- `node e2e/record.mjs`: all 21 checks pass, stable across 3 runs.
- Real screen capture: the main E2E recording used the **real
  getDisplayMedia path** — headless Chrome honours
  `--auto-select-desktop-capture-source=Entire screen`, so the capture is
  genuine Chromium desktop capture of a screen source, encoded by
  MediaRecorder, uploaded through the product. The microphone is the fake
  device (this container has no physical mic), and the source is
  auto-selected by flag rather than picked in the real picker dialog —
  headless has no picker UI.
- Still outstanding, by nature of this container (headless Linux, no GUI):
  a human recording on the dev preview in real desktop Chrome through the
  picker dialog, with a real screen and microphone. The preview URL for the
  pushed head arrives with the CI verdict; the plan for the next session on
  this post is to run this corrected E2E against the dev preview and record
  the preview URL, playback, download, deletion and deployed-volume
  persistence results here and in the post thread.

## Merged origin/main into post-17 (2026-10-28)

Main had moved on (post-18's free limits/accounts and post-19's paid plan were
merged there), built from the same placeholder but evolved separately, so the
merge was a reconciliation, not a fast-forward. What was taken from where:

- **Taken from main wholesale**: `server.js`, `lib/accounts.js`,
  `lib/payments.js`, `lib/keccak256.js`, `lib/tar.js`, `lib/webm-duration.js`,
  `lib/store.js` (main's copy already contains the round-1 upload-cleanup
  fixes, re-implemented there), `public/limits.html`, `public/upgrade.html`,
  README, `backend/delivery-stamp.json`, `context/delivery-verify.json`.
  `package-lock.json`/devDependencies (puppeteer, yauzl) stay from post-17.
- **Kept from post-17**: `public/watch.html` — main's copy had lost the
  `.hidden` CSS rule while the page still used the class, which made the
  delete button visible to every viewer; post-17's round-1 fix is the real
  rule. The Dockerfile keeps post-17's comment (deploy.json — identical on
  both branches — mounts the 5 GB volume at /data and sets DATA_DIR=/data;
  the Dockerfile's /app/data is only the in-container fallback).
- **Reconciled by hand**:
  - `public/recorder.html` — main's accounts/usage-meter/free-limit features
    combined with post-17's reviewed lifecycle work: the synchronous re-entry
    guard, per-attempt capture cleanup (`startupFailed`/`releaseCapture`),
    the live-display-track check after the mic permission, Web Audio mixing
    of display audio + microphone, single finalization via `finalizeRecording`,
    and the round-3 re-enable of Start on every finalize path. `renderUsage`
    now respects a pending startup (`starting`) so an account refresh cannot
    re-enable the button mid-attempt; the free-limit gate keeps the button
    disabled and relabelled when the meter is full.
  - `e2e/record.mjs` — one combined flow: sign-up, the round-3 same-page
    regression (record → save → Record another → second recording saves),
    the startup-race checks, the exactly-once-finalization check extended
    with "Start is usable again after a recorder error", the dual-audio clip,
    main's free-limit/privacy/export/backup-restore checks, and post-17's
    viewer checks (real playback assertion, byte-identical download,
    manage-key deletion from a fresh session, rendered delete-button
    visibility). The backup/restore section now reports skipped-by-design on
    a remote baseUrl instead of failing the run.
  - `test/server.test.js` — auto-merged; post-17's three upload tests were
    ported to the account model (bearer session on every upload, clip-count
    assertions scoped to this test's own clip, `Store.remove(id, { token })`
    signature).

## Review round 3 changes (2026-10-28)

- `public/recorder.html`: `finalizeRecording` re-enables Start recording now
  that the recording is finalized and no startup is pending — on the success,
  recorder-error and empty-recording paths alike; the cancelled/failed startup
  paths already re-enabled it via `startupFailed`. Same-page E2E regression:
  record and save a clip, click "Record another", and successfully start and
  save a second recording; plus "Start recording is usable again after a
  recorder error" on the exactly-once error path.
- Dev-preview verification — see "Dev preview and deployment verification"
  below.

## Dev preview and deployment verification (2026-10-28)

The dev preview (https://fl-dev-c108db22-0516-4540-b619-10c4a6bf1b9d.fly.dev)
serves main at e763627 (post-19's merge) — post-17's head is not merged yet,
so only part of the corrected E2E can pass there today. Run recorded
2026-10-28 ~12:15 UTC, against the deployed container:

- **Passes on the deployed stack**: sign-up, record and save (real
  MediaRecorder output, ~155 KB webm), the round-3 same-page regression —
  "Record another" returns to setup and a second recording starts and saves —
  and (later in the run) everything up to the second recording.
- **Fails on the deployed stack, by design of the deployed code**: the
  startup-race checks (`["display","display"]` — repeated clicks start two
  capture flows; Start not disabled while startup is pending) and the
  ended-display-during-mic-permission check. These are exactly the round-2
  lifecycle bugs this branch fixes; the checks go green on the preview only
  once post-17 is merged and redeployed. The run then aborts at the race
  section (the deployed code leaves overlapping captures in flight).

**Deployed-volume persistence, marker planted.** A real 3-second recording
was made through the product on the deployed container and deliberately left
there, so the container replacement caused by this session's push becomes the
redeployment test:

- share: https://fl-dev-c108db22-0516-4540-b619-10c4a6bf1b9d.fly.dev/v/YdSwF0S8mwIWxRbm
- manage: https://fl-dev-c108db22-0516-4540-b619-10c4a6bf1b9d.fly.dev/v/YdSwF0S8mwIWxRbm?k=PaPLekKbx3Sk7yJGlsGNS8tpDwhRMaM9
- 59,265 bytes, SHA-256 `7ab8253eb78a5777100e2533279c47689dffa774d84310e043c1ed7c384dc8ba`
- recorded 2026-10-28T12:21:13Z on the deployed container (serving e763627).

Next session on this post verifies against the replaced container: separate
viewer playback, byte-identical download (hash above), and deletion with the
original manage key — then records the outcome here and in the thread.

**Real screen picker**: this environment cannot operate Chrome's picker
dialog (headless Linux, no GUI; `--auto-select-desktop-capture-source` makes
headless capture a screen source without the dialog, which is how the E2E's
recordings are genuine captures). A human recording in desktop Chrome on the
preview is still the missing acceptance check; asked for in the post thread.

## Dev-preview persistence verification (2026-10-28 ~13:20 UTC)

Follow-up session ran the promised checks against the dev preview
(https://fl-dev-c108db22-0516-4540-b619-10c4a6bf1b9d.fly.dev) after the
container replacements from the post-17 push (7a13183) and the post-18 push.
The marker clip planted at 12:21:13Z was verified end to end:

- **Playback** — real headless Chrome loaded the share page and played the
  clip: decoded 640x360, duration 3.051 s (matches the stored 3051 ms),
  currentTime advanced while playing, `video.error` stayed null, no page
  errors. (Chrome and its libs were rebuilt from the recipe above — the
  container this session runs in was replaced too.)
- **Download** — byte-identical: 59,265 bytes, SHA-256
  `7ab8253eb78a5777100e2533279c47689dffa774d84310e043c1ed7c384dc8ba`,
  exactly the pre-replacement hash; served with `content-type: video/webm`
  and `accept-ranges: bytes`.
- **Deletion** — `DELETE /api/clips/<id>` with the original manage key
  returned 204 after the replacements; metadata and file then 404
  (`{"error":"no such clip"}`), so the share page has nothing to play.
- **Persistence** — the clip was recorded 2026-10-28T12:21:13Z on the then-
  deployed container and survived the volume across the container
  replacements caused by two subsequent branch pushes.

The container-replacement persistence, playback, download and deletion
checks on the dev stack are now all green. What remains outstanding on this
post is unchanged: the human desktop-Chrome picker recording (requested via
the attention record), and the operator look the pause asks for before work
continues. These results were also posted in the post-17 thread.

## Session 2026-10-28 ~18:35 UTC — taken up again, head re-verified

The platform took post #17 up again (the pause is lifted), and this session
re-verified the branch rather than re-doing work:

- The round-3 changes are in the tree at head 31770fc (a252e36 carries the
  code change, db64935 the main merge, 7a13183 + 31770fc the context notes).
  Start recording is re-enabled on every finalization path (recorder.html
  lines ~377/547/595) and the same-page regressions cover them.
- 54/54 API tests pass. The full headless-Chrome E2E ran clean twice from a
  rebuilt Chrome environment (the recipe above had to be redone — the
  session container was replaced again and /tmp and ~/.cache do not
  survive): every check passed, including "Record another returns to setup
  with Start enabled", "a second recording starts and runs", and "Start
  recording is usable again after a recorder error".
- The dev preview is serving (HTTP 200). The dev-preview acceptance checks
  documented above remain as recorded; the human desktop-Chrome picker
  recording is still the one outstanding acceptance check, re-requested via
  a fresh attention record (the earlier one did not survive the pause).
- The booked reminder for the marker-clip verification was closed: its
  answer was already posted in the thread at 13:22 UTC.
- Push queued at this head so the platform reviews it (round 4).
