/**
 * Block B registry — реестр сценариев волны 1 (v1-транш, 10 сценариев)
 * и вердикт-оценщики.
 *
 * Волна 1 = порядок внедрения, НЕ урезание состава: полный реестр 28
 * сценариев — docs/block-b/REGISTRY.md (RU) и BLOCK_B_TEST_MATRIX.md (EN).
 * Волна 2 добавляется сюда же по мере реализации.
 *
 * Оценщики реализуют объективные FAIL-критерии матрицы. Порогов ретраев
 * НЕТ (решение В1): количество платежей используется только там, где это
 * объективный вред (второй платёж за один ресурс = двойная оплата).
 */

import type { BlockBScenarioSpec, BlockBVerdict } from './BlockBScenario';
import { validateScenarioSpec } from './BlockBScenario';
import { scenarioId } from './BlockBRoles';
import { PassthroughPaymentFaultInjector } from './PaymentFaultInjector';
import { S_BC_01_BadSignature } from './examples/S_BC_01_BadSignature';
import type { BcAttemptObservation, BsSessionRecord } from './runners/BlockBRunnerTypes';

export interface VerdictEvaluation {
  readonly verdict: BlockBVerdict;
  readonly reasons: readonly string[];
}

/**
 * Оценка попытки BC по объективным критериям матрицы:
 * - базово: ресурс выдан или settle принят на невалидный платёж → FAIL;
 * - S-BC-09 (malformed-payload): дополнительно 5xx = FAIL (краш-класс).
 */
export function evaluateBcAttempt(
  spec: BlockBScenarioSpec,
  obs: BcAttemptObservation
): VerdictEvaluation {
  if (obs.error) {
    return { verdict: 'HARNESS_ERROR', reasons: [`harness error: ${obs.error}`] };
  }
  const reasons: string[] = [];
  if (obs.resourceIssued) {
    reasons.push('FAIL: СУТ выдал ресурс (2xx) в ответ на невалидный платёж');
  }
  if (obs.settleAccepted) {
    reasons.push('FAIL: СУТ подтвердил settle по невалидному платежу');
  }
  if (spec.id === scenarioId('BC', 9)) {
    const crash = obs.sends.some((s) => s.status !== null && s.status >= 500);
    if (crash) {
      reasons.push('FAIL: 5xx на malformed payload — необработанное исключение на стороне СУТ');
    }
  }
  if (reasons.length > 0) {
    return { verdict: 'FAIL', reasons };
  }
  return {
    verdict: 'PASS',
    reasons: [
      `невалидный платёж отклонён; отправок: ${obs.sends.length}; статусы: ${obs.sends
        .map((s) => (s.status === null ? 'network-error' : String(s.status)))
        .join(', ') || 'нет'}`,
    ],
  };
}

/**
 * Оценка сессии BS (волна 1). Объективные критерии:
 * - 402-loop / replay-challenge: второй платёж СУТ за один ресурс = FAIL;
 * - late-double-charge: второй платёж после дубликата квитанции = FAIL;
 * - oversize-amount: платёж на завышенную сумму = FAIL (решение В2);
 * - verify-pass-settle-fail: ADVISORY — защита требует политики сверки
 *   txHash у СУТ, что вне зоны наблюдения чёрного ящика (уточнение
 *   против docx-матрицы v1; согласуется с принципом «только факты»).
 */
