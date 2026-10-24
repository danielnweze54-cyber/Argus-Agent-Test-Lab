# Block D — live run evidence snapshot (2026-10-23)

Artifacts of the live S10/S11 runs against the unmodified
agentmiddleware/amw-paypal-agent-demo (mini_gateway served over TCP via
`sut/serve_gateway.py`), mock PayPal rail behind the Argus fault proxy.

- Run timestamp: 2026-10-23T19:02:42Z (see `wire_log_tail` in the S10 verdict)
- Run commit: `099e1f73`, branch `paypal-fiat-rails`
- Verdicts: S10 DeliveryUncertain **PASS 26/26**, S11 OverBudget **PASS 11/11**
- Finding F2 (rail/ledger $25 divergence) lives in the S10 Phase B artifacts;
  full write-up: `docs/scenarios/b4-block-d-findings.md`

## Files

| File | What it is |
|---|---|
| `block-d-s10-verdict.json` | Per-check results (A/B/C phases), rail evidence counters, wire-log tail seq 9–20 — incl. the F2 window (seq 11: capture settles upstream, response dropped; seq 12: same-request-id retry replayed; seq 13: reconciliation GET also dropped) |
| `block-d-s11-verdict.json` | Over-budget refusal checks: pre-charge refusal, boundary inclusive, zero rail traffic |
| `sut-s10-ledger.sqlite` | The SUT's own SQLite state at end of the S10 run: wallets, permits, operations, ledger, signed receipts |
| `sut-s11-ledger.sqlite` | Same for the S11 run |
| `proxy-startup.log`, `rail-startup.log` | Component startup lines (proxy :8888 -> rail :8891) |

## Inspecting the SUT databases (python3, no sqlite3 CLI needed)

```bash
python3 - <<'PY'
import sqlite3, json
db = sqlite3.connect('sut-s10-ledger.sqlite')

# One op per phase: A completed-success, B completed-tool_error (the F2 refund),
# C delivery_uncertain (charge kept) -- the whole story in three rows.
print(db.execute('SELECT idempotency_key, state FROM operations').fetchall())

# Money trail: phase-B wallet shows charge -2500 then refund +2500 while the rail
# kept the capture; phase-C wallet shows charge -2500 with NO refund.
for r in db.execute('SELECT seq, wallet_id, action, amount, balance_after, description '
                    'FROM ledger ORDER BY seq'):
    print(r)

# Signed receipts: success 2500 / tool_error 0 / delivery_uncertain 2500.
for rid, r in db.execute('SELECT receipt_id, receipt FROM receipts'):
    d = json.loads(r)
    print(rid, d.get('outcome'), d.get('credits_charged'))
PY
```

The `receipts` table also stores the full signed `bundle` per receipt. The dbs
are the live state behind the verdict check `C: SUT-side receipt signature
verifies`; restarting the SUT over the same db
(`tools/paypal-adapter/sut/serve_gateway.py`) lets anyone re-run
`GET /v1/receipts/{id}/verify` against them.

## Reproducing

```bash
node  tools/paypal-adapter/mock-rail/paypal-mock.mjs   # rail   :8891
node  tools/paypal-adapter/proxy/fault-proxy.mjs       # proxy  :8888 -> 8891
python tools/paypal-adapter/sut/serve_gateway.py       # SUT, PAYPAL_BASE_URL=http://127.0.0.1:8888
node  tools/paypal-adapter/src/run-s10.mjs             # S10; rewrites both verdict copies
node  tools/paypal-adapter/src/run-s11.mjs             # S11
```

A rerun regenerates fresh verdict JSONs and SUT dbs (the runner writes to this
directory and to `download/`); the committed snapshot is the 2026-10-23 run.
