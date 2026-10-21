# BLOCK B TEST MATRIX

**Payment fault scenarios for x402 (Argus-Agent-Test-Lab)**

Block B stress-tests the payment behaviour of a **system under test (SUT)**
treated as a black box. Argus deliberately misbehaves on one side of an
x402 exchange and the harness observes how the SUT reacts — whether it
loses money, crashes, hangs, or hands over resources for invalid payments.

This document is the consolidated English reference. The Russian working
documents (`REGISTRY.md`, `MATRIX.md`) remain the day-to-day source of
truth; the historical v1 docx matrix is superseded by them.

---

## 1. Families and roles

| Family | Argus plays | SUT plays | What we observe |
|---|---|---|---|
| **S-BC** | bad client | resource server (accepts payments) | how the SUT rejects/accepts invalid payments and whether it issues the resource |
| **S-BS** | bad server | client (pays for a resource) | how the SUT protects its money and its state against a hostile payee |

Role invariants:

- **One run = one family = one SUT role.** Families are never mixed in a
  single run; `--family` is mandatory for block B commands.
- **The operator declares who the SUT is** in the connection config
  (`--sut-url` for BC, `--bind` for BS). Only the SUT owner knows the
  deployment's protocol role. The runner derives the required role from the
  family (`rolesForFamily`) and refuses to start on a mismatch.
- **Role gates** ("canonical gates"): before a family starts, a canonical
  happy-path is executed in that role. BC gate: honest Argus pays the SUT
  and expects `200 + settlement receipt`. BS gate: the SUT pays an honest
  Argus server; exactly one payment and a served resource is expected.
  A failed gate aborts the family with exit code 2 — there is no point in
  faulting a SUT that cannot do the happy path.
- Batch order after gates: **BC first, then BS**
  (`BLOCK_B_FAMILY_ORDER`), each family as a separate run.

## 2. Verdict policy (codified)

The SUT is a **black box**: we do not know its policy, logic, or code. We
create one deliberate fault and observe external behaviour. The harness
therefore separates **verdicts** from **facts**:

### Verdicts

| Verdict | Meaning |
|---|---|
| `PASS` | No objective harm observed within the observation window W (W is printed next to the verdict) |
| `FAIL` | A spec violation (x402 / EIP-3009) or objective harm was observed: double payment; overpayment accepted; resource issued for an invalid payment; crash / unhandled exception; hang |
| `ADVISORY` | A recorded risk whose defence requires an SUT-side policy (merchant whitelist, receipt tx-hash verification, content checking). A black box cannot be expected to guess policy it cannot see |
| `HARNESS_ERROR` | The test rig's own failure. Not a SUT verdict; the run is repeated |

### Facts (recorded, never thresholds)

- Retry counts, timings, backoff shape of the SUT — **SUT policy**
  (decision V1: the harness records `retry_observed` verbatim and applies
  **no thresholds** to it);
- counts of repeated 402s, payment payloads, durations — raw report data.

### Codified review decisions

1. **V1 (retries / transient degradation)** — outside the harness's
   jurisdiction. Facts only, no thresholds.
2. **V2 (overpayment)** — any deviation from the exact amount is `FAIL`.
   "The merchant profits" is not accepted as a defence.
3. **Observation windows** — rig parameter `--observe-window-ms` with a
   per-run default; a `PASS` is valid within the printed window
   (S-BS-02 default 120 s in CLI; configurable — resolves the
   "is 60+60 s enough?" dispute).
4. **Exit codes** (CR-2 compatible): `0` — no FAIL; `1` — at least one
   FAIL; `2` — HARNESS_ERROR or failed gate. `ADVISORY` does not affect
   the exit code.

Refinements versus the historical docx v1 matrix (aligned with the runner):

- **S-BS-02**: in blockchain-less mock mode a "second charge" is observed
  as a repeated payment demand with the same requirements / a duplicate
  settlement receipt. `FAIL` = the SUT paid a second time (objective
  double payment).
- **S-BS-03**: downgraded from FAIL to ADVISORY — demanding tx-hash
  verification is SUT client policy, invisible to a black-box observer.
- **S-BS-04**: the observable FAIL is a repeated payment after a verify
  rejection (objective double payment); "crash/hang" of an external
  black-box client is not directly observable — recorded as session
  termination shape (facts).
