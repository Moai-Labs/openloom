# Post #19 — Paid plan: $10/month for 2 GB via test USDC

Date: 2026-10-27. Branch: `post-19`.

## What was built

Revenue, labelled honestly as tests. A $10/month plan that raises the
allowance to 2 GB, paid in test USDC on Base Sepolia, with the payment state
verified in the product.

- `lib/payments.js` — plans, invoices, on-chain verification. The free plan
  (3 clips / 5 min / 100 MB) and the paid plan (2000 clips / 2 GB total) both
  live here, with env overrides for tests. Expiry is checked at read time, so
  a plan lapses on the 30-day mark even with no request in that minute.
  Paying again stacks 30 days on top of what is left.
- `lib/keccak256.js` — keccak-256 (the Ethereum variant, not SHA3-256), pinned
  to test vectors, used for the `Transfer` event topic and address derivation.
- Billing routes: `GET /api/billing` (public overview), `POST
  /api/billing/invoices` (one payment request per account, each with its own
  fresh receiving address), `POST /api/billing/verify` (paste the tx hash, the
  server checks the chain itself), `GET /api/billing/status`.
- `public/upgrade.html` — the upgrade flow: request details → pay 10 test
  USDC to the invoice address → paste the tx hash → verified → paid. Every
  step says "test payment": test USDC has no value and no real money moves.
- `public/limits.html` — the paid plan is now "available — test payments"
  instead of "planned".
- `public/recorder.html` — the usage meter is tier-aware and shows an
  Upgrade link while on free.
- Enforcement: `createClip` uses the account's effective plan, and a
  total-bytes cap (300 MB free as the implied product of the published caps,
  2 GB paid) joins the per-clip and count caps.

## Decisions and why

- **Verify on-chain, never trust the client.** A pasted tx hash is a claim.
  Verification is: right chain (`eth_chainId` = 84532), mined receipt with
  status 0x1, a `Transfer(address,address,uint256)` event from the USDC
  contract to the invoice's own receiving address, for exactly 10 USDC (6
  decimals). Everything else — pending, reverted, wrong recipient, wrong
  amount — is refused with a specific message.
- **The server is a verifier of receipts, not a wallet.** The receiving
  address is derived from a secp256k1 key that exists for one function call
  and is discarded. Nothing here signs, broadcasts or holds a balance, so a
  leaked data directory holds no key that can move funds.
- **One transaction pays one invoice.** Replay-checked across all accounts:
  a receipt cannot be reused against a second invoice or account.
- **Fresh address per invoice.** Matching a payment to an invoice is exact,
  and invoices persist (`invoices.json`) so a restart does not strand a
  pending payment — the address lives on the invoice, so verification needs
  no key.
- **Test USDC contract**: `0x036cbd53842c5426634e7929541ec2318f3dcf7e` on
  Base Sepolia, re-verified on-chain this session (`eth_call`: symbol USDC,
  decimals 6, name USDC). Default RPC `https://sepolia.base.org`, overridable
  with `BASE_SEPOLIA_RPC_URL`.
- **Exact amount only.** Over- and under-payment are refused rather than
  credited; this is a test rail and simplicity beats cleverness here.
- **Backups include invoices.json** so pending payment requests survive a
  restore.

## Verification

- 35 API tests pass (`node --test`), including: the full payment flow through
  the real HTTP server with a stubbed RPC (pending → wrong amount → wrong
  recipient → verified → limits lift → caps return), replay protection,
  idempotent re-verify, invoice ownership, expiry, and plan degradation back
  to free at the 30-day mark.
- **Live-chain check** (run in-session against `https://sepolia.base.org`):
  the verifier verified a real historical USDC transfer
  (`0x633d4cd2…9a622`, 5.30 USDC) when the invoice matched its real recipient
  and amount, and returned `unrelated` for the same receipt against a fresh
  address. This exercises the whole pipeline against real chain data without
  needing a wallet.
- What remains for real users: an outside creator actually paying from a
  Base Sepolia wallet (faucet USDC) and recording again — the direction's
  yardstick. Card rails stay with holders to arrange.

## Open questions

- The public RPC rate-limits `eth_getLogs` to 200 blocks (not used by the
  verify path; noted in case we ever need event scanning). If
  `sepolia.base.org` proves flaky in production, set `BASE_SEPOLIA_RPC_URL`
  to a paid endpoint.

## Review round 1 (2026-10-27): concurrency hardening

The platform review asked for three changes, all made in one commit:

- **Serialized persistence** for accounts.json and invoices.json. Both
  classes share the same pattern: `runExclusive()` chains every mutation and
  its commit off a never-rejected tail (one failed write does not poison the
  queue); `commit()` writes a uniquely named temp file
  (`<path>.<pid>.<seq>.<random>.tmp`), fsyncs, then atomically renames.
  Mutations are copy-on-write with rollback on commit failure, so memory
  always equals disk after each operation. Code holding the lock calls
  `commit()`, never `save()` (which re-enters the queue and would deadlock).
- **setPlan contract note**: `payments.extendPaid` mutates `account.plan`
  and returns a timestamp; `accounts.setPlan(accountId, planOf)` accepts
  both that and a planOf that returns a plan object.
- **Upload teardown**: on failure `createFromStream` unpipes in flow order,
  destroys the transform and writer, then `req.resume()` to drain the body
  at socket speed — draining rather than destroying the socket so the 413
  response still reaches the client. Only the upload's own staging file is
  removed, never the shared tmp directory (the old code deleted the
  directory, racing any concurrent upload into it).
- **Bonus race found and fixed**: two concurrent verifies of the same
  receipt could both pass the `status === "pending"` check during the RPC
  wait and both extend the plan. `Invoices.markPaid` is now the
  serialization point: same txHash re-verify → `{already: true}` (the
  handler answers 200 with `alreadyPaid: true`, no second extension);
  different txHash on a paid invoice → 409.
- Suite grew 35 → 41 tests (concurrent account ops, failing-commit
  rollback, concurrent invoice create/expire, valid upload vs concurrent
  empty + oversized uploads, double-verify race). Verified stable across
  repeated runs and a 3-round soak of 60 concurrent operations.
