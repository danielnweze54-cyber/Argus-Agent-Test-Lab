# B4 Scenario Structure

B4 organizes the current scenario set by architecture/execution boundary, without moving or changing runtime scenario implementations.

## Blocks (static classification by topology)

### Block A — Direct bilateral

**Topology:** CLIENT ↔ RESOURCE_SERVER

- S8 — X402Payment
- S9 — X402Seller

Spec: [b4-block-a.md](./b4-block-a.md)

### Block B — Intermediated

**Topology:** CLIENT → FACILITATOR → RESOURCE_SERVER

- S1 — DuplicateRequest
- S2 — PaymentBeforeExecution
- S5 — ConcurrentDuplicate
- S6 — PaymentRetry
- S7 — LostDelivery

Spec: [b4-block-b.md](./b4-block-b.md)

### Block C — Current execution/evidence boundary

**Meaning:** the intended semantic scenario exists, but the current canonical runtime cannot produce the required evidence chain. C is not a run-order step; its semantics live on through runnable rail transfers (e.g. S4's lost-delivery semantics → S-BS-16, Block D S10).

- S3 — CrashAfterSettlement
- S4 — SellerTimeout

Spec: [b4-block-c.md](./b4-block-c.md)

### Block P — Payment rail program (families S-BC / S-BS)

**Meaning:** the payment-layer fault program against x402 rails. Family IDs
are historical and burned into public evidence (issue #3866, seals
#0000–0003, branch names) — they do not change. Spec:
[../block-b/MATRIX.md](../block-b/MATRIX.md) (RU source of truth) and
[../block-b/BLOCK_B_TEST_MATRIX.md](../block-b/BLOCK_B_TEST_MATRIX.md)
(consolidated EN reference).

- S-BC-01…15 — Argus = bad client; SUT = resource server
- S-BS-01…18 — SUT pays; Argus = bad server (incl. wave-3 demo transfers:
  S-BS-16 ← Block D S10 DeliveryUncertain, S-BS-17 ← Block D S11 OverBudget,
  S-BS-18 ← secretariat S-ZS-02 first-accept-wins)

## Run ladder (execution order — not the same thing as block letters)

Blocks classify by topology; the ladder defines the order in which a fresh
SUT is tested. Simplicity of required observation capability grows downward:
the gate needs only engine-boundary evidence, orchestration scenarios need
SUT-owned settlement/delivery observations.

| Order | Step | Contents | What it proves about the SUT |
|---|---|---|---|
| 1 | **Gate** | Block A (S8, S9) | The SUT is testable at all: x402 payment-required → sign → retry exchange works at the boundary |
| 2 | **Rails** | Block P (S-BC, S-BS families) | Payment fault behavior on live rails: invalid payments refused, no double-spend, no crash/hang; binding, budget, lost-response, first-accept-wins |
| 3 | **Orchestration** | Block B (S1–S7) | Intermediated flows: idempotency, ordering, retry, concurrent duplicates — requires mature observation channels |

Block C is outside the ladder (boundary classification, INCONCLUSIVE by design).

## Runtime/source boundary

The executable scenario implementations remain in src/scenarios/ and remain registered centrally by src/cli/ScenarioRegistry.ts.

B4 does not create separate runtime registries for A/B/C, move scenario source files, change imports, or alter execution semantics.

The A/B/C split is a documentation and planning structure until a later implementation task explicitly requires otherwise.

## Defect boundary

Known scenario defects/evidence gaps remain defects. They are not repaired merely because a scenario is classified into a block.

In particular:

- S3/S4 remain Block C.
- S6 remains Block B with an evidence-gap candidate.
- S7 remains Block B with a responder/emission candidate.
- Harness-only observations remain explicitly labeled as harness configuration.

## Evidence-path discipline

Paths referenced by sealed records are permanent (see `attestations/records/`
and `attestations/INDEX.json`): `docs/scenarios/b4-block-d-findings.md`,
`docs/block-b/fixtures/…`, `tools/paypal-adapter/evidence/…`. Reorganization
rebuilds around them — never renamed, never moved. New session fixtures go to
`docs/block-b/fixtures/<WAVE>/` so future seals can pin stable paths.
