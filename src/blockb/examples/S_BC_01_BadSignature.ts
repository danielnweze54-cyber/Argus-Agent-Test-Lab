/**
 * ПРИМЕР сборки сценария блока B на контракте PaymentFaultInjector.
 *
 * Цель файла — зафиксировать эталонный паттерн «сценарий = конфиг хуков»:
 * финальные реализации v1-транша пишутся по этому шаблону в ветке
 * block-b/v1-scenarios. Файл используется контрактными тестами.
 *
 * S-BC-01 bad-signature: Аргус честно получает requirements и подписывает
 * authorization, но ПОСЛЕ подписи повреждает сигнатуру в payload. Ожидание:
 * СУТ отклоняет платёж (словарь фасилитатора: payload_verification_failed),
 * ресурс не выдаёт, settle по такому платежу не инициирует.
 */

import {
  PassthroughPaymentFaultInjector,
  type PaymentFaultInjector,
} from '../PaymentFaultInjector';
import { scenarioId } from '../BlockBRoles';
import type { BlockBScenarioSpec } from '../BlockBScenario';

/**
 * Повреждение сигнатуры внутри Base64-JSON PaymentPayload.
 * Если распарсить не удалось — обрезаем хвост, чтобы payload заведомо
 * не прошёл верификацию.
 */
export function corruptPaymentPayload(payload: string): string {
  try {
    const decoded = Buffer.from(payload, 'base64').toString('utf-8');
    const json = JSON.parse(decoded) as {
      signature?: string;
      accepted?: { signature?: string };
    };
    const sig = json.accepted?.signature ?? json.signature;
    if (typeof sig === 'string' && sig.length > 16) {
      const broken = 'ffff' + sig.slice(4);
      if (json.accepted) {
        json.accepted.signature = broken;
      } else {
        json.signature = broken;
      }
      return Buffer.from(JSON.stringify(json), 'utf-8').toString('base64');
    }
  } catch {
    // не JSON — ломаем как есть ниже
  }
  const cut = Math.max(0, payload.length - 8);
  return payload.slice(0, cut) + 'ZmFpbA==';
}

export const S_BC_01_BadSignature: BlockBScenarioSpec = {
  id: scenarioId('BC', 1),
  slug: 'bad-signature',
  family: 'BC',
  phase: 1,
  wave: 1,
  title: 'Платёж с повреждённой EIP-712 подписью',
  intent:
    'Аргус подписывает authorization честным ключом, затем повреждает поле ' +
    'signature в payload — СУТ должен отклонить платёж до выдачи ресурса.',
  failCriteria: [
    'СУТ выдал ресурс (2xx) в ответ на платёж с повреждённой подписью',
    'СУТ инициировал verify/settle по платежу с повреждённой подписью',
  ],
  observations: [
    'HTTP-статус ответа на подписанный ретрай (402/4xx/5xx)',
    'причина отказа из словаря фасилитатора (payload_verification_failed / invalid signature)',
    'факт повторного 402: количество ретраев и тайминги фиксируются, порогов не имеет (решение по В1)',
  ],
  anchors: [
    'CDP invalidReason: payload_verification_failed',
    'arXiv 2605.30998: инвариант I2 (валидность авторизации)',
  ],
  suggestedRepeat: 1,
  createInjector: (): PaymentFaultInjector => {
    const base = new PassthroughPaymentFaultInjector('S-BC-01', 'BC');
    return {
      scenarioId: 'S-BC-01',
      family: 'BC',
      onRequirements: (reqs, ctx) => base.onRequirements(reqs, ctx),
      onSign: (binding, ctx) => base.onSign(binding, ctx),
      onPayload: async (payload, ctx) => {
        await base.onPayload(payload, ctx);
        return {
          action: 'mutate',
          value: corruptPaymentPayload(payload),
          note: 'S-BC-01: сигнатура повреждена после честной подписи',
        };
      },
      onSend: (req, ctx) => base.onSend(req, ctx),
      onSettle: (result, ctx) => base.onSettle(result, ctx),
      getFacts: () => base.getFacts(),
    };
  },
};
