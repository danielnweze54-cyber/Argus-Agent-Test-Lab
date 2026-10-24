# B4 — Block A: Direct Bilateral Scenarios

## Definition

Block A contains direct bilateral interactions: **CLIENT ↔ RESOURCE_SERVER**, without a facilitator/orchestrator intermediary in the request path.

## S8 — X402 Payment Flow

**Purpose:** verify the x402 payment-required exchange at the engine boundary.

**Participants:** `client-1` is CLIENT; `sut-1` is RESOURCE_SERVER.

**Topology:** `client-1 → sut-1`.

**Processing:** client requests a protected resource; the resource server returns PAYMENT_REQUIRED; the configured PaymentResolver signs; ScenarioEngine retries through `actWithSignature`; engine records `payment_signed_and_retried`.

**Primary observable:** `engine:payment_signed_and_retried`.

**What this proves:** the payment-required → sign → retry control flow.

**What this does not prove:** on-chain settlement, final delivery, successful resource execution, or economic finality. `payment_signed_and_retried` must not be interpreted as `payment_settled`.

**Current result:** PASS when the expected engine evidence is observed; otherwise the current assertion returns FAIL.

## S9 — X402 Inbound Resource Server Flow

**Purpose:** verify the same x402 payment-required exchange with the transport direction reversed — the SUT initiates, Argus serves.

**Participants:** `sut-1` is CLIENT (external initiator); `client-1` is RESOURCE_SERVER (Argus ephemeral seller, X402SellerAdapter).

**Topology:** `sut-1 → client-1` (inbound).

**Processing:** external client requests a protected resource; Argus issues the x402 V2 402 Payment Required (`payment_required_issued`); the client sends PAYMENT-SIGNATURE; Argus validates the authorization (`payment_signature_validated`) and returns a deterministic resource response (`resource_response_delivered`); canonical evidence → assertions → verdict.

**Primary observables:** `payment_required_issued`, `payment_signature_validated`, `resource_response_delivered`.

**What this proves:** the gate in the inbound direction — the SUT can act as an x402 payer against a canonical seller, and the exchange remains verifiable end-to-end when the SUT initiates.

**What this does not prove:** on-chain settlement or economic finality. A validated PAYMENT-SIGNATURE is an authorization-verification fact at the HTTP/x402 boundary, identical to S8's boundary.

**Current result:** PASS on the happy path above; otherwise FAIL/INCONCLUSIVE per the canonical assertion model.

## Boundary

B4 adds no new x402 behavior or settlement semantics to Block A. S8 and S9 mirror each other under the same execution/evidence/assertion model; together they form the **gate step of the run ladder** (see [README.md](./README.md)): the first scenarios run against any fresh SUT to establish testability before fault injection begins.
