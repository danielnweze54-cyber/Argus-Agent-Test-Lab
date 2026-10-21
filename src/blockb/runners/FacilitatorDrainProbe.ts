/**
 * Проба дрейна для S-BC-14 (frontrun-drain): атакующий submit-ит подписанную
 * authorization напрямую в settle-эндпоинт фасилитатора СУТ ДО settle СУТ.
 *
 * Контракт тела запроса (x402 v2 facilitator settle API):
 *   { x402Version, paymentPayload, paymentRequirements }
 * где paymentPayload — РАСКОДИРОВАННЫЙ объект PaymentPayload (не Base64-строка),
 * а paymentRequirements — ОДИН объект PaymentRequirements (элемент accepts[]
 * из 402), а не весь конверт payment-required: фасилитатор читает scheme/network
 * именно из верхнего уровня requirements (иначе — «No facilitator registered
 * for scheme: undefined and network: undefined»).
 */

import type { X402PaymentRequiredBody } from '../../core/AgentTargetPort';
import type { DrainProbeResult } from './BlockBRunnerTypes';

/** Payload (Base64 JSON) + requirements из 402 → факт дрейна. */
export type FacilitatorDrainProbe = (
  payload: string,
  reqs: X402PaymentRequiredBody
) => Promise<DrainProbeResult>;

/** Фабрика пробы дрейна для заданного settle-URL фасилитатора СУТ. */
export function makeFacilitatorDrainProbe(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20000
): FacilitatorDrainProbe {
  return async (payload, reqs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let paymentPayload: unknown = payload;
      try {
        paymentPayload = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
      } catch {
        // не Base64-JSON — отправляем как есть
      }
      // ОДИН requirements-объект (accepts[0]): scheme/network/asset/amount/payTo
      // должны лежать на верхнем уровне — по ним фасилитатор выбирает реализацию.
      const paymentRequirements = reqs.accepts[0];
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x402Version: reqs.x402Version ?? 2, paymentPayload, paymentRequirements }),
        signal: controller.signal,
      });
      const text = await res.text();
      let settled = false;
      let reason: string | undefined;
      try {
        const parsed = JSON.parse(text) as {
          success?: boolean;
          error?: string;
          errorReason?: string;
          invalidReason?: string;
          transaction?: string;
        };
        settled = res.status === 200 && (parsed.success === true || !!parsed.transaction);
        // x402.org фасилитатор отвечает полем errorReason; другие — error/invalidReason.
        reason = parsed.errorReason ?? parsed.error ?? parsed.invalidReason;
      } catch {
        reason = text.slice(0, 200);
      }
      return { settled, status: res.status, reason, raw: text.slice(0, 400) };
    } finally {
      clearTimeout(timer);
    }
  };
}
