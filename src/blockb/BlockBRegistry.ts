/**
 * Block B registry — полный реестр сценариев (28 = волна 1 × 10 + волна 2 × 18)
 * и вердикт-оценщики.
 *
 * Волна 1 = v1-транш (топ рейтинга поражаемости + дешёвая классика).
 * Волна 2 = остальной состав; S-BC-14 (frontrun-drain) и S-BC-15
 * (upto-overdraft) — отцепляемые сценарии фазы 2 (mempool/settle-race-проба
 * и upto-поддержка соответственно). Полный реестр с якорями —
 * docs/block-b/REGISTRY.md (RU) и BLOCK_B_TEST_MATRIX.md (EN).
 *
 * Оценщики реализуют объективные FAIL-критерии матрицы. Порогов ретраев
 * НЕТ (решение В1): количество платежей используется только там, где это
 * объективный вред (второй платёж за один ресурс = двойная оплата).
 */

import type { BlockBScenarioSpec, BlockBVerdict } from './BlockBScenario';
import { validateScenarioSpec } from './BlockBScenario';
import { scenarioId } from './BlockBRoles';
import { PassthroughPaymentFaultInjector } from './PaymentFaultInjector';
import type { PaymentFact } from './PaymentFaultInjector';
import { S_BC_01_BadSignature } from './examples/S_BC_01_BadSignature';
import type { BcAttemptObservation, BcSendRecord, BsSessionRecord } from './runners/BlockBRunnerTypes';

export interface VerdictEvaluation {
  readonly verdict: BlockBVerdict;
  readonly reasons: readonly string[];
}

/**
 * Оценка попытки BC по объективным критериям матрицы.
 * Общая логика (умолчание): ресурс выдан или settle принят на невалидный
 * платёж → FAIL; S-BC-09 — дополнительно 5xx = FAIL (краш-класс).
 * Сценарии со спецификой вынесены в отдельные ветки:
 * duplicate-send (платёж ВАЛИДЕН — FAIL только при двойном accept),
 * wallet-kyt-edge (краш-класс), frontrun-drain (факт дрейна),
 * upto-overdraft (неприменимость на СУТ без upto).
 */
export function evaluateBcAttempt(
  spec: BlockBScenarioSpec,
  obs: BcAttemptObservation
): VerdictEvaluation {
  if (obs.error) {
    return { verdict: 'HARNESS_ERROR', reasons: [`harness error: ${obs.error}`] };
  }
  switch (spec.slug) {
    case 'duplicate-send':
      return evaluateBcDuplicateSend(obs);
    case 'wallet-kyt-edge':
      return evaluateBcKytEdge(obs);
    case 'frontrun-drain':
      return evaluateBcFrontrunDrain(obs);
    case 'upto-overdraft':
      return evaluateBcUptoOverdraft(obs);
    default:
      return evaluateBcGeneric(spec, obs);
  }
}

/**
 * Дисциплина доказательств: PASS возможен только при наблюдаемом решении СУТ
 * по каждой отправке плана. Транспортный сбой/таймаут (status null + error) —
 * отсутствие наблюдения, а не отсутствие нарушения → HARNESS_ERROR.
 * status null БЕЗ ошибки — запланированный дроп инжектора (наблюдать нечего
 * по плану; фиксируем в причинах, но не валим прогон).
 */
function transportFailures(sends: readonly BcSendRecord[]): readonly BcSendRecord[] {
  return sends.filter((s) => s.status === null && s.error);
}

function plannedDrops(sends: readonly BcSendRecord[]): number {
  return sends.filter((s) => s.status === null && !s.error).length;
}

function statusesOf(sends: readonly BcSendRecord[]): string {
  return sends.map((s) => (s.status === null ? (s.error ? 'network-error' : 'dropped') : String(s.status))).join(', ') || 'нет';
}

/** HARNESS_ERROR: наблюдения нет — PASS невозможен (принцип «факты или не вердикт»). */
function unobservedVerdict(sends: readonly BcSendRecord[]): VerdictEvaluation {
  const failed = transportFailures(sends);
  return {
    verdict: 'HARNESS_ERROR',
    reasons: [
      `нет наблюдаемого решения СУТ по ${failed.length} отправке(ам) из ${sends.length} — недостаточно доказательств для PASS`,
      ...failed.map((s) => `отправка #${s.seq}: ${s.error ?? 'transport failure'}`),
    ],
  };
}

/** Общая ветка BC: невалидный платёж должен быть отклонён без выдачи ресурса. */
function evaluateBcGeneric(spec: BlockBScenarioSpec, obs: BcAttemptObservation): VerdictEvaluation {
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
  if (transportFailures(obs.sends).length > 0) {
    return unobservedVerdict(obs.sends);
  }
  const drops = plannedDrops(obs.sends);
  return {
    verdict: 'PASS',
    reasons: [
      `невалидный платёж отклонён; отправок: ${obs.sends.length}; статусы: ${statusesOf(obs.sends)}` +
        (drops > 0 ? `; запланированных дропов: ${drops}` : ''),
    ],
  };
}

