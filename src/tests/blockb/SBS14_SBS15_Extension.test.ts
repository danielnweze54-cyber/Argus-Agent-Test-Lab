/**
 * Волна 2.5 — расширение реестра пробами лаборатории (S-BS-14 binding-race,
 * S-BS-15 non-atomic-amount). Пробы A10a/A10b/A11, прогон 2026-10-25,
 * x402-foundation/x402 PR #3920 @ 2b4cc47.
 *
 * Оценщики на инструментированном мок-СУТ: уязвимый клиент → FAIL
 * (красная зона — ожидаемый диагноз коду против 2b4cc47, НЕ дефект стенда),
 * исправленный (биндинг/чек до подписанта) → PASS. Контролы 1–2 обязательны
 * и входят в вердикт. Переносить ЛОГИКУ проб (оракул, контролы, окна),
 * не копируя тело лабораторного теста (риг писан независимо).
 *
 * Attribution: executed per the Argus Agent Test Lab scenario series
 * (A10–A11 → S-BS-14/15). Any reuse or derivative MUST retain this banner.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  listBlockBScenarios,
  getBlockBScenario,
  validateBlockBRegistry,
  evaluateBsSession,
  decimalToAtomic,
} from '../../blockb/BlockBRegistry';
import { BsRunner, parallelAttempts } from '../../blockb/runners/BsRunner';
import { validateScenarioId } from '../../blockb/BlockBRoles';
import type { BsRunnerOptions } from '../../blockb/runners/BsRunner';
import type { BsSessionRecord, SutTypedRejection } from '../../blockb/runners/BlockBRunnerTypes';
import type { BlockBScenarioSpec } from '../../blockb/BlockBScenario';

const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYTO_A = '0x1111111111111111111111111111111111111111';
const PAYTO_B = '0x2222222222222222222222222222222222222222';
const USDC_DEC = 6; // USDC Base Sepolia

/* -------------------- Инструментированный мок-СУТ -------------------- */

interface SutConfig {
  /** Уязвимый режим: НИКАКИХ чеков до подписанта (красная зона 2b4cc47). */
  vulnerable?: boolean;
  /** Expectation-чек вызывающего: пин цены в atomic units (S-BS-15). */
  pin?: string;
  /** Клиентские spend-controls: maxAmountPerPayment в atomic units ($1 = 10^6). */
  spendCapAtomic?: bigint;
}

function quotaKey(url: string, offer: { scheme: string; network: string; asset: string }): string {
  // Ключ квоты: ресурс + scheme + network + asset (канон проб A10/A11).
  return `${url}|${offer.scheme}|${offer.network}|${offer.asset}`;
}

function paymentEnvelope(payTo: string, value: string): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: { scheme: 'exact', network: 'eip155:84532', asset: ASSET, amount: value, payTo, maxTimeoutSeconds: 60 },
      payload: {
        signature: '0x' + 'be'.repeat(65),
        authorization: {
          from: '0x2222222222222222222222222222222222222222',
          to: payTo,
          value,
          validAfter: '1700000000',
          validBefore: '1700000060',
          nonce: '0x' + randomBytes(32).toString('hex'),
        },
      },
    }),
    'utf-8'
  ).toString('base64');
}

/**
 * Инструментированный СУТ-клиент: счётчик вызовов подписанта (единственный
 * pre-signature оракул), typed-отказы (field/source), инспекция resolved
 * payload (createPaymentPayload резолвится УСПЕХОМ — инспектируем
 * payload.amount, НЕ catch-паттерн: он даёт ложный PASS).
 *
 * Чеки и запись биндинга СИНХРОННЫ в продолжении fetch — атомарны в
 * однопоточном JS (candidate fix: биндинг до второй попытки).
 */
class InstrumentedSutClient {
  signerCalls = 0;
  typedRejections: SutTypedRejection[] = [];
  resolvedPayload: { amount?: string; payTo?: string } | undefined;
  private readonly ledger = new Map<string, { amount: string; payTo: string }>();

