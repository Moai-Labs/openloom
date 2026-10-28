# Post 61 — close reliability and real-Chrome acceptance gaps (2026-10-28)

Branch `post-61` (from main e4fe215; origin/main 2d13f83 merged in this
session, d8b52f1). The final free-plan review finding was reproduced against
current main and fixed on this branch.

**Acceptance status: not complete.** What is done and what remains is listed
per evidence run below. Two items cannot be produced from this lane until the
platform merges this branch — the deployed-revision run on the fixed scanner,
and the human desktop-Chrome confirmation (a person, not the agent) — and the
document says precisely where each stands rather than claiming either.

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

Suite: 92/92 (`node --test test/server.test.js`), re-run after merging
origin/main into this branch.

## Why the deployed preview cannot serve this branch's fix yet

The dev preview deploys the default branch: CI builds images on pushes to
main (`.github/workflows/build.yml`), and `deploy.json` runs the commit that
was deployed. This branch's pushes go to `refs/heads/post-61`, which CI does
not build and the deploy does not run — `git ls-remote origin` shows CI and
delivery verdicts only for main commits, and none for a1352dd. Probes against
the preview during this session (2026-10-28 20:34 and 20:35 UTC, probe
accounts created and then deleted with their clips) confirmed it directly:
the evasion upload was **accepted** there with `durationMs: 0` — pre-fix
scanner behavior. main's latest commit 2d13f83 (post-62's merge) does not
carry the fix.

So the deployed preview runs the fixed scanner only after the platform
merges post-61 into main; and the merge waits on this post's review
approving it. Round 2's required change asked for deployed-revision results
"after the branch preview deploys" — that deploy cannot happen before the
review approves the merge, so those results cannot exist yet in this lane.
What this session did instead, and what completes them the moment the merge
lands, is below; the one-command post-merge plan is at the end.

## Browser checks — run A: this branch's revision, local (2026-10-28 20:41 UTC)

`node e2e/record.mjs` (self-started server, throwaway data dir): **50 checks,
0 failed.** Headless Chrome; the real product path past the synthetic source
(picker fallback only). Re-run to the same result after the remote-mode
changes below, on the suite's final form. Container Chrome needed hand-setup
again this session
(/tmp/chrome-deps via extracted .debs, fonts via FONTCONFIG_PATH — recipe in
the post-17 context file; the debs are fetched into the repo cwd by
`apt-get download`, so extract and delete them, never commit them).

One real pre-existing flake re-confirmed as fixed in the test, not the
product: the save-success path refreshes the private clip list in the
background, so the stale-completion retry check waits for the refreshed row
count instead of reading the list the instant the result shows.

Account-switch checks (4b–4e) all pass and assert non-leakage: sign-out and
sign-in-as-someone-else leave no rows and no `?k=` anchors/inputs; the result
screen clears its links; a switch-during-upload suppresses the departed
attempt's completion and lands the manage key in its owner's cache; a stale
completion never erases the successor's pending blob (retry, download and
save all work). No previous creator's links are exposed anywhere.

Separate-viewer acceptance in the same run: viewer metadata resolves, no
delete button, video actually plays (currentTime advances), download is
byte-identical (SHA-256 match) with an attachment filename, manage key
deletes, deleted links explain themselves.

## Browser checks — run B: the deployed stack, remote (2026-10-28 20:46 UTC)

`node e2e/record.mjs https://fl-dev-…fly.dev` — the full suite against the
dev preview over the network. **Result: 48 checks, 0 failed** (backup/restore
is skipped in remote mode — run C below covers it on the same revision). This
run is tied to the deployed revision **as it is**: main 2d13f83, whose
scanner does not yet carry the fix — so it is stack evidence, not evidence
for this branch's fix, and post-61's acceptance does not claim it.

Three test-only changes were needed to make remote runs safe on a shared
stack, all added this session:

- Step 0 pre-clean: the suite's fixed accounts (author@example.com and the
  others) survive from an earlier suite run — a 12:16 UTC run had left
  author@example.com full at 3 clips, which disables Start recording and
  failed the first remote attempt at "Record another". The suite now signs
  each fixed account in (only the suite's own password matches) and deletes
  the account before the checks, so a reused dev stack starts clean.
- Step 15 cleanup: after the checks, every fixed account is signed in again
  by password and deleted, clips and all, so a shared-stack run leaves
  nothing behind for the holders post-62 is inviting. The first version used
  the tokens captured at sign-up and missed two accounts whose sessions the
  account-switch scenarios had signed out mid-suite (401 on delete) — the
  final version re-authenticates by password, and the accounts the interim
  version missed on the preview were removed the same way right after. Only
  accounts that authenticate with the suite's own password are ever removed.
- "Delete everything" is already scoped to the signed-in account
  (`removeAllFor(account.id)`), so nobody else's data is ever touched —
  verified by the run itself: the first remote attempt's clip was the only
  new one on a 3-clip account.

The deployed instance's data directory lives on the platform's volume and is
not this lane's to wipe or restore; nothing in either run touched it.

## Backup → wipe → restore with isolated test data, same revision as the stack

Two demonstrations, both on throwaway data directories, neither touching the
deployed stack's volume or any shared data:

- Run A (above) covers the full cycle on this branch's revision: backup,
  wipe the data dir, restore with manifest verification, and the restored
  server serves the same clip and the accounts survive.
- Run C (2026-10-28 20:50 UTC) repeats it on a local instance of main
  2d13f83 — the exact commit the deployed preview serves — so the
  backup/restore evidence exists for the same revision the stack runs today,
  with isolated test data: **50 checks, 0 failed**, including the
  backup → wipe → restore cycle.

After the merge, the same local cycle runs on the merged revision (which is
then also the deployed one).

## Real-Chrome picker check — pending with the team, not done

Recorded as an attention request on post 61 (`real-chrome-picker-check`,
due 2026-10-29T18:00Z): real desktop Chrome, real screen picker +
microphone on the dev preview, then viewer playback, byte-identical
download and author deletion. Re-pinged in the thread this session with a
note that the current preview is valid for it — picker, microphone,
playback, download and deletion behave identically on the deployed and
branched revisions; only the duration readout differs (the pre-fix scanner
under-measures multi-cluster recordings, which is this branch's fix).

This container has no screen, no microphone and no way to operate the real
picker dialog, so the agent cannot perform this check; headless Chrome's
synthetic-capture path is not a substitute and is not counted as it. Until
a person completes it and the evidence is recorded, post 61's acceptance
stays incomplete, whatever else passes.

## Completion plan once the platform merges this branch

1. The preview redeploys with the fixed scanner; re-probe with the evasion
   fixture — expect 413 `/minute/`.
2. `node e2e/record.mjs https://<preview>` — the full suite, tied to the
   now-fixed deployed revision, including every account-switch non-leakage
   check; publish results.
3. Record the team request's real-Chrome evidence (or complete it then, if
   it lands after the merge).
4. Mark acceptance complete in this document and the post's thread only
   when 1–3 are all on record.
