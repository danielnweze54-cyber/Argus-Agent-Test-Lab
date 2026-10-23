# B4 — Block D: Fiat Rail Scenarios

## Definition

Block D contains scenarios where the system under test is a governed gateway (permit + idempotency key + signed receipt) in front of an external fiat payment rail. The rail is observed only through a controlled fault-injection proxy or the rail's own API; the rail itself is never the SUT.

Intended topology: `CLIENT → SUT(gateway) → fault-proxy → RAIL`.

First target rail: PayPal sandbox (SUT: `agentmiddleware/amw-paypal-agent-demo`). Later rails: Alipay sandbox and other fiat rails.

## Terminology mapping (AMW ↔ Argus)

| AMW (SUT vocabulary) | Argus observation |
|---|---|
| `delivery_uncertain` | `delivery_unknown` (explicit SUT-owned observation only; timeout alone must not imply UNKNOWN) |
| charged (one capture) | wallet debit + exactly one rail capture |
| signed receipt (Ed25519, verifiable offline) | SUT receipt evidence; must not be promoted to Argus canonical evidence |
| retry with same key returns original receipt | idempotency reuse (same invariant family as S1/S5) |

## S10 — Delivery Uncertain (fiat lost response)

**Purpose:** verify that a lost response after a successful rail capture does not cause a second capture, a resend, or an unmarked outcome. Agreed contract: settlement is not delivery; the SUT must mark the operation `delivery_uncertain`, hold the signed receipt, and never resend.

**Topology:** `client-1 → sut-1(gateway) → fault-proxy-1 → rail-1(paypal-sandbox)`.

**Processing:** a governed call debits the wallet, the gateway issues a capture to the rail, the rail completes the capture, and the fault proxy drops the capture response. The SUT must resolve the operation as delivery-uncertain (e.g. by reconciliation polling), must not re-dispatch the capture, and must still emit its signed receipt without a second debit.

**Fault:** `lost_response_after_capture` on the `sut → rail` wire edge, dispatched by the fault proxy. Not a harness-configured lifecycle observation: the loss point is the real response edge.

**Observable evidence:** one wallet debit; one rail capture (rail-side or proxy-side proof); zero second captures for the same idempotency key; explicit SUT-owned `delivery_unknown` observation; signed receipt retrievable and verifiable.

**Evidence boundary:** capture truth must come from the rail API or the proxy wire log, not from SUT claims alone. Harness-supplied observations must be labeled per the Block B evidence rule.

**Current result:** EXECUTED LIVE (branch `paypal-fiat-rails`, mock-first rail). Verdict PASS 26/26 checks — `tools/paypal-adapter/evidence/block-d-s10-verdict.json`. Live chain: SUT (mini_gateway over TCP via `sut/serve_gateway.py`) → fault proxy :8888 → mock rail :8891, zero PayPal keys. See "Live run record" below.

## S11 — Over Budget

**Purpose:** verify budget/policy behavior when a governed call exceeds the configured spend limit, and that no debit or rail capture occurs for the rejected call.

**Topology:** `client-1 → sut-1(gateway) → fault-proxy-1 → rail-1(paypal-sandbox)`.

**Processing:** a sequence of governed calls crosses the configured budget limit; the rejecting call must produce a policy refusal observation before any wallet debit, no dispatch to the rail, and no rail-side capture. A boundary probe at exactly the limit (currency/decimal edge) is included as a second call.

**Fault:** none active; this is a policy probe. An optional `timeout` edge on the rejected call must not convert refusal into UNKNOWN.

**Observable evidence:** refusal observation for the over-budget call; unchanged wallet balance across the refusal; zero captures at the rail for the rejected call; normal in-budget neighbor call completes with one debit and one capture.

**Evidence boundary:** rail-side absence-of-capture proof requires a rail/proxy query, not only absence of SUT logs; passive absence must not produce PASS by itself (R3-D3 semantics apply).

**Current result:** EXECUTED LIVE (branch `paypal-fiat-rails`, mock-first rail). Verdict PASS 11/11 checks — `tools/paypal-adapter/evidence/block-d-s11-verdict.json`. Refusals are synchronous SUT-local (`-32001`, `permit_budget_exceeded` / `insufficient_funds`), boundary at exactly the limit is inclusive, and the only rail traffic belongs to the allowed boundary probe.

## Block D evidence rule

Rail-side truth (capture happened / did not happen) is established by the rail API or the fault-proxy wire log. SUT receipts and SUT status fields are SUT evidence. Harness-configured lifecycle observations remain harness configuration and must not be silently promoted to canonical scenario behavior.

Block D adds no repairs to Blocks A/B/C and changes no verdict semantics.

## Adapter boundary

