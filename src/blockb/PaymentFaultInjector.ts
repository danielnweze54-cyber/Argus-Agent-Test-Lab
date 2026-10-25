/**
 * PaymentFaultInjector — контракт точек внедрения платёжных фолтов блока B.
 *
 * Пять хуков покрывают весь жизненный цикл x402-обмена; сценарий блока B
 * = конфигурация хуков (один сценарий = одно намеренное отказ-поведение).
 *
 *   BC (Аргус = плохой клиент, СУТ = ресурсный сервер):
 *     onRequirements — перехват полученных 402-requirements перед тем,
 *                      как Аргус начнёт из них подписывать;
 *     onSign         — точка фолта на authorization перед подписью
 *                      (nonce/validAfter/validBefore/value/from/to);
 *     onPayload      — исходящий payment-signature (Base64 JSON) перед
 *                      отправкой;
 *     onSend         — исходящий HTTP-запрос к СУТ (drop/delay/duplicate);
 *     onSettle       — входящий результат verify/settle от СУТ.
 *
 *   BS (Аргус = плохой сервер, СУТ = клиент):
 *     onRequirements — исходящие requirements, которые получит СУТ;
 *     onSign         — НЕ вызывается (Аргус-сервер не подписывает);
 *     onPayload      — входящий payment-signature от СУТ перед verify;
 *     onSend         — исходящий ответ Аргуса СУТ (402/verify/settle/200);
 *     onSettle       — исходящий вердикт settle, который получит СУТ.
 *
 * ВАЖНО (политика вердиктов блока B): хуки возвращают ДИРЕКТИВЫ, а
 * интерпретирует их раннер. Факты наблюдения (PaymentFact) — сырые данные
 * (статусы, тайминги, количество ретраев СУТ). Количество ретраев и форма
 * backoff — политика СУТ и его владельца; стенд их ФИКСИРУЕТ, но не
 * оценивает порогами. Вердикт выставляется только по объективным
 * FAIL-критериям сценария (см. BlockBScenarioSpec).
 */

import type { SigningBinding } from '../adapters/payment/SigningBinding';
import type { X402PaymentRequiredBody } from '../core/AgentTargetPort';
import type { Family } from './BlockBRoles';

/** Контекст вызова хука. */
export interface HookCtx {
  readonly scenarioId: string;
  readonly family: Family;
  /** Номер попытки внутри прогона (1-based; --repeat N даёт attempt=1..N). */
  readonly attempt: number;
  /** Часы стенда, мс. */
  readonly atMs: number;
}

/**
 * Директива хука. Интерпретируется раннером через resolveDirective().
 * T — тип значения на границе хука (requirements, binding, payload, ...).
 */
export type FaultDirective<T> =
  | { readonly action: 'passthrough' }
  /** Заменить значение целиком (значение после мутации). */
  | { readonly action: 'mutate'; readonly value: T; readonly note?: string }
  /** Не отправлять / не использовать значение (разрыв обмена). */
  | { readonly action: 'drop'; readonly note?: string }
  /** Задержка, затем вложенная директива (цепочки глубже 8 запрещены). */
  | {
      readonly action: 'delay';
      readonly delayMs: number;
      readonly inner: FaultDirective<T>;
      readonly note?: string;
    }
  /** Отправить значение несколько раз (для onSend/onSettle; times >= 2). */
  | { readonly action: 'duplicate'; readonly times: number; readonly note?: string };

export const passthrough = <T>(): FaultDirective<T> => ({ action: 'passthrough' });

/** Исходящий HTTP-запрос на границе onSend. */
export interface OutgoingPaymentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
}

/** Фаза платёжного подтверждения на границе onSettle. */
export type SettlementPhase = 'verify' | 'settle';

/**
 * Наблюдение/вердикт вокруг verify/settle.
 * Для BC — то, что вернул СУТ; для BS — то, что Аргус отправит СУТ.
 */
export interface SettlementObservation {
  readonly phase: SettlementPhase;
  readonly accepted: boolean;
  /** Причина из словаря фасилитатора (invalidReason/errorReason), если есть. */
  readonly reason?: string;
  readonly txHash?: string;
  readonly network?: string;
  /** Сырое представление (payment-response header / JSON), если есть. */
  readonly raw?: string;
}

/**
 * Виды фактов наблюдения. Факты — сырые данные отчёта; на вердикт влияет
 * только соответствие объективным FAIL-критериям сценария.
 * 'retry_observed' — факт ретрая СУТ: количество и тайминги фиксируются,
 * порогов НЕ имеет (решение по В1: политика ретраев вне зоны наблюдения).
 */
export type PaymentFactKind =
  | 'requirements_observed'
  | 'requirements_mutated'
  | 'requirements_dropped'
  | 'sign_performed'
  | 'sign_mutated'
  | 'sign_skipped'
  | 'payload_sent'
  | 'payload_mutated'
  | 'payload_dropped'
  | 'payload_duplicated'
  | 'payload_delayed'
  | 'request_sent'
  | 'request_dropped'
  | 'request_duplicated'
  | 'request_delayed'
  | 'verify_result_observed'
  | 'settle_result_observed'
  | 'settle_duplicated'
  | 'retry_observed'
  | 'resource_received';

