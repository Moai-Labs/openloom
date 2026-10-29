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
preview at f797f16 (2026-10-29, this session): 44 checks, all passed,
including "viewer does not see a delete button" for a fresh logged-out
session and "manage key shows a clickable delete button" for a real
manage link; all nine run accounts cleaned up afterwards.

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

Delivery ≠ acceptance. The full user-flow walk (sign-up/login, record,
logged-out viewing, playback, download, author deletion, second-account
isolation) passed on the local post-74 revision and on the deployed
f797f16 revision — but the deployed revision does not yet contain the
duration fix, and the real desktop-Chrome screen-picker + microphone
recording remains a human task. The final deployed walk of the merged
revision is the next session's first job once the platform deploys it.