  constructor(private readonly cfg: SutConfig) {}

  /** Одна попытка: 402 → resolve payload → чеки (кап → биндинг → пин) → bind+sign. */
  async attempt(url: string): Promise<'signed' | 'rejected' | 'no-402'> {
    const res = await fetch(url, { method: 'GET' });
    if (res.status !== 402) return 'no-402';
    const pr = res.headers.get('payment-required');
    expect(pr).toBeTruthy();
    const reqs = JSON.parse(Buffer.from(pr!, 'base64').toString('utf-8')) as {
      accepts: { amount: string; payTo: string; scheme: string; network: string; asset: string }[];
    };
    const offer = reqs.accepts[0]!;
    this.resolvedPayload = { amount: offer.amount, payTo: offer.payTo };
    // Десятичный эквивалент предложения (целое = atomic; дробь = десятичное
    // представление → scale 10^dec — см. decimalToAtomic).
    const atomic = decimalToAtomic(offer.amount);
    // 1) кап-щит — штативный слой официального стека (spendControls): активен
    //    ВСЕГДА, и до подписанта (в прогоне-источнике он пропустил "0.5"
    //    под капом — окно эксплойта, но поймал "2.0"/"100000.5" сверх капа).
    if (this.cfg.spendCapAtomic !== undefined && atomic !== null && atomic > this.cfg.spendCapAtomic) {
      return this.reject({ code: 'OverSpendLimitError', field: 'amount', source: 'spend-cap' });
    }
    if (!this.cfg.vulnerable) {
      // 2) quote-ledger (биндинг первой принятой котировки на ключ квоты):
      //    сумма сравнивается по ДЕСЯТИЧНОМУ ЭКВИВАЛЕНТУ (не по строке):
      //    сумма первична (first-accepted: поле amount), затем получатель
      //    (explicit: поле payTo) — канон typed-отказов пробы A10.
      const bound = this.ledger.get(quotaKey(url, offer));
      if (bound) {
        const boundAtomic = decimalToAtomic(bound.amount);
        if (atomic === null || boundAtomic === null || boundAtomic !== atomic) {
          return this.reject({ code: 'QuoteMismatchError', field: 'amount', source: 'quote-ledger' });
        }
        if (bound.payTo.toLowerCase() !== offer.payTo.toLowerCase()) {
          return this.reject({ code: 'QuoteMismatchError', field: 'payTo', source: 'quote-ledger' });
        }
      }
      // 3) expectation-чек вызывающего (explicit pin, atomic): сравнение
      //    по десятичному эквиваленту — фикс класса S-BS-15.
      if (this.cfg.pin !== undefined && (atomic === null || atomic !== BigInt(this.cfg.pin))) {
        return this.reject({ code: 'QuoteMismatchError', field: 'amount', source: 'caller-config' });
      }
    }

    this.ledger.set(quotaKey(url, offer), { amount: offer.amount, payTo: offer.payTo });
    this.signerCalls += 1;
    await fetch(url, { method: 'GET', headers: { 'payment-signature': paymentEnvelope(offer.payTo, offer.amount) } });
    return 'signed';
  }

  private reject(r: SutTypedRejection): 'rejected' {
    this.typedRejections.push(r);
    return 'rejected';
  }
}

/* ------------------------------ Драйвер ------------------------------ */

async function runWithClient(
  spec: BlockBScenarioSpec,
  driver: (url: string) => Promise<void>,
  options?: Partial<BsRunnerOptions>
): Promise<BsSessionRecord> {
  const runner = new BsRunner({
    runConfig: { family: 'BS', sutRole: 'client', argusServerUrl: 'http://127.0.0.1:0', label: 'test' },
    scenario: spec,
    observeWindowMs: 400,
    firstRequestTimeoutMs: 2000,
    ...options,
  });
  const sessionPromise = runner.runSession();
  let url = runner.getActualUrl();
  const deadline = Date.now() + 2000;
  while (!url && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    url = runner.getActualUrl();
  }
  if (!url) throw new Error('BS server did not start');
  await driver(url!);
  return sessionPromise;
}