/**
 * S-BC-11 duplicate-send: платёж ВАЛИДЕН, фолт — двойная отправка подряд.
 * Ожидаемое поведение СУТ: первое отправление принять, повтор (тот же nonce)
 * отклонить. Принятие платежа подтверждает ТОЛЬКО settle-квитанция:
 * FAIL = ДВЕ settle-квитанции по одному платежу (двойное settle).
 * HTTP 2xx без квитанции — транспортный факт (ресурс выдан), но не
 * доказательство settle: повтор 2xx без квитанции = ADVISORY (принятие
 * не подтверждено, но и не опровергнуто).
 * Ослабленная форма (первое отправление не принято — например, пустой
 * кошелёк в режиме О1) = ADVISORY: решения наблюдаемы, но гонка double-accept
 * не исполнена — PASS такой прогон не получает.
 */
function evaluateBcDuplicateSend(obs: BcAttemptObservation): VerdictEvaluation {
  if (obs.sends.length < 2) {
    return {
      verdict: 'HARNESS_ERROR',
      reasons: [`план дубликата не исполнен (отправок: ${obs.sends.length} < 2)`],
    };
  }
  if (transportFailures(obs.sends).length > 0) {
    return unobservedVerdict(obs.sends);
  }
  const [first, second] = obs.sends;
  const settled = obs.sends.filter((s) => s.settleAccepted); // только квитанции
  const statuses = statusesOf(obs.sends);
  if (settled.length >= 2) {
    return {
      verdict: 'FAIL',
      reasons: [
        `FAIL: оба отправления подтверждены settle-квитанциями (статусы: ${statuses}) — двойное settle по одному платежу`,
      ],
    };
  }
  const firstAccepted = first.settleAccepted || (first.status !== null && first.status >= 200 && first.status < 300);
  const secondRejected =
    second.status === 402 ||
    (second.status !== null && second.status >= 200 && second.status < 300 && !!second.paymentResponseRaw);
  const second2xxNoReceipt =
    second.status !== null && second.status >= 200 && second.status < 300 && !second.paymentResponseRaw;
  if (firstAccepted && secondRejected) {
    return {
      verdict: 'PASS',
      reasons: [
        `первое отправление: принято (платёж валиден); повтор: отклонён; статусы: ${statuses}` +
          (settled.length >= 1 ? '; settle-квитанций: 1' : ''),
      ],
    };
  }
  if (!firstAccepted) {
    return {
      verdict: 'ADVISORY',
      reasons: [
        `ослабленная форма: первое отправление не принято (статусы: ${statuses}) — гонка double-accept не исполнена; нужен фондированный кошелёк (отклонение О1)`,
      ],
    };
  }
  if (second2xxNoReceipt) {
    return {
      verdict: 'ADVISORY',
      reasons: [
        `повтор вернул 2xx БЕЗ settle-квитанции (статусы: ${statuses}) — принятие не подтверждено, но и не опровергнуто: требуется сверка на стороне СУТ`,
      ],
    };
  }
  return {
    verdict: 'ADVISORY',
    reasons: [`наблюдаемая форма не совпадает с планом (статусы: ${statuses}); факты зафиксированы`],
  };
}

/**
 * S-BC-13 wallet-kyt-edge: краш-класс. Публичный фасилитатор не даёт
 * управлять KYT-флагами, поэтому объективно проверяемое: 5xx/краш = FAIL;
 * отказ/принятие с фактом длительности решения — PASS + факты.
 */
function evaluateBcKytEdge(obs: BcAttemptObservation): VerdictEvaluation {
  const crash = obs.sends.some((s) => s.status !== null && s.status >= 500);
  if (crash) {
    return {
      verdict: 'FAIL',
      reasons: ['FAIL: 5xx на платеже от граничного KYT-профиля — краш-класс вместо читаемого отказа'],
    };
  }
  if (transportFailures(obs.sends).length > 0) {
    return unobservedVerdict(obs.sends);
  }
  const statuses = statusesOf(obs.sends);
  const durationMs = obs.sends.length >= 2 ? obs.sends[obs.sends.length - 1].atMs - obs.sends[0].atMs : undefined;
  return {
    verdict: 'PASS',
    reasons: [
      `краша нет; статусы: ${statuses}` +
        (durationMs !== undefined ? `; длительность решения: ${durationMs}ms` : '') +
        '; полный KYT-профиль требует фасилитатора с KYT-эмуляцией (фаза 2)',
    ],
  };
}

/**
 * S-BC-14 frontrun-drain: authorization дрейнована ДО settle СУТ.
 * FAIL = СУТ выдал ресурс/подтвердил settle по дрейнованному платежу;
 * PASS = отказ с читаемой причиной (nonce использован и т.п.).
 */
