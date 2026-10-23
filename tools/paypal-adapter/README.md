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

## What belongs to whom

- SUT-side credentials: `PAYPAL_*` (owner of the demo); never stored or logged by Argus
- Argus-side config: `AMW_GATEWAY_BASE_URL`, `FAULT_PROXY_*` (see `.env.example`)

## Status

DRAFT — scaffold only. Adapter implementation and S10/S11 scenario sources land in
follow-up commits on the `paypal-fiat-rails` branch. No changes to Blocks A/B/C,
ScenarioRegistry, or verdict semantics are made by this scaffold.
