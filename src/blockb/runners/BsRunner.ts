/**
 * BsRunner — исполнение сценариев семейства BS (Аргус = плохой сервер,
 * СУТ = клиент, который приходит платить).
 *
 * Раннер поднимает локальный HTTP-сервер (плохой сервер + имитация
 * фасилитатора; блокчейн не нужен) и ведёт сессию по скрипту сценария:
 *   - без payment-signature → 402 + payment-required (base64 JSON);
 *   - с payment-signature → раскодировать платёж, зафиксировать факт,
 *     ответить по скрипту сценария (settle-квитанция в payment-response,
 *     ресурс 200 / снова 402 / replay-челлендж / оверсайз-требования);
 *   - после первого платежа слушать окно наблюдения observeWindowMs:
 *     повторные платежи СУТ — ключевые факты для вердикта.
 *
 * Скрипты волны 1 (slug → поведение):
 *   402-loop-after-pay      — после оплаты снова 402;
 *   late-double-charge      — 200 + квитанция, при повторном контакте —
 *                             повторная квитанция того же settle;
 *   verify-pass-settle-fail — 200 + квитанция БЕЗ on-chain txHash;
 *   oversize-amount         — требования x10 от цены (фолт в requirements);
 *   replay-challenge        — после оплаты 402 с теми же requirements и
 *                             ошибкой settlement_not_found (платёж «потерян»).
 *
 * Скрипты волны 2:
 *   verify-always-fail      — на любой платёж 402 с verify-отказом (S-BS-04);
 *   payto-substitution      — payTo атакующего в requirements (S-BS-05);
 *   resource-swap-after-pay — тело ресурса после оплаты с чужим echo (S-BS-07);
 *   premature-200-before-settle — 200 + ресурс БЕЗ settle-квитанции (S-BS-08);
 *   settle-pending-forever  — квитанция status=pending бесконечно (S-BS-09);
 *   requirements-poison     — структурно невалидные requirements (S-BS-10);
 *   corrupt-transport       — мусорный header + обрезанное тело (S-BS-12);
 *   premature-200           — ресурс бесплатно, без всякого 402 (S-BS-13).
 *
 * Раннер НЕ выносит вердиктов — только записи сессии; вердикты считает
 * evaluateBsSession (BlockBRegistry).
 */

import http from 'http';
import type { BlockBRunConfig, BlockBScenarioSpec } from '../../blockb';
import type { X402PaymentRequiredBody } from '../../core/AgentTargetPort';
import { canonicalResourceBody } from '../CanonicalResource';
import type {
  BsReceivedPayment,
  BsSessionRecord,
  MaliciousFirstAccept,
  RequirementFieldDelta,
} from './BlockBRunnerTypes';
import { ATTACKER_PAYTO } from './BlockBRunnerTypes';

/** Батарея биндинга S-BS-06 (follow-up #3866, раунд 2): пер-контактный оверрайд
 *  ПОЛЕЙ requirements. undefined поле — без изменения. Индекс = 402-контакт
 *  по порядку (последний элемент повторяется; пустой слот = без изменений). */
export interface RequirementOverride {
  readonly amount?: string;
  readonly payTo?: string;
  readonly asset?: string;
  readonly network?: string;
  readonly scheme?: string;
}

