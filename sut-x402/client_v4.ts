/**
 * SUT client v4 — instrumented official x402 client for wave-3 scenario
 * transfers (Block D S10/S11 + secretariat S-ZS-02 -> x402, 2026-10-24).
 *
 * Identical to client_v3.ts EXCEPT two caller-side policy hooks, both checked
 * BEFORE the real signer is invoked (same discipline as the S-BS-06 control
 * gate — rejection must precede any signature):
 *
 *   SUT_CLIENT_BUDGET_ATOMIC  total spend budget (atomic units). Commit ledger
 *                             grows with every ACTUAL signature; a signature
 *                             that would exceed the budget is refused
 *                             (budget_exceeded_before_signer). Boundary at
 *                             exactly the limit is INCLUSIVE (S11 semantics).
 *   SUT_CLIENT_ALLOWED_PAYTO  comma-separated recipient whitelist (S-ZS-02
 *                             allowedSellers transfer). A signature to any
 *                             other recipient is refused
 *                             (allowed_sellers_rejected_before_signer).
 *
 * client_v2.ts stays byte-identical to its recorded SHA-256
 * (a4d2f787edf90d24de3db236158c46e5decd6b7bf3d707493882b960b97382a0);
 * client_v3.ts stays byte-identical to the 2026-10-24 binding probes.
 *
 * Built on the SAME official stack as client.ts (@x402/fetch, @x402/evm v2.28.0,
 * upstream example clients/fetch). Two modes:
 *
 *   SUT_CLIENT_MODE=observe (default)
 *     Strictly passive instrumentation: logs every 402 requirements served,
 *     every signer invocation (bound fields: resource, method, network, scheme,
 *     asset, payTo, amount), and every settle receipt. Behaviour is identical
 *     to client.ts — this is the "current behavior" capture.
 *
 *   SUT_CLIENT_MODE=control
 *     Implements the reviewer-proposed check: an ACCEPTED QUOTE is bound to
 *     (url, method) and re-checked on every later requirement for the same
 *     binding across {network, scheme, asset, payTo, amount}. Any mismatch
 *     rejects BEFORE the real signer is invoked (signer-call count unchanged).
 *     Optional caller-supplied expectation EXPECTED_PRICE_ATOMIC is checked on
 *     the FIRST acceptance. The server's own "canonical price" label is NOT
 *     used as an expectation — it is captured verbatim as served data only.
 *
 * Evidence discipline (per reviewer remark #1): this harness mocks settlement;
 * captures establish that the client SIGNED AND HANDED OVER an EIP-3009
 * authorization — they do NOT establish an on-chain transfer.
 *
 * Env:
 *   EVM_PRIVATE_KEY        SUT client wallet key (testnet one-shot, unfunded)
 *   RESOURCE_SERVER_URL    base URL of the payment-demanding server
 *   ENDPOINT_PATH          resource path (default /weather)
 *   REQUEST_CYCLES         number of full request cycles (default 1)
 *   REQUEST_PATHS          comma-separated resource paths, one per cycle
 *                          (default: ENDPOINT_PATH repeated; v3 only)
 *   SUT_CLIENT_MODE        observe | control (default observe)
 *   EXPECTED_PRICE_ATOMIC  caller-side price expectation (control mode)
 *   SUT_CLIENT_BUDGET_ATOMIC   total spend budget (v4; any mode)
 *   SUT_CLIENT_ALLOWED_PAYTO   recipient whitelist (v4; any mode)
 *   CLIENT_EVENT_LOG       JSONL event log path (also mirrored to stdout)
 *
 * No EVM_RPC_URL: signing is purely off-chain (black-box, no balance gates).
 */
import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { appendFileSync, writeFileSync } from "node:fs";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://127.0.0.1:4401";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;
// v3: one resource path per cycle (resource/call binding probe). Cycle c uses
// paths[(c-1) % paths.length]; with a single entry behaviour equals client_v2.
const paths = (process.env.REQUEST_PATHS || endpointPath)
  .split(",")
  .map((p) => p.trim())
  .filter((p) => p.length > 0);
