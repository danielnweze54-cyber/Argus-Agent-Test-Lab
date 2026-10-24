/**
 * Block B — семейства сценариев, роли участников и формат ID.
 *
 * Блок B проверяет платёжное поведение СУТ (чёрного ящика) в двух
 * ролевых конфигурациях x402:
 *
 *   Семейство S-BC — «Аргус = плохой КЛИЕНТ»:
 *     - СУТ   = ресурсный сервер (принимает платежи);
 *     - Аргус платит умышленно некорректно;
 *     - Наблюдаем, как СУТ отклоняет/принимает платежи и выдаёт ресурс.
 *
 *   Семейство S-BS — «Аргус = плохой СЕРВЕР»:
 *     - СУТ   = клиент (платит Аргусу за ресурс);
 *     - Аргус отвечает умышленно некорректными requirements/verify/settle;
 *     - Наблюдаем, как СУТ защищает свои деньги и своё состояние.
 *
 * ИНВАРИАНТ РОЛИ: в ОДНОМ прогоне СУТ исполняет РОВНО ОДНУ роль
 * (либо клиент, либо сервер). Семейства никогда не смешиваются в одном
 * прогоне: каждое семейство = отдельный прогон со своим гейтом.
 *
 * КТО ОПРЕДЕЛЯЕТ РОЛЬ СУТ: оператор (владелец стенда) в конфиге точки
 * подключения — только он знает, чем СУТ является по протоколу. Раннер
 * выводит требуемую роль из семейства (rolesForFamily) и обязан
 * валидировать соответствие конфига, отказывая в запуске при несоответствии.
 *
 * ФОРМАТ ID: 'S-BC-NN' / 'S-BS-NN' (NN = 01..99).
 * Историческая маркировка 'S-B-BC-NN' / 'S-B-BS-NN' устарела: буква
 * блока (B) из ID исключена, нумерация сценариев сохранена 1:1.
 */

export type Family = 'BC' | 'BS';

/** Роль участника в x402-обмене. */
export type SutRole = 'server' | 'client';

export interface RoleAssignment {
  readonly family: Family;
  /** Роль СУТ в прогонах этого семейства. */
  readonly sut: SutRole;
  /** Роль Аргуса — всегда зеркальна роли СУТ. */
  readonly argus: SutRole;
}

/**
 * Ролевая раскладка семейства.
 * BC: СУТ — ресурсный сервер (его «гоняют» платежами плохого клиента).
 * BS: СУТ — клиент (он платит плохому серверу Аргуса).
 */
export function rolesForFamily(family: Family): RoleAssignment {
  return family === 'BC'
    ? { family, sut: 'server', argus: 'client' }
    : { family, sut: 'client', argus: 'server' };
}

const SCENARIO_ID_RE = /^S-(BC|BS)-(\d{2})$/;

export interface ScenarioIdParts {
  readonly family: Family;
  readonly number: number;
}

/** Разбор ID сценария блока B. Возвращает null для чужих/устаревших форматов. */
export function parseScenarioId(id: string): ScenarioIdParts | null {
  const m = SCENARIO_ID_RE.exec(id);
  if (!m) return null;
  const number = Number(m[2]);
  if (number < 1) return null;
  return { family: m[1] as Family, number };
}

/** Построение ID сценария: S-BC-01, S-BS-13, ... */
export function scenarioId(family: Family, number: number): string {
  if (!Number.isInteger(number) || number < 1 || number > 99) {
    throw new Error(`Scenario number out of range 1..99: ${number}`);
  }
  return `S-${family}-${String(number).padStart(2, '0')}`;
}

/** Строгая валидация ID; бросает ошибку с объяснением формата. */
export function validateScenarioId(id: string): void {
  if (!parseScenarioId(id)) {
    throw new Error(
      `Invalid Block B scenario id '${id}': expected 'S-BC-NN' or 'S-BS-NN' ` +
      `(устаревший формат 'S-B-BC-NN' не принимается — используйте новый)`
    );
  }
}