/** Доклад клиентского оракула и контрола в запись сессии перед оценкой. */
function withOracle(
  session: BsSessionRecord,
  client: InstrumentedSutClient,
  kind: 'binding-race' | 'non-atomic',
  controls?:
    | BsRunnerOptions['bindingRaceControls']
    | BsRunnerOptions['nonAtomicControls']
): BsSessionRecord {
  return {
    ...session,
    sutSignerCalls: client.signerCalls,
    sutTypedRejections: client.typedRejections,
    sutResolvedPayload: client.resolvedPayload,
    ...(controls === undefined
      ? {}
      : kind === 'binding-race'
        ? { bindingRaceControls: controls as NonNullable<BsRunnerOptions['bindingRaceControls']> }
        : { nonAtomicControls: controls as NonNullable<BsRunnerOptions['nonAtomicControls']> }),
  };
}

/* ------------------------------ Реестр ------------------------------ */

describe('Волна 2.5: реестр 31 → 33 и валидатор ID', () => {
  it('S-BS-14/15 зарегистрированы: семейство BS, фаза 1, волна 2.5, валидатор пропускает', () => {
    expect(() => validateBlockBRegistry()).not.toThrow();
    const ids = listBlockBScenarios().map((s) => s.id);
    expect(ids).toHaveLength(33);
    expect(new Set(ids).size).toBe(33);

    const s14 = getBlockBScenario('S-BS-14')!;
    const s15 = getBlockBScenario('S-BS-15')!;
    expect(s14.slug).toBe('binding-race');
    expect(s15.slug).toBe('non-atomic-amount');
    for (const spec of [s14, s15]) {
      expect(spec.family).toBe('BS');
      expect(spec.phase).toBe(1);
      expect(spec.wave).toBe(2.5);
      expect(() => validateScenarioId(spec.id)).not.toThrow();
    }
    // Порядок в списке: S-BS-13 < S-BS-14 < S-BS-15 < S-BS-16.
    const bsIds = ids.filter((id) => id.startsWith('S-BS-'));
    expect(bsIds.indexOf('S-BS-13')).toBeLessThan(bsIds.indexOf('S-BS-14'));
    expect(bsIds.indexOf('S-BS-14')).toBeLessThan(bsIds.indexOf('S-BS-15'));
    expect(bsIds.indexOf('S-BS-15')).toBeLessThan(bsIds.indexOf('S-BS-16'));
  });

  it('decimalToAtomic: канон сравнения сумм — по десятичному эквиваленту (scale 10^6)', () => {
    // Целочисленная строка = атомарная форма (канон протокола) — без масштаба:
    expect(decimalToAtomic('10000')).toBe(10000n);
    expect(decimalToAtomic('500000')).toBe(500000n); // $0.50 атомарно
    expect(decimalToAtomic('2')).toBe(2n);
    // Дробная строка = неатомарное десятичное представление → масштаб:
    expect(decimalToAtomic('0.5')).toBe(500000n); // $0.50 десятично (эксплойт)
    expect(decimalToAtomic('0.50')).toBe(500000n); // эквивалент "0.5"
    expect(decimalToAtomic('2.0')).toBe(2000000n); // $2 десятично (щит капа)
    expect(decimalToAtomic('100000.5')).toBe(100000500000n); // bypass без капа
    expect(decimalToAtomic(' 0.5 ')).toBe(500000n);
    // "0.5" и "500000" — один вектор: разные строки, ОДИН десятичный эквивалент.
    expect(decimalToAtomic('0.5')).toBe(decimalToAtomic('500000'));
    // Нераспознаваемые формы — тот же класс «неатомарное представление»
    // (кандидаты карт S-BS-15b/c, unprobed): экспоненциальная, hex, знак.
    expect(decimalToAtomic('1e6')).toBeNull();
    expect(decimalToAtomic('0x10')).toBeNull();
    expect(decimalToAtomic('-1')).toBeNull();
    expect(decimalToAtomic('abc')).toBeNull();
    expect(decimalToAtomic('0.0000001')).toBeNull(); // за пределами точности 6 dec
    expect(decimalToAtomic('zzz-not-a-number')).toBeNull();
  });
});