The PayPal adapter (`tools/paypal-adapter`) speaks to the SUT's gateway HTTP surface and, in real-rail mode, routes SUT traffic through the fault proxy to the sandbox. Sandbox credentials belong to the SUT side (see `tools/paypal-adapter/.env.example`).

## SUT surface (discovered, agentmiddleware/amw-paypal-agent-demo)

Confirmed from `demo.py` / `gateway.py` / `paypal_client.py`:

- `POST /v1/billing/wallets/sponsor`, `POST /v1/billing/wallets/agent` — provisioning; agent wallets carry budget credits / daily limits (S11 hook)
- `POST /v1/api-keys` — agent key issuance; auth via `X-API-Key`
- `GET /v1/billing/ledger/{wallet_id}` — wallet ledger entries (debit evidence for S11)
- `GET /v1/receipts/{id}/portable` + `GET /.well-known/trust-keys.json` — signed receipt bundle + published key set (S10 receipt verification, offline-verifiable)
- tool dispatch via the B2A SDK client (`tools/call` surface); `PayPal-Request-Id` carries the AMW idempotency key with `create`/`capture` suffixes — rail-side idempotency is addressable per AMW key
- `paypal_client.py` reads `PAYPAL_BASE_URL` from env, but rejects any non-`https` / non-`paypal.com` host unless an explicit `transport` is injected (its own declared test seam). Block D uses that seam: `sut/serve_gateway.py` constructs `PayPalClient(base_url=<proxy>, transport=httpx.AsyncHTTPTransport())`. No demo code is modified.

Mapping to the demo's own self-played scenes (context only, not trusted as verdicts):

- Demo Scene 2 ("lost response", via in-process `LostResponseTransport` over ASGI) ↔ S10. The demo verifies itself; Argus re-establishes the same loss deterministically on the real wire and renders an independent verdict.
- Demo Scene 3 ("over budget") ↔ S11. Same boundary: self-check vs black-box proof.

Integration item resolved: the demo gateway is served over TCP by `tools/paypal-adapter/sut/serve_gateway.py` (uvicorn shim around the SUT's own `MiniGateway.app`; deployment plumbing, not a repair). Black-box runs: `tools/paypal-adapter/src/run-s10.mjs`, `run-s11.mjs` (driver toolkit in `src/driver.mjs`). Replay-based verdict logic: `src/tests/BlockD-S10-S11.test.ts`.

## Live run record (2026-10-24, mock-first rail)

Setup: SUT `agentmiddleware/amw-paypal-agent-demo` @ HEAD, mini_gateway served on 127.0.0.1:8321, fault proxy :8888, mock rail :8891, price $25.00 (2500 credits), Ed25519 receipts (`argus-block-d-sut` key id).

**S10 DeliveryUncertain — PASS 26/26.** Three phases:

1. *Idempotent retry recovers.* Capture response dropped twice (arm `lost_response_after_capture` ×2). The SUT retried the capture with the same `PayPal-Request-Id`; the rail replayed the original 201 (capture_attempts=2, captures_completed=1, capture_replays=1). SUT resolved success, one wallet debit, zero refunds.
2. *Full blackout.* Capture ×2 dropped AND the reconciliation GET dropped. The SUT refunded the wallet (`tool_error` receipt, charged 0) while the rail HAD captured. **Finding F2 (SUT-side):** in the unrecoverable-ambiguity branch the demo refunds a capture that actually settled — rail and ledger diverge by $25. Not repaired, only reported.
3. *Delivery uncertain.* Capture ×2 dropped, reconciliation GET stalled (arm `timeout` 6 s), driver aborted the MCP call mid-flight. In-process cancellation did not surface uncertainty (uvicorn did not cancel the handler); the driver fell back to the documented crash-recovery path (hard kill → restart with same db → `recover()` marked the stale in-flight op). Retry with the SAME idempotency key returned the stored envelope: JSON-RPC error `-32010` / `delivery_uncertain` with a signed receipt (`credits_charged` kept, outcome `delivery_uncertain`), verified through the SUT's own `POST /v1/receipts/verify` (valid=true). Rail frozen at 3 captures / 6 attempts — the retry dispatched nothing.

**S11 OverBudget — PASS 11/11.** Refusal before charge at cap < price; boundary at cap == price is inclusive and completes with exactly one debit + one capture; zero rail traffic for every refused probe.

**Finding F1 (Argus tooling, fixed on this branch):** the mock rail initially (a) answered a same-`PayPal-Request-Id` capture retry with 422 instead of replaying the original response, and (b) served the capture outside `purchase_units[0].payments.captures[]`, which the SUT's reconcile path (`paypal_tool._first_capture`) requires. Both fixed — the mock must mirror the rail's real contract, otherwise the SUT is punished for the mock's fidelity, not its own behavior.
