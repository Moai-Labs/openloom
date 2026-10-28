# Post #62 — Validate sharing and repeat use with outside creators

Date: 2026-10-28. Branch: `post-62`. Target: 10 November 2026.

Post #62 is a validation step, not a feature step. Its deliverables:

1. A short invitation and onboarding guide, published, stating the free
   limits and the test-payment label.
2. Voluntary participants invited through the public feed and holder
   introductions.
3. **Five real clips watched by someone other than their author.**
4. **One creator outside this community** making a verified test-USDC
   upgrade and returning to record again.
5. An aggregate result published with what users found difficult — no
   private account or clip data. If the target is missed, say so and
   recommend the next decision.

Constraints from the post: test payments count as workflow validation,
never revenue; no new payment rail, no paid promotion, no feature
expansion.

## What counts as verified

- **A clip watched by someone other than its author.** The share link is
  public — I can confirm the clip exists and is served by fetching the
  link. "Watched by someone else" is confirmed by that person saying so
  publicly (a feed reply naming the clip or its author), or by the
  participant forwarding their confirmation to their introducer, who
  reports it in the thread. A self-report from the author alone does not
  count.
- **An outside creator.** Someone who arrived through a holder
  introduction or the public invitation, is not one of the holders and is
  not me. Their upgrade counts when a payment invoice for their account is
  verified by the server's on-chain check (right chain, right contract,
  exact 10 test USDC to the invoice's own address). Their "returning to
  record again" counts as a second clip created after the verified
  payment.
- **Evidence I can check without private data.** A participant may publish
  the transaction hash in the thread — it is public chain data; I re-verify
  it on Base Sepolia myself. I never publish emails, account ids, clip
  contents, invoice addresses or anything linking a clip to an identity.

## Privacy rules for everything published

- Aggregate numbers only (counts, minutes, durations of the *process*, not
  of identifiable people's data).
- No clip titles, no emails, no handles of participants who did not
  consent, no share links unless the participant posted the link publicly
  themselves.
- Difficulties reported are described in the words people gave us or
  paraphrased without identifiers.

## Tracker (filled in as evidence arrives, never published raw)

| # | requirement | status | evidence |
|---|-------------|--------|----------|
| 1 | Invitation + onboarding guide published with free limits and test-payment label | published 2026-10-28 | see the session thread of post #62 |
| 2 | Invitations on the public feed + holder introductions asked | posted 2026-10-28 | same thread |
| 3 | Clip 1 watched by a non-author | pending | |
| 4 | Clip 2 watched by a non-author | pending | |
| 5 | Clip 3 watched by a non-author | pending | |
| 6 | Clip 4 watched by a non-author | pending | |
| 7 | Clip 5 watched by a non-author | pending | |
| 8 | Outside creator: verified test-USDC upgrade | pending | |
| 9 | Outside creator: returns and records again | pending | |

## Session plan against the 10 November target

- 2026-10-28 (this session): guide published, invitations out, protocol set.
- Next sessions: answer participants, track watches and the upgrade,
  record difficulties. The gating acceptance check for inviting real
  users — a human recording through the real desktop-Chrome picker — sits
  on post #61 (due 29 October 18:00 UTC); if it fails, invitations pause
  and participants are told straight away.
- By 10 November: publish the aggregate result and difficulties, or the
  miss and a recommended next decision.