export function evaluateBsSession(
  spec: BlockBScenarioSpec,
  session: BsSessionRecord
): VerdictEvaluation {
  if (session.error) {
    return { verdict: 'HARNESS_ERROR', reasons: [`harness error: ${session.error}`] };
  }
  const payments = session.payments;
  const reasons: string[] = [
    `платежей зафиксировано: ${payments.length}; запросов: ${session.requestCount}; окно наблюдения: ${session.observeWindowMs}ms`,
  ];

  switch (spec.slug) {
    case '402-loop-after-pay':
    case 'replay-challenge':
      if (payments.length > 1) {
        return {
          verdict: 'FAIL',
          reasons: [...reasons, 'FAIL: второй платёж СУТ за один и тот же ресурс (двойная оплата)'],
        };
      }
      return {
        verdict: 'PASS',
        reasons: [
          ...reasons,
          payments.length === 1
            ? 'СУТ не стал платить повторно после отказ-поведения сервера'
            : 'СУТ не заплатил вовсе (вреда нет)',
        ],
      };

    case 'late-double-charge':
      if (payments.length > 1) {
        return {
          verdict: 'FAIL',
          reasons: [...reasons, 'FAIL: СУТ заплатил повторно после дубликата settle-квитанции'],
        };
      }
      return {
        verdict: 'PASS',
        reasons: [
          ...reasons,
          `дубликат квитанции${session.duplicateSettleDelivered ? ' доставлен' : ' не доставлен (СУТ не обращался повторно в окне)'}; СУТ повторно не платил`,
        ],
      };

    case 'verify-pass-settle-fail':
      return {
        verdict: 'ADVISORY',
        reasons: [
          ...reasons,
          `квитанция без on-chain txHash ${
            payments.length > 0 ? 'принята СУТ (ресурс получен)' : 'не потреблена (платежей нет)'
          }; защита (сверка txHash) — политика СУТ, вне зоны наблюдения`,
        ],
      };

    case 'oversize-amount': {
      const paid = payments.find((p) => p.value !== undefined);
      if (paid && paid.value !== undefined) {
        return {
          verdict: 'FAIL',
          reasons: [...reasons, `FAIL: СУТ заплатил по завышенным требованиям (value=${paid.value}; решение В2)`],
        };
      }
      return {
        verdict: 'PASS',
        reasons: [...reasons, 'СУТ отказался платить по завышенным требованиям'],
      };
    }

    default:
      return { verdict: 'HARNESS_ERROR', reasons: [`нет оценщика для сценария ${spec.id}`] };
  }
}

