/**
 * Block B runner — общие типы и агрегация результатов.
 *
 * Отчёт прогона разделяет вердикты (см. BlockBVerdict) и сырые факты
 * (PaymentFact / BcSendRecord / BsSessionRecord). Exit-коды совместимы
 * с решением по CR-2: 0 — нет FAIL, 1 — есть FAIL, 2 — HARNESS_ERROR
 * или провал гейта.
 */

import type { BlockBRunConfig, BlockBVerdict, BlockBGateResult, BlockBScenarioSpec } from '../BlockBScenario';
import type { Family } from '../BlockBRoles';
import type { PaymentFact } from '../PaymentFaultInjector';

/** Одна отправка плохим клиентом и ответ СУТ (семейство BC). */
export interface BcSendRecord {
  readonly seq: number;
  readonly status: number | null;
  readonly settleAccepted: boolean;
  readonly settleReason?: string;
  readonly paymentResponseRaw?: string;
  readonly bodySnippet?: string;
  readonly error?: string;
  readonly atMs: number;
}

/** Наблюдение одной попытки BC. */
export interface BcAttemptObservation {
  readonly attempt: number;
  readonly sends: readonly BcSendRecord[];
  readonly resourceIssued: boolean;
  readonly settleAccepted: boolean;
  readonly facts: readonly PaymentFact[];
  readonly error?: string;
}

/** Раскодированный платёж СУТ, принятый плохим сервером (семейство BS). */
export interface BsReceivedPayment {
  readonly seq: number;
  readonly nonce?: string;
  readonly value?: string;
  readonly raw: string;
  readonly atMs: number;
}

/** Запись сессии BS: всё, что зафиксировал раннер за окно наблюдения. */
export interface BsSessionRecord {
  readonly scenarioId: string;
  readonly payments: readonly BsReceivedPayment[];
  readonly requestCount: number;
  readonly duplicateSettleDelivered: boolean;
  readonly observeWindowMs: number;
  readonly facts: readonly PaymentFact[];
  readonly error?: string;
}

/** Результат прогона одного сценария. */
export interface ScenarioRunResult {
  readonly scenarioId: string;
  readonly slug: string;
  readonly family: Family;
  readonly title: string;
  readonly verdict: BlockBVerdict;
  readonly reasons: readonly string[];
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
}

/** Полный отчёт блока B. */
export interface RunnerReport {
  readonly config: BlockBRunConfig;
  readonly gate?: BlockBGateResult;
  readonly scenarios: readonly ScenarioRunResult[];
  readonly exitCode: 0 | 1 | 2;
  readonly finishedAtMs: number;
}

/** Порядок «худшести» для агрегации вердиктов по попыткам. */
const VERDICT_SEVERITY: Record<BlockBVerdict, number> = {
  PASS: 0,
  ADVISORY: 1,
  FAIL: 2,
  HARNESS_ERROR: 3,
};

export function worstVerdict(verdicts: readonly BlockBVerdict[]): BlockBVerdict {
  return verdicts.reduce(
    (worst, v) => (VERDICT_SEVERITY[v] > VERDICT_SEVERITY[worst] ? v : worst),
    'PASS' as BlockBVerdict
  );
}

/** Exit-код отчёта: HARNESS_ERROR/провал гейта → 2; есть FAIL → 1; иначе 0. */
export function computeExitCode(report: RunnerReport): 0 | 1 | 2 {
  if (report.gate && !report.gate.passed) return 2;
  const verdicts = report.scenarios.map((s) => s.verdict);
  if (verdicts.includes('HARNESS_ERROR')) return 2;
  if (verdicts.includes('FAIL')) return 1;
  return 0;
}

/** Проверка, что сценарий принадлежит семейству конфига. */
export function assertScenarioMatchesConfig(
  spec: BlockBScenarioSpec,
  config: BlockBRunConfig
): void {
  if (spec.family !== config.family) {
    throw new Error(
      `Scenario ${spec.id} (${spec.family}) does not match run config family '${config.family}'`
    );
  }
}
