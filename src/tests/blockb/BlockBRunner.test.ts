/**
 * Тесты раннера блока B: реестр волны 1, BC-раннер против mock-СУТ,
 * BS-раннер с фейковым СУТ-клиентом, вердикт-оценщики, CLI-парсер.
 * Сети/блокчейна нет: подписант — стаб, фасилитатор — имитация.
 */

import { describe, it, expect } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  listBlockBScenarios,
  getBlockBScenario,
  validateBlockBRegistry,
  evaluateBcAttempt,
  evaluateBsSession,
} from '../../blockb/BlockBRegistry';
import { createBcRunner, type DrainProbe, type PaymentSigner } from '../../blockb/runners/BcRunner';
import { BsRunner } from '../../blockb/runners/BsRunner';
import { worstVerdict } from '../../blockb/runners/BlockBRunnerTypes';
import { parseBlockBArgs, runBlockBCommand } from '../../cli/blockBCommand';
import type { SigningBinding } from '../../adapters/payment/SigningBinding';
import type { BlockBScenarioSpec } from '../../blockb/BlockBScenario';

const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAY_TO = '0x9999999999999999999999999999999999999999';

/* ------------------------------ Реестр ------------------------------ */

describe('Block B registry (waves 1+2)', () => {
  it('валиден, содержит 28 сценариев (10 волны 1 + 18 волны 2)', () => {
    expect(() => validateBlockBRegistry()).not.toThrow();
    const ids = listBlockBScenarios().map((s) => s.id);
    expect(ids).toHaveLength(28);
    expect(new Set(ids).size).toBe(28);
    expect(ids).toEqual(
      expect.arrayContaining([
        'S-BC-01', 'S-BC-02', 'S-BC-04', 'S-BC-05', 'S-BC-09',
        'S-BS-01', 'S-BS-02', 'S-BS-03', 'S-BS-06', 'S-BS-11',
      ])
    );
    expect(ids).toEqual(
      expect.arrayContaining([
        'S-BC-03', 'S-BC-06', 'S-BC-07', 'S-BC-08', 'S-BC-10', 'S-BC-11', 'S-BC-12', 'S-BC-13',
        'S-BC-14', 'S-BC-15',
        'S-BS-04', 'S-BS-05', 'S-BS-07', 'S-BS-08', 'S-BS-09', 'S-BS-10', 'S-BS-12', 'S-BS-13',
      ])
    );
    // Фаза 2 только у отцепляемых S-BC-14/S-BC-15.
    const phase2 = listBlockBScenarios().filter((s) => s.phase === 2).map((s) => s.id);
    expect(phase2).toEqual(['S-BC-14', 'S-BC-15']);
  });

  it('поиск по ID и семействам', () => {
    expect(getBlockBScenario('S-BC-01')?.slug).toBe('bad-signature');
    expect(getBlockBScenario('S-BS-11')?.family).toBe('BS');
    expect(getBlockBScenario('S-BC-14')?.slug).toBe('frontrun-drain');
    expect(getBlockBScenario('S-BS-13')?.slug).toBe('premature-200');
  });
});

/* ------------------------- Mock СУТ (для BC) ------------------------- */

type PaidBehavior = 'accept' | 'reject' | 'crash' | 'accept-once';

interface MockSut {
  url: string;
  payloads: string[];
  stop: () => Promise<void>;
}

