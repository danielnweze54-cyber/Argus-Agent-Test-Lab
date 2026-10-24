/**
 * Block B gate — «канонические ворота» семейства.
 *
 * Перед сценарием семейства выполняется канонический happy-path в роли:
 *   BC: честный Аргус платит СУТ за ресурс — PASS гейта, если СУТ
 *       вернул 200 + settle-квитанцию;
 *   BS: СУТ-клиент платит честному серверу Аргуса — PASS гейта, если
 *       получен ровно один платёж и СУТ забрал ресурс.
 *
 * Провал гейта => семейство не стартует (exit 2).
 */

import type { BlockBGateResult, BlockBRunConfig, Family } from '../../blockb';
import { PassthroughPaymentFaultInjector } from '../PaymentFaultInjector';
import { createBcRunner } from './BcRunner';
import { BsRunner } from './BsRunner';
import { worstVerdict } from './BlockBRunnerTypes';
import type { PaymentSigner } from './BcRunner';

export interface GateOptions {
  readonly config: BlockBRunConfig;
  /** Только для BC: подписант честного клиента. */
  readonly signer?: PaymentSigner;
  /** Только для BS: цена ресурса (дефолт '10000'). */
  readonly resourcePrice?: string;
  readonly observeWindowMs?: number;
  readonly firstRequestTimeoutMs?: number;
}

/** Исполнение гейта семейства. */
export async function runBlockBGate(options: GateOptions): Promise<BlockBGateResult> {
  const family: Family = options.config.family;
  const startedAt = Date.now();

  if (family === 'BC') {
    if (!options.signer) {
      return {
        family,
        passed: false,
        details: 'gate BC requires a payment signer (wallet) for the honest client',
      };
    }
    const injector = new PassthroughPaymentFaultInjector('GATE-BC', 'BC');
    const runner = createBcRunner({
      runConfig: { ...options.config, family: 'BC' } as BlockBRunConfig & { family: 'BC' },
      scenario: {
        id: 'GATE-BC',
        slug: 'gate-happy-path',
        family: 'BC',
        phase: 1,
        wave: 1,
        title: 'Gate: canonical happy-path (SUT as resource server)',
        intent: 'Honest payment flow — no faults',
        failCriteria: [],
        observations: [],
        createInjector: () => injector,
      },
      signer: options.signer,
    });
    const observation = await runner.runAttempt(injector, 1);
    const passed =
      !observation.error &&
      observation.resourceIssued &&
      observation.settleAccepted;
    return {
      family,
      passed,
      details: passed
        ? `happy-path OK in ${Date.now() - startedAt}ms`
        : `gate failed: ${observation.error ?? 'no 200+settlement from SUT'}`,
    };
  }

  // Gate BS: честный сервер (200 + квитанция на первый платёж).
  const honestServer = new BsRunner({
    runConfig: { ...options.config, family: 'BS' } as BlockBRunConfig & { family: 'BS' },
    scenario: {
      id: 'GATE-BS',
      slug: 'gate-happy-path',
      family: 'BS',
      phase: 1,
      wave: 1,
      title: 'Gate: canonical happy-path (SUT as client)',
      intent: 'Honest server behavior — no faults',
      failCriteria: [],
      observations: [],
      createInjector: () => new PassthroughPaymentFaultInjector('GATE-BS', 'BS'),
    },
    resourcePrice: options.resourcePrice,
    observeWindowMs: options.observeWindowMs,
    firstRequestTimeoutMs: options.firstRequestTimeoutMs,
  });

  // Для гейта BS нужен честный скрипт: используем служебный slug.
  const session = await runGateBsSession(honestServer);
  const passed = !session.error && session.payments.length === 1 && session.requestCount >= 2;
  void worstVerdict;
  return {
    family,
    passed,
    details: passed
      ? `happy-path OK in ${Date.now() - startedAt}ms (one payment, resource served)`
      : `gate failed: ${session.error ?? `payments=${session.payments.length}`}`,
  };
}

/**
 * Гейт-сессия BS: тот же транспорт, но slug 'gate-happy-path' отвечает
 * честным скриптом (200 + квитанция на любой платёж).
 */
async function runGateBsSession(runner: BsRunner): Promise<{
  payments: readonly { readonly seq: number }[];
  requestCount: number;
  error?: string;
}> {
  // BsRunner.respondToPayment имеет default-ветку (200 + ресурс) для
  // несценарных slug — 'gate-happy-path' попадает именно туда: платёж
  // принят, квитанция выдана, ресурс отдан. Ожидаем ровно один платёж.
  const session = await runner.runSession();
  return {
    payments: session.payments,
    requestCount: session.requestCount,
    error: session.error,
  };
}
