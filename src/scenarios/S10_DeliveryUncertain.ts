import { ScenarioDefinition } from '../core/ScenarioDefinition';
import { Evidence } from '../core/Evidence';

/**
 * S10 — Block D: Delivery Uncertain (fiat lost response).
 *
 * Spec: docs/scenarios/b4-block-d.md. First rail: PayPal sandbox,
 * SUT: agentmiddleware/amw-paypal-agent-demo (mini_gateway).
 *
 * Agreed contract under test: settlement is not delivery. After a successful
 * rail capture whose response is lost on the wire, the SUT must mark the
 * operation delivery_uncertain, hold the signed receipt, and never resend.
 *
 * Execution boundary (same pattern as S9's actions: []):
 *   - actions[] is empty on purpose: the canonical driver is the Block D
 *     driver (outbound HTTP to the SUT gateway), not the in-process mock.
 *   - faults[] is empty on purpose: the fault (lost_response_after_capture)
 *     is armed on the external wire proxy (fault-proxy-1 admin API), not in
 *     the harness FaultInjector. Declaring it here would fake an execution
 *     path the mock does not have.
 *
 * Evidence vocabulary:
 *   source fault-proxy-1 (ARGUS observer on the sut->rail wire):
 *     'wire_dispatch'          { idempotencyKey, op: 'create' | 'capture', order_id? }
 *     'rail_capture_completed' { idempotencyKey, order_id, capture_id }
 *     'wire_response_dropped'  { idempotencyKey, upstream_status }
 *   source sut-1 (testSubject):
 *     'operation_status'       { idempotencyKey, state }
 *     'receipt_collected'      { idempotencyKey, receipt_id, outcome, signature_verified }
 *
 * Semantic boundary: rail truth comes ONLY through fault-proxy-1 (wire log /
 * rail API pulled by the proxy). SUT claims are evidence, not proof.
 * Timeout alone must not imply UNKNOWN (same rule as S4).
 */

const KEY = 'key-s10-delivery-uncertain';