/** Mock ресурсного сервера СУТ: 402 на первый запрос, поведение на платёж — конфиг. */
async function startMockSut(behavior: PaidBehavior, opts?: { scheme?: string }): Promise<MockSut> {
  const payloads: string[] = [];
  let accepted = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8'); });
    req.on('end', () => {
      void body;
      const payment = req.headers['payment-signature'];
      if (typeof payment !== 'string' || payment.length === 0) {
        const reqs = {
          x402Version: 2,
          resource: { url: 'http://sut/mock', description: 'mock' },
          accepts: [{
            scheme: opts?.scheme ?? 'exact', network: 'eip155:84532', amount: '10000',
            asset: ASSET, payTo: PAY_TO, maxTimeoutSeconds: 60,
          }],
        };
        res.writeHead(402, {
          'Content-Type': 'application/json',
          'payment-required': Buffer.from(JSON.stringify(reqs)).toString('base64'),
        });
        res.end(JSON.stringify(reqs));
        return;
      }
      payloads.push(payment);
      if (behavior === 'accept' || (behavior === 'accept-once' && accepted++ === 0)) {
        const receipt = Buffer.from(JSON.stringify({
          success: true, transaction: '0x' + 'cd'.repeat(32), network: 'eip155:84532',
        })).toString('base64');
        res.writeHead(200, { 'Content-Type': 'application/json', 'payment-response': receipt });
        res.end(JSON.stringify({ paid: true }));
        return;
      }
      if (behavior === 'crash') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
        return;
      }
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload_verification_failed' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    payloads,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Стаб-подписант: детерминированный конверт без viem/сети. */
const stubSigner: PaymentSigner = async (binding: SigningBinding) => {
  const envelope = {
    x402Version: 2,
    accepted: {
      scheme: binding.scheme, network: binding.network, asset: binding.asset,
      amount: binding.value, payTo: binding.to, maxTimeoutSeconds: binding.maxTimeoutSeconds,
    },
    payload: {
      signature: '0x' + 'de'.repeat(65),
      authorization: {
        from: '0x1111111111111111111111111111111111111111',
        to: binding.to, value: binding.value,
        validAfter: binding.validAfter, validBefore: binding.validBefore,
        nonce: binding.nonce,
      },
    },
  };
  return Buffer.from(JSON.stringify(envelope), 'utf-8').toString('base64');
};

function runSpec(spec: BlockBScenarioSpec, url: string) {
  return runSpecWithProbe(spec, url, undefined);
}

function runSpecWithProbe(spec: BlockBScenarioSpec, url: string, drainProbe?: DrainProbe) {
  const runner = createBcRunner({
    runConfig: { family: 'BC', sutRole: 'server', resourceUrl: url, label: 'test' },
    scenario: spec,
    signer: stubSigner,
    requestTimeoutMs: 3000,
    drainProbe,
  });
  const injector = spec.createInjector();
  return runner.runAttempt(injector, 1);
}

/* ------------------------------ BC ------------------------------ */

describe('BcRunner: wave-1 scenarios against mock SUT', () => {
  it('S-BC-01: честный СУТ отклоняет битую подпись => PASS; принимающий СУТ => FAIL', async () => {
    const spec = getBlockBScenario('S-BC-01')!;
    const honest = await startMockSut('reject');
    try {
      const obs = await runSpec(spec, honest.url);
      expect(evaluateBcAttempt(spec, obs).verdict).toBe('PASS');
    } finally {
      await honest.stop();
    }
    const greedy = await startMockSut('accept');
    try {
      const obs = await runSpec(spec, greedy.url);
      const verdict = evaluateBcAttempt(spec, obs);
      expect(verdict.verdict).toBe('FAIL');
      expect(verdict.reasons.some((r) => r.includes('ресурс'))).toBe(true);
    } finally {
      await greedy.stop();
    }
  });

  it('S-BC-02: validBefore уходит в прошлое (мутация доходит до payload)', async () => {
    const spec = getBlockBScenario('S-BC-02')!;
    const sut = await startMockSut('reject');
    try {
      const obs = await runSpec(spec, sut.url);
      expect(evaluateBcAttempt(spec, obs).verdict).toBe('PASS');
      const sent = JSON.parse(Buffer.from(sut.payloads[0], 'base64').toString('utf-8')) as {
        payload: { authorization: { validBefore: string } };
      };
      expect(Number(sent.payload.authorization.validBefore)).toBeLessThan(Math.floor(Date.now() / 1000));
    } finally {
      await sut.stop();
    }
  });

  it('S-BC-04: повтор той же authorization (тот же nonce); принимающий СУТ => FAIL', async () => {
    const spec = getBlockBScenario('S-BC-04')!;
    const greedy = await startMockSut('accept');
    try {
      const obs = await runSpec(spec, greedy.url);
      expect(obs.sends).toHaveLength(2);
      const nonces = sutNonces(greedy.payloads);
      expect(nonces[0]).toBe(nonces[1]);
      expect(evaluateBcAttempt(spec, obs).verdict).toBe('FAIL');
    } finally {
      await greedy.stop();
    }
    const honest = await startMockSut('reject');
    try {
      const obs = await runSpec(spec, honest.url);
      expect(evaluateBcAttempt(spec, obs).verdict).toBe('PASS');
      expect(honest.payloads).toHaveLength(2);
    } finally {
      await honest.stop();
    }
  });

  it('S-BC-09: 5xx на malformed payload => FAIL; читаемый отказ => PASS', async () => {
    const spec = getBlockBScenario('S-BC-09')!;
    const crashing = await startMockSut('crash');
    try {
      const obs = await runSpec(spec, crashing.url);
      const verdict = evaluateBcAttempt(spec, obs);
      expect(verdict.verdict).toBe('FAIL');
      expect(verdict.reasons.some((r) => r.includes('5xx'))).toBe(true);
    } finally {
      await crashing.stop();
    }
    const honest = await startMockSut('reject');
    try {
      const obs = await runSpec(spec, honest.url);
      expect(evaluateBcAttempt(spec, obs).verdict).toBe('PASS');
      expect(honest.payloads[0]).toContain('%%%');
    } finally {
      await honest.stop();
    }
  });

  it('S-BC-05: passthrough-инжектор; честный СУТ => PASS (фондирование вне инжектора)', async () => {
    const spec = getBlockBScenario('S-BC-05')!;
    const sut = await startMockSut('reject');
    try {
      const obs = await runSpec(spec, sut.url);
      expect(evaluateBcAttempt(spec, obs).verdict).toBe('PASS');
    } finally {
      await sut.stop();
    }
  });
});

/* ------------------------- BC: волна 2 ------------------------- */

async function expectRejectPassAndAcceptFail(scenarioIdStr: string, assertPayload?: (envelope: Record<string, unknown>) => void): Promise<void> {
  const spec = getBlockBScenario(scenarioIdStr)!;
  const honest = await startMockSut('reject');
  try {
    const obs = await runSpec(spec, honest.url);
    const verdict = evaluateBcAttempt(spec, obs);
    expect(verdict.verdict).toBe('PASS');
    if (assertPayload && honest.payloads[0]) {
      assertPayload(JSON.parse(Buffer.from(honest.payloads[0], 'base64').toString('utf-8')) as Record<string, unknown>);
    }
  } finally {
    await honest.stop();
  }
  const greedy = await startMockSut('accept');
  try {
    const obs = await runSpec(spec, greedy.url);
    expect(evaluateBcAttempt(spec, obs).verdict).toBe('FAIL');
  } finally {
    await greedy.stop();
  }
}

describe('BcRunner: wave-2 scenarios against mock SUT', () => {
  it('S-BC-03 not-yet-valid: validAfter в будущем; честный СУТ => PASS, принимающий => FAIL', async () => {
    await expectRejectPassAndAcceptFail('S-BC-03', (envelope) => {
      const auth = (envelope as { payload: { authorization: { validAfter: string; validBefore: string } } }).payload.authorization;
      expect(Number(auth.validAfter)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  it('S-BC-06 amount-mismatch: value = requirements+1; честный СУТ => PASS, принимающий => FAIL', async () => {
    // Мок всегда отдаёт requirements amount=10000; инжектор подписывает 10001.
    await expectRejectPassAndAcceptFail('S-BC-06', (envelope) => {
      const e = envelope as { accepted: { amount: string }; payload: { authorization: { value: string } } };
      expect(BigInt(e.payload.authorization.value)).toBe(10001n);
      expect(e.accepted.amount).toBe('10001'); // конверт согласован с authorization
    });
  });

  it('S-BC-07 wrong-chain-id: домен eip155:8453; честный СУТ => PASS, принимающий => FAIL', async () => {
    await expectRejectPassAndAcceptFail('S-BC-07', (envelope) => {
      const e = envelope as { accepted: { network: string } };
      expect(e.accepted.network).toBe('eip155:8453');
    });
  });

  it('S-BC-08 scheme-mismatch: accepted.scheme=upto в payload; честный СУТ => PASS', async () => {
    await expectRejectPassAndAcceptFail('S-BC-08', (envelope) => {
      const e = envelope as { accepted: { scheme: string } };
      expect(e.accepted.scheme).toBe('upto');
    });
  });

  it('S-BC-10 resource-mismatch: в payload другой ресурс; честный СУТ => PASS', async () => {
    await expectRejectPassAndAcceptFail('S-BC-10', (envelope) => {
      const e = envelope as { resource?: { url: string } };
      expect(e.resource?.url).toBe('http://other-resource.example/other-item');
    });
  });

  it('S-BC-12 wrong-asset: asset = WETH; честный СУТ => PASS, принимающий => FAIL', async () => {
    await expectRejectPassAndAcceptFail('S-BC-12', (envelope) => {
      const e = envelope as { accepted: { asset: string } };
      expect(e.accepted.asset).toBe('0x4200000000000000000000000000000000000006');
    });
  });

  it('S-BC-11 duplicate-send: оба приняты => FAIL; первый принят, повтор отклонён => PASS', async () => {
    const spec = getBlockBScenario('S-BC-11')!;
    const greedy = await startMockSut('accept');
    try {
      const obs = await runSpec(spec, greedy.url);
      expect(obs.sends).toHaveLength(2);
      const nonces = sutNonces(greedy.payloads);
      expect(nonces[0]).toBe(nonces[1]); // тот же nonce, платёж валиден
      const verdict = evaluateBcAttempt(spec, obs);
      expect(verdict.verdict).toBe('FAIL');
      expect(verdict.reasons.some((r) => r.includes('двойное settle'))).toBe(true);
    } finally {
      await greedy.stop();
    }
    const honest = await startMockSut('accept-once');
    try {
      const obs = await runSpec(spec, honest.url);
      const verdict = evaluateBcAttempt(spec, obs);
      expect(verdict.verdict).toBe('PASS');
      expect(verdict.reasons[0]).toContain('повтор: отклонён');
    } finally {
      await honest.stop();
    }
  });

  it('S-BC-13 wallet-kyt-edge: 5xx => FAIL (краш-класс); читаемый отказ => PASS + длительность', async () => {
    const spec = getBlockBScenario('S-BC-13')!;
    const crashing = await startMockSut('crash');
    try {
      const obs = await runSpec(spec, crashing.url);
      const verdict = evaluateBcAttempt(spec, obs);
      expect(verdict.verdict).toBe('FAIL');
      expect(verdict.reasons.some((r) => r.includes('краш-класс'))).toBe(true);
    } finally {
      await crashing.stop();
    }
    const honest = await startMockSut('reject');
    try {
      const obs = await runSpec(spec, honest.url);
      expect(evaluateBcAttempt(spec, obs).verdict).toBe('PASS');
    } finally {
      await honest.stop();
    }
  });

  it('S-BC-14 frontrun-drain: без пробы => HARNESS_ERROR; дрейн + ресурс => FAIL; дрейн + отказ => PASS', async () => {
    const spec = getBlockBScenario('S-BC-14')!;
    const sut = await startMockSut('reject');
    try {
      const obs = await runSpecWithProbe(spec, sut.url, undefined);
      const verdict = evaluateBcAttempt(spec, obs);
      expect(verdict.verdict).toBe('HARNESS_ERROR');
      expect(obs.error).toContain('--facilitator-settle-url');
    } finally {
      await sut.stop();
    }

    const probe: DrainProbe = async () => ({ settled: true, status: 200 });
    const greedy = await startMockSut('accept');
    try {
      const obs = await runSpecWithProbe(spec, greedy.url, probe);
      const verdict = evaluateBcAttempt(spec, obs);
      expect(verdict.verdict).toBe('FAIL');
      expect(verdict.reasons.some((r) => r.includes('дрейнованному платежу'))).toBe(true);
      expect(verdict.reasons.some((r) => r.includes('settle подтверждён'))).toBe(true);
    } finally {
      await greedy.stop();
    }
    const honest = await startMockSut('reject');
    try {
      const obs = await runSpecWithProbe(spec, honest.url, probe);
      const verdict = evaluateBcAttempt(spec, obs);
      expect(verdict.verdict).toBe('PASS');
    } finally {
      await honest.stop();
    }
  });

  it('S-BC-15 upto-overdraft: exact-СУТ => PASS (неприменим, приём валидного платежа — норма)', async () => {
    const spec = getBlockBScenario('S-BC-15')!;
    const exactSut = await startMockSut('accept'); // requirements exact — инжектор честен
    try {
      const obs = await runSpec(spec, exactSut.url);
      const verdict = evaluateBcAttempt(spec, obs);
      expect(verdict.verdict).toBe('PASS');
      expect(verdict.reasons[0]).toContain('неприменим');
      expect(obs.sends).toHaveLength(1); // платёж отправлен, но фолта не было
    } finally {
      await exactSut.stop();
    }
  });

  it('S-BC-15 upto-overdraft: upto-СУТ, платёж сверх потолка принят => FAIL; отклонён => PASS', async () => {
    const spec = getBlockBScenario('S-BC-15')!;
    const uptoSut = await startMockSut('accept', { scheme: 'upto' });
    try {
      const obs = await runSpec(spec, uptoSut.url);
      const verdict = evaluateBcAttempt(spec, obs);
      expect(verdict.verdict).toBe('FAIL');
      expect(verdict.reasons.some((r) => r.includes('сверх upto-потолка'))).toBe(true);
      // подписанная value = потолок + 1
      const sent = JSON.parse(Buffer.from(uptoSut.payloads[0], 'base64').toString('utf-8')) as {
        payload: { authorization: { value: string } };
      };
      expect(BigInt(sent.payload.authorization.value)).toBe(10001n);
    } finally {
      await uptoSut.stop();
    }
    const rejecting = await startMockSut('reject', { scheme: 'upto' });
    try {
      const obs = await runSpec(spec, rejecting.url);
      expect(evaluateBcAttempt(spec, obs).verdict).toBe('PASS');
    } finally {
      await rejecting.stop();
    }
  });
});

function sutNonces(payloads: string[]): (string | undefined)[] {
  return payloads.map((p) => {
    try {
      const parsed = JSON.parse(Buffer.from(p, 'base64').toString('utf-8')) as {
        payload?: { authorization?: { nonce?: string } };
      };
      return parsed.payload?.authorization?.nonce;
    } catch {
      return undefined;
    }
  });
}

/* ------------------------------ BS ------------------------------ */

function paymentEnvelope(nonce: string, value: string): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: { scheme: 'exact', network: 'eip155:84532', asset: ASSET, amount: value, payTo: PAY_TO, maxTimeoutSeconds: 60 },
    payload: {
      signature: '0x' + 'be'.repeat(65),
      authorization: {
        from: '0x2222222222222222222222222222222222222222',
        to: PAY_TO, value, validAfter: '1700000000', validBefore: '1700000060', nonce,
      },
    },
  }), 'utf-8').toString('base64');
}

type ClientBehavior =
  | 'pay-once'
  | 'pay-twice'
  | 'pay-oversize'
  | 'refuse-oversize'
  | 'repay-again'
  | 'stop-on-poison'
  | 'stop-on-corrupt'
  | 'take-free'
  | 'take-free-then-pay';

/** Фейковый СУТ-клиент: 402 → платёж → реакция на ответ сервера. */
async function fakeSutClient(url: string, behavior: ClientBehavior, nonceSeed: number): Promise<void> {
  if (behavior === 'stop-on-corrupt') {
    // S-BS-12: битый транспорт (мусорный header + оборванный сокет) —
    // безопасная форма: прекратить без платежа.
    try {
      await fetch(url, { method: 'GET' });
    } catch {
      /* соединение оборвано сервером — ожидаемо */
    }
    return;
  }

  if (behavior === 'take-free' || behavior === 'take-free-then-pay') {
    // S-BS-13: ресурс отдан без 402 (бесплатно); наблюдаем,
    // платит ли клиент за уже полученный ресурс.
    const free = await fetch(url, { method: 'GET' });
    expect(free.status).toBe(200);
    if (behavior === 'take-free') return;
    await fetch(url, {
      method: 'GET',
      headers: { 'payment-signature': paymentEnvelope(`0x${'99'.repeat(31)}01`, '10000') },
    });
    return;
  }

  const first = await fetch(url, { method: 'GET' });
  expect(first.status).toBe(402);
  const prHeader = first.headers.get('payment-required');
  expect(prHeader).toBeTruthy();
  const reqs = JSON.parse(Buffer.from(prHeader!, 'base64').toString('utf-8')) as {
    resource: { description?: string };
    accepts: { amount: string; payTo: string }[];
  };

  if (behavior === 'refuse-oversize') {
    // Оверсайз-требования против реальной цены из description — отказ.
    expect(reqs.resource.description).toContain('real price');
    return;
  }

  if (behavior === 'stop-on-poison') {
    // S-BS-10: нечисловая сумма/не-hex payTo — отбить ДО подписания.
    expect(Number.isNaN(Number(reqs.accepts[0].amount))).toBe(true);
    return;
  }

  const amount = reqs.accepts[0].amount;
  let nonceCounter = nonceSeed;
  const payOnce = async (): Promise<{ status: number; error?: string; hasReceipt: boolean }> => {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'payment-signature': paymentEnvelope(`0x${'77'.repeat(31)}${String(nonceCounter).padStart(2, '0')}`, amount) },
    });
    nonceCounter += 1;
    const text = await res.text();
    const error = (() => {
      try { return (JSON.parse(text) as { error?: string }).error; } catch { return undefined; }
    })();
    return { status: res.status, error, hasReceipt: res.headers.get('payment-response') !== null };
  };

  const firstPayment = await payOnce();
  if (behavior === 'pay-once') return;
  if (behavior === 'pay-oversize') return;
  if (behavior === 'repay-again') {
    // «Жадный» клиент: платит повторно независимо от ответа (verify-отказ,
    // отсутствующая квитанция, pending) — объективная двойная оплата.
    await payOnce();
    return;
  }
  if (behavior === 'pay-twice') {
    // «Жадный» клиент: на любой 402 после платежа платит снова.
    if (firstPayment.status === 402) {
      await payOnce();
    } else {
      await fetch(url, { method: 'GET' }).then(async (r) => {
        if (r.status === 402) {
          await fetch(url, { method: 'GET', headers: { 'payment-signature': paymentEnvelope(`0x${'88'.repeat(32)}`, amount) } });
        }
      });
    }
  }
}

