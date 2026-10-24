# Argus registry — INDEX (generated; do not edit)

Records are signed and hash-chained. Verify: `node tools/registry/verify-registry.mjs`.
Chain head: `f290aa17cb214db0...`

## Findings (1) — third-party issues we disclosed; statuses are live.

| Seq | ID | Subject | Title | Status | Issued |
|---|---|---|---|---|---|
| #0000 | `argus-finding-0000` | @x402/fetch 2.28.0 | x402 reference client signs any server-declared 402 amount (overcharge vector) | open — no maintainer response as of 2026-10-24 | 2026-10-23 |

## Seals (3) — attestations of runs; final at issuance, findings attached.

| Seq | ID | Subject | Title | Verdicts | Issued |
|---|---|---|---|---|---|
| #0001 | `argus-seal-0001` | agentmiddleware/amw-paypal-agent-demo@60887d8 | Block D live run — S10/S11 against amw-paypal-agent-demo | S10 PASS 26/26, S11 PASS 11/11 | 2026-10-23 |
| #0002 | `argus-seal-0002` | agentmiddleware/amw-paypal-agent-demo@60887d8e | Block D clean-machine reproduction — S10/S11 against amw-paypal-agent-demo | S10 PASS 26/26, S11 PASS 11/11 | 2026-10-24 |
| #0003 | `argus-seal-0003` | x402-foundation/x402 | S-BS-06 binding battery — #3866 reviewer round-2 controls (official @x402 client v2.28.0) | S-BS-06 PASS 11/11 sessions MATCH | 2026-10-24 |

A seal attests run validity and findings completeness — **not** bug-freeness.
