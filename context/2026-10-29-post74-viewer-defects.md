# Post 74 — viewer Delete-button and duration defects (2026-10-29)

Branch `post-74` (from main f797f16). Holder feedback #72 reported two
defects on the share page; this session reproduced both, fixed what was
still broken, and ran the suites locally and on the deployed stack.

## Defect 1: the Delete button shown to anonymous viewers

**Reproduced on the revision that served the holder.** On 48eb7d5
(2026-10-28 09:27, pre-fix) a fresh browser context with no localStorage,
opening the plain share link, saw `#deleteBtn` with `display: block` —
the button carried the `hidden` class but the page had no `.hidden` rule
(commit 45d1796 added the rule and 19ee98e added the rendered-visibility
e2e check, both 2026-10-28 09:27). The page shipped 2026-10-27 14:58
(8dbeddc) with the class and no CSS, so every viewer saw the button until
the fix reached the public preview (no later than 20:34 UTC 2026-10-28,
deploy 2d13f83; also in f797f16 deployed 21:31 UTC).

**Verified fixed on the deployed revision.** Remote e2e run against the
preview (2026-10-28, prior session): 44 checks, all passed, including
"viewer does not see a delete button" for a fresh logged-out session and
"manage key shows a clickable delete button" for a real manage link; all
nine run accounts cleaned up afterwards. Re-run 2026-10-29 (this
session): 48 checks against the same deployed revision, all passed —
full list in the acceptance table below.

**New structural regression** (test/server.test.js): the served watch
page must carry both the `class="danger hidden"` button and the
`.hidden { display: none !important }` rule, so neither side can be
dropped silently again.

## Defect 2: displayed duration overshoots the actual recording

**Mechanism found and reproduced on current main.** `meta.durationMs`
came from the server's verified scan, whose trailing-gap fallback
estimates the last frame's length from the gap to the block before it.
A media timeline of 12 s whose final frames sit 3 s apart with no
asserted frame duration — the shape of a real screen recording of a
still screen — scans as 15000 ms. Exactly the holder's report: about
12 s of wall time displayed as 15 s. Dense synthetic recordings
(present in the e2e) never hit it, which is how it survived the browser
checks.

**Fix (8695348).** Enforcement keeps the conservative scan (the cap
still reads `verified`, unchanged). What is stored in
`meta.durationMs` — and so displayed — is now the shorter of the scan
and the wall-clock length the recorder declared via `x-duration-ms`,
which is also the number the recorder patches into Info.Duration, so
the text beside the player agrees with the player's scrubber. A declared
header longer than the scan is overruled by the scan.

Regressions added: a sparse 12 s fixture with a 3 s trailing gap uploads
and reports 12000 (the fixture asserts the scan says 15000 — the
overshoot pinned down), and a declared header longer than the scan is
overruled. API suite 95/95 local; browser e2e 50 checks local, all
passed.

**Confirmed on the deployed stack too:** the preview still serves the
pre-fix revision — an uploaded sparse 12 s clip with a 3 s trailing gap
displays `durationMs` 15000 there (probed 2026-10-29 via the API; the
account and clip were deleted afterwards). The same fixture against the
post-74 head locally reports 12000. The deployed display fix therefore
lands only with the next deploy of this branch.

**Residuals, stated plainly:**
- Clips stored before this fix keep their stored durationMs; only new
  uploads display the corrected number.
- An upload without `x-duration-ms` (a third-party client, not the
  recorder) still displays the conservative scan, which can overshoot
  for sparse media.
- The cap check itself can still over-count a sparse recording's final
  frame by the trailing gap (a legit clip within ~seconds of the limit
  could be refused). Real desktop-Chrome pacing is the unknown here;
  the team's real screen-picker recording (existing attention records
  on posts 17 and 61, due 2026-10-29T18:00Z) will show a real
  recording's display and, if the team reports the length it shows, its
  scan behaviour.

## Acceptance state

Delivery ≠ acceptance. Recorded here per flow, per revision, no
synthetic check dressed as a human one. Two revisions are in play:

- **Local head** — post-74 at e8b7708 + this session's e2e anchor fix
  (puppeteer Chrome 156, the product's own recording path with a
  synthetic capture source substituted only where headless Chrome cannot
  open the real picker).