async function runBs(
  spec: BlockBScenarioSpec,
  behavior: ClientBehavior,
  price = '10000'
): Promise<{ session: Awaited<ReturnType<BsRunner['runSession']>> }> {
  const runner = new BsRunner({
    runConfig: { family: 'BS', sutRole: 'client', argusServerUrl: 'http://127.0.0.1:0', label: 'test' },
    scenario: spec,
    resourcePrice: price,
    observeWindowMs: 400,
    firstRequestTimeoutMs: 2000,
  });
  const sessionPromise = runner.runSession();
  // Ждём подъёма сервера и отдаём URL фейковому клиенту.
  let url = runner.getActualUrl();
  const deadline = Date.now() + 2000;
  while (!url && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    url = runner.getActualUrl();
  }
  if (!url) throw new Error('BS server did not start');
  await fakeSutClient(url, behavior, 1);
  return { session: await sessionPromise };
}

describe('BsRunner + evaluators: wave-1 sessions', () => {
  it('S-BS-01 402-loop: платит один раз и останавливается => PASS; жадный => FAIL', async () => {
    const spec = getBlockBScenario('S-BS-01')!;
    const good = await runBs(spec, 'pay-once');
    expect(good.session.payments).toHaveLength(1);
    expect(evaluateBsSession(spec, good.session).verdict).toBe('PASS');

    const greedy = await runBs(spec, 'pay-twice');
    expect(greedy.session.payments.length).toBeGreaterThanOrEqual(2);
    expect(evaluateBsSession(spec, greedy.session).verdict).toBe('FAIL');
  });

  it('S-BS-11 replay-challenge: отказ от повторного платежа => PASS; повтор => FAIL', async () => {
    const spec = getBlockBScenario('S-BS-11')!;
    const good = await runBs(spec, 'pay-once');
    expect(evaluateBsSession(spec, good.session).verdict).toBe('PASS');

    const greedy = await runBs(spec, 'pay-twice');
    expect(evaluateBsSession(spec, greedy.session).verdict).toBe('FAIL');
  });

  it('S-BS-06 oversize: СУТ платит x10 => FAIL (решение В2); отказ => PASS', async () => {
    const spec = getBlockBScenario('S-BS-06')!;
    const payer = await runBs(spec, 'pay-oversize');
    expect(payer.session.payments[0]?.value).toBe('100000');
    expect(evaluateBsSession(spec, payer.session).verdict).toBe('FAIL');

    const refuser = await runBs(spec, 'refuse-oversize');
    expect(refuser.session.payments).toHaveLength(0);
    expect(evaluateBsSession(spec, refuser.session).verdict).toBe('PASS');
  });

  it('S-BS-02 late-double-charge: дубликат квитанции доставлен, повторного платежа нет => PASS', async () => {
    const spec = getBlockBScenario('S-BS-02')!;
    const good = await runBs(spec, 'pay-once');
    expect(good.session.payments).toHaveLength(1);
    const verdict = evaluateBsSession(spec, good.session);
    expect(verdict.verdict).toBe('PASS');

    const greedy = await runBs(spec, 'pay-twice');
    expect(greedy.session.duplicateSettleDelivered).toBe(true);
    expect(evaluateBsSession(spec, greedy.session).verdict).toBe('FAIL');
  });

  it('S-BS-03 verify-pass-settle-fail: квитанция без txHash => ADVISORY', async () => {
    const spec = getBlockBScenario('S-BS-03')!;
    const result = await runBs(spec, 'pay-once');
    const verdict = evaluateBsSession(spec, result.session);
    expect(verdict.verdict).toBe('ADVISORY');
    expect(verdict.reasons.some((r) => r.includes('txHash'))).toBe(true);
  });
});

