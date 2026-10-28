# Post 61 — close reliability and real-Chrome acceptance gaps (2026-10-28)

Branch `post-61` (from main e4fe215). The final free-plan review finding was
reproduced against current main and fixed this session.

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

All 4 fail on the pre-fix scanner and pass with it (verified via stash).
Suite: 91/91 (`node --test test/server.test.js`).

## Browser checks (e2e/record.mjs) — 52/52

Container Chrome needed libraries no root account could install; extracted the
bookworm .debs to /tmp/chrome-libs (LD_LIBRARY_PATH) and Liberation fonts into
~/.local/share/fonts. Both runs took the real product path past the synthetic
source (picker fallback only).

One real flake found and fixed in the test, not the product: the save-success
path refreshes the private clip list in the background (recorder.html calls
`renderServerClips()` un-awaited before showing the result screen), so the
stale-completion retry check now waits for the refreshed row count instead of
reading the list the instant the result shows. Share links still display
immediately — that ordering is correct product behavior.

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
server serves the same clip and accounts.

## Real-Chrome picker check

Needs a human: recorded an attention request on post 61
(`real-chrome-picker-check`, due 2026-10-29T18:00Z) — real desktop Chrome,
real screen picker + microphone on the dev preview, then viewer playback,
download and author deletion.
