# OpenLoom

Screen recording you share with a link — no account needed to watch.
Built in the open by an autonomous agent together with the people who hold its
token. Record your screen and microphone in desktop Chrome, get a share link
anyone can open. Creators sign up free; the free limits are published in the
product before any upgrade exists.

## Free plan (enforced by the server)

- **3 stored clips** per account.
- Each clip up to **5 minutes** (the recorder stops at the cap and saves what
  you have; the server also verifies the real duration from the webm header)
  and up to **100 MB**.
- Share links play for anyone, no account needed to watch.
- Export everything as one `.tar` archive, delete one clip, all clips or the
  whole account at any time.

Limits live in one place (`server.js`, overridable by `FREE_MAX_CLIPS`,
`FREE_MAX_DURATION_MS`, `FREE_MAX_CLIP_BYTES` for tests) and are published on
`/limits` and in the recorder UI.

## Using it

Open the site in desktop Chrome:

1. Create a free account (email + password) — it keeps your clip list private
   to you.
2. Type a title (optional) and press **Start recording**.
3. Pick a screen, window or tab; allow the microphone if you want your voice.
4. Press **Stop and save** (or Chrome's own "Stop sharing").
5. You get a **share link** (plays for anyone) and a **manage link** (also
   allows deleting the clip — it works even signed out).

On the home page you can export everything (`.tar`) or delete everything;
per-clip deletion is on the list and on the share page.

## How it runs

- `Dockerfile` builds the product into one container image that serves on port 3000.
- `deploy.json` describes the services to run: their image, size, port and whether they are
  reachable from the internet. Changing this file is how the product's infrastructure changes.
  Clips live on a 5 GB volume mounted at `/data` (`DATA_DIR=/data`), so redeploys
  keep the data.
- `.github/workflows/build.yml` runs on every push to the default branch: it builds the image,
  runs the tests, publishes the image to the GitHub container registry tagged with the commit,
  and records the result as `refs/ci/pass/<commit>` or `refs/ci/fail/<commit>`. An image named
  in `deploy.json` without a tag runs the commit being deployed.

## Persistence

Recordings, accounts and sessions live under `DATA_DIR` (default `./data`,
`/data` in the container): one directory per clip with `video.bin` and
`meta.json`, plus `accounts.json` (scrypt password hashes, session token
hashes — no plaintext secrets at rest).

`scripts/backup.mjs` copies the whole data directory into a timestamped backup
with a SHA-256 manifest; `scripts/restore.mjs` verifies every file against the
manifest before overwriting anything and moves the pre-restore state aside.

```
node scripts/backup.mjs [--dir <backup-dir>]
node scripts/restore.mjs <backup-dir> | --latest
```

## Developing

Zero runtime dependencies; Node 22 standard library only.

```
npm start          # serve on :3000 (PORT, DATA_DIR, MAX_UPLOAD_BYTES, FREE_* to override)
npm test           # API tests against a real server on an ephemeral port
```

`e2e/record.mjs` is an end-to-end check in a real headless Chrome: sign up,
record three clips, the free cap stops the fourth with a clear message, a
second account sees nothing, a viewer plays a share link without an account,
export downloads a tar, a full backup → wipe → restore cycle brings the clips
and accounts back, delete-everything empties the list. It is not part of CI:

```
npm i puppeteer    # once, outside the repo's dependencies
node e2e/record.mjs [baseUrl]
```

Headless Chrome cannot open a real screen picker, so the script falls back to
a synthetic capture source for the *source only*; everything past that is the
real product path.

## Licence

No licence has been chosen yet; see `LICENSE`.
