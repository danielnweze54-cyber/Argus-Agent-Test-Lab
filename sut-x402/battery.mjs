#!/usr/bin/env node
/**
 * S-BS-06 binding battery (round 2 of #3866 follow-up).
 *
 * Closes the reviewer asks (NSPG13 2026-10-22, TKCollective 2026-10-24):
 *   - C1-CTL   unchanged quote WITH control mode enabled (positive case);
 *   - F-series per-field requirement changes (payTo/asset/network/resource/method);
 *   - F6       mid-session price DROP (bait-down), symmetric band;
 *   - ANCHOR   a rejected quote must NOT replace the accepted anchor.
 *
 * Each session: stand (lab CLI, adversarial 402 server) + instrumented official
 * client (client_v2.ts). Evidence = client event JSONL (requirements verbatim,
 * signer-call counts, control-gate rejections) + stand CLI report.
 *
 * Evidence discipline: settlement is mocked; captures establish SIGNING, not
 * on-chain transfer. No keys, no usable authorizations in the fixture output.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAB_ROOT = path.resolve(__dirname, "..");
const SUT_ROOT = __dirname;
const OUT_DIR = "/tmp/argus-battery";
const FIXTURE_OUT = path.join(LAB_ROOT, "docs/block-b/fixtures/S-BS-06/s-bs-06-binding-battery.fixture.json");
const TSX = path.join(SUT_ROOT, "node_modules/.bin/tsx");

const BASE = "http://127.0.0.1";
const ATTACKER2 = "0x2222222222222222222222222222222222222222";
const ASSET2 = "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"; // non-USDC decoy
const NETWORK2 = "eip155:11155111"; // Ethereum Sepolia decoy

const SESSIONS = [
  {
    id: "c1ctl_run1", mode: "control", amounts: "10000,10000", cycles: 2,
    expect: "unchanged accepted quote with control mode enabled: both cycles sign (signer x2), zero rejections — the gate does not break the honest case",
    match: (f) => f.signer_values.join(",") === "10000,10000" && f.rejections.length === 0,
  },
  {
    id: "f1_payto_run1", mode: "control", amounts: "10000,10000",
    overrides: [{}, { payTo: ATTACKER2 }], cycles: 2,
    expect: "payTo swap on cycle 2 rejected BEFORE the signer (reason names payTo); signer x1",
    match: (f) => f.rejections.length === 1 && /payTo/i.test(f.rejections[0].reason ?? "") && f.signer_values.join(",") === "10000",
  },
  {
    id: "f2_asset_run1", mode: "control", amounts: "10000,10000",
    overrides: [{}, { asset: ASSET2 }], cycles: 2,
    expect: "asset swap on cycle 2 rejected BEFORE the signer by the client's OWN spendControls (asset allowlist/denomination) — our control gate never reached; signer x1. Positive control: the asset dimension is already guarded in 2.28.0",
    match: (f) => f.rejections.length === 0 && f.signer_values.join(",") === "10000" && JSON.stringify(f.per_cycle).includes("spendControls"),
  },
  {
    id: "f2_asset_obs_run1", mode: "observe", amounts: "10000,10000",
    overrides: [{}, { asset: ASSET2 }], cycles: 2,
    expect: "observe mode confirms the asset-swap rejection is the client's built-in guard (no control gate installed): signer x1, cycle 2 spendControls error",
    match: (f) => f.rejections.length === 0 && f.signer_values.join(",") === "10000" && JSON.stringify(f.per_cycle).includes("spendControls"),
  },
  {
    id: "f3_network_run1", mode: "control", amounts: "10000,10000",
    overrides: [{}, { network: NETWORK2 }], cycles: 2,
    expect: "network swap on cycle 2 rejected BEFORE the signer by the client's OWN spendControls (network-bound asset default) — our control gate never reached; signer x1",
    match: (f) => f.rejections.length === 0 && f.signer_values.join(",") === "10000" && JSON.stringify(f.per_cycle).includes("spendControls"),
  },
  {
    id: "f3_network_obs_run1", mode: "observe", amounts: "10000,10000",
    overrides: [{}, { network: NETWORK2 }], cycles: 2,
    expect: "observe mode confirms the network-swap rejection is the client's built-in guard: signer x1, cycle 2 spendControls error",
    match: (f) => f.rejections.length === 0 && f.signer_values.join(",") === "10000" && JSON.stringify(f.per_cycle).includes("spendControls"),
  },
  {
    id: "f4a_resource_new_binding_run1", mode: "control",
    endpointSequence: "GET /weather,GET /weather2", amounts: "10000,10000", cycles: 2,
    expect: "resource change = NEW quote binding (per url+method): both sign, two anchors; the caller expectation (10000) still applies to each first acceptance",
    match: (f) => f.signer_values.join(",") === "10000,10000" && f.rejections.length === 0 && f.quote_accepted.length === 2,
  },
  {
    id: "f4b_resource_raise_run1", mode: "control",
    endpointSequence: "GET /weather,GET /weather2", amounts: "10000,50000", cycles: 2,
    expect: "raised requirement on a NEW resource caught by the caller expectation (caller_expectation_mismatch), rejected BEFORE the signer; signer x1",
    match: (f) => f.rejections.length === 1 && /caller_expectation_mismatch/.test(f.rejections[0].reason ?? "") && f.signer_values.join(",") === "10000",
  },
  {
    id: "f5_method_run1", mode: "control",
    endpointSequence: "GET /weather,POST /weather", amounts: "10000,10000", cycles: 2,
    expect: "method change = NEW quote binding (per url+method): both sign, two anchors, zero rejections",
    match: (f) => f.signer_values.join(",") === "10000,10000" && f.rejections.length === 0 && f.quote_accepted.length === 2,
  },
  {
    id: "f6_drop_run1", mode: "control", amounts: "10000,5000", cycles: 2,
    expect: "mid-session price DROP (bait-down) rejected BEFORE the signer: amount 10000 -> 5000; signer x1",
    match: (f) => f.rejections.length === 1 && /10000 -> 5000/.test(f.rejections[0].reason ?? "") && f.signer_values.join(",") === "10000",
  },
  {
    id: "anchor_run1", mode: "control", amounts: "50000,50000", cycles: 2,
    expect: "a REJECTED quote never becomes the accepted anchor: both cycles rejected (caller_expectation_mismatch), signer x0",
    match: (f) => f.signer_values.length === 0 && f.rejections.length === 2 && f.rejections.every((r) => /caller_expectation_mismatch/.test(r.reason ?? "")),
  },
];

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const withTimeout = async (promise, ms, killFn) => {
  let timer = setTimeout(() => killFn?.(), ms);
  try { return await promise; } finally { clearTimeout(timer); }
};

async function runSession(sess, port) {
  const evLog = path.join(OUT_DIR, `${sess.id}.jsonl`);
  const standLog = path.join(OUT_DIR, `${sess.id}.stand.json`);
  // Evidence hygiene: the client APPENDS to CLIENT_EVENT_LOG — start clean
  // so each fixture session contains exactly one run's events.
  try { unlinkSync(evLog); } catch {}
  try { unlinkSync(`${evLog}.summary`); } catch {}

  const standArgs = [
    "src/cli/argus.ts", "run", "--block", "B", "--family", "BS",
    "--scenario", "S-BS-06", "--bind", `0.0.0.0:${port}`,
    "--observe-window-ms", "2500", "--skip-gate", "--json",
  ];
  if (sess.amounts) standArgs.push("--requirement-amounts", sess.amounts);
  if (sess.overrides) standArgs.push("--requirement-overrides", JSON.stringify(sess.overrides));

  const standProc = spawn(TSX, standArgs, { cwd: LAB_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let standOut = "";
  standProc.stdout.on("data", (d) => (standOut += d));
  let standErr = "";
  standProc.stderr.on("data", (d) => (standErr += d));

  await new Promise((r) => setTimeout(r, 3000)); // stand listen

  const clientEnv = {
    ...process.env,
    RESOURCE_SERVER_URL: `${BASE}:${port}`,
    REQUEST_CYCLES: String(sess.cycles),
    SUT_CLIENT_MODE: sess.mode,
    EVM_PRIVATE_KEY: `0x${randomBytes(32).toString("hex")}`,
    CLIENT_EVENT_LOG: evLog,
  };
  if (sess.endpointSequence) clientEnv.ENDPOINT_SEQUENCE = sess.endpointSequence;
  if (sess.mode === "control") clientEnv.EXPECTED_PRICE_ATOMIC = "10000";

  const client = await withTimeout(
    run(TSX, ["client_v2.ts"], { cwd: SUT_ROOT, env: clientEnv }),
    45000,
    () => {},
  );

  await withTimeout(
    new Promise((resolve) => {
      standProc.on("close", resolve);
      setTimeout(() => { try { standProc.kill("SIGKILL"); } catch {} }, 15000);
    }),
    16000,
  );
  writeFileSync(standLog, standOut || JSON.stringify({ error: standErr || "no output" }));

  // ---- parse evidence ----
  const events = existsSync(evLog)
    ? readFileSync(evLog, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const summaryLine = (client.stdout.split("\n").find((l) => l.startsWith("PROBE_SUMMARY:")) ?? "").slice("PROBE_SUMMARY: ".length);
  let summary = null;
  try { summary = JSON.parse(summaryLine); } catch {}

  const signerValues = events.filter((e) => e.type === "signer_call").map((e) => e.value);
  const rejections = events
    .filter((e) => e.type === "control_rejected_before_signer")
    .map((e) => ({ cycle: e.call_index, reason: e.reason }));
  const quoteAccepted = events
    .filter((e) => e.type === "quote_accepted")
    .map((e) => ({ cycle: e.cycle, bound_to: e.bound_to }));

  let standReport = null;
  try { standReport = JSON.parse(standOut); } catch {}

  const facts = {
    signer_values: signerValues,
    signer_call_count: summary?.signer_call_count ?? signerValues.length,
    rejections,
    quote_accepted: quoteAccepted,
    per_cycle: summary?.per_cycle ?? null,
    client_rc: client.code,
    stand_verdict: standReport?.scenarios?.[0]?.verdict ?? null,
  };
  const harnessError = client.code !== 0 && events.length === 0;
  return {
    session: sess.id,
    client_mode: sess.mode,
    requirement_amounts_served: sess.amounts ? sess.amounts.split(",") : null,
    requirement_overrides: sess.overrides ?? null,
    endpoint_sequence: sess.endpointSequence ?? null,
    request_cycles: sess.cycles,
    expected: sess.expect,
    observed: facts,
    verdict: harnessError ? "HARNESS_ERROR" : sess.match(facts) ? "MATCH" : "MISMATCH",
    timeline: events,
    signer_calls: events.filter((e) => e.type === "signer_call"),
    stand: standReport?.scenarios?.[0]
      ? { stand_verdict: standReport.scenarios[0].verdict, stand_reasons: standReport.scenarios[0].reasons }
      : null,
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const results = [];
  let port = 4430;
  for (const sess of SESSIONS) {
    process.stdout.write(`[battery] ${sess.id} ... `);
    const rec = await runSession(sess, port++);
    results.push(rec);
    console.log(`${rec.verdict} (signer=${rec.observed.signer_call_count}, rejections=${rec.observed.rejections.length})`);
  }

  const fixture = {
    fixture: "S-BS-06 binding battery (reviewer round 2: field-change controls, unchanged-quote positive case, anchor integrity)",
    upstream_issue: "https://github.com/x402-foundation/x402/issues/3866",
    evidence_discipline: {
      established: "the client SIGNED and handed over an EIP-3009 transferWithAuthorization for the offered amount (signer-call counts and values captured at the signer boundary); the control gate rejects BEFORE the signer (signer-call count unchanged)",
      not_established: "an ON-CHAIN transfer: settlement in this harness is mocked (fault-injection stand, not a facilitator), the client wallet is an unfunded one-shot test key per session",
      redaction: "no private keys, no signatures, no usable authorizations; nonce values truncated; per-session throwaway wallets",
    },
    case_semantics: {
      note: "session labels follow the reviewer's naming remark: quote-change cases are TWO COMPLETED MOCKED REQUEST/SETTLEMENT CYCLES (a new independent payment per cycle), NOT an uncertain lost-response retry of one operation. Lost-response recovery is a separate failure mode (tracked separately in the Argus lab, block C/D).",
      rename_map: { c1: "unchanged quote, observe mode", c1ctl: "unchanged quote, control mode (NEW)", c2: "raised requirement, second completed cycle (observe)", "c2ctl/f-series": "per-field changes with control mode (NEW)", f6: "mid-session price DROP (NEW)", anchor: "rejected quote cannot replace the accepted anchor (NEW)" },
    },
    defense_boundary: {
      note: "the battery maps which requirement-field changes the CURRENT client (2.28.0) already rejects pre-signer, and which it does not. Evidence per row below.",
      guarded_by_client_spendControls: ["asset swap (asset allowlist/denomination: f2_asset_obs_run1)", "network swap (network-bound asset default: f3_network_obs_run1)"],
      unguarded_in_current_client: ["amount within the cap, both directions (original capture, f6 in observe mode would sign)", "payTo substitution within the same asset/network (f1; also lab scenario S-BS-05)", "resource/method binding: a changed resource or method creates a NEW quote binding with nothing to compare against (f4a, f5)"],
      what_the_proposed_control_adds: "caller-anchored amount expectation (both directions) + payTo/resource/method binding + rejected-quote-cannot-anchor (anchor integrity)",
    },
    expectation_provenance: {
      rule: "caller-supplied EXPECTED_PRICE_ATOMIC=10000 (control sessions) + first ACCEPTED requirement per (url, method); acceptance = 200 + settle receipt; rejected quotes never enter the ledger",
      bound_to: ["resource url", "method", "network", "scheme", "asset", "payTo", "amount"],
    },
    reproduce: {
      stand_cmd: "npx tsx src/cli/argus.ts run --block B --family BS --scenario S-BS-06 --bind 0.0.0.0:4430 --observe-window-ms 2500 --skip-gate --requirement-amounts \"<A1,A2>\" [--requirement-overrides '<json>'] --json",
      client_cmd: "SUT_CLIENT_MODE=observe|control [EXPECTED_PRICE_ATOMIC=10000] [ENDPOINT_SEQUENCE=\"GET /weather,POST /weather\"] REQUEST_CYCLES=<N> npx tsx client_v2.ts  # env: EVM_PRIVATE_KEY, RESOURCE_SERVER_URL=http://127.0.0.1:4430",
      orchestrator: "node sut-x402/battery.mjs",
      amounts_note: "atomic units, USDC 6 decimals: 10000 = $0.01, 5000 = $0.005, 50000 = $0.05, 100000 = $0.10",
      overrides_note: "per-contact requirement field overrides [{}, {payTo: ...}, {asset: ...}, {network: ...}]; empty object = serve canonical",
    },
    versions: {
      note: "tested version pin",
      packages: { "@x402/core": "2.28.0", "@x402/evm": "2.28.0", "@x402/express": "2.28.0", "@x402/fetch": "2.28.0", viem: "2.48.11 (package-lock resolved)" },
      runtime: `node ${process.version}`,
      network: "Base Sepolia (eip155:84532), USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      test_lab: { repo: "github.com/igor-vii/Argus-Agent-Test-Lab", branch: process.env.BATTERY_BRANCH || "block-b/binding-battery" },
    },
    sessions: results,
    summary: {
      total: results.length,
      match: results.filter((r) => r.verdict === "MATCH").length,
      mismatch: results.filter((r) => r.verdict === "MISMATCH").length,
      harness_error: results.filter((r) => r.verdict === "HARNESS_ERROR").length,
      all_match: results.every((r) => r.verdict === "MATCH"),
    },
  };

  writeFileSync(FIXTURE_OUT, JSON.stringify(fixture, null, 2));
  console.log(`\n[battery] fixture -> ${FIXTURE_OUT}`);
  console.log(`[battery] summary: ${JSON.stringify(fixture.summary)}`);
}

main().catch((e) => {
  console.error("[battery] fatal:", e);
  process.exit(1);
});