function evaluateBcFrontrunDrain(obs: BcAttemptObservation): VerdictEvaluation {
  if (!obs.drain) {
    return { verdict: 'HARNESS_ERROR', reasons: ['факт дрейна отсутствует (проба не исполнена)'] };
  }
  if (transportFailures(obs.sends).length > 0) {
    return unobservedVerdict(obs.sends);
  }
  const drainFact = `дрейн: ${obs.drain.settled ? 'settle подтверждён фасилитатором' : 'не подтверждён'}${obs.drain.reason ? ` (${obs.drain.reason})` : ''}`;
  if (obs.resourceIssued || obs.settleAccepted) {
    return {
      verdict: 'FAIL',
      reasons: [
        `FAIL: СУТ ${obs.resourceIssued ? 'выдал ресурс' : 'подтвердил settle'} по дрейнованному платежу`,
        drainFact,
      ],
    };
  }
  return {
    verdict: 'PASS',
    reasons: [
      `дрейнованный платёж отклонён; статусы: ${statusesOf(obs.sends)}`,
      drainFact,
    ],
  };
}

/**
 * S-BC-15 upto-overdraft: списокание сверх upto-потолка. Сценарий применим
 * только к СУТ с upto-схемой: фолт = факт sign_mutated от инжектора. На СУТ
 * без upto инжектор честен — сценарий НЕПРИМЕНИМ и получает отдельный
 * вердикт NOT_APPLICABLE (НЕ PASS: непрогнанный сценарий не увеличивает
 * долю успешных испытаний; приём валидного exact-платежа — корректное
 * поведение СУТ, а не подтверждённый успех проверки overdraft).
 */
function evaluateBcUptoOverdraft(obs: BcAttemptObservation): VerdictEvaluation {
  const mutated = obs.facts.some((f) => f.kind === 'sign_mutated');
  if (!mutated) {
    return {
      verdict: 'NOT_APPLICABLE',
      reasons: ['СУТ не поддерживает upto-схему — сценарий неприменим (перенос на стенд с upto-фасилитатором); не засчитывается в долю PASS'],
    };
  }
  if (obs.resourceIssued || obs.settleAccepted) {
    return {
      verdict: 'FAIL',
      reasons: ['FAIL: сверх-списание сверх upto-потолка принято СУТ'],
    };
  }
  if (transportFailures(obs.sends).length > 0) {
    return unobservedVerdict(obs.sends);
  }
  return {
    verdict: 'PASS',
    reasons: [
      `списание сверх потолка отклонено; статусы: ${statusesOf(obs.sends)}`,
    ],
  };
}

