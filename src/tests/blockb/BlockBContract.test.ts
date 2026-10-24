/**
 * Контрактные тесты блока B: роли, ID, директивы хуков, конфиг прогона,
 * фондирование (В3), канонический ресурс (В4), пример сценария S-BC-01.
 * Сетевых вызовов нет: faucet/баланс — заглушки.
 */

import { describe, it, expect } from 'vitest';
import {
  rolesForFamily,
  parseScenarioId,
  scenarioId,
  validateScenarioId,
} from '../../blockb/BlockBRoles';
import {
  PassthroughPaymentFaultInjector,
  resolveDirective,
} from '../../blockb/PaymentFaultInjector';
import {
  validateRunConfig,
  validateScenarioSpec,
} from '../../blockb/BlockBScenario';
import {
  AutoFundingProvider,
  ManualFundingProvider,
  ManualTopUpRequiredError,
  type BalanceSource,
  type FaucetClient,
} from '../../blockb/FundingProvider';
import {
  canonicalResourceBody,
  fingerprintRequest,
} from '../../blockb/CanonicalResource';
import { S_BC_01_BadSignature, corruptPaymentPayload } from '../../blockb/examples/S_BC_01_BadSignature';
import type { SigningBinding } from '../../adapters/payment/SigningBinding';
import type { X402PaymentRequiredBody } from '../../core/AgentTargetPort';

const ADDR_A = '0x1111111111111111111111111111111111111111' as const;
const ADDR_B = '0x2222222222222222222222222222222222222222' as const;

const baseReqs: X402PaymentRequiredBody = {
  x402Version: 2,
  resource: { url: 'https://sut.example/resource', description: 'test' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '10000',
      asset: ADDR_A,
      payTo: ADDR_B,
      maxTimeoutSeconds: 60,
    },
  ],
};

const baseBinding: SigningBinding = {
  from: ADDR_A,
  to: ADDR_B,
  value: '10000',
  nonce: `0x${'a'.repeat(64)}`,
  validAfter: '1700000000',
  validBefore: '1700000060',
  network: 'eip155:84532',
  asset: ADDR_A,
  scheme: 'exact',
  maxTimeoutSeconds: 60,
};

describe('BlockB roles and scenario ids', () => {
  it('BC: СУТ = сервер, Аргус = плохой клиент', () => {
    const r = rolesForFamily('BC');
    expect(r.sut).toBe('server');
    expect(r.argus).toBe('client');
  });

  it('BS: СУТ = клиент, Аргус = плохой сервер', () => {
    const r = rolesForFamily('BS');
    expect(r.sut).toBe('client');
    expect(r.argus).toBe('server');
  });

  it('round-trip ID: S-BC-01 / S-BS-13', () => {
    expect(scenarioId('BC', 1)).toBe('S-BC-01');
    expect(scenarioId('BS', 13)).toBe('S-BS-13');
    expect(parseScenarioId('S-BC-01')).toEqual({ family: 'BC', number: 1 });
    expect(parseScenarioId('S-BS-13')).toEqual({ family: 'BS', number: 13 });
  });

  it('устаревшая маркировка S-B-BC-NN отклоняется (буква B исключена)', () => {
    expect(parseScenarioId('S-B-BC-01')).toBeNull();
    expect(() => validateScenarioId('S-B-BC-01')).toThrow(/S-BC-NN/);
    expect(parseScenarioId('S-BB-01')).toBeNull();
    expect(parseScenarioId('s-bc-01')).toBeNull();
    expect(parseScenarioId('S-BC-00')).toBeNull();
  });
});

describe('BlockB run config (инвариант одной роли СУТ)', () => {
  // Негативные конфиги приходят на стенде из нетипизированной границы
  // (CLI-флаги/JSON), поэтому приводим их к типу вручную: дискриминированный
  // union ловит несоответствие на этапе компиляции, validateRunConfig — на этапе прогона.
  const fromCli = (raw: unknown) => raw as Parameters<typeof validateRunConfig>[0];

  it('BC требует sutRole=server и resourceUrl', () => {
    expect(() =>
      validateRunConfig({
        family: 'BC',
        sutRole: 'server',
        resourceUrl: 'https://sut.example/resource',
        label: 'sut-as-server',
      })
    ).not.toThrow();

    expect(() =>
      validateRunConfig(
        fromCli({
          family: 'BC',
          sutRole: 'client',
          resourceUrl: 'https://sut.example/resource',
          label: 'x',
        })
      )
    ).toThrow(/requires SUT role 'server'/);

    expect(() =>
      validateRunConfig({ family: 'BC', sutRole: 'server', resourceUrl: '', label: 'x' })
    ).toThrow(/resourceUrl/);
  });

  it('BS требует sutRole=client и argusServerUrl', () => {
    expect(() =>
      validateRunConfig({
        family: 'BS',
        sutRole: 'client',
        argusServerUrl: 'http://127.0.0.1:3461',
        label: 'sut-as-client',
      })
    ).not.toThrow();

    expect(() =>
      validateRunConfig(
        fromCli({
          family: 'BS',
          sutRole: 'server',
          argusServerUrl: 'http://127.0.0.1:3461',
          label: 'x',
        })
      )
    ).toThrow(/requires SUT role 'client'/);
  });
});

