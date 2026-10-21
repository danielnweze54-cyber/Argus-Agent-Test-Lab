/**
 * BcRunner — исполнение сценариев семейства BC (Аргус = плохой клиент,
 * СУТ = ресурсный сервер).
 *
 * Поток попытки (x402 V2, черные ящики на HTTP-границе):
 *   1. запрос ресурса → ожидаем 402 + payment-required;
 *   2. hook onRequirements → мутация requirements (если задана);
 *   3. сборка SigningBinding (intent через инжектируемый источник,
 *      дефолт — случайный nonce, MAJ-4) → hook onSign;
 *   4. signer(binding) → hook onPayload → мутация payload;
 *   5. hook onSend → отправка (drop/delay/duplicate);
 *   6. наблюдение ответа (статус, payment-response) → hook onSettle;
 *   7. план сценария: replayAfterSend → повтор той же отправки (S-BC-04).
 *
 * Раннер НЕ выносит вердиктов — только собирает наблюдения и факты;
 * вердикты считает evaluateBcAttempt (BlockBRegistry).
 */

import type { BlockBRunConfig, BlockBScenarioSpec } from '../../blockb';
import type { X402Accept, X402PaymentRequiredBody } from '../../core/AgentTargetPort';
import {
  resolveDirective,
  type HookCtx,
  type OutgoingPaymentRequest,
  type PaymentFaultInjector,
  type SettlementObservation,
} from '../PaymentFaultInjector';
import { defaultSigningIntentSource, type SigningBinding, type SigningIntentSource } from '../../adapters/payment/SigningBinding';
import type { BcAttemptObservation, BcSendRecord, DrainProbeResult } from './BlockBRunnerTypes';

/** Подписант плохого клиента: binding → Base64 JSON PaymentPayload. */
export type PaymentSigner = (binding: SigningBinding) => Promise<string>;

export interface BcRunnerOptions {
  readonly runConfig: BlockBRunConfig & { family: 'BC' };
  readonly scenario: BlockBScenarioSpec;
  /** Подписант плохого клиента (адрес/ключ — у вызывающего). */
  readonly signer: PaymentSigner;
  /** Дефолт — defaultSigningIntentSource (случайный nonce, MAJ-4). */
  readonly intentSource?: SigningIntentSource;
  /** Таймаут одной HTTP-отправки, мс (дефолт 15000). */
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /**
   * S-BC-14 (frontrun-drain): проба дрейна — атакующий submit-ит подписанную
   * authorization напрямую в фасилитатор ДО settle СУТ. Конфигурируется
   * оператором (URL settle фасилитатора); без неё сценарий даёт
   * HARNESS_ERROR с читаемой причиной.
   */
  readonly drainProbe?: DrainProbe;
}

/** Проба дрейна: payload (Base64 JSON) + requirements из 402 → факт дрейна. */
export type DrainProbe = (payload: string, reqs: X402PaymentRequiredBody) => Promise<DrainProbeResult>;

interface ResourceResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function timedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Разбор payment-required (header base64 JSON, fallback — тело ответа). */
export function parseRequirements(res: ResourceResponse): X402PaymentRequiredBody | null {
  const tryParse = (raw: string): X402PaymentRequiredBody | null => {
    try {
      const body = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8')) as Partial<X402PaymentRequiredBody>;
      if (
        body.x402Version === 2 &&
        typeof body.resource?.url === 'string' &&
        Array.isArray(body.accepts) &&
        body.accepts.length > 0
      ) {
        return body as X402PaymentRequiredBody;
      }
    } catch {
      // не base64/JSON
    }
    return null;
  };

  const header = res.headers['payment-required'];
  if (header) {
    const parsed = tryParse(header);
    if (parsed) return parsed;
  }
  return res.bodyText ? tryParse(res.bodyText) : null;
}

/** Извлечение settlement-фактов из payment-response (base64 JSON). */
export function parsePaymentResponse(raw: string | undefined): { accepted: boolean; reason?: string } {
  if (!raw) return { accepted: false };
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8')) as {
      success?: boolean;
      accepted?: boolean;
      error?: string;
      invalidReason?: string;
      transaction?: string;
    };
    const accepted = (parsed.success === true || parsed.accepted === true) && parsed.error === undefined;
    return { accepted, reason: parsed.error ?? parsed.invalidReason };
  } catch {
    return { accepted: false };
  }
}