/**
 * Оценка сессии BS (волны 1 и 2). Объективные критерии:
 * - 402-loop / replay-challenge: второй платёж СУТ за один ресурс = FAIL;
 * - late-double-charge: второй платёж после дубликата квитанции = FAIL;
 * - oversize-amount: платёж на завышенную сумму = FAIL (решение В2);
 * - verify-pass-settle-fail: ADVISORY — защита требует политики сверки
 *   txHash у СУТ, что вне зоны наблюдения чёрного ящика (уточнение
 *   против docx-матрицы v1; согласуется с принципом «только факты»);
 * - волна 2:
 *   verify-always-fail: повторный платёж СУТ после verify-отказа = FAIL
 *     (двойная оплата); «краш/зависание» внешнего чёрного ящика напрямую
 *     не наблюдаемо — фиксируется формой завершения сессии (уточнение);
 *   payto-substitution: ADVISORY (защита — whitelist-политика СУТ);
 *   resource-swap-after-pay: ADVISORY (детекция по echo — политика СУТ);
 *   premature-200-before-settle: 200 без квитанции принят = ADVISORY;
 *     повторный платёж = FAIL (двойная оплата — общая политика п.1);
 *   settle-pending-forever: pending без финала = ADVISORY;
 *     повторный платёж = FAIL (двойная оплата — общая политика п.1);
 *   requirements-poison: платёж по невалидным requirements = FAIL
 *     («подписал невалидное»); отбил до подписания = PASS;
 *   corrupt-transport: платёж после битого транспорта = FAIL;
 *     безопасное завершение без платежа = PASS (форма отказа — факты);
 *   premature-200: ресурс без 402 — ADVISORY (состояние учёта СУТ);
 *     факт платежа за бесплатный ресурс — в фактах.
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

    case 'verify-always-fail':
      if (payments.length > 1) {
        return {
          verdict: 'FAIL',
          reasons: [
            ...reasons,
            `FAIL: СУТ заплатил повторно после verify-отказа (verify-отказов доставлено: ${session.verifyRejectionsDelivered ?? 0}) — двойная оплата`,
          ],
        };
      }
      return {
        verdict: 'PASS',
        reasons: [
          ...reasons,
          `СУТ прекратил платежи после verify-отказа (доставлено отказов: ${session.verifyRejectionsDelivered ?? 0}; форма завершения — факты)`,
        ],
      };

    case 'payto-substitution':
      return {
        verdict: 'ADVISORY',
        reasons: [
          ...reasons,
          payments.length > 0
            ? `платёж ушёл на подставной payTo (0x6666…6666); защита (whitelist получателей) — политика СУТ`
            : 'СУТ не платил (требования атакующего отклонены до оплаты); защита — whitelist-политика',
        ],
      };

    case 'resource-swap-after-pay':
      return {
        verdict: 'ADVISORY',
        reasons: [
          ...reasons,
          payments.length > 0
            ? `подменённое тело доставлено (echo mismatch: ${session.resourceEchoMismatch ? 'да' : 'нет'}); детекция по fingerprint — политика СУТ`
            : 'платежей нет — подмена не состоялась',
        ],
      };

    case 'premature-200-before-settle':
      if (payments.length > 1) {
        return {
          verdict: 'FAIL',
          reasons: [...reasons, 'FAIL: СУТ заплатил повторно при отсутствующей settle-квитанции — двойная оплата'],
        };
      }
      if (payments.length === 1) {
        return {
          verdict: 'ADVISORY',
          reasons: [...reasons, '200 с ресурсом доставлен БЕЗ settle-квитанции; бухучёт состояния СУТ — вне зоны наблюдения (ADVISORY)'],
        };
      }
      return {
        verdict: 'PASS',
        reasons: [...reasons, 'СУТ не платил — premature-200 не потреблён'],
      };

    case 'settle-pending-forever':
      if (payments.length > 1) {
        return {
          verdict: 'FAIL',
          reasons: [...reasons, 'FAIL: СУТ заплатил повторно при бесконечном pending — двойная оплата'],
        };
      }
      if (payments.length === 1) {
        return {
          verdict: 'ADVISORY',
          reasons: [...reasons, 'settle-квитанция со статусом pending (финала нет); зависание/таймаут — форма завершения (факты)'],
        };
      }
      return {
        verdict: 'PASS',
        reasons: [...reasons, 'СУТ не платил — pending-цикл не потреблён'],
      };

    case 'requirements-poison':
      if (payments.length > 0) {
        return {
          verdict: 'FAIL',
          reasons: [
            ...reasons,
            'FAIL: СУТ подписал платёж по структурно невалидным requirements (не-hex payTo, нечисловая сумма)',
          ],
        };
      }
      return {
        verdict: 'PASS',
        reasons: [...reasons, 'невалидные requirements отклонены до подписания; платежей нет'],
      };

    case 'corrupt-transport':
      if (payments.length > 0) {
        return {
          verdict: 'FAIL',
          reasons: [...reasons, 'FAIL: СУТ отправил платёж после битого транспорта (подписал мусорные требования)'],
        };
      }
      return {
        verdict: 'PASS',
        reasons: [
          ...reasons,
          `безопасная форма отказа: СУТ не платил; битый транспорт доставлен (${session.corruptTransportServed ? 'да' : 'нет'})`,
        ],
      };

    case 'premature-200':
      return {
        verdict: 'ADVISORY',
        reasons: [
          ...reasons,
          `ресурс отдан без 402 (бесплатно); ${payments.length > 0 ? `СУТ заплатил за бесплатный ресурс (${payments.length} пл.) — состояние учёта СУТ` : 'СУТ забрал ресурс бесплатно, без платежа'}`,
        ],
      };

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

/**
 * Реестр волны 2 (остальной состав полного реестра 28; S-BC-14/S-BC-15 —
 * отцепляемые сценарии фазы 2).
 */