describe('PaymentFaultInjector contract', () => {
  const ctx = { scenarioId: 'S-BC-01', family: 'BC' as const, attempt: 1, atMs: 0 };

  it('passthrough-инжектор не мутирует и копит факты', async () => {
    const inj = new PassthroughPaymentFaultInjector('S-BC-01', 'BC');
    const d1 = await inj.onRequirements(baseReqs, ctx);
    expect(d1.action).toBe('passthrough');

    const d2 = await inj.onSign(baseBinding, ctx);
    expect(d2.action).toBe('passthrough');

    const facts = inj.getFacts();
    expect(facts.map((f) => f.kind)).toEqual([
      'requirements_observed',
      'sign_performed',
    ]);
    expect(facts[0].details).toMatchObject({ accepts: 1, version: 2 });
  });

  it('resolveDirective: mutate заменяет значение', () => {
    const r = resolveDirective(baseBinding, { action: 'mutate', value: { ...baseBinding, value: '1' } });
    expect(r.value).toMatchObject({ value: '1' });
    expect(r.times).toBe(1);
  });

  it('resolveDirective: drop => null, times 0', () => {
    const r = resolveDirective('payload', { action: 'drop' });
    expect(r.value).toBeNull();
    expect(r.times).toBe(0);
  });

  it('resolveDirective: duplicate => times >= 2', () => {
    const r = resolveDirective('payload', { action: 'duplicate', times: 3 });
    expect(r.times).toBe(3);
    expect(r.value).toBe('payload');
  });

  it('resolveDirective: цепочка delay суммируется и применяет вложенную директиву', () => {
    const r = resolveDirective('x', {
      action: 'delay',
      delayMs: 100,
      note: 'первая',
      inner: {
        action: 'delay',
        delayMs: 50,
        inner: { action: 'mutate', value: 'y', note: 'вторая' },
      },
    });
    expect(r.delayMs).toBe(150);
    expect(r.value).toBe('y');
    expect(r.notes).toEqual(['первая', 'вторая']);
  });

  it('resolveDirective: delay-цепочка глубже 8 запрещена', () => {
    const deep = (n: number): unknown =>
      n === 0
        ? { action: 'delay', delayMs: 1, inner: { action: 'passthrough' } }
        : { action: 'delay', delayMs: 1, inner: deep(n - 1) };
    expect(() => resolveDirective('x', deep(10) as never)).toThrow(/too deep/);
  });
});

describe('Scenario spec validation', () => {
  it('пример S-BC-01 валиден', () => {
    expect(() => validateScenarioSpec(S_BC_01_BadSignature)).not.toThrow();
    expect(S_BC_01_BadSignature.id).toBe('S-BC-01');
    expect(S_BC_01_BadSignature.family).toBe('BC');
    expect(S_BC_01_BadSignature.wave).toBe(1);
  });

  it('несоответствие family и префикса id отклоняется', () => {
    const broken = { ...S_BC_01_BadSignature, family: 'BS' as const };
    expect(() => validateScenarioSpec(broken)).toThrow(/does not match/);
  });

  it('инжектор примера мутирует payload, но не requirements', async () => {
    const inj = S_BC_01_BadSignature.createInjector();
    const ctx = { scenarioId: 'S-BC-01', family: 'BC' as const, attempt: 1, atMs: 0 };

    const reqs = await inj.onRequirements(baseReqs, ctx);
    expect(reqs.action).toBe('passthrough');

    const payload = Buffer.from(JSON.stringify({ accepted: { signature: 'a'.repeat(130) } }))
      .toString('base64');
    const mutated = await inj.onPayload(payload, ctx);
    expect(mutated.action).toBe('mutate');
    if (mutated.action === 'mutate') {
      expect(mutated.value).not.toBe(payload);
      const decoded = JSON.parse(Buffer.from(mutated.value, 'base64').toString('utf-8')) as {
        accepted?: { signature?: string };
      };
      expect(decoded.accepted?.signature?.startsWith('ffff')).toBe(true);
    }

    expect(inj.getFacts().some((f) => f.kind === 'payload_mutated')).toBe(false);
    expect(inj.getFacts().some((f) => f.kind === 'requirements_observed')).toBe(true);
  });

  it('corruptPaymentPayload переживает не-JSON вход', () => {
    const out = corruptPaymentPayload('%%%not-base64%%%');
    expect(typeof out).toBe('string');
    expect(out).not.toBe('%%%not-base64%%%');
  });
});