export class BcRunner {
  private readonly fetchImpl: typeof fetch;
  private readonly intentSource: SigningIntentSource;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: BcRunnerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.intentSource = options.intentSource ?? defaultSigningIntentSource;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15000;
  }

  private get resourceUrl(): string {
    return this.options.runConfig.resourceUrl;
  }

  /** Одна попытка сценария. */
  async runAttempt(injector: PaymentFaultInjector, attempt: number): Promise<BcAttemptObservation> {
    const sends: BcSendRecord[] = [];
    let resourceIssued = false;
    let settleAccepted = false;
    let drain: DrainProbeResult | undefined;

    const ctx = (family: 'BC'): HookCtx => ({
      scenarioId: injector.scenarioId,
      family,
      attempt,
      atMs: Date.now(),
    });

    try {
      // Шаг 1: запрос ресурса.
      const firstRes = await this.toResourceResponse(
        await timedFetch(this.fetchImpl, this.resourceUrl, { method: 'GET' }, this.requestTimeoutMs)
      );
      if (firstRes.status >= 200 && firstRes.status < 300) {
        resourceIssued = true;
        return {
          attempt,
          sends: [{ seq: 1, status: firstRes.status, settleAccepted: false, atMs: Date.now() }],
          resourceIssued,
          settleAccepted,
          facts: injector.getFacts(),
        };
      }
      if (firstRes.status !== 402) {
        return {
          attempt,
          sends: [{ seq: 1, status: firstRes.status, settleAccepted: false, atMs: Date.now() }],
          resourceIssued,
          settleAccepted,
          facts: injector.getFacts(),
          error: `expected 402 from SUT, got HTTP ${firstRes.status}`,
        };
      }

      // Шаг 2: requirements → хук.
      const reqs = parseRequirements(firstRes);
      if (!reqs) {
        return {
          attempt,
          sends: [],
          resourceIssued,
          settleAccepted,
          facts: injector.getFacts(),
          error: 'could not parse payment requirements from 402 response',
        };
      }
      const reqsDirective = await injector.onRequirements(reqs, ctx('BC'));
      const reqsResolved = resolveDirective(reqs, reqsDirective);
      if (reqsResolved.value === null) {
        return { attempt, sends: [], resourceIssued, settleAccepted, facts: injector.getFacts() };
      }
      const accept: X402Accept = reqsResolved.value.accepts[0];

      // Шаг 3: binding → хук onSign.
      const intent = this.intentSource({ maxTimeoutSeconds: accept.maxTimeoutSeconds });
      const binding: SigningBinding = {
        from: '', // заполняет signer (адрес кошелька)
        to: accept.payTo,
        value: accept.amount,
        nonce: intent.nonce,
        validAfter: intent.validAfter,
        validBefore: intent.validBefore,
        network: accept.network,
        asset: accept.asset,
        scheme: accept.scheme,
        maxTimeoutSeconds: accept.maxTimeoutSeconds,
      };
      const signDirective = await injector.onSign(binding, ctx('BC'));
      const signResolved = resolveDirective(binding, signDirective);
      if (signResolved.value === null) {
        return { attempt, sends: [], resourceIssued, settleAccepted, facts: injector.getFacts() };
      }

      // Шаг 4: подпись → хук onPayload.
      const signedPayload = await this.options.signer(signResolved.value);
      const payloadDirective = await injector.onPayload(signedPayload, ctx('BC'));
      const payloadResolved = resolveDirective(signedPayload, payloadDirective);
      if (payloadResolved.value === null) {
        return { attempt, sends: [], resourceIssued, settleAccepted, facts: injector.getFacts() };
      }
      const finalPayload = payloadResolved.value;

      // Шаг 4.5 (S-BC-14): дрейн authorization ДО settle СУТ. Без пробы —
      // HARNESS_ERROR с читаемой причиной (сценарий отцепляемый).
      if (this.options.scenario.bcPlan?.drainBeforeSend) {
        if (!this.options.drainProbe) {
          return {
            attempt,
            sends: [],
            resourceIssued,
            settleAccepted,
            facts: injector.getFacts(),
            error:
              'S-BC-14 требует пробу дрейна: передайте --facilitator-settle-url ' +
              '(env ARGUS_B_FACILITATOR_SETTLE_URL) — URL settle-эндпоинта фасилитатора СУТ',
          };
        }
        drain = await this.options.drainProbe(finalPayload, reqsResolved.value);
      }

      // Шаг 5-6: отправка (с учётом duplicate/delay) и наблюдение.
      const sendCount = await this.performSends(injector, attempt, finalPayload, sends, (v) => {
        if (v >= 200 && v < 300) resourceIssued = true;
      });
      void sendCount;

      // Шаг 7: replay-план (S-BC-04): та же отправка тем же binding/payload.
      if (this.options.scenario.bcPlan?.replayAfterSend) {
        await this.performSends(injector, attempt, finalPayload, sends, (v) => {
          if (v >= 200 && v < 300) resourceIssued = true;
        }, sends.length + 1);
      }

      settleAccepted = sends.some((s) => s.settleAccepted);
      return {
        attempt,
        sends,
        resourceIssued,
        settleAccepted,
        facts: injector.getFacts(),
        drain,
      };
    } catch (error) {
      return {
        attempt,
        sends,
        resourceIssued,
        settleAccepted,
        facts: injector.getFacts(),
        drain,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async performSends(
    injector: PaymentFaultInjector,
    attempt: number,
    payload: string,
    sink: BcSendRecord[],
    on2xx: (status: number) => void,
    startSeq = 1
  ): Promise<number> {
    const ctx: HookCtx = {
      scenarioId: injector.scenarioId,
      family: 'BC',
      attempt,
      atMs: Date.now(),
    };
    const req: OutgoingPaymentRequest = {
      url: this.resourceUrl,
      method: 'GET',
      headers: { 'payment-signature': payload },
    };
    const directive = await injector.onSend(req, ctx);
    const resolved = resolveDirective(req, directive);
    if (resolved.value === null) {
      sink.push({ seq: startSeq, status: null, settleAccepted: false, atMs: Date.now() });
      return 0;
    }
    if (resolved.delayMs > 0) await sleep(resolved.delayMs);

    let seq = startSeq;
    for (let i = 0; i < resolved.times; i++) {
      const record = await this.sendOnce(resolved.value, payload, injector, attempt, seq);
      sink.push(record);
      if (record.status !== null && record.status >= 200 && record.status < 300) {
        on2xx(record.status);
      }
      seq += 1;
    }
    return seq - startSeq;
  }

  private async sendOnce(
    request: OutgoingPaymentRequest,
    payload: string,
    injector: PaymentFaultInjector,
    attempt: number,
    seq: number
  ): Promise<BcSendRecord> {
    try {
      const res = await timedFetch(
        this.fetchImpl,
        request.url,
        {
          method: request.method,
          headers: { ...request.headers, 'payment-signature': payload },
        },
        this.requestTimeoutMs
      );
      const resObj = await this.toResourceResponse(res);
      const paymentResponseRaw = resObj.headers['payment-response'];
      const settle = parsePaymentResponse(paymentResponseRaw);

      const observation: SettlementObservation = {
        phase: paymentResponseRaw ? 'settle' : 'verify',
        // Дисциплина доказательств: принятие платежа подтверждает ТОЛЬКО
        // settle-квитанция (success без error). HTTP 2xx — транспортный
        // факт (ресурс выдан → resourceIssued), но не доказательство
        // settle: ответ 200 с явным отказом в квитанции не «принят».
        accepted: settle.accepted,
        reason: resObj.status === 402 ? this.extractError(resObj) : settle.reason,
        raw: paymentResponseRaw,
      };
      await injector.onSettle(observation, {
        scenarioId: injector.scenarioId,
        family: 'BC',
        attempt,
        atMs: Date.now(),
      });

      return {
        seq,
        status: resObj.status,
        settleAccepted: observation.accepted,
        settleReason: observation.reason,
        paymentResponseRaw,
        bodySnippet: resObj.bodyText.slice(0, 200),
        atMs: Date.now(),
      };
    } catch (error) {
      return {
        seq,
        status: null,
        settleAccepted: false,
        error: error instanceof Error ? error.message : String(error),
        atMs: Date.now(),
      };
    }
  }

  private extractError(res: ResourceResponse): string | undefined {
    try {
      const parsed = JSON.parse(res.bodyText) as { error?: string; invalidReason?: string };
      return parsed.error ?? parsed.invalidReason;
    } catch {
      return undefined;
    }
  }

  private async toResourceResponse(res: Response): Promise<ResourceResponse> {
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const bodyText = await res.text();
    return { status: res.status, headers, bodyText };
  }
}

/** Фабрика BC-раннера. */
export function createBcRunner(options: BcRunnerOptions): BcRunner {
  return new BcRunner(options);
}
