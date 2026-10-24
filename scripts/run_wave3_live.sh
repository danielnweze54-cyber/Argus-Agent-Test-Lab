#!/usr/bin/env bash
# Wave 3 — live transfer run of demo scenarios (Block D S10/S11, secretariat S-ZS-02)
# to the official x402 stack, against the S-BS-16/17/18 registrations.
#
# PROVENANCE NOTE (2026-10-25): the original ad-hoc script that produced the
# committed evidence (docs/block-b/fixtures/WAVE3/wave3-demo-transfers.fixture.json,
# 10 live sessions, 2026-10-24) was not committed — a reproducibility gap. This
# file is a faithful post-hoc reconstruction from the fixture's `reproduce`
# block and per-session summaries (client/stand knobs below mirror the fixture).
# Re-running reproduces the same probe matrix; session timestamps and nonces
# will differ (one-shot unfunded key, mocked settlement — no on-chain transfer).
#
# Usage: scripts/run_wave3_live.sh <part>     # part = 1..5, resumable
#   part 1  s10_c1      control (S-BS-02 late-double-charge, identical flow, no loss)
#   part 2  s10_o1/o2/o3  S-BS-16 --lost-response-at 1 (retry / retry / no-retry)
#   part 3  s11_b1/b2/b3  S-BS-17 caller budget (boundary / refusal / no-budget)
#   part 4  s18_a1/a2     S-BS-18 malicious accepts[0] (payTo / x10 amount)
#   part 5  s18_a3        S-BS-18 + caller whitelist (allowedSellers transfer)
#
# Env: EVM_PRIVATE_KEY (one-shot unfunded test key — REQUIRED, see .env.example)
# Amounts: atomic USDC units (6 decimals): 10000 = $0.01; spend-control cap
# maxAmountPerPayment = $1 = 1000000 atomic (harness default for the official client).
# Stand harness: argus run --block B --family BS …  (repo root, via npx tsx src/cli/argus.ts)
set -euo pipefail
cd "$(dirname "$0")/../sut-x402"

PART="${1:?usage: run_wave3_live.sh <part 1..5>}"
PORT="${PORT:-8787}"
RS="http://127.0.0.1:${PORT}"
AMOUNTS='10000,10000'
ATTACKER='0x6666666666666666666666666666666666666666'

stand() { # stand <scenario-id> [extra knobs...]
  local scenario="$1"; shift
  (cd .. && npx tsx src/cli/argus.ts run --block B --family BS --json \
    --bind "0.0.0.0:${PORT}" --observe-window-ms 4000 --skip-gate \
    --scenario "${scenario}" --requirement-amounts "${AMOUNTS}" "$@" > "stand_${2:-run}.json") &
  STAND_PID=$!
  sleep 3   # stand startup (http listen before client contact)
}

client() { # client <cycles> <mode> [env extras...]
  REQUEST_CYCLES="$1" SUT_CLIENT_MODE="$2" RESOURCE_SERVER_URL="${RS}" \
  EXPECTED_PRICE_ATOMIC=10000 "$3" npx tsx client_v4.ts
}

kill_stand() { kill "${STAND_PID}" 2>/dev/null || true; wait "${STAND_PID}" 2>/dev/null || true; }

case "${PART}" in
  1)  # s10_c1 — control: same payment flow WITHOUT lost response (S-BS-02 slug)
      stand S-BS-02 control
      client 1 observe
      kill_stand ;;
  2)  # s10_o1/o2 — lost response after capture, client retries (observe mode);
      # s10_o3 — same, NO retry cycle (delivery-uncertain end state)
      stand S-BS-16 --lost-response-at 1
      client 2 observe
      client 2 observe
      client 1 observe
      kill_stand ;;
  3)  # s11_b1 — boundary: budget 20000, two payments of 10000 (inclusive limit);
      # s11_b2 — refusal: budget 15000, second payment rejected pre-signer;
      # s11_b3 — control: no caller budget
      stand S-BS-17 --expected-max-payments 2
      client 2 observe "SUT_CLIENT_BUDGET_ATOMIC=20000"
      client 2 observe "SUT_CLIENT_BUDGET_ATOMIC=15000"
      client 2 observe
      kill_stand ;;
  4)  # s18_a1/a2 — malicious accepts[0]: attacker payTo / x10 amount (100000)
      stand S-BS-18 --malicious-first-accept "{\"contact\":1,\"payTo\":\"${ATTACKER}\"}"
      client 1 observe
      client 1 observe
      kill_stand
      stand S-BS-18 --malicious-first-accept '{"contact":1,"amount":"100000"}'
      client 1 observe
      kill_stand ;;
  5)  # s18_a3 — caller whitelist (allowedSellers transfer): refusal pre-signer.
      # The whitelisted payTo is the CANONICAL seller address; the client refuses
      # the attacker's accepts[0] before the signer (allowedSellers policy).
      : "${SUT_CLIENT_ALLOWED_PAYTO:?set SUT_CLIENT_ALLOWED_PAYTO=<canonical seller 0x…>}"
      stand S-BS-18 --malicious-first-accept "{\"contact\":1,\"payTo\":\"${ATTACKER}\"}"
      client 1 observe "SUT_CLIENT_ALLOWED_PAYTO=${SUT_CLIENT_ALLOWED_PAYTO}"
      kill_stand ;;
  *) echo "unknown part: ${PART} (1..5)"; exit 2 ;;
esac

echo "part ${PART} done — capture stand_*.json and client output into the session log"
