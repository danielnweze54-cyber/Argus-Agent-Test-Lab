# Getting Started — connecting a SUT and running Argus

A short operator guide for **Argus-Agent-Test-Lab**: how to wire your
system under test (SUT) into the harness and run test scenarios against
it. For the payment-fault block see
[`docs/block-b/BLOCK_B_TEST_MATRIX.md`](./block-b/BLOCK_B_TEST_MATRIX.md).

## 1. Prerequisites

```bash
git clone https://github.com/igor-vii/Argus-Agent-Test-Lab.git
cd Argus-Agent-Test-Lab
npm install
npm run build        # tsc
npm test             # vitest (3 external sitecheck tests may drift — they hit a live API)
```

Requires Node 18+ (native `fetch`). The CLI is run from sources via tsx:

```bash
npm run argus -- <command>            # or: npx tsx src/cli/argus.ts <command>
```

## 2. Scenario catalogue

```bash
npm run argus -- list
```

- **S1–S7** — transport/delivery fault scenarios (duplicate requests,
  payment-before-execution, crash after settlement, seller timeout,
  concurrent duplicates, payment retry, lost delivery). They run against
  any `AgentTargetPort` adapter.
- **S8** — live x402 outbound flow (Argus as paying client).
- **S9** — x402 inbound flow (Argus as resource server; self-check client
  built in, or wait for an external client with `ARGUS_S9_SELF_CHECK=0`).
- **Block B** (`--block B`) — payment fault scenarios S-BC-xx / S-BS-xx;
  see §5.

## 3. Connecting your SUT

The target is selected through two environment variables:

| Env | Values | Meaning |
|---|---|---|
| `ARGUS_TARGET_KIND` | `mock` (default) / `http` / `x402` | transport adapter |
| `ARGUS_TARGET_ENDPOINT` | URL | SUT endpoint; required for `http` and `x402` |

Examples:

```bash
# mock (no SUT — baseline/self-test)
npm run argus -- run S1

# your SUT over plain HTTP
ARGUS_TARGET_KIND=http ARGUS_TARGET_ENDPOINT=https://your-sut.example/agent \
  npm run argus -- run S5

# your SUT as an x402 resource server (live payment flow, Base Sepolia)
ARGUS_TARGET_KIND=x402 ARGUS_TARGET_ENDPOINT=https://your-sut.example/resource \
ARGUS_TEST_WALLET_PRIVATE_KEY=0x... \
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
  npm run argus -- run S8
```

Notes:

- The x402 adapter performs the full client flow: request → `402 +
  payment-required` → EIP-712/EIP-3009 signature → signed retry →
  `200 + payment-response`.
- Use a **one-shot test key** funded with testnet USDC (Base Sepolia).
  `ARGUS_TEST_WALLET_PRIVATE_KEY` is read by the CLI; never commit it.
- For S9 (Argus is the server) the SUT-client should point at the URL the
  adapter prints; `ARGUS_S9_PAY_TO` overrides the receiving address and
  `ARGUS_S9_TIMEOUT_MS` the evidence window.

## 4. Reading results

Each run prints Run ID, scenario, status, evidence count and the verdict;
the exit code is CI-friendly:

- `0` — PASS / INCONCLUSIVE-free success path,
- `1` — FAIL (or scenario validation error),
- INCONCLUSIVE verdicts (mock-lifecycle scenarios S2/S3/S6/S7) exit 0 —
  see the audit report for the CLI limitation (MAJ-3).

Run artefacts (sessions, evidence) are persisted under `src/sessions/` /
`argus-sessions/` depending on the entry point used.

## 5. Block B — payment fault scenarios

Quick tour:

```bash
npm run argus -- list --block B          # all 28 scenarios (wave 1 × 10 + wave 2 × 18)

# SUT = resource server (Argus is the bad client):
ARGUS_TEST_WALLET_PRIVATE_KEY=0x... \
  npm run argus -- run --block B --family BC --sut-url https://your-sut.example/resource

# SUT = client (Argus is the bad server; SUT must be pointed at this URL):
npm run argus -- run --block B --family BS --scenario S-BS-11 \
  --bind 127.0.0.1:3461 --observe-window-ms 120000

# funding check/top-up before a BC run (decision V3):
ARGUS_TEST_WALLET_PRIVATE_KEY=0x... \
  npm run argus -- run --block B --family BC --sut-url https://your-sut.example/resource \
  --funding manual --rpc-url https://sepolia.base.org
```

Rules of the road:

- `--family` is **mandatory** — the SUT plays exactly one role per run;
- a role **gate** (canonical happy-path) executes first; a failed gate
  aborts with exit code 2;
- BS scenarios run **one at a time** (each needs a fresh SUT session);
- exit codes: `0` no FAIL, `1` FAIL found, `2` harness error / failed gate;
- S-BC-14 (frontrun-drain) additionally requires
  `--facilitator-settle-url` (the SUT's facilitator settle endpoint);
  without it the scenario returns HARNESS_ERROR.

## 6. Local smoke test without any SUT

```bash
npm run sut-server       # reference x402 resource server on :3457
# another terminal:
ARGUS_TARGET_KIND=x402 ARGUS_TARGET_ENDPOINT=http://127.0.0.1:3457 \
ARGUS_TEST_WALLET_PRIVATE_KEY=0x... BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
  npm run argus -- run S8

npm run smoke:local      # reproducible S1 smoke (no network)
```

## 7. Where to look next

- `docs/block-b/BLOCK_B_TEST_MATRIX.md` — payment fault matrix, verdicts,
  funding, canonical resource;
- `docs/block-b/REGISTRY.md` / `docs/block-b/MATRIX.md` — полная Russian
  registry (28 scenarios) and verdict policy;
- `src/blockb/` — PaymentFaultInjector contract, runners, funding,
  canonical resource;
- audit report (docx, repository releases/discussions) — 33 findings incl.
  CR-1 (S4 hang), CR-2 (exit codes), MAJ-4 (nonce — fixed).