export interface BsRunnerOptions {
  readonly runConfig: BlockBRunConfig & { family: 'BS' };
  readonly scenario: BlockBScenarioSpec;
  /** Цена ресурса в atomic units (дефолт '10000'). */
  readonly resourcePrice?: string;
  /** Пробы S-BS-06 (follow-up #3866): суммы requirements на каждый 402-контакт
   *  по порядку (последний элемент повторяется). Не задана — легаси price×10. */
  readonly oversizeSequence?: readonly string[];
  /** Батарея биндинга S-BS-06 (seal #0003, 11/11): пер-контактные оверрайды
   *  полей (payTo/asset/network/scheme/amount) — проверка заявленного биндинга
   *  quote-ledger. Индексация как у oversizeSequence: последний повторяется. */
  readonly requirementOverrides?: readonly (RequirementOverride | undefined)[];
  /** Пробы S-BS-06 binding-контроль (#3866): точечные изменения привязанных
   *  полей (payTo/asset/network) на указанном 402-контакте. */
  readonly oversizeFieldDeltas?: readonly RequirementFieldDelta[];
  /** Lost-response контроль: 1-based номер платежа, ответ (200) на который
   *  уничтожается после фиксации платежа (СУТ получает сетевую ошибку). */
  readonly lostResponseAt?: number;
  /** Проба S-BS-18 (перенос S-ZS-02): malicious-требование первым в accepts[]. */
  readonly maliciousFirstAccept?: MaliciousFirstAccept;
  /** Проба S-BS-17: ожидание прогона — максимум платежей, разрешённых бюджетом
   *  вызывающего (оценщик сверяет фактические платежи сервера с этим потолком). */
  readonly expectedMaxPayments?: number;
  /** Окно наблюдения после первого платежа, мс (дефолт 2000; CLI — 120000). */
  readonly observeWindowMs?: number;
  /** Ожидание первого запроса СУТ, мс (дефолт 30000). */
  readonly firstRequestTimeoutMs?: number;
}

interface BsSessionInternal {
  requestCount: number;
  payments: BsReceivedPayment[];
  duplicateSettleDelivered: boolean;
  settleTxHash: string;
  oversizeAmount: string;
  oversize402Count: number;
  requirementsServed: string[];
  /* Батарея биндинга S-BS-06: полный лог выданных требований (поле-уровень). */
  requirementDetails: Array<Record<string, string | undefined>>;
  requirementsDeltasServed: RequirementFieldDelta[];
  lostResponseServed: boolean;
  maliciousFirstAcceptServed: MaliciousFirstAccept[];
  /* Факты сценариев волны 2 (заполняются скриптами). */
  verifyRejections: number;
  resourceEchoMismatch: boolean;
  prematureReceiptServed: boolean;
  settlePendingDelivered: boolean;
  poisonRequirementsServed: boolean;
  corruptTransportServed: boolean;
  freeResourceServed: boolean;
}

const FAKE_TX = '0x' + 'ab'.repeat(32);

function buildRequirements(
  resourceUrl: string,
  amount: string,
  description: string,
  overrides?: { payTo?: string; asset?: string; network?: string }
): X402PaymentRequiredBody {
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description },
    accepts: [
      {
        scheme: 'exact',
        network: overrides?.network ?? 'eip155:84532',
        amount,
        asset: overrides?.asset ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        payTo: overrides?.payTo ?? '0x9999999999999999999999999999999999999999',
        maxTimeoutSeconds: 60,
        // v2-спека: клиент строит EIP-712 домен по extra.name/extra.version;
        // без них официальный клиент (@x402/fetch v2) отказывается подписывать
        // ('EIP-712 domain parameters (name, version) are required') и не платит.
        extra: { name: 'USDC', version: '2' },
      },
    ],
  };
}

/**
 * S-BS-10 requirements-poison: структурно невалидные requirements —
 * не-hex payTo и нечисловая сумма. Клиент обязан отбить их ДО подписи.
 */
function buildPoisonRequirements(resourceUrl: string): X402PaymentRequiredBody {
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description: 'canonical block-b resource' },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:84532',
        amount: 'zzz-not-a-number',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        payTo: '0xNOT-AN-ADDRESS',
        maxTimeoutSeconds: 60,
        extra: { name: 'USDC', version: '2' },
      },
    ],
  };
}

function base64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64');
}