describe('Canonical resource (В4: минимальное универсальное тело)', () => {
  const fp = { url: 'https://sut.example/resource', method: 'POST', body: { q: 1 } };

  it('детерминизм: одинаковый вход => одинаковое тело', () => {
    const a = canonicalResourceBody('S-BC-01', 1, fp);
    const b = canonicalResourceBody('S-BC-01', 1, fp);
    expect(a).toEqual(b);
    expect(a.echo).toMatch(/^[0-9a-f]{64}$/);
  });

  it('attempt меняет метаданные тела; echo меняется только от отпечатка запроса', () => {
    const a = canonicalResourceBody('S-BC-01', 1, fp);
    const b = canonicalResourceBody('S-BC-01', 2, fp);
    const c = canonicalResourceBody('S-BC-01', 1, { ...fp, method: 'GET' });
    // echo — отпечаток ЗАПРОСА: не зависит от сценария/попытки
    expect(a.echo).toBe(b.echo);
    expect(a.echo).not.toBe(c.echo);
    // тело различается полем attempt (сравнимость повторов)
    expect(a.attempt).toBe(1);
    expect(b.attempt).toBe(2);
    expect(a).toMatchObject({ v: 1, service: 'argus-block-b', scenario: 'S-BC-01' });
  });

  it('fingerprintRequest стабилен и чувствителен к телу', () => {
    expect(fingerprintRequest(fp)).toBe(fingerprintRequest(fp));
    expect(fingerprintRequest(fp)).not.toBe(fingerprintRequest({ ...fp, body: { q: 2 } }));
    expect(fingerprintRequest({ url: 'u', method: 'GET' })).toBe(
      fingerprintRequest({ url: 'u', method: 'GET' })
    );
  });
});

describe('Funding (В3: авто через faucet, ручной fallback)', () => {
  const wallet = ADDR_A;
  const required = 10_000n;

  function makeBalance(seq: bigint[]): BalanceSource & { calls: number } {
    let i = 0;
    return {
      calls: 0,
      async getBalance() {
        this.calls += 1;
        const value = seq[Math.min(i, seq.length - 1)];
        i += 1;
        return value;
      },
    };
  }

  function makeFaucet(ok: boolean): FaucetClient & { calls: number } {
    return {
      calls: 0,
      name: 'test-faucet',
      async drip() {
        this.calls += 1;
        return ok ? { ok: true, txHash: '0x' + 'f'.repeat(64) } : { ok: false, error: 'rate limited' };
      },
    };
  }

  it('баланс достаточен: faucet не вызывается', async () => {
    const bal = makeBalance([required]);
    const faucet = makeFaucet(true);
    const report = await new AutoFundingProvider(bal, faucet).ensureFunded(wallet, required);
    expect(report.source).toBe('already_funded');
    expect(faucet.calls).toBe(0);
  });

  it('баланс мал + faucet ок: доливает недостающее', async () => {
    const bal = makeBalance([2_000n, required]);
    const faucet = makeFaucet(true);
    const report = await new AutoFundingProvider(bal, faucet).ensureFunded(wallet, required);
    expect(report.source).toBe('faucet');
    expect(faucet.calls).toBe(1);
    expect(report.balanceAfter).toBe(required);
  });

  it('баланс мал + faucet отказал: ManualTopUpRequiredError с инструкцией', async () => {
    const bal = makeBalance([2_000n]);
    const faucet = makeFaucet(false);
    const promise = new AutoFundingProvider(bal, faucet).ensureFunded(wallet, required);
    await expect(promise).rejects.toBeInstanceOf(ManualTopUpRequiredError);
    try {
      await promise;
    } catch (error) {
      const err = error as ManualTopUpRequiredError;
      expect(err.message).toContain(wallet);
      expect(err.message).toContain('ручное пополнение');
    }
  });

  it('ручной режим: faucet не используется вовсе', async () => {
    const bal = makeBalance([1n]);
    const faucet = makeFaucet(true);
    await expect(
      new ManualFundingProvider(bal).ensureFunded(wallet, required)
    ).rejects.toBeInstanceOf(ManualTopUpRequiredError);
    expect(faucet.calls).toBe(0);
  });
});
