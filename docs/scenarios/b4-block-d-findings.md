# Block D — Finding F2: refund of a settled capture under full blackout

| | |
|---|---|
| Scenario | S10 DeliveryUncertain, Phase B ("full blackout") |
| SUT | agentmiddleware/amw-paypal-agent-demo (mini_gateway, run unmodified over its declared transport seam) |
| Rail truth | Argus mock PayPal rail behind an Argus-owned fault-injection proxy |
| Run | 2026-10-23T19:02:42Z, verdict PASS 26/26 (findings reported, not repaired), commit `099e1f73`, branch `paypal-fiat-rails` |
| Price | $25.00 per checkout (1 credit = 1 US cent; wallet funded with exactly 2500 cents) |
| Severity (suggested) | High — silent, permanent money divergence, client-triggerable, compounding on retry |
| Status | Report item for the AMW team. Argus changed no SUT code (no-repairs policy); all faults were wire-level, Argus-owned. |

## TL;DR

Under a full blackout (every rail response lost, including the reconciliation read), the demo
**refunds the client and finalizes the operation as `tool_error` even though the capture settled on
the rail**. The rail holds a captured $25 that the demo ledger says was returned. The divergence is
silent and permanent: the operation is stored `COMPLETED`, so a same-key retry replays the refund
envelope forever, and no state in the SUT references the orphaned capture. This is the exact
situation the demo's own contract reserves `delivery_uncertain` for — "the charge is kept ... a
human settles it" — but the refund path swallows it first.

## Why this matters (the demo's own contract)

The AMW demo README states the intended semantics:

> "The gateway charges before the tool body runs and refunds if the tool raises. If the process
> dies after PayPal captures but before the receipt is stored, the next start marks that key
> `delivery_uncertain` and keeps the charge; a human settles it."

And `mini_gateway/governance.py` (module docstring) draws the same line:

> "4. The tool runs. If it raises, the charge is refunded." vs. "If the tool is cancelled midway
> (or the process dies), nobody knows whether its side effect happened. The charge is kept, the key
> is marked `delivery_uncertain`, and the case is left for a human."

The defect: a lost response after a money-moving write is **epistemically identical** to a mid-call
cancellation — nobody knows whether the side effect happened — yet it is classified as the first
case ("tool raised → refund") instead of the second. The result contradicts the clause the whole
design is built around: *settlement is not delivery; an ambiguous delivery is marked
`delivery_uncertain`, charged, with a signed receipt, and never resent.*

## Reproduction

Topology and driver: `tools/paypal-adapter/README.md`. In short:

```
SUT (mini_gateway, PAYPAL_BASE_URL=http://127.0.0.1:8888)
  → Argus fault proxy :8888   (arm/disarm admin API, wire log)
    → mock PayPal rail :8891  (Orders v2 subset, /__rail/evidence = rail-side truth)
```

Faults armed for Phase B (both Argus-owned, via `POST /__argus/arm`):

```json
{"scenario":"lost_response_after_capture","method":"POST","pathSuffix":"/capture"}
{"scenario":"lost_response_after_capture","method":"GET","pathSuffix":""}
```

The second arm is what makes it a *full blackout*: the proxy forwards every request upstream, waits
for the rail to finish, then destroys the SUT socket instead of returning the response. The SUT's
recovery read is eaten by the same arm. `node tools/paypal-adapter/src/run-s10.mjs` reproduces the
whole scene end to end.

## Timeline of the $25 divergence

Wire-log and rail evidence from the live run (`block-d-s10-verdict.json`, run commit `099e1f73`):

| # | Event (wire log) | Rail state | SUT ledger state |
|---|---|---|---|
| 1 | Pre-tool: permit check passes, wallet debited 2500¢, op in-flight (one transaction) | — | −2500¢ (charge) |
| 2 | `POST /v2/checkout/orders` → upstream 201, order created | order `51FDD0290D69C18A3C` created | (unchanged) |
| 3 | `POST .../capture` (seq 11) → **upstream 201, capture settles on rail**; response destroyed | capture #2 completed, order COMPLETED | (unchanged) |
| 4 | `paypal_client._post` retries with the **same PayPal-Request-Id** (seq 12) → rail correctly **replays** the settled capture (201, no new money); response destroyed again | replay counted, no new capture | (unchanged) |
| 5 | `_post` exhausts retries → `PayPalError(..., ambiguous=True)` → tool reconciles: `GET /v2/checkout/orders/{id}` (seq 13) → upstream 200 (COMPLETED); response destroyed | rail truth available and correct | (unchanged) |
| 6 | Raw `httpx.RemoteProtocolError` escapes `get_order` → governor's `except Exception` → **refund 2500¢**, receipt `tool_error`, `credits_charged="0"`, op finalized `COMPLETED` | capture #2 still settled | +2500¢ (refund) → balance restored |
| 7 | Net | **$25 captured** | **$25 refunded** → divergence |

Note what did *not* fail: the rail-side idempotency held perfectly. The same-request-id retry in
step 4 moved no money (rail `capture_replays` +1, `captures_completed` +0). The entire divergence
comes from the SUT's interpretation of silence, not from any double-charge on the wire.

## Root cause: three code points

**1. Governance classifies an ambiguous transport loss as a local tool failure (primary).**
`mini_gateway/governance.py:194-214` (`_run`): any `Exception` raised by the tool body triggers an
unconditional refund, a `tool_error` receipt with `credits_charged="0"`, and finalization to
`COMPLETED`. There is no consultation of *where* the exception came from. The branch immediately
below (`governance.py:215-218`, `except BaseException` → `mark_uncertain`) already implements the
correct semantics — keep the charge, sign a `delivery_uncertain` receipt, leave the case for a human
— but an exception raised *because the result was lost* takes the refund path, not the uncertain
path. The client even tags the error as ambiguous, and the governor never looks at the flag.