- **S-BS-08 / S-BS-09 / S-BS-13**: the per-row criterion is ADVISORY
  (bookkeeping/policy), but the generic policy of §1 still applies: a
  second payment (objective double payment) is FAIL in S-BS-08/S-BS-09.
- **S-BC-11 duplicate-send**: the payment is VALID; the fault is the
  double send. Expected: first send accepted, replay (same nonce)
  rejected. FAIL = both sends accepted (double settle).
- **S-BC-13 wallet-kyt-edge**: a public facilitator does not expose KYT
  flag control; the objectively checkable failure is the crash class
  (5xx). Full KYT profiles need a KYT-emulating facilitator (phase 2).
- **S-BC-14 frontrun-drain**: implemented as a deterministic settle-race
  (attacker submits the signed authorization to the SUT's facilitator
  settle endpoint BEFORE the SUT settles). Requires
  `--facilitator-settle-url`; without it the run is HARNESS_ERROR.
- **S-BC-15 upto-overdraft**: applies only to SUTs advertising the `upto`
  scheme; on exact-only SUTs the scenario is NOT APPLICABLE (PASS with an
  explicit reason; accepting a valid exact payment is correct behavior).

## 3. CLI

```bash
# list all registered scenarios (all 28 in code: wave 1 × 10 + wave 2 × 18)
argus list --block B

# role gates (mandatory before a family run)
argus gate --block B --family BC --sut-url https://sut.example/resource
argus gate --block B --family BS --bind 127.0.0.1:3461

# whole BC family after the gate (client-side scenarios are safe to batch)
argus run --block B --family BC --sut-url https://sut.example/resource

# ONE specific scenario, N repetitions
argus run --block B --family BS --scenario S-BS-11 --repeat 5 \
    --bind 127.0.0.1:3461 --observe-window-ms 180000

# S-BC-14 needs the SUT's facilitator settle endpoint (settle-race probe)
argus run --block B --family BC --scenario S-BC-14 \
    --sut-url https://sut.example/resource \
    --facilitator-settle-url https://facilitator.example/settle

# funding before a BC run/gate (decision V3)
argus run --block B --family BC --sut-url https://sut.example/resource \
    --funding manual --rpc-url https://sepolia.base.org
```

Flags and environment:

| Flag / Env | Purpose |
|---|---|
| `--family BC\|BS` | required; selects the SUT role |
| `--scenario S-XX-NN` | run a single scenario (BS requires it: each BS scenario needs a fresh SUT session) |
| `--repeat N` | attempts; every attempt gets an independent fact log; verdicts are aggregated worst-case (default 1; race/replay scenarios may suggest more) |
| `--observe-window-ms W` | post-settlement observation window (BS default 120000 in CLI) |
| `--sut-url URL` / `ARGUS_B_SUT_URL` | BC: the SUT resource-server URL |
| `--bind HOST:PORT` / `ARGUS_B_BIND` | BS: where Argus hosts the bad server |
| `ARGUS_TEST_WALLET_PRIVATE_KEY` | BC: one-shot key of the bad client (viem-based signer) |
| `--facilitator-settle-url URL` / `ARGUS_B_FACILITATOR_SETTLE_URL` | S-BC-14: the SUT facilitator settle endpoint (settle-race drain probe; without it the scenario is HARNESS_ERROR) |
| `--funding auto\|manual` / `ARGUS_B_FUNDING` | BC: funding mode (V3) — auto = faucet + manual fallback, manual = balance check only |
| `--faucet-url URL` / `ARGUS_B_FAUCET_URL` | faucet endpoint accepting `POST {wallet, amount} → {ok, txHash}` |
| `--rpc-url URL` / `ARGUS_B_RPC_URL` | RPC endpoint for the USDC `balanceOf` check (required with `--funding`) |
| `--funding-min-atomic N` | minimum balance in atomic units (default 100000 = 0.1 USDC) |
| `--price`, `--json`, `--skip-gate`, `--request-timeout-ms` | misc: BS resource price (atomic units), machine-readable report, gate skip, HTTP timeout |

Exit codes: `0` / `1` / `2` as per the verdict policy.

## 4. Funding (decision V3)

Automation first, manual as a fallback
(`src/blockb/FundingProvider.ts`):

- `AutoFundingProvider` checks the one-shot wallet's USDC balance and, if
  short, calls the configured faucet for exactly the missing amount, then
  re-checks. On faucet failure it raises `ManualTopUpRequiredError` with
  the address and the exact missing amount — the operator tops up manually
  and simply re-runs (the balance check repeats automatically).
