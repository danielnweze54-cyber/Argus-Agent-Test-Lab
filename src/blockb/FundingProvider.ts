/**
 * Block B — фондирование тестовыми USDC (решение по В3).
 *
 * Политика: автоматизация предпочтительна, ручное пополнение — допустимый
 * fallback. AutoFundingProvider сначала пробует faucet; при недоступности
 * faucet бросает ManualTopUpRequiredError с точной инструкцией (адрес,
 * недостающий размер) — оператор пополняет вручную, перезапускает прогон,
 * проверка баланса повторяется автоматически.
 *
 * ManualFundingProvider — режим без faucet (закрытые стенды, исчерпанные
 * лимиты CI): только проверка баланса и требование ручного пополнения.
 *
 * Классы НЕ делают сетевых вызовов напрямую: сеть приходит извне
 * (BalanceSource / FaucetClient), поэтому контракт тестируем без testnet.
 */

import type { Address } from '../adapters/payment/PaymentAdapter';

export type Amount = bigint;

export interface FaucetDripResult {
  readonly ok: boolean;
  readonly txHash?: string;
  readonly error?: string;
}

/** Точка интеграции с faucet (Circle faucet, Alchemy, собственный кран). */
export interface FaucetClient {
  readonly name: string;
  drip(wallet: Address, amount: Amount): Promise<FaucetDripResult>;
}

/** Точка интеграции с сетью: только чтение баланса USDC. */
export interface BalanceSource {
  getBalance(wallet: Address): Promise<Amount>;
}

export type FundingSource = 'already_funded' | 'faucet' | 'manual';

export interface FundingReport {
  readonly wallet: Address;
  readonly required: Amount;
  readonly balanceBefore: Amount;
  /** null, если пополнение не состоялось. */
  readonly balanceAfter: Amount | null;
  readonly source: FundingSource;
  readonly message?: string;
}

/**
 * Требуется ручное пополнение. Сообщение содержит адрес и точный размер
 * недостающего — инструкция достаточна без чтения логов.
 */
export class ManualTopUpRequiredError extends Error {
  readonly wallet: Address;
  readonly required: Amount;
  readonly balance: Amount;
  readonly causeMessage?: string;

  constructor(wallet: Address, required: Amount, balance: Amount, causeMessage?: string) {
    const missing = required > balance ? required - balance : required;
    super(
      `Требуется ручное пополнение: адрес ${wallet}, недостаёт ${missing} (atomic units). ` +
      `Причина: ${causeMessage ?? 'manual funding mode'}. ` +
      `Пополните кошелёк и перезапустите сценарий — проверка баланса повторится.`
    );
    this.name = 'ManualTopUpRequiredError';
    this.wallet = wallet;
    this.required = required;
    this.balance = balance;
    this.causeMessage = causeMessage;
  }
}

/** Общий интерфейс провайдера фондирования. */
export interface FundingProvider {
  ensureFunded(wallet: Address, required: Amount): Promise<FundingReport>;
}

/** Автоматический режим: faucet, при его отказе — ручной fallback. */
export class AutoFundingProvider implements FundingProvider {
  constructor(
    private readonly balanceSource: BalanceSource,
    private readonly faucet: FaucetClient
  ) {}

  async ensureFunded(wallet: Address, required: Amount): Promise<FundingReport> {
    const balanceBefore = await this.balanceSource.getBalance(wallet);
    if (balanceBefore >= required) {
      return {
        wallet,
        required,
        balanceBefore,
        balanceAfter: balanceBefore,
        source: 'already_funded',
      };
    }

    const missing = required - balanceBefore;
    const drip = await this.faucet.drip(wallet, missing).catch(
      (error: unknown): FaucetDripResult => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    );

    if (!drip.ok) {
      throw new ManualTopUpRequiredError(wallet, required, balanceBefore, drip.error);
    }

    const balanceAfter = await this.balanceSource.getBalance(wallet);
    if (balanceAfter < required) {
      throw new ManualTopUpRequiredError(
        wallet,
        required,
        balanceAfter,
        'faucet отработал, но баланса недостаточно (вероятна задержка подтверждения — повторите позже)'
      );
    }

    return {
      wallet,
      required,
      balanceBefore,
      balanceAfter,
      source: 'faucet',
      message: `faucet ${this.faucet.name}${drip.txHash ? `, tx ${drip.txHash}` : ''}`,
    };
  }
}

/** Ручной режим: faucet не используется вовсе. */
export class ManualFundingProvider implements FundingProvider {
  constructor(private readonly balanceSource: BalanceSource) {}

  async ensureFunded(wallet: Address, required: Amount): Promise<FundingReport> {
    const balance = await this.balanceSource.getBalance(wallet);
    if (balance >= required) {
      return {
        wallet,
        required,
        balanceBefore: balance,
        balanceAfter: balance,
        source: 'already_funded',
      };
    }
    throw new ManualTopUpRequiredError(wallet, required, balance);
  }
}
