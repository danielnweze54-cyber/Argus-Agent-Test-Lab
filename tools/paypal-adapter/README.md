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

# SUT side: point the demo at the proxy instead of PayPal sandbox
#   PAYPAL_BASE_URL=http://127.0.0.1:8888
# (paypal_client.py reads PAYPAL_BASE_URL from env; no demo patch needed)
```

The mock rail speaks the same surface as the sandbox: `POST /v1/oauth2/token`,
`POST /v2/checkout/orders` (idempotent by `PayPal-Request-Id`),
`POST /v2/checkout/orders/{id}/capture` (at most one; second attempt -> 422
`ORDER_ALREADY_CAPTURED`), `GET /v2/checkout/orders/{id}` (reconciliation polling).
Rail-side truth for assertions: `GET /__rail/evidence`.

Arm the S10 fault and read evidence (Argus drives these):

```bash
curl -X POST localhost:8888/__argus/arm -H 'Content-Type: application/json' \
  -d '{"scenario":"lost_response_after_capture","method":"POST","pathSuffix":"/capture","times":1}'
curl localhost:8888/__argus/wire-log
```

`lost_response_after_capture` forwards the capture upstream, waits for the rail to
complete it (201), then destroys the SUT socket without sending the response —
exactly the "charged, response lost" point of S10. `timeout` drops the request in
transit without forwarding.

## What belongs to whom

- SUT-side credentials: `PAYPAL_*` (owner of the demo); never stored or logged by Argus
- Argus-side config: `AMW_GATEWAY_BASE_URL`, `FAULT_PROXY_*` (see `.env.example`)

## Status

DRAFT — scaffold + working mock-first loop. The S10 loss mechanism is verified by
`scripts/smoke-block-d.sh` (token/order/capture through the proxy, armed response
drop, rail-side truth, duplicate-capture rejection, wire-log entry). Next:
Argus-side adapter + S10/S11 scenario sources on this branch. No changes to
Blocks A/B/C, ScenarioRegistry, or verdict semantics.