/* ------------------------- BS: волна 2 ------------------------- */

describe('BsRunner + evaluators: wave-2 sessions', () => {
  it('S-BS-04 verify-always-fail: стоп после отказа => PASS; повторный платёж => FAIL', async () => {
    const spec = getBlockBScenario('S-BS-04')!;
    const good = await runBs(spec, 'pay-once');
    expect(good.session.verifyRejectionsDelivered).toBe(1);
    expect(evaluateBsSession(spec, good.session).verdict).toBe('PASS');

    const greedy = await runBs(spec, 'repay-again');
    expect(greedy.session.payments).toHaveLength(2);
    const verdict = evaluateBsSession(spec, greedy.session);
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.reasons.some((r) => r.includes('двойная оплата'))).toBe(true);
  });

  it('S-BS-05 payto-substitution: платёж на подставной payTo => ADVISORY (факт зафиксирован)', async () => {
    const spec = getBlockBScenario('S-BS-05')!;
    const result = await runBs(spec, 'pay-once');
    expect(result.session.payments).toHaveLength(1);
    const verdict = evaluateBsSession(spec, result.session);
    expect(verdict.verdict).toBe('ADVISORY');
    expect(verdict.reasons.some((r) => r.includes('подставной payTo'))).toBe(true);
  });

  it('S-BS-07 resource-swap-after-pay: подменённое тело после оплаты => ADVISORY (echo mismatch)', async () => {
    const spec = getBlockBScenario('S-BS-07')!;
    const result = await runBs(spec, 'pay-once');
    expect(result.session.resourceEchoMismatch).toBe(true);
    const verdict = evaluateBsSession(spec, result.session);
    expect(verdict.verdict).toBe('ADVISORY');
    expect(verdict.reasons.some((r) => r.includes('echo mismatch'))).toBe(true);
  });

  it('S-BS-08 premature-200-before-settle: ресурс без квитанции => ADVISORY; повтор => FAIL', async () => {
    const spec = getBlockBScenario('S-BS-08')!;
    const calm = await runBs(spec, 'pay-once');
    expect(calm.session.prematureReceiptServed).toBe(true);
    expect(evaluateBsSession(spec, calm.session).verdict).toBe('ADVISORY');

    const greedy = await runBs(spec, 'repay-again');
    expect(greedy.session.payments).toHaveLength(2);
    expect(evaluateBsSession(spec, greedy.session).verdict).toBe('FAIL');
  });

  it('S-BS-09 settle-pending-forever: pending без финала => ADVISORY; повторный платёж => FAIL', async () => {
    const spec = getBlockBScenario('S-BS-09')!;
    const calm = await runBs(spec, 'pay-once');
    expect(calm.session.settlePendingDelivered).toBe(true);
    expect(evaluateBsSession(spec, calm.session).verdict).toBe('ADVISORY');

    const greedy = await runBs(spec, 'repay-again');
    expect(greedy.session.payments).toHaveLength(2);
    expect(evaluateBsSession(spec, greedy.session).verdict).toBe('FAIL');
  });

  it('S-BS-10 requirements-poison: отбил до подписания => PASS; подписал => FAIL', async () => {
    const spec = getBlockBScenario('S-BS-10')!;
    const careful = await runBs(spec, 'stop-on-poison');
    expect(careful.session.poisonRequirementsServed).toBe(true);
    expect(careful.session.payments).toHaveLength(0);
    expect(evaluateBsSession(spec, careful.session).verdict).toBe('PASS');

    const careless = await runBs(spec, 'pay-once'); // платит не глядя на сумму/адрес
    expect(careless.session.payments).toHaveLength(1);
    expect(evaluateBsSession(spec, careless.session).verdict).toBe('FAIL');
  });

  it('S-BS-12 corrupt-transport: безопасное завершение без платежа => PASS', async () => {
    const spec = getBlockBScenario('S-BS-12')!;
    const careful = await runBs(spec, 'stop-on-corrupt');
    expect(careful.session.corruptTransportServed).toBe(true);
    expect(careful.session.payments).toHaveLength(0);
    expect(evaluateBsSession(spec, careful.session).verdict).toBe('PASS');
  });

  it('S-BS-13 premature-200: бесплатный ресурс без платежа => ADVISORY; платёж за бесплатный => ADVISORY (факт)', async () => {
    const spec = getBlockBScenario('S-BS-13')!;
    const taker = await runBs(spec, 'take-free');
    expect(taker.session.freeResourceServed).toBe(true);
    expect(taker.session.payments).toHaveLength(0);
    expect(evaluateBsSession(spec, taker.session).verdict).toBe('ADVISORY');

    const payer = await runBs(spec, 'take-free-then-pay');
    expect(payer.session.payments).toHaveLength(1);
    const verdict = evaluateBsSession(spec, payer.session);
    expect(verdict.verdict).toBe('ADVISORY');
    expect(verdict.reasons.some((r) => r.includes('заплатил за бесплатный ресурс'))).toBe(true);
  });
});

