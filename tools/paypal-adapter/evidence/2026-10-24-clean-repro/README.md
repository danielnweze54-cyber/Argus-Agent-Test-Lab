# Block D — clean-machine reproduction, 2026-10-24

Independent reproduction of the 2026-10-23 live run (registry seal `argus-seal-0001`)
from the repository alone: fresh clones, fresh environment, fresh processes. Purpose:
validate the reproducibility claim of the evidence pack — someone else must be able
to rebuild this stand from these files and get the same verdicts.

## Result

| Scenario | 2026-10-23 live run | 2026-10-24 clean repro | Delta |
|---|---|---|---|
| S10 DeliveryUncertain | PASS 26/26 | PASS 26/26 | none |
| S11 OverBudget | PASS 11/11 | PASS 11/11 | none |

F2 reproduced identically in S10 phase B: the SUT refunds the wallet and signs a
`tool_error` receipt (operation `completed`) while the mock rail holds the settled
capture — rail/ledger divergence on the first call, before any retry. Phase C still
takes the correct `delivery_uncertain` branch (abort path), confirming the defect is
in transport-exception classification, not in a missing capability.

## Environment

- Linux, node v24.21.0 (rail, proxy and runners are zero-dependency `.mjs`)
- Python 3.12.15 (SUT side), venv isolated

## Setup (exact dependency list)

```bash
git clone https://github.com/agentmiddleware/amw-paypal-agent-demo.git   # SUT, tested @ 60887d8eb746c032be8bc0f6dc806c6bdd0ee149
git clone -b paypal-fiat-rails https://github.com/igor-vii/Argus-Agent-Test-Lab.git

python3 -m venv sut-venv
./sut-venv/bin/pip install uvicorn "httpx>=0.28.1,<0.29" starlette cryptography
./sut-venv/bin/pip install -e amw-paypal-agent-demo/vendor/b2a_sdk[verify]
./sut-venv/bin/pip install -e amw-paypal-agent-demo/vendor/openai-agent-middleware
```

NOTE: `b2a-sdk` exists only in the demo's `vendor/` directory — it is NOT on PyPI.
Installing it from PyPI fails; install the vendored path exactly as above.
(`uvicorn` is needed by `sut/serve_gateway.py`; the demo's own pyproject does not
list it. `httpx` must stay `<0.29` per the demo's pin.)

## Run

```bash
cd Argus-Agent-Test-Lab/tools/paypal-adapter

node mock-rail/paypal-mock.mjs &          # fake PayPal Orders v2, :8891
node proxy/fault-proxy.mjs &              # fault injector, :8888 -> :8891

PATH=/path/to/sut-venv/bin:$PATH \
AMW_DEMO_ROOT=/path/to/amw-paypal-agent-demo \
node src/run-s10.mjs                      # spawns the SUT shim itself
PATH=/path/to/sut-venv/bin:$PATH \
AMW_DEMO_ROOT=/path/to/amw-paypal-agent-demo \
node src/run-s11.mjs
```

Verdicts are written to `download/` and `evidence/`. Runs executed ~05:10–05:14 UTC
2026-10-24 (verdict artifact write times).

## Inspect the money state (verified column names)

```bash
python3 - << 'EOF'
import sqlite3, json
db = sqlite3.connect('sut-s10-ledger.sqlite')  # this file, after download
print('operations:', db.execute('SELECT idempotency_key, state FROM operations').fetchall())
print('ledger:    ', db.execute('SELECT seq, action, amount, description FROM ledger ORDER BY seq').fetchall())
for (receipt,) in db.execute('SELECT receipt FROM receipts'):
    r = json.loads(receipt)
    print('receipt:   ', r.get('outcome'))
EOF
```

Expected for S10: `argus-key-a completed` (phase A, rail replay), `argus-key-b completed`
with ledger `charge -2500` then `refund +2500` (phase B — the F2 divergence),
`argus-key-c delivery_uncertain` (phase C, charge kept).

## Files

| File | What it is |
|---|---|
| `block-d-s10-verdict.json` | S10 verdict: PASS, 26/26 checks, wire-log tail with the F2 window |
| `block-d-s11-verdict.json` | S11 verdict: PASS, 11/11 checks |
| `sut-s10-ledger.sqlite` | live SUT wallet database from the S10 run |
| `sut-s11-ledger.sqlite` | live SUT wallet database from the S11 run |

Rail-side truth (`GET /__rail/evidence`) is in-memory and ephemeral, so it is not
shipped here; the S10 verdict embeds the wire-log tail covering the F2 window.
