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

/**
 * Атакующий payTo для S-BS-05 / S-BS-18 (валидный 0x-адрес, НЕ канонический
 * получатель). Единая константа раннера и оценщиков.
 */
export const ATTACKER_PAYTO = '0x6666666666666666666666666666666666666666';

/**
 * Пробы S-BS-06 (follow-up #3866, binding-контроль): точечное изменение
 * ОДНОГО привязанного поля requirements на выбранном 402-контакте.
 * contact — 1-based номер 402-контакта в сессии.
 */
export interface RequirementFieldDelta {
  readonly contact: number;
  readonly payTo?: string;
  readonly asset?: string;
  readonly network?: string;
}

/**
 * Проба S-BS-18 (перенос S-ZS-02 secretariat, first-accept-wins): на выбранном
 * 402-контакте malicious-требование вставляется ПЕРВЫМ в accepts[]
 * (canonical остаётся вторым). Задано ровно одно из полей payTo/amount.
 */
export interface MaliciousFirstAccept {
  readonly contact: number;
  readonly payTo?: string;
  readonly amount?: string;
}

/**
 * Typed-отказ СУТ ДО подписанта (клиентский оракул волны 2.5). Единственный
 * pre-signature оракул карт S-BS-14/15: подписант ещё не вызван, решение
 * СУТ наблюдаемо по именованному полю и источнику проверки.
 */
export interface SutTypedRejection {
  /** 1-based номер клиентской попытки в сессии. */
  readonly attempt?: number;
  /** Тип ошибки клиента ('QuoteMismatchError' | 'OverSpendLimitError' | ...). */
  readonly code?: string;
  /** Именованное поле отказа ('payTo' | 'amount' | ...). */
  readonly field?: string;
  /** Источник проверки ('quote-ledger' | 'caller-config' | 'spend-cap' | ...). */
  readonly source?: string;
}

/**
 * Проба S-BS-14 binding-race (волна 2.5, пробы лаборатории A10a/A10b):
 * сервер выдаёт два КОНКУРЕНТНЫХ набора requirements на один ключ квоты
 * (resource, scheme, network, asset) при пустом клиентском биндинге.
 * Вариант 'explicit' — расхождение ТОЛЬКО payTo (ожидание вызывающего задано);
 * вариант 'first-accepted' — расхождение payTo И amount (ожидание не задано).
 * identical: true — обслуживать ИДЕНТИЧНЫЕ наборы (риг контроля-2, no false
 * positive). Адреса детерминированы: payToA = 0x111…, payToB = 0x222…
 */
export interface BindingRaceProbe {
  readonly variant?: 'explicit' | 'first-accepted';
  readonly payToA?: string;
  readonly payToB?: string;
  readonly amountA?: string;
  /** По умолчанию: explicit — amountA; first-accepted — amountA ×10. */
  readonly amountB?: string;
  /** Риг контроля-2: две параллельные ИДЕНТИЧНЫЕ попытки (без расхождения). */
  readonly identical?: boolean;
}

/** Наборы requirements, фактически отданные на контакты гонки S-BS-14. */
export interface BindingRaceServed {
  readonly contact: number;
  readonly payTo: string;
  readonly amount: string;
  readonly variant: 'explicit' | 'first-accepted' | 'identical';
}

/**
 * Контролы S-BS-14 (обязательны и входят в вердикт; исполняются драйвером
 * СУТ на СВЕЖЕМ клиенте, исходы докладываются в основную сессию):
 * control-1 — последовательная пара ТЕХ ЖЕ наборов на свежем клиенте:
 *   ровно 1 signer-вызов, вторая попытка отклонена ДО подписанта typed-ошибкой;
 * control-2 — две параллельные ИДЕНТИЧНЫЕ попытки payToA/amountA:
 *   2 подписанных payload (no false positive).
 */
export interface BindingRaceControlOutcomes {
  readonly control1: {
    readonly signerCalls: number;
    readonly rejectedPreSigner: boolean;
    readonly rejection?: SutTypedRejection;
  };
  readonly control2: {
    readonly signedPayloads: number;
  };
}