/* --------------------------- Агрегация/CLI --------------------------- */

describe('Verdict aggregation and CLI', () => {
  it('worstVerdict: PASS < ADVISORY < FAIL < HARNESS_ERROR', () => {
    expect(worstVerdict(['PASS', 'ADVISORY'])).toBe('ADVISORY');
    expect(worstVerdict(['PASS', 'FAIL', 'ADVISORY'])).toBe('FAIL');
    expect(worstVerdict(['FAIL', 'HARNESS_ERROR'])).toBe('HARNESS_ERROR');
  });

  it('evaluateBcAttempt: ошибка транспорта => HARNESS_ERROR', () => {
    const spec = getBlockBScenario('S-BC-01')!;
    const evaluation = evaluateBcAttempt(spec, {
      attempt: 1,
      sends: [],
      resourceIssued: false,
      settleAccepted: false,
      facts: [],
      error: 'network down',
    });
    expect(evaluation.verdict).toBe('HARNESS_ERROR');
  });

  it('parseBlockBArgs: флаги читаются, неизвестные отклоняются', () => {
    const parsed = parseBlockBArgs(['run', '--block', 'B', '--family', 'BS', '--scenario', 'S-BS-11', '--repeat', '5']);
    expect(parsed.action).toBe('run');
    expect(parsed.family).toBe('BS');
    expect(parsed.scenarioId).toBe('S-BS-11');
    expect(parsed.repeat).toBe(5);
    expect(() => parseBlockBArgs(['run', '--block', 'B', '--wat'])).toThrow(/--wat/);
    expect(() => parseBlockBArgs(['run', '--block', 'A'])).toThrow(/--block B/);
  });

  it('parseBlockBArgs: --facilitator-settle-url и --funding читаются; мусорный --funding отклоняется', () => {
    const parsed = parseBlockBArgs([
      'run', '--block', 'B', '--family', 'BC', '--sut-url', 'http://sut',
      '--facilitator-settle-url', 'https://facilitator.example/settle',
      '--funding', 'manual', '--rpc-url', 'https://rpc.example',
    ]);
    expect(parsed.facilitatorSettleUrl).toBe('https://facilitator.example/settle');
    expect(parsed.funding).toBe('manual');
    expect(parsed.rpcUrl).toBe('https://rpc.example');
    expect(() => parseBlockBArgs(['run', '--block', 'B', '--funding', 'wat'])).toThrow(/auto\|manual/);
  });

  it('runBlockBCommand: list --block B => 0 и печатает реестр', async () => {
    const exit = await runBlockBCommand(['list', '--block', 'B']);
    expect(exit).toBe(0);
  });

  it('runBlockBCommand: run BS без --scenario => 2 (нужен один сценарий на сессию)', async () => {
    const exit = await runBlockBCommand(['run', '--block', 'B', '--family', 'BS', '--skip-gate']);
    expect(exit).toBe(2);
  });

  it('runBlockBCommand: --bind HOST:PORT нормализуется в http://HOST:PORT (регрессия Invalid URL)', async () => {
    // До фиксы '0.0.0.0:4401' падало с 'Block B error: Invalid URL' на new URL();
    // теперь сервер стартует, клиент не приходит => HARNESS_ERROR (exit 2) вместо 'Invalid URL'.
    const exit = await runBlockBCommand([
      'run', '--block', 'B', '--family', 'BS', '--scenario', 'S-BS-01',
      '--bind', '0.0.0.0:4401', '--skip-gate',
      '--first-request-timeout-ms', '100', '--observe-window-ms', '1',
    ]);
    expect(exit).toBe(2);
  });

  it('runBlockBCommand: --bind с мусорным значением => exit 2 с читаемой ошибкой', async () => {
    const exit = await runBlockBCommand([
      'run', '--block', 'B', '--family', 'BS', '--scenario', 'S-BS-01',
      '--bind', 'not a url at all', '--skip-gate',
    ]);
    expect(exit).toBe(2);
  });
});
