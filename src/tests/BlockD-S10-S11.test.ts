/**
 * Block D replay tests — S10 DeliveryUncertain / S11 OverBudget.
 *
 * These tests prove the assertion/verdict logic of the Block D scenarios
 * against replayed canonical evidence (no live SUT, no rail, no proxy).
 * The evidence shapes mirror the vocabulary documented in the scenario
 * files and docs/scenarios/b4-block-d.md.
 *
 * Aggregation mirrors the engine semantics: any FAIL -> FAIL, else any
 * INCONCLUSIVE -> INCONCLUSIVE, else PASS.
 */
import { describe, expect, it } from 'vitest';
import { Evidence } from '../core/Evidence';
import { validateScenario } from '../core/validateScenario';
import { S10_DeliveryUncertain } from '../scenarios/S10_DeliveryUncertain';
import { S11_OverBudget } from '../scenarios/S11_OverBudget';

let clock = 0;
function obs(source: string, type: string, data: Record<string, unknown>): Evidence {
  clock += 1;
  return { source, type, data, timestamp: clock };
}

type Verdict = { status: 'PASS' | 'FAIL' | 'INCONCLUSIVE'; reason?: string };

function aggregate(assertions: { evaluate: (e: Evidence[]) => Verdict }[], evidence: Evidence[]): Verdict {
  const results = assertions.map((a) => a.evaluate(evidence));
  if (results.some((r) => r.status === 'FAIL')) {
    const fail = results.find((r) => r.status === 'FAIL')!;
    return { status: 'FAIL', reason: fail.reason };
  }
  if (results.some((r) => r.status === 'INCONCLUSIVE')) {
    const inc = results.find((r) => r.status === 'INCONCLUSIVE')!;
    return { status: 'INCONCLUSIVE', reason: inc.reason };
  }
  return { status: 'PASS' };
}

const KEY10 = 'key-s10-delivery-uncertain';

function s10HappyPath(): Evidence[] {
  return [
    obs('fault-proxy-1', 'wire_dispatch', { idempotencyKey: KEY10, op: 'create', order_id: 'ORD1' }),
    obs('fault-proxy-1', 'wire_dispatch', { idempotencyKey: KEY10, op: 'capture', order_id: 'ORD1' }),
    obs('fault-proxy-1', 'rail_capture_completed', { idempotencyKey: KEY10, order_id: 'ORD1', capture_id: 'CAP1' }),
    obs('fault-proxy-1', 'wire_response_dropped', { idempotencyKey: KEY10, upstream_status: 201 }),
    obs('sut-1', 'operation_status', { idempotencyKey: KEY10, state: 'delivery_uncertain' }),
    obs('sut-1', 'receipt_collected', { idempotencyKey: KEY10, receipt_id: 'R1', outcome: 'success', signature_verified: true }),
  ];
}

