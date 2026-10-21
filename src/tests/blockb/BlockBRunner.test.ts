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
import { createBcRunner, type PaymentSigner } from '../../blockb/runners/BcRunner';
import { BsRunner } from '../../blockb/runners/BsRunner';
import { worstVerdict } from '../../blockb/runners/BlockBRunnerTypes';
import { parseBlockBArgs, runBlockBCommand } from '../../cli/blockBCommand';
import type { SigningBinding } from '../../adapters/payment/SigningBinding';
import type { BlockBScenarioSpec } from '../../blockb/BlockBScenario';

const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAY_TO = '0x9999999999999999999999999999999999999999';

/* ------------------------------ Реестр ------------------------------ */

describe('Block B wave-1 registry', () => {
  it('валиден, содержит 10 сценариев волны 1', () => {
    expect(() => validateBlockBRegistry()).not.toThrow();
    const ids = listBlockBScenarios().map((s) => s.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect(ids).toEqual(
      expect.arrayContaining([
        'S-BC-01', 'S-BC-02', 'S-BC-04', 'S-BC-05', 'S-BC-09',
        'S-BS-01', 'S-BS-02', 'S-BS-03', 'S-BS-06', 'S-BS-11',
      ])
    );
  });

  it('поиск по ID и семействам', () => {
    expect(getBlockBScenario('S-BC-01')?.slug).toBe('bad-signature');
    expect(getBlockBScenario('S-BS-11')?.family).toBe('BS');
    expect(getBlockBScenario('S-BC-14')).toBeUndefined(); // волна 2 не зарегистрирована
  });
});

/* ------------------------- Mock СУТ (для BC) ------------------------- */

type PaidBehavior = 'accept' | 'reject' | 'crash';

interface MockSut {
  url: string;
  payloads: string[];
  stop: () => Promise<void>;
}

/** Mock ресурсного сервера СУТ: 402 на первый запрос, поведение на платёж — конфиг. */
async function startMockSut(behavior: PaidBehavior): Promise<MockSut> {
  const payloads: string[] = [];
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
            scheme: 'exact', network: 'eip155:84532', amount: '10000',
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
      if (behavior === 'accept') {
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
  const runner = createBcRunner({
    runConfig: { family: 'BC', sutRole: 'server', resourceUrl: url, label: 'test' },
    scenario: spec,
    signer: stubSigner,
    requestTimeoutMs: 3000,
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

type ClientBehavior = 'pay-once' | 'pay-twice' | 'pay-oversize' | 'refuse-oversize';

/** Фейковый СУТ-клиент: 402 → платёж → реакция на ответ сервера. */
async function fakeSutClient(url: string, behavior: ClientBehavior, nonceSeed: number): Promise<void> {
  const first = await fetch(url, { method: 'GET' });
  expect(first.status).toBe(402);
  const prHeader = first.headers.get('payment-required');
  expect(prHeader).toBeTruthy();
  const reqs = JSON.parse(Buffer.from(prHeader!, 'base64').toString('utf-8')) as {
    resource: { description?: string };
    accepts: { amount: string }[];
  };

  if (behavior === 'refuse-oversize') {
    // Оверсайз-требования против реальной цены из description — отказ.
    expect(reqs.resource.description).toContain('real price');
    return;
  }

  const amount = reqs.accepts[0].amount;
  let nonceCounter = nonceSeed;
  const payOnce = async (): Promise<{ status: number; error?: string }> => {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'payment-signature': paymentEnvelope(`0x${'77'.repeat(31)}${String(nonceCounter).padStart(2, '0')}`, amount) },
    });
    nonceCounter += 1;
    const text = await res.text();
    const error = (() => {
      try { return (JSON.parse(text) as { error?: string }).error; } catch { return undefined; }
    })();
    return { status: res.status, error };
  };

  const firstPayment = await payOnce();
  if (behavior === 'pay-once') return;
  if (behavior === 'pay-oversize') return;
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
