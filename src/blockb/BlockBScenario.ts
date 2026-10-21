/**
 * Block B — спецификация сценария, конфиг прогона, гейт и вердикты.
 *
 * ВЕРДИКТАРХИВ (решено, спорные категории убраны):
 *
 *   PASS          — вред по объективным критериям НЕ зафиксирован
 *                   в пределах окна наблюдения W (W указывается в отчёте).
 *   FAIL          — зафиксировано нарушение спецификации x402/EIP-3009
 *                   или объективный вред: двойное списание, принятая
 *                   переплата, выдача ресурса по невалидному платежу,
 *                   краш/необработанное исключение, зависание обмена.
 *   ADVISORY      — зафиксированный риск, защита от которого требует
 *                   внешней политики СУТ (whitelist продавцов, сверка
 *                   содержимого ресурса и т.п.). Не FAIL: чёрный ящик
 *                   не обязан угадывать политику, которой у него не видно.
 *   HARNESS_ERROR — собственный сбой стенда. Не вердикт СУТ; прогон
 *                   повторяется, в отчёт попадает с пометкой стенда.
 *
 * Решено по итогам ревью матрицы (В1/В2):
 * - количество ретраев и форма backoff СУТ — его политика; стенд пишет
 *   факты (retry_observed), порогов в вердиктах НЕТ;
 * - приём переплаты в пользу продавца — FAIL всегда: спецификация exact
 *   требует отклонения, политика «продавцу выгодно» не принимается.
 */

import type { Family } from './BlockBRoles';
import { parseScenarioId, rolesForFamily, validateScenarioId } from './BlockBRoles';
import type { PaymentFaultInjector } from './PaymentFaultInjector';

export type BlockBVerdict = 'PASS' | 'FAIL' | 'ADVISORY' | 'HARNESS_ERROR';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Спецификация сценария блока B.
 * Один сценарий = ОДНО намеренное отказ-поведение Аргуса.
 */
export interface BlockBScenarioSpec {
  /** Формат 'S-BC-NN' / 'S-BS-NN'. */
  readonly id: string;
  /** kebab-case слаг, напр. 'bad-signature'. */
  readonly slug: string;
  readonly family: Family;
  /** Фаза 1 — ядро (работает на голом x402); фаза 2 — отцепляемые. */
  readonly phase: 1 | 2;
  /** Волна внедрения: 1 = v1-транш (10 сценариев), 2 = остальные 18. */
  readonly wave: 1 | 2;
  readonly title: string;
  /** Формулировка единственного намеренного отказа. */
  readonly intent: string;
  /**
   * Объективные FAIL-критерии. Для сценариев-фактов (ADVISORY-only)
   * допускается пустой список, но тогда observations обязано объяснять,
   * почему вердикт не выставляется.
   */
  readonly failCriteria: readonly string[];
  /** Что фиксируем (факты; порогов не содержит — решение по В1). */
  readonly observations: readonly string[];
  /** Якоря: словарь invalidReason/errorReason фасилитатора, инварианты I1–I5, источники. */
  readonly anchors?: readonly string[];
  /** Рекомендуемое число повторов (дефолт 1; > 1 — для гонок/replay). */
  readonly suggestedRepeat?: number;
  /** Фабрика инжектора фолтов этого сценария. */
  readonly createInjector: () => PaymentFaultInjector;
}

/** Валидация спецификации; бросает Error с конкретной причиной. */
export function validateScenarioSpec(spec: BlockBScenarioSpec): void {
  validateScenarioId(spec.id);
  const parts = parseScenarioId(spec.id);
  if (!parts || parts.family !== spec.family) {
    throw new Error(
      `Scenario ${spec.id}: family '${spec.family}' does not match id prefix`
    );
  }
  if (!SLUG_RE.test(spec.slug)) {
    throw new Error(`Scenario ${spec.id}: slug '${spec.slug}' must be kebab-case`);
  }
  if (spec.failCriteria.length === 0 && spec.observations.length === 0) {
    throw new Error(
      `Scenario ${spec.id}: needs objective failCriteria or (for advisory-only) non-empty observations`
    );
  }
  if (spec.suggestedRepeat !== undefined && (!Number.isInteger(spec.suggestedRepeat) || spec.suggestedRepeat < 1)) {
    throw new Error(`Scenario ${spec.id}: suggestedRepeat must be a positive integer`);
  }
}

/**
 * Конфиг прогона блока B. Дискриминированное объединение кодирует
 * инвариант: одно семейство = одна роль СУТ = один прогон.
 * Роль СУТ объявляет оператор; validateRunConfig сверяет её с семейством.
 */
export type BlockBRunConfig =
  | {
      readonly family: 'BC';
      readonly sutRole: 'server';
      /** URL ресурсного сервера СУТ, которому будет платить плохой клиент. */
      readonly resourceUrl: string;
      /** Метка стенда для отчёта. */
      readonly label: string;
    }
  | {
      readonly family: 'BS';
      readonly sutRole: 'client';
      /** URL плохого сервера Аргуса, куда придёт платить СУТ-клиент. */
      readonly argusServerUrl: string;
      /** Метка стенда для отчёта. */
      readonly label: string;
    };

/** Сверка объявленной роли СУТ с ролью, вытекающей из семейства. */
export function validateRunConfig(config: BlockBRunConfig): void {
  const expected = rolesForFamily(config.family).sut;
  if (config.sutRole !== expected) {
    throw new Error(
      `Run config mismatch: family '${config.family}' requires SUT role '${expected}', ` +
      `declared '${config.sutRole}'. Семейства не смешиваются: СУТ исполняет одну роль на прогон.`
    );
  }
  const url = config.family === 'BC' ? config.resourceUrl : config.argusServerUrl;
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new Error(
      `Run config mismatch: family '${config.family}' requires ` +
      `${config.family === 'BC' ? 'resourceUrl' : 'argusServerUrl'}`
    );
  }
}

/** Результат гейта семейства. */
export interface BlockBGateResult {
  readonly family: Family;
  readonly passed: boolean;
  /** Факты happy-path (статусы/заголовки/тайминги) для отчёта. */
  readonly details?: string;
}

/**
 * Гейт семейства — «канонические ворота» блока B: канонический happy-path
 * в роли семейства. Провал гейта => семейство НЕ стартует (СУТ не готов
 * принимать/делать платежи даже честно — тестировать фолты бессмысленно).
 */
export type BlockBGate = (family: Family) => Promise<BlockBGateResult>;

/**
 * Порядок запуска семейств после прохождения гейтов: сначала BC
 * (Аргус платит — СУТ принимает платежи), затем BS (СУТ платит —
 * Аргус принимает). Каждое семейство — ОТДЕЛЬНЫЙ прогон со своим гейтом;
 * порядок актуален только для пакетного режима «оба семейства».
 */
export const BLOCK_B_FAMILY_ORDER: readonly Family[] = ['BC', 'BS'];