describe('S10 — DeliveryUncertain (Block D)', () => {
  it('passes Rule 1 source validation', () => {
    const result = validateScenario(S10_DeliveryUncertain);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('happy lost-response path: all assertions PASS', () => {
    expect(aggregate(S10_DeliveryUncertain.assertions, s10HappyPath()).status).toBe('PASS');
  });

  it('duplicate capture after loss: FAIL (never-resend violated)', () => {
    const evidence = [
      ...s10HappyPath(),
      obs('fault-proxy-1', 'wire_dispatch', { idempotencyKey: KEY10, op: 'capture', order_id: 'ORD1' }),
    ];
    expect(aggregate(S10_DeliveryUncertain.assertions, evidence).status).toBe('FAIL');
  });

  it('two rail captures: FAIL (exactly-one violated)', () => {
    const evidence = [
      ...s10HappyPath(),
      obs('fault-proxy-1', 'rail_capture_completed', { idempotencyKey: KEY10, order_id: 'ORD1', capture_id: 'CAP2' }),
    ];
    expect(aggregate(S10_DeliveryUncertain.assertions, evidence).status).toBe('FAIL');
  });

  it('SUT marked captured instead of delivery_uncertain: FAIL', () => {
    const evidence = s10HappyPath().map((e) =>
      e.source === 'sut-1' && e.type === 'operation_status'
        ? obs('sut-1', 'operation_status', { idempotencyKey: KEY10, state: 'captured' })
        : e
    );
    expect(aggregate(S10_DeliveryUncertain.assertions, evidence).status).toBe('FAIL');
  });

  it('SUT silent (no status/receipt): INCONCLUSIVE, not FAIL', () => {
    const evidence = s10HappyPath().filter((e) => e.source !== 'sut-1');
    expect(aggregate(S10_DeliveryUncertain.assertions, evidence).status).toBe('INCONCLUSIVE');
  });

  it('fault not armed (no drop event): INCONCLUSIVE on no-redispatch', () => {
    const evidence = s10HappyPath().filter((e) => e.type !== 'wire_response_dropped');
    const verdicts = S10_DeliveryUncertain.assertions.map((a) => a.evaluate(evidence));
    const noRedispatch = verdicts.find((v, i) => S10_DeliveryUncertain.assertions[i].id === 'assert_no_redispatch_after_loss');
    expect(noRedispatch?.status).toBe('INCONCLUSIVE');
  });
});

const KEY_OVER = 'key-s11-over-budget';
const KEY_OK = 'key-s11-in-budget';

function s11HappyPath(): Evidence[] {
  return [
    obs('sut-1', 'call_denied', { idempotencyKey: KEY_OVER, reason: 'permit cap 12.50 USD below price 25.00 USD' }),
    obs('sut-1', 'wallet_ledger_observed', { wallet_id: 'w-1', entries: [{ idempotencyKey: KEY_OK, kind: 'debit', credits: 2500 }] }),
    obs('fault-proxy-1', 'wire_dispatch', { idempotencyKey: KEY_OK, op: 'create', order_id: 'ORD2' }),
    obs('fault-proxy-1', 'wire_dispatch', { idempotencyKey: KEY_OK, op: 'capture', order_id: 'ORD2' }),
    obs('fault-proxy-1', 'rail_capture_completed', { idempotencyKey: KEY_OK, order_id: 'ORD2', capture_id: 'CAP3' }),
    obs('sut-1', 'receipt_collected', { idempotencyKey: KEY_OK, receipt_id: 'R2', outcome: 'success', signature_verified: true }),
  ];
}

describe('S11 — OverBudget (Block D)', () => {
  it('passes Rule 1 source validation', () => {
    const result = validateScenario(S11_OverBudget);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('denial path with zero rail traffic: all assertions PASS', () => {
    expect(aggregate(S11_OverBudget.assertions, s11HappyPath()).status).toBe('PASS');
  });

  it('over-budget call reached the rail: FAIL', () => {
    const evidence = [
      ...s11HappyPath(),
      obs('fault-proxy-1', 'wire_dispatch', { idempotencyKey: KEY_OVER, op: 'create', order_id: 'ORD3' }),
    ];
    expect(aggregate(S11_OverBudget.assertions, evidence).status).toBe('FAIL');
  });

  it('wallet debited despite denial: FAIL', () => {
    const evidence = s11HappyPath().map((e) =>
      e.source === 'sut-1' && e.type === 'wallet_ledger_observed'
        ? obs('sut-1', 'wallet_ledger_observed', {
            wallet_id: 'w-1',
            entries: [
              { idempotencyKey: KEY_OK, kind: 'debit', credits: 2500 },
              { idempotencyKey: KEY_OVER, kind: 'debit', credits: 1250 },
            ],
          })
        : e
    );
    expect(aggregate(S11_OverBudget.assertions, evidence).status).toBe('FAIL');
  });

  it('over-budget call produced a receipt instead of denial: FAIL', () => {
    const evidence = s11HappyPath().map((e) =>
      e.source === 'sut-1' && e.type === 'call_denied'
        ? obs('sut-1', 'receipt_collected', { idempotencyKey: KEY_OVER, receipt_id: 'R9', outcome: 'success', signature_verified: true })
        : e
    );
    expect(aggregate(S11_OverBudget.assertions, evidence).status).toBe('FAIL');
  });

  it('empty wire log (channel not proven live): INCONCLUSIVE on no-dispatch, not PASS', () => {
    const evidence = s11HappyPath().filter(
      (e) => !(e.source === 'fault-proxy-1')
    );
    const verdicts = S11_OverBudget.assertions.map((a) => a.evaluate(evidence));
    const noDispatch = verdicts.find((v, i) => S11_OverBudget.assertions[i].id === 'assert_no_rail_dispatch_over_budget');
    expect(noDispatch?.status).toBe('INCONCLUSIVE');
  });

  it('neighbor never ran: INCONCLUSIVE, not PASS', () => {
    const evidence = [
      obs('sut-1', 'call_denied', { idempotencyKey: KEY_OVER, reason: 'permit cap below price' }),
    ];
    expect(aggregate(S11_OverBudget.assertions, evidence).status).toBe('INCONCLUSIVE');
  });
});

describe('ScenarioRegistry — Block D registration', () => {
  it('S10 and S11 are registered', async () => {
    const { ScenarioRegistry, getScenario } = await import('../cli/ScenarioRegistry');
    expect(ScenarioRegistry.has('S10')).toBe(true);
    expect(ScenarioRegistry.has('S11')).toBe(true);
    expect(getScenario('S10')?.testSubject).toBe('sut-1');
    expect(getScenario('S11')?.testSubject).toBe('sut-1');
  });
});