function asRecord(data: unknown): Record<string, unknown> {
  return (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
}

export const S10_DeliveryUncertain: ScenarioDefinition = {
  id: 'S10',
  name: 'Delivery Uncertain (fiat lost response)',
  description:
    'Захват рельсы завершён, ответ потерян на проводе (фейл-прокси). Инварианты: ровно один capture, нет повторной отправки, операция помечена delivery_uncertain, подписанная квитанция проверяема. Rail-правда только через fault-proxy-1.',

  participants: [
    { participantId: 'client-1', protocolRole: 'CLIENT', ownership: 'ARGUS' },
    { participantId: 'sut-1', protocolRole: 'FACILITATOR', ownership: 'EXTERNAL' },
    { participantId: 'fault-proxy-1', ownership: 'ARGUS' }, // app-level: wire observer + fault injector
    { participantId: 'rail-1', ownership: 'EXTERNAL' }, // app-level: fiat rail (PayPal)
  ],

  topology: {
    edges: [
      { from: 'client-1', to: 'sut-1', kind: 'request' },
      { from: 'sut-1', to: 'fault-proxy-1', kind: 'forward' }, // observation source: declared
      { from: 'fault-proxy-1', to: 'rail-1', kind: 'forward' },
    ],
  },

  testSubject: 'sut-1',

  actions: [], // Block D driver executes; см. шапку файла

  faults: [], // fault armed on the external wire proxy; см. шапку файла

  invariants: [
    {
      id: 'exactly_one_rail_capture',
      description: 'Ровно один dispatch capture и ровно один завершённый capture на рельсе для ключа сценария.',
    },
    {
      id: 'no_redispatch_after_loss',
      description: 'После потери ответа SUT не повторяет dispatch capture (never resent) для того же ключа.',
    },
    {
      id: 'delivery_uncertain_marked',
      description: 'SUT явно помечает операцию delivery_uncertain (не по таймауту, а каноническим наблюдением).',
    },
    {
      id: 'receipt_verifiable',
      description: 'Подписанная квитанция собираема и верифицируема, outcome success.',
    },
  ],

  assertions: [
    {
      id: 'assert_exactly_one_capture',
      invariantId: 'exactly_one_rail_capture',
      kind: 'behavioral',
      referencedSources: ['sut-1', 'fault-proxy-1'],
      evaluate: (evidence: Evidence[]) => {
        const dispatches = evidence.filter(
          (e) => e.source === 'fault-proxy-1' && e.type === 'wire_dispatch' &&
                 asRecord(e.data).idempotencyKey === KEY && asRecord(e.data).op === 'capture'
        );
        const captures = evidence.filter(
          (e) => e.source === 'fault-proxy-1' && e.type === 'rail_capture_completed' &&
                 asRecord(e.data).idempotencyKey === KEY
        );
        if (dispatches.length === 0) {
          return { status: 'INCONCLUSIVE', reason: 'no capture dispatch observed on the wire; the run may not have reached the capture step' };
        }
        if (dispatches.length > 1 || captures.length > 1) {
          return { status: 'FAIL', reason: `expected 1 capture dispatch/completion, got ${dispatches.length} dispatch(es), ${captures.length} completion(s)` };
        }
        if (captures.length === 0) {
          return { status: 'INCONCLUSIVE', reason: 'capture dispatched but no rail completion proof (rail evidence missing)' };
        }
        return { status: 'PASS' };
      },
    },
    {
      id: 'assert_no_redispatch_after_loss',
      invariantId: 'no_redispatch_after_loss',
      kind: 'behavioral',
      referencedSources: ['sut-1', 'fault-proxy-1'],
      evaluate: (evidence: Evidence[]) => {
        const dropped = evidence.find(
          (e) => e.source === 'fault-proxy-1' && e.type === 'wire_response_dropped' &&
                 asRecord(e.data).idempotencyKey === KEY
        );
        if (!dropped) {
          return { status: 'INCONCLUSIVE', reason: 'no lost-response event observed for the key; fault may not have been armed' };
        }
        const redispatches = evidence.filter(
          (e) => e.source === 'fault-proxy-1' && e.type === 'wire_dispatch' &&
                 asRecord(e.data).idempotencyKey === KEY && asRecord(e.data).op === 'capture' &&
                 e.timestamp > dropped.timestamp
        );
        if (redispatches.length > 0) {
          return { status: 'FAIL', reason: `SUT re-dispatched capture ${redispatches.length} time(s) after the response was lost` };
        }
        return { status: 'PASS' };
      },
    },
    {
      id: 'assert_delivery_uncertain_marked',
      invariantId: 'delivery_uncertain_marked',
      kind: 'behavioral',
      referencedSources: ['sut-1'],
      evaluate: (evidence: Evidence[]) => {
        const statuses = evidence.filter(
          (e) => e.source === 'sut-1' && e.type === 'operation_status' &&
                 asRecord(e.data).idempotencyKey === KEY
        );
        if (statuses.length === 0) {
          return { status: 'INCONCLUSIVE', reason: 'no SUT operation status observed; absence of evidence is not a violation' };
        }
        const uncertain = statuses.find((e) => asRecord(e.data).state === 'delivery_uncertain');
        if (!uncertain) {
          const states = statuses.map((e) => String(asRecord(e.data).state)).join(', ');
          return { status: 'FAIL', reason: `SUT did not mark delivery_uncertain; observed states: ${states}` };
        }
        return { status: 'PASS' };
      },
    },
    {
      id: 'assert_receipt_verifiable',
      invariantId: 'receipt_verifiable',
      kind: 'behavioral',
      referencedSources: ['sut-1'],
      evaluate: (evidence: Evidence[]) => {
        const receipts = evidence.filter(
          (e) => e.source === 'sut-1' && e.type === 'receipt_collected' &&
                 asRecord(e.data).idempotencyKey === KEY
        );
        if (receipts.length === 0) {
          return { status: 'INCONCLUSIVE', reason: 'no receipt collected for the key' };
        }
        const ok = receipts.find(
          (e) => asRecord(e.data).signature_verified === true && asRecord(e.data).outcome === 'success'
        );
        if (!ok) {
          return { status: 'FAIL', reason: 'receipt collected but not signature-verified / outcome is not success' };
        }
        return { status: 'PASS' };
      },
    },
  ],

  seed: 100,
};