/* -------------------- BsRunner: скрипты обеих карт -------------------- */

describe('BsRunner: скрипты волны 2.5 (фолт-инъекция Аргуса)', () => {
  const spec14 = getBlockBScenario('S-BS-14')!;
  const spec15 = getBlockBScenario('S-BS-15')!;

  async function serveContacts(
    spec: BlockBScenarioSpec,
    contacts: number,
    options?: Partial<BsRunnerOptions>
  ): Promise<{ served: { amount: string; payTo: string }[]; session: BsSessionRecord }> {
    const served: { amount: string; payTo: string }[] = [];
    const session = await runWithClient(spec, async (url) => {
      for (let i = 0; i < contacts; i++) {
        const res = await fetch(url, { method: 'GET' });
        expect(res.status).toBe(402);
        const reqs = JSON.parse(Buffer.from(res.headers.get('payment-required')!, 'base64').toString('utf-8')) as {
          accepts: { amount: string; payTo: string }[];
        };
        served.push(reqs.accepts[0]!);
      }
    }, options);
    return { served, session };
  }

  it('binding-race explicit (дефолт слага): contact 1 — payToA/цена, contact 2 — payToB/та же сумма; факт фиксируется', async () => {
    const { served, session } = await serveContacts(spec14, 2);
    expect(served.map((s) => ({ amount: s.amount, payTo: s.payTo }))).toEqual([
      { amount: '10000', payTo: PAYTO_A },
      { amount: '10000', payTo: PAYTO_B },
    ]);
    expect(session.bindingRaceServed).toHaveLength(2);
    expect(session.bindingRaceServed!.map((s) => s.variant)).toEqual(['explicit', 'explicit']);
  });

  it('binding-race first-accepted: расхождение ещё и в amount (×10)', async () => {
    const { served, session } = await serveContacts(spec14, 2, {
      bindingRace: { variant: 'first-accepted' },
    });
    expect(served.map((s) => ({ amount: s.amount, payTo: s.payTo }))).toEqual([
      { amount: '10000', payTo: PAYTO_A },
      { amount: '100000', payTo: PAYTO_B },
    ]);
    expect(session.bindingRaceServed!.every((s) => s.variant === 'first-accepted')).toBe(true);
  });

  it('binding-race identical: ИДЕНТИЧНЫЕ наборы на оба контакта (риг контроля-2)', async () => {
    const { served, session } = await serveContacts(spec14, 2, {
      bindingRace: { identical: true },
    });
    expect(served[0]).toEqual(served[1]);
    expect(session.bindingRaceServed!.every((s) => s.variant === 'identical')).toBe(true);
  });

  it('non-atomic-amount (дефолт слага): amount "0.5", получатель НЕ подменён, пин = цена ресурса', async () => {
    const { served, session } = await serveContacts(spec15, 1);
    expect(served.map((s) => ({ amount: s.amount, payTo: s.payTo }))).toEqual([
      { amount: '0.5', payTo: '0x9999999999999999999999999999999999999999' },
    ]);
    expect(session.nonAtomicAmountServed).toEqual({
      amount: '0.5',
      payTo: '0x9999999999999999999999999999999999999999',
      pin: '10000',
      kind: 'exploit',
    });
  });

  it('non-atomic-amount: риги контрола подают заданные суммы (кап-щит "2.0", атомарный дубль "500000")', async () => {
    // Кап-щит: "2.0" — ДЕСЯТИЧНАЯ форма $2, СВЕРХ капа $1 (спека-канал "2";
    // явная дробь однозначно задаёт десятичную интерпретацию при одном
    // каноне разбора: целое = atomic, дробь = десятичное).
    const over = await serveContacts(spec15, 1, {
      nonAtomicAmount: { amount: '2.0', pin: '10000', kind: 'over-cap' },
    });
    expect(over.served[0]!.amount).toBe('2.0');
    expect(over.session.nonAtomicAmountServed!.kind).toBe('over-cap');
    const atomicCtl = await serveContacts(spec15, 1, {
      nonAtomicAmount: { amount: '500000', pin: '10000', kind: 'atomic-control' },
    });
    expect(atomicCtl.served[0]!.amount).toBe('500000');
    expect(atomicCtl.session.nonAtomicAmountServed!.kind).toBe('atomic-control');
  });
});