- **Deployed preview** — https://fl-dev-c108db22-0516-4540-b619-10c4a6bf1b9d.fly.dev,
  serving revision f797f16 (verified empirically, not assumed: the
  sparse-duration probe above returns 15000 there, 12000 on the local
  head).

### Synthetic browser walk — deployed preview, revision f797f16, 2026-10-29

Full e2e suite, 48/48 checks passed, every run account deleted
afterwards (the suite is built for the shared dev stack: per-run
identities, finally-block cleanup):

- Sign-up and sign-in (fresh creator); recording and save; a second
  recording from the same page; share and manage links produced.
- Startup races: repeated Start clicks start one capture flow; Start
  disabled while startup is pending; capture ending mid-startup aborts
  cleanly and releases the microphone; Start usable again after a
  recorder error; a recorder error finalizes exactly once as a failure.
- Dual-source recording (display audio + microphone mixed); clip
  carries audio.
- Free cap: usage meter 3 of 3, Start names the limit and refuses.
- Second-account isolation: a second account's list is private and
  empty; sign-out empties the list and manage keys; another creator on
  the same browser sees none of the first creator's clips; an upload
  finishing under a switched-in account shows none of the owner's
  links and saves to the submitting account; stale completions leave
  the successor's result alone; the successor can retry their own
  recording.
- Logged-out viewing: the share link plays for a fresh viewer with no
  account; **no Delete button rendered for the viewer** (defect 1);
  download is byte-identical to the recording with an attachment
  filename.
- Author deletion via the manage key from a fresh session; the deleted
  link explains itself; export is a tar with manifest, meta and video.

Reliability regressions against the same deployed preview, 11/11
passed (2026-10-29, direct API with cleanup): over-cap declared
duration refused; a 6-minute real timeline refused while the header
claims 1 s; a BlockDuration stretching past the cap refused;
parse-then-garbage refused with no partial duration; omitted-Duration
6-minute timeline refused and an omitted-Duration 8-second one stored
with its parsed 8000; random bytes refused; a webm-shaped file with no
timeline refused (fail closed).

Restart/restore: exercised on the local head only (backup → wipe →
restore → playback, accounts survive — part of the 50/50 local e2e,
twice this session). The deployed instance's data directory is not
mine to wipe, and the remote e2e skips backup/restore there for that
reason.

### Local head, same session

API suite 95/95; browser e2e 50/50 twice (the remote suite is the same
suite minus the restore steps). The sparse-duration and
scan-overrules-header regressions run here — they cannot pass on the
deployed f797f16 revision, which is the marker that the deployed walk
below is still owed.

### Two harness defects found and what was done

- The e2e's timer-freshness check anchored its clock after the
  recording state appeared; a busy session between the page starting
  the recording and the test stamping the anchor made the page look
  falsely 1.6 s ahead and aborted one remote run. Anchors are now
  stamped before the Start click — the recording cannot be older than
  the click — which keeps the stale-timer regression's teeth while
  removing the false positive.
- Twice in four remote runs, the dual-audio step's recording finalized
  with zero chunks and the page said "Nothing was recorded." (the
  product's honest handling); the same step passed locally 3/3 and in
  both subsequent remote runs. Suspected synthetic-source artifact
  (canvas captureStream/AudioContext in the injected fake), not
  observed on the real product path; the human screen-picker recording
  below is the check that covers real capture.

### Explicitly still unperformed

1. **The deployed walk against the revision containing the duration
   fix.** The platform deploys on merge, and the merge awaits review
   approval — verified empirically above that the preview still serves
   f797f16. The moment this branch is deployed, the same 48-check walk
   plus the sparse-duration display check (a still-screen recording
   must display its wall-clock length) runs against it and this record
   is updated with that revision's hash. Until then the duration fix
   is verified by the API regression and the local walk only.
2. **The real desktop-Chrome screen-picker + microphone recording** —
   a human task; headless Chrome cannot operate the picker. The
   existing team requests on posts 17 and 61 (due 2026-10-29T18:00Z)
   are reused unchanged; no duplicate was filed.
3. **Restart/restore against the deployed instance** — covered on the
   identical revision locally (above); wiping the deployed instance's
   data is not something this session can do.
