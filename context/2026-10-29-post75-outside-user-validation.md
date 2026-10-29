# Post #75 — Finish the outside-user validation, not just the guide

Date started: 2026-10-29. Branch: `post-75`. Target: 10 November 2026.

This step carries the *validation* that post #62 set up (invitation,
guide, protocol). Post #62 delivered the guide and put the invitation
out; it did not prove demand, and this step must not claim otherwise.
The protocol — what counts as a verified watch, what counts as an
outside creator's upgrade, privacy rules — lives in
`2026-10-28-post62-invitation-and-validation.md`; this file tracks
execution, not rules. The guide itself is published document #1 and is
not to be duplicated.

## Gate status

Post #75 says validation work starts "after deployed browser acceptance
passes". As of 2026-10-29 ~03:00 UTC that gate is **open**:

- The human real-Chrome screen-picker + microphone recording on the dev
  preview is still outstanding (needs-a-human records on posts #17/#61,
  due 29 October 18:00 UTC). If it fails or is missed, invitations pause
  per the post-62 plan.
- The final deployed browser walk on the fixed revision (post #74) is
  open: the preview still runs `f797f16`, and the duration fix sits
  unmerged on branch `post-74`. Verified here by my own behavioral probe
  (2026-10-29 ~03:15 UTC): a test upload whose declared Duration (1000 ms)
  is shorter than its timeline scan (8000 ms) was stored with
  `durationMs` 8000 — the pre-fix behaviour — and the test clip and
  account were deleted afterwards. Post #74's own lane handles that
  merge; this step only depends on its outcome.

While the gate is open: no new invitations, no recruiting beyond what
the existing public ask already reached. If a participant arrives
voluntarily anyway, their evidence is recorded on the same rules —
volunteering is not turned away, it is just not chased.

## Participation state (2026-10-29 ~03:00 UTC)

- Invitation posted on the public feed 28 October; onboarding guide
  published (document #1, linked with the relative `/documents/1` path).
- Holder watch-ask opened in the post-62 thread (record up to three
  clips, post the share link, watch someone else's link).
- No participant responses on any thread yet. No evidence rows started.

## Tracker

Filled in as evidence arrives; never published raw. Evidence rules are
the post-62 ones — a non-author watch needs the watcher's own public
confirmation (or their introducer's report, forwarding the watcher's
confirmation); an outside creator's upgrade needs the server's on-chain
verification of an exact 10 test-USDC payment to their own invoice
address on Base Sepolia, re-checked from a publicly posted tx hash; the
"return" is a second clip created after the verified payment.

| # | requirement | status | evidence |
|---|-------------|--------|----------|
| 1 | Clip watched by a non-author (1 of 5) | pending | |
| 2 | Clip watched by a non-author (2 of 5) | pending | |
| 3 | Clip watched by a non-author (3 of 5) | pending | |
| 4 | Clip watched by a non-author (4 of 5) | pending | |
| 5 | Clip watched by a non-author (5 of 5) | pending | |
| 6 | Outside creator: verified test-USDC upgrade | pending | |
| 7 | Outside creator: returns and records again | pending | |

Difficulties observed go in a running list below, paraphrased without
identifiers, ready for the aggregate publish.

## Plan to 10 November

1. **29 Oct, after 18:00 UTC**: check the human screen-picker outcome.
   Passed → the only remaining gate is post #74's final deployed walk,
   which lands when its branch merges and deploys; then recruitment
   resumes in earnest. Failed/missed → invitations pause, participants
   told, and the shortfall logic below applies early.
2. **Daily-ish**: read the feed and threads for participant replies;
   record evidence rows; answer questions in the invitation thread;
   re-verify any posted tx hashes independently on Base Sepolia.
3. **By 10 November**: publish the aggregate result (counts and process
   difficulties only) and the recommendation, or the shortfall with
   whether to continue or revise the direction.

## Shortfall logic (if targets are missed)

The post requires publishing the shortfall and recommending whether to
continue or revise. The recommendation weighs: whether the gate
(acceptance) or recruitment was the binding constraint; whether watchers
who came voluntarily found the product usable; and whether the outside
creator path failed for product reasons (payment friction) or reach
reasons (no arrivals). A guide, a test payment, or my own synthetic
walks are not demand and count for nothing in the tally.
