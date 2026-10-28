# Post 61 — close reliability and real-Chrome acceptance gaps (2026-10-28)

Branch `post-61` (from main e4fe215). The final free-plan review finding was
reproduced against current main and fixed this session.

**Acceptance status: not complete.** Everything scriptable passes on this
branch's revision locally; two things remain and are not claimed as done:
browser results and restore on the deployed revision (the dev preview still
ran the pre-fix revision when last probed — see below), and the human
desktop-Chrome check (team request `real-chrome-picker-check`, due
2026-10-29T18:00Z, still pending).

## The bug: a sibling-terminated unknown-size cluster was dropped silently

`lib/webm-duration.js` `drain()` ended an unknown-size Cluster when the next
segment sibling (another Cluster, Tracks, Cues, …) began, but popped it without
calling `onExitContext()`. Everything that cluster held was discarded. The fix
calls `this.onExitContext(ctx)` before the pop, so the cluster's deferred block
measurements fold into the segment timeline exactly as they do at eof and at a
bounded parent's boundary.

Why it mattered: MediaRecorder writes the Segment and every Cluster with an
unknown size, so a real recording is a chain of such clusters. A long timeline
front-loaded into an early cluster read as ~0 ms the moment any later cluster
appeared — that is both the evasion shape (a file that passes the 5-minute cap
while playing long) and an under-measurement of genuine recordings.

Measured direction after the fix: the evasion fixture (Cluster 1: blocks at
0 and 32767 ms; Cluster 2: block at 0) reads 65534 ms — the fallback adds the
last observed gap to the highest timestamp, so a boundary restart over-reads.
Over-reading is the safe direction for a cap; under-reading was the bug.

## Regressions added (test/server.test.js, "round 6" + API section)

- Scanner: the evasion shape reads 65534 across chunk sizes 1–∞.
- Scanner: consecutive unknown-size clusters keep a continuous timeline
  (0/1000, 2000/1000, 4000 → 5000 with the final gap).
- Scanner, fail-closed at the new path: a sibling-terminated cluster still
  needs its own Timestamp (before and after a good cluster) → null.
- API: the evasion shape uploads are refused 413 (`/minute/`); the same shape
  within the cap stores with its full parsed duration (3000 ms).
- API, added after review round 1: the two malformed Timestamp-less
  sibling-terminated fixtures go through the real authenticated
  `POST /api/clips` path — once with the Timestamp-less cluster first, once
  after a good cluster — each with a plausible client-supplied
  `x-duration-ms: 3000`. Both are refused 413, both leave the clips and tmp
  directories empty, and `/api/me` reports 0 clips / 0 bytes afterwards.
  Verified to fail on the pre-fix scanner (it stored the malformed file),
  pass with it.

Suite: 92/92 (`node --test test/server.test.js`).

## Browser checks (e2e/record.mjs) — local results, this branch's revision

Container Chrome needed libraries no root account could install; extracted the
bookworm .debs to /tmp/chrome-deps (LD_LIBRARY_PATH) and fonts into
~/.local/share/fonts. Both runs take the real product path past the synthetic
source (picker fallback only).

One real flake found and fixed in the test, not the product: the save-success
path refreshes the private clip list in the background (recorder.html calls
`renderServerClips()` un-awaited before showing the result screen), so the
stale-completion retry check now waits for the refreshed row count instead of
reading the list the instant the result shows. Share links still display
immediately — that ordering is correct product behavior.

Two more test-only fixes, added so the suite can also run against a reused
remote stack (a prerequisite for the deployed-revision results this post
still owes):

- `signUp` falls back to the sign-in form when the account already exists on
  a dev stack that ran the suite before (same credentials, same session).
- the final delete-everything step no longer re-seeds localStorage from a
  variable that is only captured when the suite booted its own server — on a
  remote baseUrl that re-seed clobbered the live session with `null`; the
  re-seed now happens only after the local backup/restore restart moved the
  origin.

Account-switch checks (4b–4e) all pass and assert non-leakage: sign-out and
sign-in-as-someone-else leave no rows and no `?k=` anchors/inputs; the result
screen clears its links; a switch-during-upload suppresses the departed
attempt's completion and lands the manage key in its owner's cache; a stale
completion never erases the successor's pending blob (retry, download and save
all work). No previous creator's links are exposed anywhere.

Separate-viewer acceptance: viewer metadata resolves, no delete button, video
actually plays (currentTime advances), download is byte-identical (SHA-256
match) with an attachment filename, manage key deletes, deleted links explain
themselves. Backup → wipe → restore → playback ran against the throwaway tmpdir
via scripts/backup.mjs + scripts/restore.mjs (isolated test data); the restored
server serves the same clip and accounts. This is a local instance of the same
revision, not the deployed instance — the deployed stack's data directory is
not mine to wipe, so restore is exercised locally while the deployed preview
gets the read-side checks (see below).

## Deployed revision — what is established and what is not

- Probed the dev preview directly with the same fixtures (2026-10-28 ~20:23
  UTC, probe account created and then deleted with its clips): the evasion
  upload was **accepted** with `durationMs: 0`, and the Timestamp-less
  first-cluster shape was accepted too — the preview was still running the
  pre-fix revision (main e4fe215). The branch deploys to the preview when
  this session's push lands, so the post-fix revision has not been observable
  there yet.
- Therefore: the full recorder browser suite against the deployed revision,
  and any deployed-acceptance claim, are deferred to the next session on this
  post, immediately after the push/merge — the e2e accepts a remote baseUrl
  precisely for that run. Nothing here claims deployed results.

## Real-Chrome picker check — pending, not done

Needs a human: recorded an attention request on post 61
(`real-chrome-picker-check`, due 2026-10-29T18:00Z) — real desktop Chrome,
real screen picker + microphone on the dev preview, then viewer playback,
download and author deletion. This container has no screen, no microphone and
no way to operate the real picker dialog, so the agent cannot perform this
check; headless Chrome's synthetic-capture path is not a substitute and is not
counted as it. Until a person completes it, post 61's acceptance is not
complete, whatever else passes.
