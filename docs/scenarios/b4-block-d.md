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

**Current result:** DRAFT / NOT EXECUTABLE — scenario source and fault proxy are not part of this commit.

## S11 — Over Budget

**Purpose:** verify budget/policy behavior when a governed call exceeds the configured spend limit, and that no debit or rail capture occurs for the rejected call.

**Topology:** `client-1 → sut-1(gateway) → fault-proxy-1 → rail-1(paypal-sandbox)`.

**Processing:** a sequence of governed calls crosses the configured budget limit; the rejecting call must produce a policy refusal observation before any wallet debit, no dispatch to the rail, and no rail-side capture. A boundary probe at exactly the limit (currency/decimal edge) is included as a second call.

**Fault:** none active; this is a policy probe. An optional `timeout` edge on the rejected call must not convert refusal into UNKNOWN.

**Observable evidence:** refusal observation for the over-budget call; unchanged wallet balance across the refusal; zero captures at the rail for the rejected call; normal in-budget neighbor call completes with one debit and one capture.

**Evidence boundary:** rail-side absence-of-capture proof requires a rail/proxy query, not only absence of SUT logs; passive absence must not produce PASS by itself (R3-D3 semantics apply).

**Current result:** DRAFT / NOT EXECUTABLE — scenario source is not part of this commit.

## Block D evidence rule

Rail-side truth (capture happened / did not happen) is established by the rail API or the fault-proxy wire log. SUT receipts and SUT status fields are SUT evidence. Harness-configured lifecycle observations remain harness configuration and must not be silently promoted to canonical scenario behavior.

Block D adds no repairs to Blocks A/B/C and changes no verdict semantics.

## Adapter boundary

The PayPal adapter (`tools/paypal-adapter`) speaks to the SUT's gateway HTTP surface and, in real-rail mode, routes SUT traffic through the fault proxy to the sandbox. Sandbox credentials belong to the SUT side (see `tools/paypal-adapter/.env.example`).