/* ------------- S-BS-14: оценщик на инструментированном мок-СУТ ------------- */

describe('S-BS-14 binding-race: уязвимый СУТ → FAIL (красная зона 2b4cc47), исправленный → PASS', () => {
  const spec = getBlockBScenario('S-BS-14')!;

  it('уязвимый клиент (параллель Promise.allSettled) подписывает ОБА payload → FAIL с candidate-fix boundary', async () => {
    const vuln = new InstrumentedSutClient({ vulnerable: true, spendCapAtomic: 1000000n });
    const session = await runWithClient(spec, async (url) => {
      // Параллель = Promise.allSettled, НЕ Promise.all (частичный отказ не
      // роняет сбор данных второй попытки); счётчик — после обеих.
      await parallelAttempts([() => vuln.attempt(url), () => vuln.attempt(url)]);
    });
    // Серверная сторона: оба подписанных payload дошли, получатели расходятся.
    expect(session.payments).toHaveLength(2);
    const tos = new Set(session.payments.map((p) => p.to!.toLowerCase()));
    expect(tos).toEqual(new Set([PAYTO_A, PAYTO_B]));

    const evaluation = evaluateBsSession(spec, withOracle(session, vuln, 'binding-race', {
      control1: { signerCalls: 2, rejectedPreSigner: false },
      control2: { signedPayloads: 2 },
    }));
    expect(evaluation.verdict).toBe('FAIL');
    expect(evaluation.reasons.join(' ')).toContain('signer-вызовов 2');
    expect(evaluation.reasons.join(' ')).toContain('candidate-fix boundary');
  });

  it('исправленный клиент (биндинг до второй попытки): гонка удержана, контролы 1–2 зелёные → PASS', async () => {
    const fixed = new InstrumentedSutClient({ spendCapAtomic: 1000000n });
    const session = await runWithClient(spec, async (url) => {
      await parallelAttempts([() => fixed.attempt(url), () => fixed.attempt(url)]);
    });
    expect(session.payments).toHaveLength(1);
    expect(fixed.signerCalls).toBe(1);
    expect(fixed.typedRejections).toHaveLength(1);
    expect(fixed.typedRejections[0]!.field).toBe('payTo');
    expect(fixed.typedRejections[0]!.source).toBe('quote-ledger');

    // Контролы на СВЕЖИХ клиентах (иначе биндинг отравит контролы):
    // контроль-1 — последовательная пара, тот же состав;
    const ctl1 = new InstrumentedSutClient({ spendCapAtomic: 1000000n });
    const ctl1Out = await runWithClient(spec, async (url) => {
      await ctl1.attempt(url);
      await ctl1.attempt(url);
    });
    void ctl1Out;
    expect(ctl1.signerCalls).toBe(1);
    expect(ctl1.typedRejections).toHaveLength(1);
    // контроль-2 — две параллельные ИДЕНТИЧНЫЕ попытки (identical-риг).
    const ctl2 = new InstrumentedSutClient({ spendCapAtomic: 1000000n });
    await runWithClient(spec, async (url) => {
      await parallelAttempts([() => ctl2.attempt(url), () => ctl2.attempt(url)]);
    }, { bindingRace: { identical: true } });
    expect(ctl2.signerCalls).toBe(2);

    const evaluation = evaluateBsSession(spec, withOracle(session, fixed, 'binding-race', {
      control1: { signerCalls: ctl1.signerCalls, rejectedPreSigner: ctl1.typedRejections.length > 0, rejection: ctl1.typedRejections[0] },
      control2: { signedPayloads: ctl2.signerCalls },
    }));
    expect(evaluation.verdict).toBe('PASS');
    expect(evaluation.reasons.join(' ')).toContain('контролы 1–2 зелёные');
  });

  it('контролы не докладывались → HARNESS_ERROR (обязательны и входят в вердикт)', async () => {
    const fixed = new InstrumentedSutClient({ spendCapAtomic: 1000000n });
    const session = await runWithClient(spec, async (url) => {
      await parallelAttempts([() => fixed.attempt(url), () => fixed.attempt(url)]);
    });
    const evaluation = evaluateBsSession(spec, withOracle(session, fixed, 'binding-race'));
    expect(evaluation.verdict).toBe('HARNESS_ERROR');
    expect(evaluation.reasons.join(' ')).toContain('контролы 1–2 не прогнаны');
  });

  it('контроль-1 красный (двойная подпись воспроизводится последовательно) → FAIL', async () => {
    const fixed = new InstrumentedSutClient({ spendCapAtomic: 1000000n });
    const session = await runWithClient(spec, async (url) => {
      await parallelAttempts([() => fixed.attempt(url), () => fixed.attempt(url)]);
    });
    const evaluation = evaluateBsSession(spec, withOracle(session, fixed, 'binding-race', {
      control1: { signerCalls: 2, rejectedPreSigner: false },
      control2: { signedPayloads: 2 },
    }));
    expect(evaluation.verdict).toBe('FAIL');
    expect(evaluation.reasons.join(' ')).toContain('контроль-1');
  });

  it('контроль-2 красный (ложное срабатывание на ИДЕНТИЧНЫХ попытках) → ADVISORY, не FAIL (деньги не потеряны)', async () => {
    const fixed = new InstrumentedSutClient({ spendCapAtomic: 1000000n });
    const session = await runWithClient(spec, async (url) => {
      await parallelAttempts([() => fixed.attempt(url), () => fixed.attempt(url)]);
    });
    const evaluation = evaluateBsSession(spec, withOracle(session, fixed, 'binding-race', {
      control1: { signerCalls: 1, rejectedPreSigner: true, rejection: { code: 'QuoteMismatchError', field: 'payTo', source: 'quote-ledger' } },
      control2: { signedPayloads: 1 },
    }));
    expect(evaluation.verdict).toBe('ADVISORY');
    expect(evaluation.reasons.join(' ')).toContain('контроль-2');
  });

  it('гонка не подана (один контакт) → HARNESS_ERROR (фолт-инъекция потеряна)', async () => {
    const client = new InstrumentedSutClient({ vulnerable: true });
    const session = await runWithClient(spec, async (url) => {
      await client.attempt(url);
    });
    const evaluation = evaluateBsSession(spec, withOracle(session, client, 'binding-race', {
      control1: { signerCalls: 1, rejectedPreSigner: true },
      control2: { signedPayloads: 2 },
    }));
    expect(evaluation.verdict).toBe('HARNESS_ERROR');
    expect(evaluation.reasons.join(' ')).toContain('гонка не подана');
  });

  it('решение по непринятой попытке ненаблюдаемо (typed-отказа нет) → HARNESS_ERROR (evidence discipline)', async () => {
    const client = new InstrumentedSutClient({ spendCapAtomic: 1000000n });
    const session = await runWithClient(spec, async (url) => {
      await parallelAttempts([() => client.attempt(url), () => client.attempt(url)]);
    });
    // Оракул частично: счётчик есть, typed-отказы НЕ докладывались.
    const evaluation = evaluateBsSession(spec, {
      ...session,
      sutSignerCalls: client.signerCalls,
      bindingRaceControls: { control1: { signerCalls: 1, rejectedPreSigner: true }, control2: { signedPayloads: 2 } },
    });
    expect(evaluation.verdict).toBe('HARNESS_ERROR');
    expect(evaluation.reasons.join(' ')).toContain('ненаблюдаемо');
  });
});

