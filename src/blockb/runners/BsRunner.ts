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
 * Раннер НЕ выносит вердиктов — только записи сессии; вердикты считает
 * evaluateBsSession (BlockBRegistry).
 */

import http from 'http';
import type { BlockBRunConfig, BlockBScenarioSpec } from '../../blockb';
import type { X402PaymentRequiredBody } from '../../core/AgentTargetPort';
import { canonicalResourceBody } from '../CanonicalResource';
import type { BsReceivedPayment, BsSessionRecord } from './BlockBRunnerTypes';

export interface BsRunnerOptions {
  readonly runConfig: BlockBRunConfig & { family: 'BS' };
  readonly scenario: BlockBScenarioSpec;
  /** Цена ресурса в atomic units (дефолт '10000'). */
  readonly resourcePrice?: string;
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
}

const FAKE_TX = '0x' + 'ab'.repeat(32);

function buildRequirements(resourceUrl: string, amount: string, description: string): X402PaymentRequiredBody {
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:84532',
        amount,
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        payTo: '0x9999999999999999999999999999999999999999',
        maxTimeoutSeconds: 60,
      },
    ],
  };
}

function base64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64');
}

/** Раскодировка payment-signature СУТ в факт (nonce/value). */
export function decodePayment(rawBase64: string): { nonce?: string; value?: string } {
  try {
    const parsed = JSON.parse(Buffer.from(rawBase64, 'base64').toString('utf-8')) as {
      accepted?: { amount?: string };
      payload?: { authorization?: { nonce?: string; value?: string } };
    };
    return {
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

      return {
        scenarioId: scenario.id,
        payments: session.payments,
        requestCount: session.requestCount,
        duplicateSettleDelivered: session.duplicateSettleDelivered,
        observeWindowMs,
        facts: [],
      };
    } catch (error) {
      return {
        scenarioId: scenario.id,
        payments: session.payments,
        requestCount: session.requestCount,
        duplicateSettleDelivered: session.duplicateSettleDelivered,
        observeWindowMs,
        facts: [],
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await this.stopServer();
    }
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

          // Контакт без платежа → 402 + requirements (с фолтами сценария).
          if (typeof paymentHeader !== 'string' || paymentHeader.length === 0) {
            const amount = slug === 'oversize-amount' ? session.oversizeAmount : price;
            const description =
              slug === 'oversize-amount'
                ? `canonical resource, real price ${price} atomic units`
                : 'canonical block-b resource';
            const reqs = buildRequirements(resourceUrl, amount, description);
            res.writeHead(402, {
              'Content-Type': 'application/json',
              'payment-required': base64(reqs),
            });
            res.end(JSON.stringify(reqs));
            return;
          }

          // Платёж СУТ: фиксируем факт (nonce/value — сырые данные отчёта).
          const decoded = decodePayment(paymentHeader);
          session.payments.push({
            seq: session.payments.length + 1,
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

  /** Ответ на платёж по скрипту сценария (волна 1). */
  private respondToPayment(
    slug: string,
    price: string,
    session: BsSessionInternal,
    res: http.ServerResponse,
    resourceUrl: string
  ): void {
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
        // Несценарный slug волны 1 не должен сюда попадать.
        res.writeHead(200, { 'Content-Type': 'application/json' });
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