**2. The reconciliation read is the one call with no ambiguity mapping (secondary).**
`paypal_client.py:122-129` maps `httpx.TransportError` on writes to
`PayPalError(..., ambiguous=True)` after one same-request-id retry. But `get_order`
(`paypal_client.py:132-136`) does a bare `self._http.get(...)` with no TransportError handling. The
tool's recovery step (`paypal_tool.py:53-60`) therefore works only when the wire is partially
healthy: if the reconciliation GET is lost too, a raw `httpx.RemoteProtocolError` propagates out of
the tool body and lands in the refund branch. The fallback's own failure mode is the worst possible
one — silent refund of settled money.

**3. Finalization buries the ambiguity forever (tertiary).**
Because the op is stored `COMPLETED` with a `tool_error` receipt (governance.py:213), nothing will
ever revisit the key. A same-key retry replays the refund envelope (`governance.py:151`), and the
startup recovery worker only converts `IN_FLIGHT` keys (`governance.py:244-249`). No ledger entry,
receipt field, or op state references the orphaned rail capture, so a reconciliation job has
nothing to key on. The divergence is not just created; it is *preserved*.

The intent to handle this was clearly present — `paypal_tool.py:56-57` says: *"No response does not
mean no capture. Raising here makes the gateway refund the credits, so first ask PayPal what
happened"* — and `REPORT.md` documents the same fix intent ("after an ambiguous capture the tool
reads the order back and returns success when PayPal says `COMPLETED`"). But the order-read-back
itself lives on the same wire, and nobody covered the case where the read is also lost. The demo's
own tests cover "capture ambiguous → GET succeeds"; not "GET blackholed".

## Blast radius

- **Direct money loss.** Rail captured $25; the client was refunded. In a real rail the merchant
  eats the amount (or a manual refund eats fees) for goods/payment that did settle.
- **Silent and permanent.** No marker ties the refund to the rail capture; the receipt says
  `charged=0`; the op is `COMPLETED`. Nothing alerts, nothing reconciles, nothing decays.
- **Compounding on client retry.** The client is told "tool failed, credits refunded", so a rational
  client retries under a *new* idempotency key. That is a second create+capture that also settles:
  the merchant now holds two captures against one net client payment, and the orphaned amount
  grows. This is how the "never resent" clause gets broken without any code resending anything.
- **Trigger surface.** Any total network partition covering the capture retry window plus one
  reconciliation GET — i.e., precisely the blackout scenario the contract is written for. It does
  not require a crash, a deploy, or a bug in the rail.

## What the demo already gets right

Credit where due, because it bounds the fix: the same run proves the hard parts work. Phase A:
same-`PayPal-Request-Id` capture retry is replayed by the rail, one debit, zero refunds, zero
double-captures. Phase C: a true mid-call crash routes to `mark_uncertain` — charge kept, JSON-RPC
`-32010 delivery_uncertain`, signed receipt that verifies via `GET /v1/receipts/{id}/verify`, and a
same-key retry re-dispatches nothing (rail captures frozen). The machinery for the correct outcome
already exists; only the classification of "sent money, got silence" is wired to the wrong branch.

## Suggested direction (non-normative — AMW team decides; Argus does not repair)

1. In `governance._run`, route post-charge ambiguity to `mark_uncertain` instead of refund: if the
   exception is `PayPalError(ambiguous=True)` — or, more robustly, if any write was already sent
   upstream when the tool raised — keep the charge and sign a `delivery_uncertain` receipt. Refund
   only failures that provably predate the send (validation, refusals, 4xx that prove non-settlement).
2. Give `get_order` the same `TransportError → ambiguous` mapping as `_post`, and bound the
   reconciliation (a couple of retries). If rail truth is unreachable, fall through to
   `delivery_uncertain` — that is exactly the case the contract names — never to refund.
3. Leave such keys in the `DELIVERY_UNCERTAIN` state (not `COMPLETED`) so a same-key retry surfaces
   `-32010` instead of replaying a refund envelope, and the recovery worker can find them.
4. Optionally add a rail-first recovery pass for `delivery_uncertain` keys: `GET order`; if
   `COMPLETED`, flip to a charged success with a signed receipt; refund only after a rail-verified
   non-capture. Rail truth beats ledger guesses in both directions.
5. Note the client-visible angle: while refund-on-silence stands, every blackout hands the client a
   "free retry" incentive that silently doubles settled captures. Fixing 1–3 removes the incentive.

## Evidence pointers

- Verdict with per-check results: `download/block-d-s10-verdict.json` (Phase B checks; wire log
  seq 11–13; rail evidence `captures_completed: 3, capture_replays: 3` across phases).
- Phase B assertions verified live: envelope is a tool failure; receipt outcome `tool_error`,
  `credits_charged="0"`; wallet refunded; SUT balance restored to 2500.0 while rail captures
  advanced 1 → 2 (the finding check itself).
- Contrast Phase C (same run): `delivery_uncertain`, charge kept at 2500, signed receipt verified,
  rail frozen at 3 captures / 6 attempts — the correct outcome for the same class of silence.
- Reproduction: `tools/paypal-adapter/README.md` (mock-first loop, arm commands),
  `tools/paypal-adapter/src/run-s10.mjs` (driver; Phase B = arms above).
- SUT code references: `mini_gateway/governance.py:194-218,237-249`; `paypal_client.py:115-136`;
  `paypal_tool.py:43-72`; AMW README "governed flow" section; AMW `REPORT.md` fix-intent lines.
