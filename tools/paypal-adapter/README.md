# PayPal adapter (Block D, draft scaffold)

Wiring for Block D scenarios (S10 DeliveryUncertain, S11 OverBudget) against the
AMW PayPal sandbox demo: https://github.com/agentmiddleware/amw-paypal-agent-demo

Spec: `docs/scenarios/b4-block-d.md`.

## Mock-first strategy

1. Offline dev loop (no PayPal keys):
   - run the SUT demo in mock mode: `demo.py --mock-paypal --mock-llm`
   - point Argus at the SUT gateway HTTP surface (`AMW_GATEWAY_BASE_URL`)
2. Real sandbox loop:
   - SUT-side `.env`: `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` (developer.paypal.com, Sandbox app)
   - SUT upstream traffic is routed through the fault proxy (`FAULT_PROXY_*`)
   - webhook-free: the demo capture path is synchronous Orders v2 REST
     (`POST /v2/checkout/orders`, `POST /v2/checkout/orders/{id}/capture`),
     so the S10 loss point is the capture response, not a webhook delivery

## Mock-first loop (offline, no PayPal keys)

```
AMW demo (PAYPAL_BASE_URL) ──► fault proxy :8888 ──► mock rail :8891
                                        │
Argus ── arm/disarm faults, read wire-log (rail-side evidence)
```

Run the loop:

```bash
node mock-rail/paypal-mock.mjs    # fake PayPal Orders v2, :8891
node proxy/fault-proxy.mjs        # fault injector, :8888 -> :8891

# SUT side (deployment plumbing, no demo patch):
#   python3 sut/serve_gateway.py --demo-root /path/to/amw-paypal-agent-demo \
#       --port 8321 --proxy-url http://127.0.0.1:8888 --price-usd 25.00
# The shim serves the demo's own MiniGateway over TCP (uvicorn) and constructs
# PayPalClient with an explicit transport pointed at the proxy: paypal_client.py
# refuses plain-HTTP / non-paypal.com base URLs without a transport, so the
# transport parameter (its own declared test seam) is the intended entry point.
```

The mock rail speaks the same surface as the sandbox: `POST /v1/oauth2/token`,
`POST /v2/checkout/orders` (idempotent by `PayPal-Request-Id`),
`POST /v2/checkout/orders/{id}/capture` (at most one; a retry with the SAME
`PayPal-Request-Id` replays the original 201 — real PayPal idempotency — while
a different request id on a captured order gets 422 `ORDER_ALREADY_CAPTURED`),
`GET /v2/checkout/orders/{id}` (reconciliation polling; the capture is served
inside `purchase_units[0].payments.captures[]`, as PayPal serves it).
Rail-side truth for assertions: `GET /__rail/evidence`.

Arm the S10 fault and read evidence (Argus drives these):

```bash
curl -X POST localhost:8888/__argus/arm -H 'Content-Type: application/json' \
  -d '{"scenario":"lost_response_after_capture","method":"POST","pathSuffix":"/capture","times":2}'
curl -X POST localhost:8888/__argus/arm -H 'Content-Type: application/json' \
  -d '{"scenario":"timeout","method":"GET","pathSuffix":"","times":1,"timeoutMs":6000}'
curl localhost:8888/__argus/wire-log
```

Arms are additive (several live at once; every request consumes the first
matching arm). `pathSuffix: ""` matches any path — use it for GET faults, the
default suffix is `/capture`.

`lost_response_after_capture` forwards the capture upstream, waits for the rail to
complete it (201), then destroys the SUT socket without sending the response —
exactly the "charged, response lost" point of S10. `timeout` drops the request in
transit without forwarding.

## What belongs to whom

- SUT-side credentials: `PAYPAL_*` (owner of the demo); never stored or logged by Argus
- Argus-side config: `AMW_GATEWAY_BASE_URL`, `FAULT_PROXY_*` (see `.env.example`)

## Status

EXECUTED LIVE (mock-first rail): S10 PASS 26/26, S11 PASS 11/11 — see the live
run record in `docs/scenarios/b4-block-d.md` and the verdict JSONs in
`evidence/`. Findings: F1 (Argus tooling, fixed — mock replay + capture
embedding), F2 (SUT-side, reported — the demo refunds a settled capture in the
unrecoverable-ambiguity branch; rail/ledger divergence). Black-box runs:
`node src/run-s10.mjs`, `node src/run-s11.mjs` (start rail + proxy first; the
run scripts spawn the SUT shim themselves). Next: real sandbox keys on the SUT
side, then Alipay. No changes to Blocks A/B/C, ScenarioRegistry, or verdict
semantics.
