/**
 * Детальный прогон BC-сценариев против реального СУТ с полной телеметрией
 * (статусы, причины отказа, сниппеты тел) — источник доказательств для
 * протокола испытаний. Не меняет код лаборатории, только потребляет раннер.
 */
import { writeFileSync } from 'node:fs';
import { createBcRunner } from '../src/blockb/runners/BcRunner';
import { BLOCK_B_WAVE1_SCENARIOS, evaluateBcAttempt } from '../src/blockb/BlockBRegistry';
import { walletSigner } from '../src/cli/blockBCommand';

const pk = process.env.ARGUS_TEST_WALLET_PRIVATE_KEY as `0x${string}`;
const sutUrl = process.env.SUT_URL ?? 'http://127.0.0.1:4021/weather';
const repeatDefault = Number(process.env.REPEAT ?? 2);

/** Записывающий fetch: сохраняет PAYMENT-REQUIRED/PAYMENT-RESPONSE каждого ответа. */
function makeRecordingFetch(sink: { url: string; status: number; paymentRequired: unknown; paymentResponse: unknown }[]): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input as string, init);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const decode = (raw?: string) => {
      if (!raw) return null;
      try {
        return JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
      } catch {
        return raw;
      }
    };
    sink.push({
      url: typeof input === 'string' ? input : (input as RequestInfo).toString(),
      status: res.status,
      paymentRequired: decode(headers['payment-required']),
      paymentResponse: decode(headers['payment-response']),
    });
    return res;
  };
}

const outFile = process.env.OUT_FILE ?? '/home/z/my-project/run-b-artifacts/bc_detailed.json';

async function main(): Promise<void> {
  const signer = walletSigner(pk);
  const out: Record<string, unknown>[] = [];

  for (const spec of BLOCK_B_WAVE1_SCENARIOS.filter((s) => s.family === 'BC')) {
    const repeat = spec.id === 'S-BC-04' ? 3 : repeatDefault;
    const httpLog: { url: string; status: number; paymentRequired: unknown; paymentResponse: unknown }[] = [];
    const runner = createBcRunner({
      runConfig: {
        family: 'BC',
        sutRole: 'server',
        resourceUrl: sutUrl,
        label: 'bc-detailed-evidence',
      },
      scenario: spec,
      signer,
      requestTimeoutMs: 20000,
      fetchImpl: makeRecordingFetch(httpLog),
    });
    const attempts = [];
    for (let attempt = 1; attempt <= repeat; attempt++) {
      const injector = spec.createInjector();
      const obs = await runner.runAttempt(injector, attempt);
      attempts.push({
        attempt,
        resourceIssued: obs.resourceIssued,
        settleAccepted: obs.settleAccepted,
        error: obs.error,
        sends: obs.sends,
      });
    }
    const evaluations = attempts.map((a) => evaluateBcAttempt(spec, a as never));
    out.push({
      scenarioId: spec.id,
      slug: spec.slug,
      title: spec.title,
      verdicts: evaluations.map((e) => e.verdict),
      reasons: evaluations.flatMap((e) => e.reasons),
      attempts,
      httpLog,
    });
    console.error(`${spec.id} ${spec.slug}: ${evaluations.map((e) => e.verdict).join(',')}`);
  }

  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.error('written: bc_detailed.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
