/**
 * Block B — каноническое минимальное универсальное тело ресурса (решение
 * по В4: «сговнякать тело минимальное и насколько возможно универсальное»).
 *
 * Принципы:
 * - МИНИМАЛЬНОСТЬ: четыре коротких поля; не провоцирует содержательную
 *   валидацию на стороне СУТ, подходит для всех сценариев транша;
 * - ДЕТЕРМИНИЗМ: одинаковым входам соответствует одинаковое тело —
 *   прогоны и повторы сравнимы побайтово;
 * - ECHO-FINGERPRINT: sha256 отпечатка запроса. База для проверки
 *   целостности в сценариях подмены ресурса (инвариант I3): если СУТ
 *   возвращает echo, отличное от отправленного, подмена детектируема.
 *
 * Сценарии, которым нужен специальный контент, мутируют только echo-поле
 * (или добавляют поля поверх базы) через хуки инжектора — база не меняется.
 */

import { createHash } from 'node:crypto';

export interface CanonicalResourceBody {
  readonly v: 1;
  readonly service: 'argus-block-b';
  /** ID сценария, выпустившего тело ('S-BC-01', ...). */
  readonly scenario: string;
  /** Номер попытки (--repeat), чтобы повторы различались только attempt. */
  readonly attempt: number;
  /** sha256-отпечаток запроса (hex, 64 символа). */
  readonly echo: string;
}

export interface RequestFingerprint {
  readonly url: string;
  readonly method: string;
  readonly body?: unknown;
}

/** Детерминированный отпечаток запроса: sha256 от канонической тройки. */
export function fingerprintRequest(fp: RequestFingerprint): string {
  const canonical = JSON.stringify([fp.method, fp.url, fp.body ?? null]);
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

/** Каноническое тело ресурса для сценария/попытки/запроса. */
export function canonicalResourceBody(
  scenario: string,
  attempt: number,
  fp: RequestFingerprint
): CanonicalResourceBody {
  return {
    v: 1,
    service: 'argus-block-b',
    scenario,
    attempt,
    echo: fingerprintRequest(fp),
  };
}
