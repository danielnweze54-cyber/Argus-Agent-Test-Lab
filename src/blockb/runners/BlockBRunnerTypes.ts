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

/**
 * Результат settle-дрейна (S-BC-14 frontrun-drain): атакующий submits
 * подписанную authorization напрямую в фасилитатор ДО settle СУТ.
 */
export interface DrainProbeResult {
  /** Фасилитатор подтвердил settlement дрейнованного платежа. */
  readonly settled: boolean;
  readonly status?: number;
  readonly reason?: string;
  readonly raw?: string;
}

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
  /** S-BC-14: результат дрейна authorization до отправки СУТ. */
  readonly drain?: DrainProbeResult;
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

/**
 * Запись сессии BS: всё, что зафиксировал раннер за окно наблюдения.
 * Поля сценарных фактов волны 2 — опциональные: заполняются только теми
 * скриптами, для которых они являются наблюдением сценария.
 */
export interface BsSessionRecord {
  readonly scenarioId: string;
  readonly payments: readonly BsReceivedPayment[];
  readonly requestCount: number;
  readonly duplicateSettleDelivered: boolean;
  readonly observeWindowMs: number;
  readonly facts: readonly PaymentFact[];
  /** S-BS-04: сколько verify-отказов доставлено СУТ. */
  readonly verifyRejectionsDelivered?: number;
  /** S-BS-07: тело ресурса после оплаты отличалось от канонического. */
  readonly resourceEchoMismatch?: boolean;
  /** S-BS-08: 200 с ресурсом доставлен БЕЗ settle-квитанции. */
  readonly prematureReceiptServed?: boolean;
  /** S-BS-09: settle-квитанция со статусом pending (финала нет). */
  readonly settlePendingDelivered?: boolean;
  /** S-BS-10: доставлены структурно невалидные requirements. */
  readonly poisonRequirementsServed?: boolean;
  /** S-BS-12: битый транспорт (мусорный header/обрезанное тело). */
  readonly corruptTransportServed?: boolean;
  /** S-BS-13: ресурс отдан бесплатно (200 без 402). */
  readonly freeResourceServed?: boolean;
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
  NOT_APPLICABLE: 1, // непрогнанный сценарий не должен маскироваться под PASS
  ADVISORY: 2,
  FAIL: 3,
  HARNESS_ERROR: 4,
};

export function worstVerdict(verdicts: readonly BlockBVerdict[]): BlockBVerdict {
  return verdicts.reduce(
    (worst, v) => (VERDICT_SEVERITY[v] > VERDICT_SEVERITY[worst] ? v : worst),
    'PASS' as BlockBVerdict
  );
}

/** Exit-код отчёта: HARNESS_ERROR/провал гейта → 2; есть FAIL → 1; иначе 0.
 *  NOT_APPLICABLE — не FAIL и не сбой (сценарий неприменим к СУТ): exit 0,
 *  но в отчёте сценарий идёт отдельной строкой, не в доле PASS. */
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