- `ManualFundingProvider` — closed stands / exhausted CI faucet limits:
  balance check only, faucet never called.

## 5. Canonical resource (decision V4)

All tranche scenarios serve/consume one **minimal universal resource body**
(`src/blockb/CanonicalResource.ts`):

```json
{
  "v": 1,
  "service": "argus-block-b",
  "scenario": "S-BC-01",
  "attempt": 1,
  "echo": "<sha256 of the request fingerprint>"
}
```

Four short fields — unlikely to trigger content validation on the SUT side;
byte-deterministic for identical inputs; the `echo` fingerprint is the
anchor for resource-substitution detection (invariant I3, e.g. S-BS-07).

## 6. Scenario matrix — family S-BC (Argus pays, SUT accepts)

Common expectation: an invalid payment must be **rejected without issuing
the resource**, without unhandled 5xx crashes; rejection reasons should
come from the facilitator vocabulary (`invalidReason` / `errorReason`).

| ID | Injected fault (hook) | FAIL criteria | Observed facts | Phase / Wave |
|---|---|---|---|---|
| S-BC-01 | corrupt `signature` after honest signing (`onPayload`) | resource issued; settle performed on the bad signature | retry status; reason (`payload_verification_failed`); retries | 1 / **1** |
| S-BC-02 | `validBefore` in the past (`onSign`) | resource issued; settle performed | reason (`authorization_valid_before`); status | 1 / **1** |
| S-BC-03 | `validAfter` in the future (clock skew) | resource issued | reason (`authorization_valid_after`) | 1 / 2 |
| S-BC-04 | replay the same authorization/nonce (`bcPlan.replayAfterSend`) | replay accepted (2xx) or settled | both send responses; timings | 1 / **1** |
| S-BC-05 | wallet balance below the required amount | resource issued; settle "succeeded" without funds | reason (`insufficient_funds` / `unavailable_funds`) | 1 / **1** |
| S-BC-06 | signed `value` ≠ requirements amount | payment accepted | reason; status | 1 / 2 |
| S-BC-07 | wrong EIP-712 domain `chainId` | payment accepted | reason; status | 1 / 2 |
| S-BC-08 | `scheme` mismatch payload vs requirements | payment accepted | reason; status | 1 / 2 |
| S-BC-09 | truncated / invalid Base64-JSON `payment-signature` | 5xx crash; hang; resource issued | status; error readability | 1 / **1** |
| S-BC-10 | payment references a different resource | payment accepted; resource issued | reason; status | 1 / 2 |
| S-BC-11 | same valid payment sent twice back-to-back | both accepted; two settles | both responses; settle count | 1 / 2 |
| S-BC-12 | wrong `asset` in authorization | payment accepted | reason; status | 1 / 2 |
| S-BC-13 | wallet with a borderline KYT profile | crash; hang; resource issued without rejection | reason (KYT); decision time | 1 / 2 |
| S-BC-14 | mempool drain of the authorization before the SUT's settle | resource issued on a drained payment | drain facts; SUT responses | 2 / 2 (decoupled: needs mempool) |
| S-BC-15 | spend above the `upto` ceiling | over-spend accepted | amounts before/after | 2 / 2 (decoupled: needs `upto` support) |

## 7. Scenario matrix — family S-BS (SUT pays, Argus accepts)

Common expectation: the SUT must not lose money (no second payments for the
same resource), must not crash, and must end the operation in an explicit
state. Retry thresholds are **never** verdicts.