export interface PaymentFact {
  readonly kind: PaymentFactKind;
  readonly scenarioId: string;
  readonly attempt: number;
  readonly atMs: number;
  readonly details: Record<string, unknown>;
}

/** Контракт инжектора фолтов одного сценария блока B. */
export interface PaymentFaultInjector {
  readonly scenarioId: string;
  readonly family: Family;

  onRequirements(
    reqs: X402PaymentRequiredBody,
    ctx: HookCtx
  ): Promise<FaultDirective<X402PaymentRequiredBody>>;

  /** Вызывается только в семействе BC. */
  onSign(binding: SigningBinding, ctx: HookCtx): Promise<FaultDirective<SigningBinding>>;

  /** BC: исходящий payment-signature; BS: входящий от СУТ. */
  onPayload(payload: string, ctx: HookCtx): Promise<FaultDirective<string>>;

  /** BC: запрос к СУТ; BS: ответ Аргуса СУТ. */
  onSend(req: OutgoingPaymentRequest, ctx: HookCtx): Promise<FaultDirective<OutgoingPaymentRequest>>;

  onSettle(
    result: SettlementObservation,
    ctx: HookCtx
  ): Promise<FaultDirective<SettlementObservation>>;

  /** Факты, накопленные инжектором за прогон (только чтение). */
  getFacts(): readonly PaymentFact[];
}

/** Результат интерпретации директивы раннером. */
export interface DirectiveResolution<T> {
  /** null = drop (не отправлять). */
  readonly value: T | null;
  /** Сколько раз отправить (>= 2 для duplicate). */
  readonly times: number;
  /** Суммарная задержка перед отправкой, мс. */
  readonly delayMs: number;
  readonly notes: readonly string[];
}

/**
 * Разворачивание директивы в действие раннера. Цепочки delay сглаживаются
 * в суммарную задержку; вложенность глубже 8 — ошибка конфигурации.
 */
export function resolveDirective<T>(
  value: T,
  directive: FaultDirective<T>
): DirectiveResolution<T> {
  let current = directive;
  let delayMs = 0;
  let times = 1;
  const notes: string[] = [];
  let guard = 0;

  while (true) {
    if (++guard > 8) {
      throw new Error('Directive nesting too deep: delay chains longer than 8 are forbidden');
    }
    switch (current.action) {
      case 'passthrough':
        return { value, times, delayMs, notes };
      case 'mutate':
        if (current.note) notes.push(current.note);
        return { value: current.value, times, delayMs, notes };
      case 'drop':
        if (current.note) notes.push(current.note);
        return { value: null, times: 0, delayMs, notes };
      case 'duplicate':
        if (current.note) notes.push(current.note);
        return { value, times: Math.max(2, current.times), delayMs, notes };
      case 'delay':
        delayMs += current.delayMs;
        if (current.note) notes.push(current.note);
        current = current.inner;
        continue;
    }
  }
}

/**
 * Базовый passthrough-инжектор: честное поведение, факты фиксирует,
 * ничего не мутирует. Используется гейтами (канонический happy-path)
 * и как база для сценариев-обёрток.
 */
export class PassthroughPaymentFaultInjector implements PaymentFaultInjector {
  private readonly facts: PaymentFact[] = [];

  constructor(
    readonly scenarioId: string,
    readonly family: Family
  ) {}

  async onRequirements(
    reqs: X402PaymentRequiredBody,
    ctx: HookCtx
  ): Promise<FaultDirective<X402PaymentRequiredBody>> {
    this.push('requirements_observed', ctx, {
      accepts: Array.isArray(reqs.accepts) ? reqs.accepts.length : 0,
      version: reqs.x402Version,
    });
    return passthrough();
  }

  async onSign(
    binding: SigningBinding,
    ctx: HookCtx
  ): Promise<FaultDirective<SigningBinding>> {
    this.push('sign_performed', ctx, { nonce: binding.nonce, value: binding.value });
    return passthrough();
  }

  async onPayload(payload: string, ctx: HookCtx): Promise<FaultDirective<string>> {
    this.push('payload_sent', ctx, { bytes: payload.length });
    return passthrough();
  }

  async onSend(
    req: OutgoingPaymentRequest,
    ctx: HookCtx
  ): Promise<FaultDirective<OutgoingPaymentRequest>> {
    this.push('request_sent', ctx, { url: req.url, method: req.method });
    return passthrough();
  }

  async onSettle(
    result: SettlementObservation,
    ctx: HookCtx
  ): Promise<FaultDirective<SettlementObservation>> {
    this.push(
      result.phase === 'settle' ? 'settle_result_observed' : 'verify_result_observed',
      ctx,
      { accepted: result.accepted, reason: result.reason ?? null, txHash: result.txHash ?? null }
    );
    return passthrough();
  }

  getFacts(): readonly PaymentFact[] {
    return [...this.facts];
  }

  protected push(
    kind: PaymentFactKind,
    ctx: HookCtx,
    details: Record<string, unknown>
  ): void {
    this.facts.push({
      kind,
      scenarioId: this.scenarioId,
      attempt: ctx.attempt,
      atMs: ctx.atMs,
      details,
    });
  }
}
