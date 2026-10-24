/**
 * SUT client v2 — instrumented official x402 client for S-BS-06 probe sessions
 * (upstream issue #3866 follow-up; reviewer remarks of 2026-10-22).
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
 *   ENDPOINT_SEQUENCE      per-cycle request targets, comma-separated
 *                          "METHOD /path" or "/path" (GET implied); overrides
 *                          ENDPOINT_PATH; cycles default to entries count —
 *                          binding-battery probe for resource/method changes
 *   REQUEST_CYCLES         number of full request cycles (default 1, or the
 *                          ENDPOINT_SEQUENCE length when the sequence is set)
 *   SUT_CLIENT_MODE        observe | control (default observe)
 *   EXPECTED_PRICE_ATOMIC  caller-side price expectation (control mode)
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

/** Батарея биндинга: per-cycle targets из ENDPOINT_SEQUENCE (последний
 *  элемент повторяется; пусто — единственная цель из ENDPOINT_PATH). */
interface CycleTarget {
  method: string;
  path: string;
}

function parseEndpointSequence(raw: string | undefined): CycleTarget[] | undefined {
  if (!raw) return undefined;
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) return undefined;
  return entries.map((entry) => {
    const m = /^(GET|POST|PUT|DELETE|PATCH)\s+(\/.*)$/i.exec(entry);
    return m ? { method: m[1]!.toUpperCase(), path: m[2]! } : { method: "GET", path: entry };
  });
}

const endpointSequence = parseEndpointSequence(process.env.ENDPOINT_SEQUENCE);
const url = `${baseURL}${endpointPath}`;
const cycles = Number.parseInt(
  process.env.REQUEST_CYCLES || String(endpointSequence?.length ?? 1),
  10,
);
const mode = (process.env.SUT_CLIENT_MODE || "observe").toLowerCase();
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
  console.log(`[sut-client-v2] ${line}`);
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

/** Текущая цель цикла (url/method запроса СУТ). */
let currentTarget: { url: string; method: string } = {
  url: `${baseURL}${endpointSequence?.[0]?.path ?? endpointPath}`,
  method: endpointSequence?.[0]?.method ?? "GET",
};

/** Цель для цикла c (1-based): ENDPOINT_SEQUENCE, последний элемент повторяется. */
function targetForCycle(cycle: number): { url: string; method: string } {
  const seq = endpointSequence;
  if (!seq || seq.length === 0) {
    return { url: `${baseURL}${endpointPath}`, method: "GET" };
  }
  const idx = Math.min(cycle - 1, seq.length - 1);
  return { url: `${baseURL}${seq[idx]!.path}`, method: seq[idx]!.method };
}

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
  return {
    url: currentTarget.url,
    method: currentTarget.method,
    scheme: a.scheme,
    network: a.network,
    amount: a.amount,
    asset: a.asset,
    payTo: a.payTo,
  };
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
        url: currentTarget.url,
        method: currentTarget.method,
        payTo: String(message.to ?? ""),
        amount: message.value !== undefined ? BigInt(String(message.value)).toString() : undefined,
      };
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
      return orig(args);
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
        emit({ type: "quote_offered", cycle_context_url: currentTarget.url, requirements: body });
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
    url: currentTarget.url,
    cycles,
    endpoint_sequence: endpointSequence ?? null,
    expected_price_atomic: expectedPrice ?? null,
    spend_controls: { maxAmountPerPayment: "$1" },
    note: "settlement is mocked by the harness; captures establish signing, not on-chain transfer",
  });

  const perCycle: { cycle: number; http?: number; error?: string; receipt?: unknown }[] = [];

  for (let c = 1; c <= cycles; c++) {
    emit({ type: "cycle_start", cycle: c });
    currentTarget = targetForCycle(c);
    try {
      const response = await fetchWithPayment(currentTarget.url, { method: currentTarget.method });
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
    probe: "S-BS-06 review follow-up",
    mode,
    url,
    cycles,
    signer_call_count: signerCallCount,
    quote_ledger_size: quoteLedger.size,
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
  console.error(`[sut-client-v2] fatal: ${message}`);
  emit({ type: "fatal", error: message });
  process.exit(1);
});