/* ------------- S-BS-15: оценщик на инструментированном мок-СУТ ------------- */

describe('S-BS-15 non-atomic-amount: подкаповое окно эксплойта, двойной оракул, тройка вариантов', () => {
  const spec = getBlockBScenario('S-BS-15')!;
  const PIN = '10000'; // $0.01 atomic — expectation-чек вызывающего включён
  const CAP = 1000000n; // $1 — дефолтный maxAmountPerPayment

  it('уязвимый клиент подписал "0.5" ПОД дефолтным капом (50× пина) → FAIL', async () => {
    const vuln = new InstrumentedSutClient({ vulnerable: true, spendCapAtomic: CAP });
    const session = await runWithClient(spec, async (url) => {
      await vuln.attempt(url);
    });
    expect(session.payments).toHaveLength(1);
    expect(session.payments[0]!.value).toBe('0.5');

    const evaluation = evaluateBsSession(spec, withOracle(session, vuln, 'non-atomic', {
      control1: { signerCalls: 0, rejectedPreSigner: true, rejection: { code: 'OverSpendLimitError', field: 'amount', source: 'spend-cap' } },
      control2: { signerCalls: 0, rejectedPreSigner: true, rejection: { code: 'QuoteMismatchError', field: 'amount', source: 'caller-config' } },
    }));
    expect(evaluation.verdict).toBe('FAIL');
    expect(evaluation.reasons.join(' ')).toContain('500000');
    expect(evaluation.reasons.join(' ')).toContain('×50');
  });

  it('исправленный клиент (пин + кап): неатомарное отклонено до подписанта, контролы зелёные → PASS', async () => {
    const fixed = new InstrumentedSutClient({ pin: PIN, spendCapAtomic: CAP });
    const session = await runWithClient(spec, async (url) => {
      await fixed.attempt(url);
    });
    expect(session.payments).toHaveLength(0);
    expect(fixed.signerCalls).toBe(0);
    expect(fixed.typedRejections[0]!.field).toBe('amount');
    expect(fixed.typedRejections[0]!.source).toBe('caller-config');
    // resolved payload СУЩЕСТВУЕТ (резолвится УСПЕХОМ) — инспекция, не catch.
    expect(fixed.resolvedPayload!.amount).toBe('0.5');

    // Контролы на свежих клиентах: кап-щит ("2.0", десятичная $2 сверх капа)
    // и атомарный дубль ("500000", $0.50 атомарно, ≠ пину).
    const ctl1 = new InstrumentedSutClient({ pin: PIN, spendCapAtomic: CAP });
    await runWithClient(spec, async (url) => {
      await ctl1.attempt(url);
    }, { nonAtomicAmount: { amount: '2.0', pin: PIN, kind: 'over-cap' } });
    expect(ctl1.signerCalls).toBe(0);
    expect(ctl1.typedRejections[0]!.source).toBe('spend-cap');
    const ctl2 = new InstrumentedSutClient({ pin: PIN, spendCapAtomic: CAP });
    await runWithClient(spec, async (url) => {
      await ctl2.attempt(url);
    }, { nonAtomicAmount: { amount: '500000', pin: PIN, kind: 'atomic-control' } });
    expect(ctl2.signerCalls).toBe(0);
    expect(ctl2.typedRejections[0]!.source).toBe('caller-config');

    const evaluation = evaluateBsSession(spec, withOracle(session, fixed, 'non-atomic', {
      control1: { signerCalls: ctl1.signerCalls, rejectedPreSigner: ctl1.typedRejections.length > 0, rejection: ctl1.typedRejections[0] },
      control2: { signerCalls: ctl2.signerCalls, rejectedPreSigner: ctl2.typedRejections.length > 0, rejection: ctl2.typedRejections[0] },
    }));
    expect(evaluation.verdict).toBe('PASS');
    expect(evaluation.reasons.join(' ')).toContain('контролы 1–2 зелёные');
  });

  it('вариант-2 (cap=false): неатомарный bypass подписывает безлимитную величину "100000.5" → FAIL', async () => {
    const vulnNoCap = new InstrumentedSutClient({ vulnerable: true });
    const session = await runWithClient(spec, async (url) => {
      await vulnNoCap.attempt(url);
    }, { nonAtomicAmount: { amount: '100000.5', pin: PIN } });
    expect(session.payments[0]!.value).toBe('100000.5');
    const evaluation = evaluateBsSession(spec, withOracle(session, vulnNoCap, 'non-atomic', {
      control1: { signerCalls: 0, rejectedPreSigner: true },
      control2: { signerCalls: 0, rejectedPreSigner: true },
    }));
    expect(evaluation.verdict).toBe('FAIL');
    expect(evaluation.reasons.join(' ')).toContain('100000500000');
  });

  it('контролы не докладывались → HARNESS_ERROR; тройка вариантов обязательна', async () => {
    const fixed = new InstrumentedSutClient({ pin: PIN, spendCapAtomic: CAP });
    const session = await runWithClient(spec, async (url) => {
      await fixed.attempt(url);
    });
    const evaluation = evaluateBsSession(spec, withOracle(session, fixed, 'non-atomic'));
    expect(evaluation.verdict).toBe('HARNESS_ERROR');
    expect(evaluation.reasons.join(' ')).toContain('тройка вариантов');
  });

  it('payTo варьировался (изоляция вектора нарушена) → HARNESS_ERROR, вердикт не смазывается', async () => {
    const vuln = new InstrumentedSutClient({ vulnerable: true });
    const session = await runWithClient(spec, async (url) => {
      await vuln.attempt(url);
    });
    // Чужой платёж (payTo атакующего из соседней карты S-BS-05/14).
    const smeared: BsSessionRecord = {
      ...withOracle(session, vuln, 'non-atomic', {
        control1: { signerCalls: 0, rejectedPreSigner: true },
        control2: { signerCalls: 0, rejectedPreSigner: true },
      }),
      payments: [
        ...session.payments,
        { seq: 2, to: PAYTO_B, value: '0.5', raw: 'x', atMs: Date.now() },
      ],
    };
    const evaluation = evaluateBsSession(spec, smeared);
    expect(evaluation.verdict).toBe('HARNESS_ERROR');
    expect(evaluation.reasons.join(' ')).toContain('изоляция вектора');
  });

  it('контроль-1 красный (кап-щит пропустил сверх-каповую десятичную) → FAIL', async () => {
    const fixed = new InstrumentedSutClient({ pin: PIN, spendCapAtomic: CAP });
    const session = await runWithClient(spec, async (url) => {
      await fixed.attempt(url);
    });
    const evaluation = evaluateBsSession(spec, withOracle(session, fixed, 'non-atomic', {
      control1: { signerCalls: 1, rejectedPreSigner: false },
      control2: { signerCalls: 0, rejectedPreSigner: true },
    }));
    expect(evaluation.verdict).toBe('FAIL');
    expect(evaluation.reasons.join(' ')).toContain('контроль-1');
  });

  it('контроль-2 красный (атомарный дубль ≠ пину подписан) → FAIL', async () => {
    const fixed = new InstrumentedSutClient({ pin: PIN, spendCapAtomic: CAP });
    const session = await runWithClient(spec, async (url) => {
      await fixed.attempt(url);
    });
    const evaluation = evaluateBsSession(spec, withOracle(session, fixed, 'non-atomic', {
      control1: { signerCalls: 0, rejectedPreSigner: true },
      control2: { signerCalls: 1, rejectedPreSigner: false },
    }));
    expect(evaluation.verdict).toBe('FAIL');
    expect(evaluation.reasons.join(' ')).toContain('контроль-2');
  });
});