| ID | Injected fault (hook) | FAIL criteria | Observed facts | Phase / Wave |
|---|---|---|---|---|
| S-BS-01 | 402 again after a successful payment | the SUT pays a second time for the same resource | counts of repeated 402s / payments; timings; session end shape | 1 / **1** |
| S-BS-02 | same requirements demanded again within window W (duplicate settle receipt on re-contact) | **the SUT pays again** after the duplicate receipt (no thresholds) | window W (default 120 s); duplicate-delivered fact; all payments with timings | 1 / **1** |
| S-BS-03 | `verify` OK → `settle` "success" without an on-chain transaction | — (ADVISORY: tx-hash checking is SUT policy*) | whether the receipt without txHash was accepted (resource consumed) | 1 / **1** |
| S-BS-04 | `verify` always fails with a valid reason | crash; hang without explicit termination | attempt count; termination shape | 1 / 2 |
| S-BS-05 | requirements point at an attacker's `payTo` | — (ADVISORY: requires a whitelist policy) | whether the payment went to the attacker | 1 / 2 |
| S-BS-06 | requirements exceed the real resource price (x10, price stated in `description`) | **the SUT pays the inflated amount** (V2: always FAIL) | demanded amount; actual payment value; refusal fact | 1 / **1** |
| S-BS-07 | swapped resource body after payment | — (ADVISORY if undetected) | `echo` comparison sent/received; detection | 1 / 2 |
| S-BS-08 | 200 with the resource before settle | — (ADVISORY: SUT bookkeeping state) | whether the SUT treats the operation as settled | 1 / 2 |
| S-BS-09 | `settle` returns pending forever | — (ADVISORY: hang recorded as fact) | termination shape within W; status re-polls | 1 / 2 |
| S-BS-10 | structurally invalid requirements (malformed address, garbage) | SUT signs the invalid data; crash; hang | rejected pre-sign vs post-sign; error text | 1 / 2 |
| S-BS-11 | replay challenge: "payment lost, pay again" with the same requirements | the SUT pays a second time for the same resource | payment count; timings; reaction to `settlement_not_found` | 1 / **1** |
| S-BS-12 | corrupt headers / truncated bodies | crash; unhandled exception; hang | rejection shape (safe/unsafe) | 1 / 2 |
| S-BS-13 | 200 without any 402 (resource for free) | — (ADVISORY: SUT accounting state) | what the SUT does with a "free" resource | 1 / 2 |

\* See the refinement notes in §2.

### Known upstream finding (live run 2026-10-21, Base Sepolia)

S-BS-06 (oversize-amount) against the official client `@x402/fetch` +
`@x402/core` + `@x402/evm` v2.28.0: the client signed and submitted an
EIP-3009 authorization for the ×10 inflated requirement (`value: 100000`
at a canonical price of `10000`), 3/3 sessions — FAIL per V2; the only
client-side guard engaged was the spend cap (`maxAmountPerPayment`), no
price validation. Filed upstream:
<https://github.com/x402-foundation/x402/issues/3866>.

## 8. Implementation waves

- **Wave 1 (v1 tranche, 10 scenarios)** — top of the exploitability rating
  (settlement failures → 402 loops / double payments → replay) plus cheap
  signature/format classics: S-BC-01, 02, 04, 05, 09 and S-BS-01, 02, 03,
  06, 11. All phase 1; no mempool or `upto` dependencies. **Implemented**
  in `src/blockb/BlockBRegistry.ts` with runners in `src/blockb/runners/`.
- **Wave 2 (18 scenarios)** — the rest of the registry, including the
  decoupled phase-2 scenarios (S-BC-14, S-BC-15). **Implemented** in
  `BLOCK_B_WAVE2_SCENARIOS` (same registry module); S-BC-14 requires the
  `--facilitator-settle-url` settle-race probe, S-BC-15 applies only to
  `upto`-capable SUTs (otherwise PASS "not applicable").

Waves define the implementation order, not a reduced scope: full coverage
is 28 scenarios — all 28 are registered and executable in code.

## 9. Payment layer requirements (summary)

1. **PaymentFaultInjector with 5 hooks** — contract in
   `src/blockb/PaymentFaultInjector.ts` (`onRequirements`, `onSign`,
   `onPayload`, `onSend`, `onSettle`); a scenario is a hook configuration
   (reference example: `src/blockb/examples/S_BC_01_BadSignature.ts`).
2. **Asymmetric wallet needs**: BC requires a real EIP-3009/EIP-712 signer
   (one-shot keys, test USDC); BS needs only `payTo` + facilitator-response
   emulation — no blockchain.
3. **MAJ-4 fix** (nonce `0x0…0` → `crypto.randomBytes`) — prerequisite for
   S-BC-04 / S-BS-11; landed in `defaultSigningIntentSource`.
4. **Funding** — §4 (`FundingProvider`, faucet + manual fallback).
5. **Canonical resource** — §5 (`CanonicalResource`).
6. **Role gates** — happy-path before every family; a failed gate exits 2.
7. **Fact/verdict separation** — all run facts (`PaymentFact`,
   `BcSendRecord`, `BsSessionRecord`) go to the report as raw data;
   verdicts are a separate column.