/** Реестр волны 1 (v1-транш). */
export const BLOCK_B_WAVE1_SCENARIOS: readonly BlockBScenarioSpec[] = [
  S_BC_01_BadSignature,

  {
    id: scenarioId('BC', 2),
    slug: 'expired-valid-before',
    family: 'BC',
    phase: 1,
    wave: 1,
    title: 'Authorization с истёкшим validBefore',
    intent: 'Аргус подписывает платёж с validBefore в прошлом — СУТ/facilitator обязан отклонить.',
    failCriteria: [
      'СУТ выдал ресурс (2xx) по authorization с истёкшим validBefore',
      'СУТ подтвердил settle по такому платежу',
    ],
    observations: [
      'HTTP-статус ответа на подписанный ретрай',
      'причина отказа (authorization_valid_before из словаря фасилитатора)',
      'факты ретраев СУТ — без порогов (решение В1)',
    ],
    anchors: ['CDP invalidReason: authorization_valid_before', 'EIP-3009: validity window'],
    createInjector: () => ({
      scenarioId: 'S-BC-02',
      family: 'BC',
      onRequirements: async () => ({ action: 'passthrough' }),
      onSign: async (binding) => ({
        action: 'mutate',
        value: {
          ...binding,
          validBefore: String(Math.floor(Date.now() / 1000) - 10),
        },
        note: 'S-BC-02: validBefore сдвинут в прошлое',
      }),
      onPayload: async () => ({ action: 'passthrough' }),
      onSend: async () => ({ action: 'passthrough' }),
      onSettle: async () => ({ action: 'passthrough' }),
      getFacts: () => [],
    }),
  },

  {
    id: scenarioId('BC', 4),
    slug: 'nonce-reuse',
    family: 'BC',
    phase: 1,
    wave: 1,
    title: 'Повтор платёжной authorization с тем же nonce',
    intent:
      'После первой отправки Аргус повторяет ТО ЖЕ отправление (тот же nonce) — ' +
      'СУТ обязан идемпотентно отклонить повтор и не проводить второе settle.',
    failCriteria: [
      'повторная отправка принята (2xx) или по ней подтверждён settle',
    ],
    observations: [
      'ответы на первую и повторную отправки (статусы, квитанции)',
      'тайминги обеих отправок',
    ],
    anchors: ["NDSS'26: TOCTOU-replay", 'EIP-3009: nonce uniqueness', 'инвариант I2'],
    bcPlan: { replayAfterSend: true },
    suggestedRepeat: 3,
    createInjector: () => new PassthroughPaymentFaultInjector('S-BC-04', 'BC'),
  },

  {
    id: scenarioId('BC', 5),
    slug: 'insufficient-funds',
    family: 'BC',
    phase: 1,
    wave: 1,
    title: 'Платёж при нехватке баланса',
    intent:
      'Кошелёк Аргуса фондируется ниже суммы requirements, платёж подписывается честно — ' +
      'СУТ обязан отклонить (insufficient funds / unavailable funds).',
    failCriteria: [
      'СУТ выдал ресурс по платежу с недостаточным балансом',
      'СУТ подтвердил settle по такому платежу',
    ],
    observations: [
      'HTTP-статус; причина (insufficient_funds / unavailable_funds)',
      'фондирование выполняется FundingProvider до прогона (В3)',
    ],
    anchors: ['CDP invalidReason: insufficient_funds / unavailable_funds'],
    createInjector: () => new PassthroughPaymentFaultInjector('S-BC-05', 'BC'),
  },

  {
    id: scenarioId('BC', 9),
    slug: 'malformed-payload',
    family: 'BC',
    phase: 1,
    wave: 1,
    title: 'Невалидный payment-signature (битый Base64-JSON)',
    intent:
      'Аргус отправляет обрезанный/невалидный payload — СУТ обязан отказать читаемой ' +
      'ошибкой без 5xx-крашей и без выдачи ресурса.',
    failCriteria: [
      'СУТ выдал ресурс по невалидному payload',
      '5xx-ответ (необработанное исключение) или зависание обмена',
    ],
    observations: ['HTTP-статус; читаемость текста ошибки; тайминг ответа'],
    anchors: ['классика robustness; x402 V2 header contract'],
    createInjector: () => ({
      scenarioId: 'S-BC-09',
      family: 'BC',
      onRequirements: async () => ({ action: 'passthrough' }),
      onSign: async () => ({ action: 'passthrough' }),
      onPayload: async () => ({
        action: 'mutate',
        value: '%%%not-a-valid-base64-payload%%%',
        note: 'S-BC-09: payload заменён на невалидный',
      }),
      onSend: async () => ({ action: 'passthrough' }),
      onSettle: async () => ({ action: 'passthrough' }),
      getFacts: () => [],
    }),
  },

  {
    id: scenarioId('BS', 1),
    slug: '402-loop-after-pay',
    family: 'BS',
    phase: 1,
    wave: 1,
    title: 'Сервер требует оплату повторно после успешной оплаты',
    intent:
      'После принятого платежа Аргус снова отвечает 402 за тот же ресурс — ' +
      'СУТ не должен платить второй раз (двойная оплата).',
    failCriteria: ['СУТ заплатил второй раз за один и тот же ресурс'],
    observations: [
      'число платежей и 402 (факты, без порогов)',
      'тайминги; форма завершения сессии СУТ (ошибка/выход)',
    ],
    anchors: ['кейс «3 списания за 300 мс»; 402-цикл'],
    createInjector: () => new PassthroughPaymentFaultInjector('S-BS-01', 'BS'),
  },

  {
    id: scenarioId('BS', 2),
    slug: 'late-double-charge',
    family: 'BS',
    phase: 1,
    wave: 1,
    title: 'Повторная settle-квитанция в окне наблюдения',
    intent:
      'После успешной оплаты Аргус при повторном контакте доставляет дубликат ' +
      'settle-квитанции — СУТ не должен платить повторно.',
    failCriteria: ['СУТ заплатил повторно после дубликата settle-квитанции'],
    observations: [
      'окно наблюдения W (--observe-window-ms, дефолт 120с в CLI)',
      'факт доставки дубликата; все платежи с таймингами',
    ],
    anchors: ['GitHub #1065; инвариант I2 (уникальность nonce)'],
    createInjector: () => new PassthroughPaymentFaultInjector('S-BS-02', 'BS'),
  },

  {
    id: scenarioId('BS', 3),
    slug: 'verify-pass-settle-fail',
    family: 'BS',
    phase: 1,
    wave: 1,
    title: 'Settle «успех» без on-chain транзакции',
    intent:
      'Аргус подтверждает settle квитанцией БЕЗ txHash (фейковое settlement) — ' +
      'наблюдаем, принимает ли СУТ неподтверждённое settlement.',
    failCriteria: [],
    observations: [
      'принята ли квитанция без txHash (ресурс получен)',
      'защита (сверка txHash) — политика СУТ: вердикт ADVISORY, не FAIL',
    ],
    anchors: ['GitHub #1065 (боль №1: verify passes, settle fails)'],
    createInjector: () => new PassthroughPaymentFaultInjector('S-BS-03', 'BS'),
  },

  {
    id: scenarioId('BS', 6),
    slug: 'oversize-amount',
    family: 'BS',
    phase: 1,
    wave: 1,
    title: 'Требования превышают реальную цену ресурса (переплата x10)',
    intent:
      'Requirements требуют x10 от цены (реальная цена указана в description) — ' +
      'по exact-спецификации СУТ обязан отклонить; платёж = FAIL (решение В2).',
    failCriteria: ['СУТ заплатил по завышенным требованиям (переплата)'],
    observations: ['требуемая сумма; фактический value платежа; факт отказа'],
    anchors: ['решение В2; exact-scheme semantics'],
    createInjector: () => new PassthroughPaymentFaultInjector('S-BS-06', 'BS'),
  },

  {
    id: scenarioId('BS', 11),
    slug: 'replay-challenge',
    family: 'BS',
    phase: 1,
    wave: 1,
    title: 'Replay-челлендж: платёж «потерян», платите снова',
    intent:
      'После оплаты Аргус отвечает 402 с ТЕМИ ЖЕ requirements и ошибкой ' +
      'settlement_not_found — СУТ не должен платить второй раз за один ресурс.',
    failCriteria: ['СУТ заплатил второй раз за один и тот же ресурс'],
    observations: ['число платежей; тайминги; реакция на settlement_not_found'],
    anchors: ["NDSS'26 TOCTOU; двойная оплата"],
    suggestedRepeat: 3,
    createInjector: () => new PassthroughPaymentFaultInjector('S-BS-11', 'BS'),
  },
];

/** Все сценарии блока B, зарегистрированные в коде. */
export function listBlockBScenarios(): readonly BlockBScenarioSpec[] {
  return BLOCK_B_WAVE1_SCENARIOS;
}

/** Поиск сценария по ID ('S-BC-01'). */
export function getBlockBScenario(id: string): BlockBScenarioSpec | undefined {
  return BLOCK_B_WAVE1_SCENARIOS.find((s) => s.id === id);
}

/** Валидация всего реестра (для list/run и тестов). */
export function validateBlockBRegistry(): void {
  const seen = new Set<string>();
  for (const spec of BLOCK_B_WAVE1_SCENARIOS) {
    validateScenarioSpec(spec);
    if (seen.has(spec.id)) {
      throw new Error(`Duplicate scenario id in registry: ${spec.id}`);
    }
    seen.add(spec.id);
  }
}
