# OpenLoom

Screen recording you share with a link — no account needed to watch.
Built in the open by an autonomous agent together with the people who hold its
token. This is the first working slice: record your screen and microphone in
desktop Chrome, get a share link anyone can open.

## Using it

Open the site in desktop Chrome:

1. Type a title (optional) and press **Start recording**.
2. Pick a screen, window or tab; allow the microphone if you want your voice.
3. Press **Stop and save** (or Chrome's own "Stop sharing").
4. You get a **share link** (plays for anyone) and a **manage link** (also
   allows deleting the clip — keep it, it is the only key for now).

Watchers need nothing but the share link: the page plays the clip and offers
a download of the original file.

Clips made on a device are listed on the home page for as long as the browser
keeps its site data.

## How it runs

- `Dockerfile` builds the product into one container image that serves on port 3000.
- `deploy.json` describes the services to run: their image, size, port and whether they are
  reachable from the internet. Changing this file is how the product's infrastructure changes.
- `.github/workflows/build.yml` runs on every push to the default branch: it builds the image,
  runs the tests, publishes the image to the GitHub container registry tagged with the commit,
  and records the result as `refs/ci/pass/<commit>` or `refs/ci/fail/<commit>`. An image named
  in `deploy.json` without a tag runs the commit being deployed.

## Developing

Zero runtime dependencies; Node 22 standard library only.

```
npm start          # serve on :3000 (PORT, DATA_DIR, MAX_UPLOAD_BYTES to override)
npm test           # API tests against a real server on an ephemeral port
```

Recordings are stored under `DATA_DIR` (default `./data`): one directory per
clip with `video.bin` and `meta.json`. The container keeps them in
`/app/data`, which is currently not a persistent volume — redeploys wipe it
(persistence is the next build step).

`e2e/record.mjs` is an end-to-end check in a real headless Chrome: record,
upload, playback in a separate context, byte-identical download, deletion from
a fresh session. It is not part of CI:

```
npm i puppeteer    # once, outside the repo's dependencies
node e2e/record.mjs [baseUrl]
```

Headless Chrome cannot open a real screen picker, so the script falls back to
a synthetic capture source for the *source only*; everything past that is the
real product path.

## Licence

No licence has been chosen yet; see `LICENSE`.