let activeUrl = url;
const cycles = Number.parseInt(process.env.REQUEST_CYCLES || "1", 10);
const mode = (process.env.SUT_CLIENT_MODE || "observe").toLowerCase();
// v4: caller-side policies (budget + recipient whitelist), both pre-signer.
const budgetAtomic = process.env.SUT_CLIENT_BUDGET_ATOMIC || undefined;
const allowedPayTo = (process.env.SUT_CLIENT_ALLOWED_PAYTO || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s.length > 0);
const expectedPrice = process.env.EXPECTED_PRICE_ATOMIC || undefined;
const eventLogPath = process.env.CLIENT_EVENT_LOG || undefined;

if (!evmPrivateKey) {
  console.error("Missing required EVM_PRIVATE_KEY environment variable");
  process.exit(1);
}
if (mode !== "observe" && mode !== "control") {
  console.error(`SUT_CLIENT_MODE must be observe|control, got '${mode}'`);
  process.exit(1);
}

/* ----------------------------- event ledger ----------------------------- */

type ClientEvent = Record<string, unknown>;
const events: ClientEvent[] = [];
let signerCallCount = 0;
const startedAt = new Date().toISOString();

function emit(event: ClientEvent): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  events.push({ at: new Date().toISOString(), ...event });
  console.log(`[sut-client-v4] ${line}`);
  if (eventLogPath) {
    try {
      appendFileSync(eventLogPath, `${line}\n`, { encoding: "utf-8" });
    } catch {
      /* logging must never change SUT behaviour */
    }
  }
}

const short = (v: unknown, keep = 10): string => {
  const s = String(v ?? "");
  return s.length <= keep * 2 ? s : `${s.slice(0, keep)}…${s.slice(-4)}(len${s.length})`;
};

/* --------------------------- quote-bound check -------------------------- */

interface BoundRequirement {
  url: string;
  method: string;
  network?: string;
  scheme?: string;
  asset?: string;
  payTo?: string;
  amount?: string;
}

const quoteLedger = new Map<string, BoundRequirement>();
// v4: caller-side spend budget — committed grows only with ACTUAL signatures.
let budgetCommitted = 0n;

const eq = (a: unknown, b: unknown): boolean =>
  String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/**
 * Reviewer-proposed control: bind the accepted quote to the intended
 * resource/call, network, asset and recipient — not just the number.
 * Returns null when the signer may be invoked, else a rejection reason.
 */
function controlGate(current: BoundRequirement): string | null {
  const key = `${current.method} ${current.url}`;
  const accepted = quoteLedger.get(key);
  if (!accepted) {
    if (expectedPrice && current.amount && BigInt(current.amount) !== BigInt(expectedPrice)) {
      return `caller_expectation_mismatch: expected ${expectedPrice} (caller config), offered ${current.amount}`;
    }
    return null;
  }
  const diffs: string[] = [];
  if (!eq(accepted.network, current.network)) diffs.push(`network ${accepted.network} -> ${current.network}`);
  if (!eq(accepted.scheme, current.scheme)) diffs.push(`scheme ${accepted.scheme} -> ${current.scheme}`);
  if (!eq(accepted.asset, current.asset)) diffs.push(`asset ${accepted.asset} -> ${current.asset}`);
  if (!eq(accepted.payTo, current.payTo)) diffs.push(`payTo ${accepted.payTo} -> ${current.payTo}`);
  if (accepted.amount && current.amount && BigInt(accepted.amount) !== BigInt(current.amount)) {
    diffs.push(`amount ${accepted.amount} -> ${current.amount}`);
  }
  return diffs.length > 0 ? `quote_mismatch_vs_accepted: ${diffs.join("; ")}` : null;
}

/* ------------------------------ instrumentation -------------------------- */

function extractBound(body: unknown): BoundRequirement {
  const reqs = body as {
    accepts?: { scheme?: string; network?: string; amount?: string; asset?: string; payTo?: string }[];
  };
  const a = reqs?.accepts?.[0] ?? {};
  return { url: activeUrl, method: "GET", scheme: a.scheme, network: a.network, amount: a.amount, asset: a.asset, payTo: a.payTo };
}