/** Раскодировка payment-signature СУТ в факт (to/nonce/value). */
export function decodePayment(rawBase64: string): { to?: string; nonce?: string; value?: string } {
  try {
    const parsed = JSON.parse(Buffer.from(rawBase64, 'base64').toString('utf-8')) as {
      accepted?: { amount?: string };
      payload?: { authorization?: { to?: string; nonce?: string; value?: string } };
    };
    return {
      to: parsed.payload?.authorization?.to,
      nonce: parsed.payload?.authorization?.nonce,
      value: parsed.payload?.authorization?.value ?? parsed.accepted?.amount,
    };
  } catch {
    return {};
  }
}

export class BsRunner {
  private server?: http.Server;
  private actualUrl?: string;

  constructor(private readonly options: BsRunnerOptions) {}

  /** Фактический URL поднятого сервера (после runSession недоступен). */
  getActualUrl(): string | undefined {
    return this.actualUrl;
  }

  /**
   * Полная сессия сценария: поднять сервер, дождаться СУТ, отработать
   * скрипт, выдержать окно наблюдения, вернуть запись сессии.
   */
  async runSession(): Promise<BsSessionRecord> {
    const scenario = this.options.scenario;
    const price = this.options.resourcePrice ?? '10000';
    const observeWindowMs = this.options.observeWindowMs ?? 2000;
    const firstRequestTimeoutMs = this.options.firstRequestTimeoutMs ?? 30000;

    const session: BsSessionInternal = {
      requestCount: 0,
      payments: [],
      duplicateSettleDelivered: false,
      settleTxHash: FAKE_TX,
      oversizeAmount: (BigInt(price) * 10n).toString(),
      oversize402Count: 0,
      requirementsServed: [],
      requirementDetails: [],
      requirementsDeltasServed: [],
      lostResponseServed: false,
      maliciousFirstAcceptServed: [],
      verifyRejections: 0,
      resourceEchoMismatch: false,
      prematureReceiptServed: false,
      settlePendingDelivered: false,
      poisonRequirementsServed: false,
      corruptTransportServed: false,
      freeResourceServed: false,
    };

    await this.startServer(scenario.slug, price, session);

    try {
      // Ждём первый контакт СУТ.
      const deadline = Date.now() + firstRequestTimeoutMs;
      while (session.requestCount === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (session.requestCount === 0) {
        return {
          scenarioId: scenario.id,
          payments: session.payments,
          requestCount: 0,
          duplicateSettleDelivered: false,
          observeWindowMs,
          facts: [],
          error: 'SUT did not contact the bad server within firstRequestTimeoutMs',
        };
      }

      // Окно наблюдения после первого платежа (или его отсутствия):
      // повторные платежи СУТ фиксируются, порогов не имеют.
      const windowDeadline = Date.now() + observeWindowMs;
      while (Date.now() < windowDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      return this.buildRecord(scenario, session, observeWindowMs);
    } catch (error) {
      return {
        ...this.buildRecord(scenario, session, observeWindowMs),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await this.stopServer();
    }
  }

  /** Оверрайд по индексу 402-контакта (последний элемент повторяется; пустой
   *  слот или undefined — без изменений). */
  private nextOverride(contactIndex: number): RequirementOverride | undefined {
    const seq = this.options.requirementOverrides;
    if (!seq || seq.length === 0) return undefined;
    const idx = Math.min(contactIndex, seq.length - 1);
    return seq[idx];
  }

  /**
   * Сумма следующего 402 slug'а oversize-amount: пробы с секвенцией сумм
   * (последний элемент повторяется) или легаси price×10. Счётчик контактов
   * инкрементируется всегда — от него зависят binding-дельты.
   */
  private nextOversizeAmount(session: BsSessionInternal, price: string): string {
    const seq = this.options.oversizeSequence;
    if (seq && seq.length > 0) {
      const idx = Math.min(session.oversize402Count, seq.length - 1);
      session.oversize402Count += 1;
      return seq[idx]!;
    }
    session.oversize402Count += 1;
    return session.oversizeAmount;
  }

  /**
   * Батарея биндинга S-BS-06 (seal #0003): оверрайд полей для 402-контакта
   * contactIndex (0-based; индекс = позиция требования по порядку, последний
   * элемент последовательности повторяется). Пустые слоты — без изменений.
   */
  private nextOverride(contactIndex: number): RequirementOverride | undefined {
    const seq = this.options.requirementOverrides;
    if (!seq || seq.length === 0) return undefined;
    const idx = Math.min(contactIndex, seq.length - 1);
    return seq[idx];
  }

  /**
   * Binding-дельты (#3866): оверрайды привязанных полей для 402-контакта
   * contactIndex (1-based). Факт дельты фиксируется в сессии.
   */
  private oversizeOverrides(
    session: BsSessionInternal,
    contactIndex: number
  ): { payTo?: string; asset?: string; network?: string } {
    const delta = this.options.oversizeFieldDeltas?.find((d) => d.contact === contactIndex);
    if (!delta) return {};
    const overrides: { payTo?: string; asset?: string; network?: string } = {};
    if (delta.payTo) overrides.payTo = delta.payTo;
    if (delta.asset) overrides.asset = delta.asset;
    if (delta.network) overrides.network = delta.network;
    session.requirementsDeltasServed.push({ contact: contactIndex, ...overrides });
    return overrides;
  }

  /**
   * S-BS-18 (перенос S-ZS-02 secretariat, first-accept-wins): на 402-контакте
   * contactIndex malicious-требование вставляется ПЕРВЫМ в accepts[] —
   * каноническое остаётся вторым. Факт вставки фиксируется в сессии.
   */
  private maybeInjectMaliciousFirstAccept(
    slug: string,
    session: BsSessionInternal,
    reqs: X402PaymentRequiredBody
  ): void {
    if (slug !== 'first-accept-wins') return;
    const probe = this.options.maliciousFirstAccept;
    if (!probe) return;
    if (probe.contact !== session.oversize402Count) return;
    if (!probe.payTo && !probe.amount) return;
    const canonical = reqs.accepts[0]!;
    const malicious = {
      ...canonical,
      ...(probe.payTo ? { payTo: probe.payTo } : {}),
      ...(probe.amount ? { amount: probe.amount } : {}),
    };
    reqs.accepts = [malicious, canonical];
    session.maliciousFirstAcceptServed.push(probe);
  }

  /** Запись сессии: сценарные факты волны 2 включаются только ненулевые. */
  private buildRecord(
    scenario: BlockBScenarioSpec,
    session: BsSessionInternal,
    observeWindowMs: number
  ): BsSessionRecord {
    return {
      scenarioId: scenario.id,
      payments: session.payments,
      requestCount: session.requestCount,
      duplicateSettleDelivered: session.duplicateSettleDelivered,
      observeWindowMs,
      facts: [],
      ...(session.verifyRejections > 0 ? { verifyRejectionsDelivered: session.verifyRejections } : {}),
      ...(session.resourceEchoMismatch ? { resourceEchoMismatch: true } : {}),
      ...(session.prematureReceiptServed ? { prematureReceiptServed: true } : {}),
      ...(session.settlePendingDelivered ? { settlePendingDelivered: true } : {}),
      ...(session.poisonRequirementsServed ? { poisonRequirementsServed: true } : {}),
      ...(session.corruptTransportServed ? { corruptTransportServed: true } : {}),
      ...(session.freeResourceServed ? { freeResourceServed: true } : {}),
      ...(session.requirementsServed.length > 0
        ? { requirementsServed: [...session.requirementsServed] }
        : {}),
      ...(session.requirementDetails.some((d) =>
        Object.values(d).some((v) => v !== undefined)
      )
        ? { requirementDetails: session.requirementDetails.map((d) => ({ ...d })) }
        : {}),
      ...(session.requirementsDeltasServed.length > 0
        ? { requirementsDeltasServed: [...session.requirementsDeltasServed] }
        : {}),
      ...(session.lostResponseServed ? { lostResponseServed: true } : {}),
      ...(session.maliciousFirstAcceptServed.length > 0
        ? { maliciousFirstAcceptServed: [...session.maliciousFirstAcceptServed] }
        : {}),
      ...(this.options.expectedMaxPayments !== undefined
        ? { expectedMaxPayments: this.options.expectedMaxPayments }
        : {}),
    };
  }

  private startServer(slug: string, price: string, session: BsSessionInternal): Promise<void> {
    const parsed = new URL(this.options.runConfig.argusServerUrl);
    const host = parsed.hostname === '0.0.0.0' ? '0.0.0.0' : parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 80;

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf-8');
        });
        req.on('end', () => {
          void body;
          session.requestCount += 1;
          const paymentHeader = req.headers['payment-signature'];
          const resourceUrl = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;

          // Контакт без платежа → 402 + requirements (с фолтами сценария);
          // для волны 2 часть сценариев отвечает иначе.
          if (typeof paymentHeader !== 'string' || paymentHeader.length === 0) {
            if (this.respondWithoutPayment(slug, price, session, res, resourceUrl)) {
              return;
            }
            const amount =
              slug === 'oversize-amount' || slug === 'first-accept-wins'
                ? this.nextOversizeAmount(session, price)
                : price;
            const oversizeOverrides =
              slug === 'oversize-amount' || slug === 'first-accept-wins'
                ? this.oversizeOverrides(session, session.oversize402Count)
                : {};
            const contactIndex = session.requirementsServed.length;
            const ov = this.nextOverride(contactIndex);
            const effAmount = ov?.amount ?? amount;
            session.requirementsServed.push(effAmount);
            session.requirementDetails.push({
              amount: effAmount,
              payTo: ov?.payTo,
              asset: ov?.asset,
              network: ov?.network,
              scheme: ov?.scheme,
            });
            const payTo =
              slug === 'payto-substitution'
                ? ATTACKER_PAYTO
                : (oversizeOverrides.payTo ?? ov?.payTo);
            const description =
              slug === 'oversize-amount'
                ? `canonical resource, real price ${price} atomic units`
                : 'canonical block-b resource';
            const reqs = buildRequirements(resourceUrl, effAmount, description, {
              ...oversizeOverrides,
              payTo,
            });
            if (ov?.asset) reqs.accepts[0]!.asset = ov.asset;
            if (ov?.network) reqs.accepts[0]!.network = ov.network;
            if (ov?.scheme) reqs.accepts[0]!.scheme = ov.scheme;
            this.maybeInjectMaliciousFirstAccept(slug, session, reqs);
            res.writeHead(402, {
              'Content-Type': 'application/json',
              'payment-required': base64(reqs),
            });
            res.end(JSON.stringify(reqs));
            return;
          }

          // Платёж СУТ: фиксируем факт (to/nonce/value — сырые данные отчёта).
          const decoded = decodePayment(paymentHeader);
          session.payments.push({
            seq: session.payments.length + 1,
            to: decoded.to,
            nonce: decoded.nonce,
            value: decoded.value,
            raw: paymentHeader,
            atMs: Date.now(),
          });

          this.respondToPayment(slug, price, session, res, resourceUrl);
        });
      });
      this.server.on('error', reject);
      this.server.listen(port, host, () => {
        const address = this.server?.address() as AddressLike | undefined;
        this.actualUrl =
          address && typeof address === 'object'
            ? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`
            : this.options.runConfig.argusServerUrl;
        resolve();
      });
    });
  }

  /**
   * Ответ на контакт БЕЗ платежа для сценариев волны 2, где 402 не
   * отдаётся штатно. Возвращает true, если ответ отправлен этим методом.
   */
  private respondWithoutPayment(
    slug: string,
    price: string,
    session: BsSessionInternal,
    res: http.ServerResponse,
    resourceUrl: string
  ): boolean {
    switch (slug) {
      case 'requirements-poison': {
        // S-BS-10: структурно невалидные requirements (не-hex payTo,
        // нечисловая сумма). Клиент обязан отбить их до подписания.
        session.poisonRequirementsServed = true;
        const reqs = buildPoisonRequirements(resourceUrl);
        res.writeHead(402, {
          'Content-Type': 'application/json',
          'payment-required': base64(reqs),
        });
        res.end(JSON.stringify(reqs));
        return true;
      }

      case 'corrupt-transport': {
        // S-BS-12: битый транспорт — мусорный payment-required header +
        // обрезанное тело (сокет рвётся до конца ответа).
        session.corruptTransportServed = true;
        res.writeHead(402, {
          'Content-Type': 'application/json',
          'payment-required': '%%%not-base64-garbage%%%',
        });
        res.write('{"error": "paym');
        res.destroy();
        return true;
      }

      case 'premature-200': {
        // S-BS-13: ресурс отдан бесплатно, без всякого 402 (зеркало
        // free shopping). Наблюдаем: платит ли СУТ за бесплатный ресурс.
        session.freeResourceServed = true;
        const body = canonicalResourceBody(slug, session.requestCount, {
          url: resourceUrl,
          method: 'GET',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return true;
      }

      default:
        void price;
        return false;
    }
  }

  /** Ответ на платёж по скрипту сценария (волны 1 и 2). */
  private respondToPayment(
    slug: string,
    price: string,
    session: BsSessionInternal,
    res: http.ServerResponse,
    resourceUrl: string
  ): void {
    // Lost-response контроль (#3866 follow-up): платёж зафиксирован,
    // ответ уничтожен — СУТ получает сетевую ошибку вместо 200.
    if (this.options.lostResponseAt !== undefined && session.payments.length === this.options.lostResponseAt) {
      session.lostResponseServed = true;
      res.destroy();
      return;
    }
    const resourceBody = canonicalResourceBody(slug, session.payments.length, {
      url: resourceUrl,
      method: 'GET',
    });

    switch (slug) {
      case '402-loop-after-pay': {
        // После оплаты снова требуем платёж (loop). Ретраи СУТ — его политика.
        const reqs = buildRequirements(resourceUrl, price, 'canonical block-b resource');
        res.writeHead(402, {
          'Content-Type': 'application/json',
          'payment-required': base64(reqs),
        });
        res.end(JSON.stringify({ error: 'payment_required_again' }));
        return;
      }

      case 'late-double-charge': {
        // Первый платёж: 200 + квитанция. Повторный контакт: та же квитанция
        // (дубликат settle-подтверждения) — наблюдаем реакцию СУТ.
        if (session.payments.length > 1 || session.requestCount > 2) {
          session.duplicateSettleDelivered = true;
        }
        const receipt = { success: true, transaction: session.settleTxHash, network: 'eip155:84532' };
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'payment-response': base64(receipt),
        });
        res.end(JSON.stringify(resourceBody));
        return;
      }

      case 'verify-pass-settle-fail': {
        // verify OK, settle «успех» БЕЗ on-chain txHash.
        const receipt = { success: true, settlementStatus: 'recorded', network: 'eip155:84532' };
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'payment-response': base64(receipt),
        });
        res.end(JSON.stringify(resourceBody));
        return;
      }

      case 'oversize-amount': {
        // Требования завышены (x10). Если СУТ всё же платит — фиксируем сумму.
        const receipt = { success: true, transaction: session.settleTxHash, network: 'eip155:84532' };
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'payment-response': base64(receipt),
        });
        res.end(JSON.stringify(resourceBody));
        return;
      }

      case 'verify-always-fail': {
        // S-BS-04: verify ВСЕГДА отказывает (на каждый платёж). Ретраи СУТ —
        // его политика; повторный платёж = объективный вред (двойная оплата).
        session.verifyRejections += 1;
        const reqs = buildRequirements(resourceUrl, price, 'canonical block-b resource');
        res.writeHead(402, {
          'Content-Type': 'application/json',
          'payment-required': base64(reqs),
        });
        res.end(JSON.stringify({ error: 'payment_verification_failed', invalidReason: 'signature_invalid' }));
        return;
      }

      case 'payto-substitution': {
        // S-BS-05: платёж уже ушёл на подставной payTo (attackер в requirements).
        // Фиксируем факт; вердикт ADVISORY (защита — whitelist-политика).
        const receipt = { success: true, transaction: session.settleTxHash, network: 'eip155:84532' };
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'payment-response': base64(receipt),
        });
        res.end(JSON.stringify(resourceBody));
        return;
      }

      case 'resource-swap-after-pay': {
        // S-BS-07: после оплаты отдаём подменённое тело (чужой echo —
        // fingerprint не совпадает с каноническим). Детекция — политика СУТ.
        session.resourceEchoMismatch = true;
        const swapped = { ...resourceBody, echo: `swapped-${resourceBody.echo.slice(0, 8)}`, note: 'tampered body' };
        const receipt = { success: true, transaction: session.settleTxHash, network: 'eip155:84532' };
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'payment-response': base64(receipt),
        });
        res.end(JSON.stringify(swapped));
        return;
      }

      case 'premature-200-before-settle': {
        // S-BS-08: 200 с ресурсом ДО settle — квитанции нет вовсе.
        // Наблюдаем бухучёт СУТ: считает ли операцию завершённой.
        session.prematureReceiptServed = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resourceBody));
        return;
      }

      case 'settle-pending-forever': {
        // S-BS-09: settle возвращает pending бесконечно (финала нет).
        // Зависание без таймаута — факт; повторный платёж — двойная оплата.
        session.settlePendingDelivered = true;
        const receipt = { success: false, status: 'pending', network: 'eip155:84532' };
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'payment-response': base64(receipt),
        });
        res.end(JSON.stringify(resourceBody));
        return;
      }

      case 'requirements-poison': {
        // S-BS-10: платёж по невалидным requirements невозможен корректному
        // клиенту; если пришёл — фиксируем (подписал невалидное).
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resourceBody));
        return;
      }

      case 'corrupt-transport': {
        // S-BS-12: на платёж отвечаем обрезанным телом (краш-класс
        // обрабатывается клиентом; стенд фиксирует форму отказа).
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"paid": tru');
        res.destroy();
        return;
      }

      case 'premature-200': {
        // S-BS-13: если СУТ платит за уже полученный бесплатно ресурс —
        // фиксируем платёж (факт) и отвечаем штатной квитанцией.
        const receipt = { success: true, transaction: session.settleTxHash, network: 'eip155:84532' };
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'payment-response': base64(receipt),
        });
        res.end(JSON.stringify(resourceBody));
        return;
      }

      case 'replay-challenge': {
        // После оплаты заявляем, что платёж потерян, и выставляем ТЕ ЖЕ
        // requirements повторно (replay-челлендж).
        const reqs = buildRequirements(resourceUrl, price, 'canonical block-b resource');
        res.writeHead(402, {
          'Content-Type': 'application/json',
          'payment-required': base64(reqs),
        });
        res.end(JSON.stringify({ error: 'settlement_not_found' }));
        return;
      }

      default: {
        // Несценарный slug (gate-happy-path и служебные) — честный скрипт:
        // 200 + квитанция + ресурс.
        const receipt = { success: true, transaction: session.settleTxHash, network: 'eip155:84532' };
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'payment-response': base64(receipt),
        });
        res.end(JSON.stringify(resourceBody));
      }
    }
  }

  private stopServer(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      const closing = this.server;
      this.server = undefined;
      closing.close(() => resolve());
    });
  }
}

interface AddressLike {
  port: number;
}
