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