async function main(): Promise<void> {
  let lastOffered: BoundRequirement | null = null;

  const client = new x402Client();
  client.setSpendControls({ maxAmountPerPayment: "$1" });

  const rawAccount = privateKeyToAccount(evmPrivateKey!);
  const wrapSignTypedData =
    (label: string, orig: (args: Record<string, unknown>) => Promise<string>) =>
    async (args: Record<string, unknown>): Promise<string> => {
      const message = (args.message ?? {}) as Record<string, unknown>;
      const bound: BoundRequirement = {
        url: activeUrl,
        method: "GET",
        payTo: String(message.to ?? ""),
        amount: message.value !== undefined ? BigInt(String(message.value)).toString() : undefined,
      };
      // v4 caller-side policy 1 — recipient whitelist (S-ZS-02 transfer):
      // refusal BEFORE the real signer, identical discipline to the control gate.
      const payToLc = String(message.to ?? "").toLowerCase();
      if (allowedPayTo.length > 0 && !allowedPayTo.includes(payToLc)) {
        emit({
          type: "allowed_sellers_rejected_before_signer",
          call_index: signerCallCount + 1,
          signer_entry: label,
          pay_to: payToLc,
          whitelist: allowedPayTo,
          would_have_signed: { to: String(message.to ?? ""), value: bound.amount },
        });
        throw new Error(`allowed-sellers-rejected: payTo ${payToLc} not in caller whitelist`);
      }
      // v4 caller-side policy 2 — total spend budget (S11 transfer). Boundary
      // at exactly the limit is INCLUSIVE (committed + amount == budget passes).
      if (budgetAtomic) {
        const amount = bound.amount !== undefined ? BigInt(bound.amount) : 0n;
        const budget = BigInt(budgetAtomic);
        if (budgetCommitted + amount > budget) {
          emit({
            type: "budget_rejected_before_signer",
            call_index: signerCallCount + 1,
            signer_entry: label,
            committed: budgetCommitted.toString(),
            amount: amount.toString(),
            budget: budget.toString(),
            would_have_signed: { to: String(message.to ?? ""), value: bound.amount },
          });
          throw new Error(
            `budget-rejected: budget_exceeded_before_signer (committed ${budgetCommitted} + ${amount} > budget ${budget})`
          );
        }
      }
      if (mode === "control") {
        // Rejection happens HERE — before the real signer is invoked.
        // Binding fields come from what is actually signed (message.to/value)
        // merged with the offered requirements (network/scheme/asset).
        const reason = controlGate({
          ...bound,
          scheme: lastOffered?.scheme,
          network: lastOffered?.network,
          asset: lastOffered?.asset,
        });
        if (reason) {
          emit({
            type: "control_rejected_before_signer",
            call_index: signerCallCount + 1,
            signer_entry: label,
            reason,
            would_have_signed: { to: String(message.to ?? ""), value: bound.amount },
          });
          throw new Error(`quote-check-rejected: ${reason}`);
        }
      }
      signerCallCount += 1;
      emit({
        type: "signer_call",
        call_index: signerCallCount,
        signer_entry: label,
        primary_type: String(args.primaryType ?? ""),
        domain: {
          name: (args.domain as Record<string, unknown> | undefined)?.name,
          version: (args.domain as Record<string, unknown> | undefined)?.version,
          chainId: (args.domain as Record<string, unknown> | undefined)?.chainId,
          verifyingContract: (args.domain as Record<string, unknown> | undefined)?.verifyingContract,
        },
        to: String(message.to ?? ""),
        value: bound.amount,
        from: String(message.from ?? ""),
        valid_after: message.validAfter !== undefined ? String(message.validAfter) : undefined,
        valid_before: message.validBefore !== undefined ? String(message.validBefore) : undefined,
        nonce: short(message.nonce as string | undefined),
        // NOTE: signature is deliberately NOT logged (usable authorization).
      });
      const signature = await orig(args);
      if (budgetAtomic && bound.amount !== undefined) {
        budgetCommitted += BigInt(bound.amount);
        emit({ type: "budget_committed", committed: budgetCommitted.toString() });
      }
      return signature;
    };

  const instrumentedAccount = {
    ...rawAccount,
    signTypedData: wrapSignTypedData("signTypedData", rawAccount.signTypedData.bind(rawAccount)),
    ...(rawAccount.signTypedDataAsync
      ? { signTypedDataAsync: wrapSignTypedData("signTypedDataAsync", rawAccount.signTypedDataAsync.bind(rawAccount)) }
      : {}),
  };

  client.register("eip155:*", new ExactEvmScheme(instrumentedAccount as never));

  const loggingFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await fetch(input, init);
    if (res.status === 402) {
      try {
        const body = await res.clone().json();
        lastOffered = extractBound(body);
        emit({ type: "quote_offered", cycle_context_url: activeUrl, requirements: body });
      } catch {
        emit({ type: "quote_offered_unparseable" });
      }
    }
    return res;
  };

  const fetchWithPayment = wrapFetchWithPayment(loggingFetch as typeof fetch, client);
  const httpClient = new x402HTTPClient(client);

  emit({
    type: "probe_start",
    mode,
    client_version: "v4",
    paths,
    cycles,
    expected_price_atomic: expectedPrice ?? null,
    budget_atomic: budgetAtomic ?? null,
    allowed_payto_count: allowedPayTo.length,
    spend_controls: { maxAmountPerPayment: "$1" },
    note: "settlement is mocked by the harness; captures establish signing, not on-chain transfer",
  });

  const perCycle: { cycle: number; http?: number; error?: string; receipt?: unknown }[] = [];

  for (let c = 1; c <= cycles; c++) {
    const cycleUrl = `${baseURL}${paths[(c - 1) % paths.length]}`;
    activeUrl = cycleUrl;
    emit({ type: "cycle_start", cycle: c, url: cycleUrl });
    try {
      const response = await fetchWithPayment(cycleUrl, { method: "GET" });
      let receipt: unknown;
      const prHeader = response.headers.get("payment-response");
      if (prHeader) {
        try {
          receipt = JSON.parse(Buffer.from(prHeader, "base64").toString("utf-8"));
        } catch {
          receipt = { unparsable: short(prHeader, 24) };
        }
      }
      await httpClient.processResponse(response).catch(() => undefined);
      emit({ type: "cycle_result", cycle: c, http: response.status, receipt_served: receipt ?? null });
      perCycle.push({ cycle: c, http: response.status, receipt: receipt ?? null });
      // Quote accepted = the harness proceeded and payment was confirmed by the
      // server (200 + settle receipt). Ledger update AFTER the fact.
      if (response.status >= 200 && response.status < 300 && lastOffered) {
        const key = `${lastOffered.method} ${lastOffered.url}`;
        if (!quoteLedger.has(key)) {
          quoteLedger.set(key, { ...lastOffered });
          emit({
            type: "quote_accepted",
            cycle: c,
            bound_to: lastOffered,
            source: "server 402 accepts[0], accepted by caller at this timestamp",
            ledger_size: quoteLedger.size,
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "cycle_error", cycle: c, error: message });
      perCycle.push({ cycle: c, error: message });
    }
  }

  const summary = {
    probe: "wave-3 scenario transfers (S10/S11/S-ZS-02 -> x402)",
    mode,
    client_version: "v4",
    paths,
    cycles,
    signer_call_count: signerCallCount,
    quote_ledger_size: quoteLedger.size,
    budget_atomic: budgetAtomic ?? null,
    budget_committed_total: budgetAtomic ? budgetCommitted.toString() : null,
    allowed_payto_count: allowedPayTo.length,
    per_cycle: perCycle,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    distinction: "signed authorization captured; on-chain transfer NOT established (mocked settlement)",
  };
  console.log(`PROBE_SUMMARY: ${JSON.stringify(summary)}`);
  if (eventLogPath) {
    try {
      writeFileSync(`${eventLogPath}.summary`, JSON.stringify(summary, null, 2), { encoding: "utf-8" });
    } catch {
      /* non-fatal */
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[sut-client-v4] fatal: ${message}`);
  emit({ type: "fatal", error: message });
  process.exit(1);
});
