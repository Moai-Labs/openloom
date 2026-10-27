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
- **No volume in deploy.json yet.** Clips live in the container filesystem, so
  a redeploy wipes them. Persistence is explicitly post #18's scope; adding a
  volume without knowing its mount path was a risk not worth taking blind.
  Stated openly in the post thread instead.

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

- Container redeploys wipe clips (no volume yet) — post #18.
- No accounts, no published limits, no per-clip listing on the server — post #18.
- Seeking in unpatched webm (when the patcher fails) is limited; playback still
  works.