/**
 * Проба S-BS-15 non-atomic-amount (волна 2.5, проба лаборатории A11):
 * сервер объявляет amount в НЕАТОМАРНОЙ десятичной форме ("0.5") при
 * включённом и настроенном expectation-чеке (пин) — в расчёте на то, что
 * клиентская валидация пропускает неатомарное представление. Получатель
 * НЕ подменён (изоляция вектора — только представление суммы).
 * kind: exploit — подкаповое окно (основной вариант); over-cap — десятичная
 * сумма СВЕРХ капа (кап-щит, контроль-1); atomic-control — атомарный дубль
 * вектора (контроль-2).
 */
export interface NonAtomicAmountProbe {
  /** Неатомарное/атомарное представление суммы, отдаваемое в requirements. */
  readonly amount: string;
  /** Пин вызывающего (atomic units) — expectation-чек включён. */
  readonly pin: string;
  readonly kind?: 'exploit' | 'over-cap' | 'atomic-control';
}

/** Факт подачи неатомарной суммы (S-BS-15): что отдано и против какого пина. */
export interface NonAtomicAmountServed {
  readonly amount: string;
  readonly payTo: string;
  readonly pin: string;
  readonly kind: 'exploit' | 'over-cap' | 'atomic-control';
}

/**
 * Контролы S-BS-15 (обязательны и входят в вердикт):
 * control-1 (кап-щит): amount "2" ($2, десятичная, СВЕРХ капа $1) —
 *   отклонение ДО подписанта капом, 0 signer-вызовов;
 * control-2 (атомарный дубль): amount "500000" ($0.50 атомарно, ≠ пину) —
 *   QuoteMismatchError до подписанта, 0 signer-вызовов.
 */
export interface NonAtomicControlOutcomes {
  readonly control1: {
    readonly signerCalls: number;
    readonly rejectedPreSigner: boolean;
    readonly rejection?: SutTypedRejection;
  };
  readonly control2: {
    readonly signerCalls: number;
    readonly rejectedPreSigner: boolean;
    readonly rejection?: SutTypedRejection;
  };
}

/** Раскодированный платёж СУТ, принятый плохим сервером (семейство BS). */
export interface BsReceivedPayment {
  readonly seq: number;
  readonly nonce?: string;
  readonly value?: string;
  /** S-BS-18: получатель из authorization (payload.authorization.to), если был. */
  readonly to?: string;
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
  /** Пробы S-BS-06 (follow-up #3866): суммы requirements, отданные на каждый 402-контакт. */
  readonly requirementsServed?: readonly string[];
  /** Пробы S-BS-06 (binding-контроль): дельты полей, фактически отданные на контактах. */
  readonly requirementsDeltasServed?: readonly RequirementFieldDelta[];
  /** Lost-response контроль: ответ 200 после платежа уничтожен (не доставлен СУТ). */
  readonly lostResponseServed?: boolean;
  /** S-BS-18: malicious-first-accept требования, фактически вставленные в 402. */
  readonly maliciousFirstAcceptServed?: readonly MaliciousFirstAccept[];
  /** S-BS-17: ожидание прогона — максимум платежей, разрешённых caller-бюджетом. */
  readonly expectedMaxPayments?: number;
  /** S-BS-14: наборы requirements, фактически отданные на контакты гонки. */
  readonly bindingRaceServed?: readonly BindingRaceServed[];
  /** S-BS-14: исходы контрола 1–2 (драйвер СУТ; обязательны для PASS). */
  readonly bindingRaceControls?: BindingRaceControlOutcomes;
  /** S-BS-15: факт подачи неатомарной суммы против пина вызывающего. */
  readonly nonAtomicAmountServed?: NonAtomicAmountServed;
  /** S-BS-15: исходы контрола 1–2 (кап-щит + атомарный дубль). */
  readonly nonAtomicControls?: NonAtomicControlOutcomes;
  /** Волна 2.5: клиентский оракул — число вызовов подписанта за сессию. */
  readonly sutSignerCalls?: number;
  /** Волна 2.5: typed-отказы СУТ до подписанта (решение наблюдаемо). */
  readonly sutTypedRejections?: readonly SutTypedRejection[];
  /** S-BS-15: resolved payload инспекцией (не только catch: резолвится УСПЕХОМ). */
  readonly sutResolvedPayload?: { readonly amount?: string; readonly payTo?: string };
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