export const BLOCK_B_WAVE2_SCENARIOS: readonly BlockBScenarioSpec[] = [
  {
    id: scenarioId('BC', 3),
    slug: 'not-yet-valid',
    family: 'BC',
    phase: 1,
    wave: 2,
    title: 'Authorization с validAfter в будущем (клок-скью)',
    intent:
      'Аргус подписывает платёж, окно действия которого ещё не открыто ' +
      '(validAfter в будущем) — СУТ обязан отклонить (authorization_valid_after).',
    failCriteria: [
      'СУТ выдал ресурс (2xx) по authorization, которая ещё не действительна',
      'СУТ подтвердил settle по такому платежу',
    ],
    observations: [
      'HTTP-статус ответа; причина (authorization_valid_after из словаря фасилитатора)',
    ],
    anchors: ['CDP invalidReason: authorization_valid_after', 'EIP-3009: validity window'],
    createInjector: () => ({
      scenarioId: 'S-BC-03',
      family: 'BC',
      onRequirements: async () => ({ action: 'passthrough' }),
      onSign: async (binding) => {
        const nowSec = Math.floor(Date.now() / 1000);
        return {
          action: 'mutate' as const,
          value: {
            ...binding,
            validAfter: String(nowSec + 3600),
            validBefore: String(nowSec + 7200),
          },
          note: 'S-BC-03: окно действия сдвинуто в будущее (validAfter = now+1h)',
        };
      },
      onPayload: async () => ({ action: 'passthrough' }),
      onSend: async () => ({ action: 'passthrough' }),
      onSettle: async () => ({ action: 'passthrough' }),
      getFacts: () => [],
    }),
  },

  {
    id: scenarioId('BC', 6),
    slug: 'amount-mismatch',
    family: 'BC',
    phase: 1,
    wave: 2,
    title: 'Подписанное value не совпадает с суммой requirements',
    intent:
      'Аргус подписывает authorization на сумму +1 atomic unit от requirements — ' +
      'СУТ обязан отклонить расхождение (exact: подписанная сумма = требуемой).',
    failCriteria: [
      'СУТ выдал ресурс (2xx) по платежу с расхождением суммы',
      'СУТ подтвердил settle по такому платежу',
    ],
    observations: ['HTTP-статус; причина; сумма в requirements vs подписанная value'],
    anchors: ['CDP: invalid_exact_eip3009_authorization', 'exact-scheme semantics'],
    createInjector: () => ({
      scenarioId: 'S-BC-06',
      family: 'BC',
      onRequirements: async () => ({ action: 'passthrough' }),
      onSign: async (binding) => ({
        action: 'mutate',
        value: { ...binding, value: (BigInt(binding.value) + 1n).toString() },
        note: 'S-BC-06: подписанная value = requirements + 1 atomic unit',
      }),
      onPayload: async () => ({ action: 'passthrough' }),
      onSend: async () => ({ action: 'passthrough' }),
      onSettle: async () => ({ action: 'passthrough' }),
      getFacts: () => [],
    }),
  },

  {
    id: scenarioId('BC', 7),
    slug: 'wrong-chain-id',
    family: 'BC',
    phase: 1,
    wave: 2,
    title: 'Чужой chainId в домене EIP-712',
    intent:
      'Аргус подписывает authorization в домене другой сети (Base mainnet 8453 ' +
      'вместо Base Sepolia 84532) — подпись не валидна в сети СУТ.',
    failCriteria: [
      'СУТ выдал ресурс (2xx) по платежу с чужим chainId',
      'СУТ подтвердил settle по такому платежу',
    ],
    observations: ['HTTP-статус; причина (chain_id mismatch / payload_verification_failed)'],
    anchors: ['CDP: chain_id mismatch', 'EIP-712: domain separation'],
    createInjector: () => ({
      scenarioId: 'S-BC-07',
      family: 'BC',
      onRequirements: async () => ({ action: 'passthrough' }),
      onSign: async (binding) => ({
        action: 'mutate',
        value: { ...binding, network: 'eip155:8453' },
        note: 'S-BC-07: домен подписан для eip155:8453 (Base mainnet)',
      }),
      onPayload: async () => ({ action: 'passthrough' }),
      onSend: async () => ({ action: 'passthrough' }),
      onSettle: async () => ({ action: 'passthrough' }),
      getFacts: () => [],
    }),
  },

  {
    id: scenarioId('BC', 8),
    slug: 'scheme-mismatch',
    family: 'BC',
    phase: 1,
    wave: 2,
    title: 'Scheme в payload не совпадает со scheme requirements',
    intent:
      'Аргус отправляет payload, в котором accepted.scheme отличается от scheme ' +
      'в requirements (upto вместо exact) — СУТ обязан отклонить.',
    failCriteria: [
      'СУТ выдал ресурс (2xx) по платежу с чужим scheme',
      'СУТ подтвердил settle по такому платежу',
    ],
    observations: ['HTTP-статус; причина (scheme mismatch); scheme requirements vs payload'],
    anchors: ['CDP: scheme mismatch', 'x402: exact/upto scheme separation'],
    createInjector: () => ({
      scenarioId: 'S-BC-08',
      family: 'BC',
      onRequirements: async () => ({ action: 'passthrough' }),
      onSign: async () => ({ action: 'passthrough' }),
      onPayload: async (payload) => {
        try {
          const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8')) as {
            accepted?: { scheme?: string };
          };
          if (parsed.accepted) parsed.accepted.scheme = 'upto';
          return {
            action: 'mutate',
            value: Buffer.from(JSON.stringify(parsed), 'utf-8').toString('base64'),
            note: 'S-BC-08: accepted.scheme в payload заменён на upto',
          };
        } catch {
          return { action: 'passthrough' };
        }
      },
      onSend: async () => ({ action: 'passthrough' }),
      onSettle: async () => ({ action: 'passthrough' }),
      getFacts: () => [],
    }),
  },

  {
    id: scenarioId('BC', 10),
    slug: 'resource-mismatch',
    family: 'BC',
    phase: 1,
    wave: 2,
    title: 'Платёж ссылается на другой ресурс',
    intent:
      'Аргус отправляет платёж, в payload которого заявлен другой ресурс, чем ' +
      'запрошен у СУТ — СУТ обязан отклонить (кросс-ресурсный платёж).',
    failCriteria: [
      'СУТ выдал ресурс (2xx) по платежу за другой ресурс',
      'СУТ подтвердил settle по такому платежу',
    ],
    observations: ['HTTP-статус; причина; resource в requirements vs payload'],
    anchors: ['arXiv 2605.30998: I3 (клиентская сторона)'],
    createInjector: () => ({
      scenarioId: 'S-BC-10',
      family: 'BC',
      onRequirements: async () => ({ action: 'passthrough' }),
      onSign: async () => ({ action: 'passthrough' }),
      onPayload: async (payload) => {
        try {
          const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8')) as Record<string, unknown>;
          parsed.resource = {
            url: 'http://other-resource.example/other-item',
            description: 'different resource (S-BC-10 fault)',
          };
          return {
            action: 'mutate',
            value: Buffer.from(JSON.stringify(parsed), 'utf-8').toString('base64'),
            note: 'S-BC-10: в payload заявлен другой ресурс',
          };
        } catch {
          return { action: 'passthrough' };
        }
      },
      onSend: async () => ({ action: 'passthrough' }),
      onSettle: async () => ({ action: 'passthrough' }),
      getFacts: () => [],
    }),
  },

  {
    id: scenarioId('BC', 11),
    slug: 'duplicate-send',
    family: 'BC',
    phase: 1,
    wave: 2,
    title: 'Двойная отправка одного валидного платежа подряд',
    intent:
      'Аргус отправляет ОДИН валидный платёж дважды подряд (тот же nonce, без паузы) — ' +
      'СУТ обязан принять первое и идемпотентно отклонить повтор.',
    failCriteria: [
      'оба отправления приняты (двойное settle по одному платежу)',
    ],
    observations: [
      'ответы на обе отправки (статусы, квитанции); тайминги',
    ],
    anchors: ['гонка double-submit; инвариант I2 (уникальность nonce)'],
    suggestedRepeat: 3,
    createInjector: () => ({
      scenarioId: 'S-BC-11',
      family: 'BC',
      onRequirements: async () => ({ action: 'passthrough' }),
      onSign: async () => ({ action: 'passthrough' }),
      onPayload: async () => ({ action: 'passthrough' }),
      onSend: async () => ({ action: 'duplicate', times: 2, note: 'S-BC-11: двойная отправка подряд' }),
      onSettle: async () => ({ action: 'passthrough' }),
      getFacts: () => [],
    }),
  },

  {
    id: scenarioId('BC', 12),
    slug: 'wrong-asset',
    family: 'BC',
    phase: 1,
    wave: 2,
    title: 'Чужой asset в авторизации',
    intent:
      'Аргус подписывает authorization для другого токена (WETH вместо USDC) — ' +
      'домен EIP-712 не совпадает с контрактом asset из requirements.',
    failCriteria: [
      'СУТ выдал ресурс (2xx) по платежу чужим токеном',
      'СУТ подтвердил settle по такому платежу',
    ],
    observations: ['HTTP-статус; причина (asset mismatch); asset requirements vs payload'],
    anchors: ['CDP: asset mismatch', 'EIP-712: verifyingContract = asset'],
    createInjector: () => ({
      scenarioId: 'S-BC-12',
      family: 'BC',
      onRequirements: async () => ({ action: 'passthrough' }),
      onSign: async (binding) => ({
        action: 'mutate',
        value: { ...binding, asset: '0x4200000000000000000000000000000000000006' },
        note: 'S-BC-12: asset заменён на WETH (0x4200…0006)',
      }),
      onPayload: async () => ({ action: 'passthrough' }),
      onSend: async () => ({ action: 'passthrough' }),
      onSettle: async () => ({ action: 'passthrough' }),
      getFacts: () => [],
    }),
  },

  {
    id: scenarioId('BC', 13),
    slug: 'wallet-kyt-edge',
    family: 'BC',
    phase: 1,
    wave: 2,
    title: 'Кошелёк с граничным KYT-профилем',
    intent:
      'Платёж честно подписан с одноразового кошелька без истории (граничный ' +
      'KYT-профиль) — СУТ/facilitator должен отказать с KYT-причиной или ' +
      'принять после явной оценки; краш/зависание/выдача без оценки = FAIL.',
    failCriteria: [
      '5xx/необработанное исключение на платеже от граничного профиля (краш-класс)',
    ],
    observations: [
      'HTTP-статус; причина (KYT-класс, если есть); длительность решения',
      'ограничение: публичный фасилитатор не управляет KYT-флагами — полный ' +
        'KYT-профиль требует фасилитатора с KYT-эмуляцией (фаза 2)',
    ],
    anchors: ['Coinbase CDP: KYT failures'],
    createInjector: () => new PassthroughPaymentFaultInjector('S-BC-13', 'BC'),
  },

  {
    id: scenarioId('BC', 14),
    slug: 'frontrun-drain',
    family: 'BC',
    phase: 2,
    wave: 2,
    title: 'Дрейн authorization до settle СУТ (отцепляемый)',
    intent:
      'Атакующий submit-ит подписанную authorization напрямую в фасилитатор ДО ' +
      'settle СУТ (settle-race вместо mempool) — nonce уже использован; СУТ обязан ' +
      'отказать с читаемой причиной и НЕ выдать ресурс.',
    failCriteria: [
      'СУТ выдал ресурс (2xx) по дрейнованному платежу',
      'СУТ подтвердил settle по дрейнованному платежу',
    ],
    observations: [
      'факт дрейна (settle фасилитатора на payload атакующего)',
      'ответ СУТ на платёж с уже использованным nonce',
    ],
    anchors: ["USENIX Sec'26: mempool-дрейн", 'EIP-3009: nonce uniqueness', 'инвариант I2'],
    bcPlan: { drainBeforeSend: true },
    createInjector: () => new PassthroughPaymentFaultInjector('S-BC-14', 'BC'),
  },

  {
    id: scenarioId('BC', 15),
    slug: 'upto-overdraft',
    family: 'BC',
    phase: 2,
    wave: 2,
    title: 'Списание сверх upto-потолка (отцепляемый)',
    intent:
      'Для СУТ, рекламирующего upto-схему: Аргус подписывает authorization выше ' +
      'потолка из requirements — СУТ обязан отклонить. На СУТ без upto сценарий ' +
      'НЕПРИМЕНИМ (PASS с явной причиной).',
    failCriteria: [
      'СУТ выдал ресурс / подтвердил settle по платежу сверх upto-потолка',
    ],
    observations: [
      'поддерживает ли СУТ upto (scheme в requirements); суммы потолок vs подпись',
    ],
    anchors: ['arXiv 2605.30998: overdraft в upto-схеме'],
    createInjector: () => {
      const facts: PaymentFact[] = [];
      return {
        scenarioId: 'S-BC-15',
        family: 'BC' as const,
        onRequirements: async () => ({ action: 'passthrough' }),
        onSign: async (binding, ctx) => {
          if (binding.scheme === 'upto') {
            facts.push({
              kind: 'sign_mutated',
              scenarioId: 'S-BC-15',
              attempt: ctx.attempt,
              atMs: ctx.atMs,
              details: { ceiling: binding.value, signed: (BigInt(binding.value) + 1n).toString() },
            });
            return {
              action: 'mutate',
              value: { ...binding, value: (BigInt(binding.value) + 1n).toString() },
              note: 'S-BC-15: подписанная value выше upto-потолка',
            };
          }
          // СУТ без upto: фолт невозможен — инжектор честен (сценарий неприменим).
          return { action: 'passthrough' };
        },
        onPayload: async () => ({ action: 'passthrough' }),
        onSend: async () => ({ action: 'passthrough' }),
        onSettle: async () => ({ action: 'passthrough' }),
        getFacts: () => [...facts],
      };
    },
  },

  {
    id: scenarioId('BS', 4),
    slug: 'verify-always-fail',
    family: 'BS',
    phase: 1,
    wave: 2,
    title: 'Verify всегда отказывает',
    intent:
      'На КАЖДЫЙ платёж СУТ Аргус отвечает 402 с verify-отказом (signature_invalid) — ' +
      'СУТ не должен платить повторно; ретраи — его политика (факты).',
    failCriteria: ['СУТ заплатил повторно после verify-отказа (двойная оплата)'],
    observations: [
      'число verify-отказов и попыток СУТ (факты, без порогов)',
      'форма завершения сессии СУТ (ошибка/выход); краш внешнего ящика напрямую не наблюдаем',
    ],
    anchors: ['CDP: verification failures'],
    createInjector: () => new PassthroughPaymentFaultInjector('S-BS-04', 'BS'),
  },

  {
    id: scenarioId('BS', 5),
    slug: 'payto-substitution',
    family: 'BS',
    phase: 1,
    wave: 2,
    title: 'payTo атакующего в requirements',
    intent:
      'Requirements ведут на адрес атакующего (0x6666…6666) вместо канонического ' +
      'получателя — наблюдаем, платит ли СУТ на подставной адрес.',
    failCriteria: [],
    observations: [
      'ушёл ли платёж на подставной адрес (факт)',
      'защита (whitelist получателей) — политика СУТ: вердикт ADVISORY, не FAIL',
    ],
    anchors: ['arXiv 2605.30998: I3/I5 (подмена получателя)'],
    createInjector: () => new PassthroughPaymentFaultInjector('S-BS-05', 'BS'),
  },

  {
    id: scenarioId('BS', 7),
    slug: 'resource-swap-after-pay',
    family: 'BS',
    phase: 1,
    wave: 2,
    title: 'Подменённое тело ресурса после оплаты',
    intent:
      'После оплаты Аргус отдаёт тело с ЧУЖИМ echo-fingerprint (подмена ресурса) — ' +
      'детекция по сверке echo — политика СУТ (инвариант I3).',
    failCriteria: [],
    observations: [
      'echo отправленного тела (канон) vs доставленного (подменённый)',
      'детекция (реакция СУТ на mismatch) — политика: вердикт ADVISORY',
    ],
    anchors: ['инвариант I3; echo-fingerprint CanonicalResource'],
    createInjector: () => new PassthroughPaymentFaultInjector('S-BS-07', 'BS'),
  },

  {
    id: scenarioId('BS', 8),
    slug: 'premature-200-before-settle',
    family: 'BS',
    phase: 1,
    wave: 2,
    title: '200 с ресурсом до settle',
    intent:
      'На платёж СУТ Аргус отдаёт 200 с ресурсом БЕЗ settle-квитанции (settle ещё ' +
      'не был/не будет подтверждён) — наблюдаем бухучёт состояния СУТ.',
    failCriteria: ['СУТ заплатил повторно при отсутствующей квитанции (двойная оплата)'],
    observations: [
      'потребил ли СУТ ресурс без квитанции; дальнейшие запросы/платежи (факты)',
    ],
    anchors: ['TOCTOU ресурс/расчёт; бухучёт состояния СУТ'],
    createInjector: () => new PassthroughPaymentFaultInjector('S-BS-08', 'BS'),
  },

  {
    id: scenarioId('BS', 9),
    slug: 'settle-pending-forever',
    family: 'BS',
    phase: 1,
    wave: 2,
    title: 'Settle возвращает pending бесконечно',
    intent:
      'На платёж СУТ Аргус отвечает квитанцией status=pending без финала — ' +
      'denial of settlement: наблюдаем, как СУТ завершает операцию.',
    failCriteria: ['СУТ заплатил повторно при бесконечном pending (двойная оплата)'],
    observations: [
      'число pending-квитанций; форма завершения за окно W (факты, без порогов)',
    ],
    anchors: ['denial of settlement; GitHub #1065 (транзиентные settle)'],
    createInjector: () => new PassthroughPaymentFaultInjector('S-BS-09', 'BS'),
  },

  {
    id: scenarioId('BS', 10),
    slug: 'requirements-poison',
    family: 'BS',
    phase: 1,
    wave: 2,
    title: 'Структурно невалидные requirements',
    intent:
      'Аргус отдаёт requirements с не-hex payTo и нечисловой суммой — клиент ' +
      'обязан отбить их ДО подписания; платёж по ним = подписал невалидное.',
    failCriteria: [
      'СУТ подписал платёж по невалидным requirements',
    ],
    observations: [
      'отклонение до/после подписания; текст ошибки; ретраи (факты)',
    ],
    anchors: ['robustness клиента; каноническая форма x402 requirements'],
    createInjector: () => new PassthroughPaymentFaultInjector('S-BS-10', 'BS'),
  },

  {
    id: scenarioId('BS', 12),
    slug: 'corrupt-transport',
    family: 'BS',
    phase: 1,
    wave: 2,
    title: 'Битые заголовки / обрезанные тела',
    intent:
      'Аргус отдаёт 402 с мусорным payment-required header и обрывает тела/сокет — ' +
      'СУТ обязан завершить обмен безопасно (без платежа по мусору, без краша).',
    failCriteria: [
      'СУТ отправил платёж после битого транспорта (подписал мусор)',
    ],
    observations: [
      'форма отказа (безопасная/краш-класс) — по внешним признакам: платежи, ретраи',
    ],
    anchors: ['robustness; x402 V2 header contract'],
    createInjector: () => new PassthroughPaymentFaultInjector('S-BS-12', 'BS'),
  },

  {
    id: scenarioId('BS', 13),
    slug: 'premature-200',
    family: 'BS',
    phase: 1,
    wave: 2,
    title: '200 без всякого 402 (ресурс бесплатно)',
    intent:
      'Аргус отдаёт ресурс бесплатно (200 без 402) — зеркало free shopping: ' +
      'наблюдаем состояние учёта СУТ (платит ли за бесплатный ресурс).',
    failCriteria: [],
    observations: [
      'что СУТ делает с бесплатным ресурсом (факт: платит/забирает)',
      'состояние учёта СУТ — вне зоны наблюдения: вердикт ADVISORY',
    ],
    anchors: ['зеркало free shopping; состояние учёта СУТ'],
    createInjector: () => new PassthroughPaymentFaultInjector('S-BS-13', 'BS'),
  },
];

/** Все сценарии блока B, зарегистрированные в коде (28 = 10 + 18). */
export function listBlockBScenarios(): readonly BlockBScenarioSpec[] {
  return [...BLOCK_B_WAVE1_SCENARIOS, ...BLOCK_B_WAVE2_SCENARIOS];
}

/** Поиск сценария по ID ('S-BC-01'). */
export function getBlockBScenario(id: string): BlockBScenarioSpec | undefined {
  return listBlockBScenarios().find((s) => s.id === id);
}

/** Валидация всего реестра (для list/run и тестов). */
export function validateBlockBRegistry(): void {
  const seen = new Set<string>();
  for (const spec of listBlockBScenarios()) {
    validateScenarioSpec(spec);
    if (seen.has(spec.id)) {
      throw new Error(`Duplicate scenario id in registry: ${spec.id}`);
    }
    seen.add(spec.id);
  }
}
