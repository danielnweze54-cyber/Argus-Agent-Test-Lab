import { ScenarioDefinition } from '../core/ScenarioDefinition';
import { Evidence } from '../core/Evidence';

/**
 * S11 — Block D: Over Budget (fiat policy probe).
 *
 * Spec: docs/scenarios/b4-block-d.md. First rail: PayPal sandbox,
 * SUT: agentmiddleware/amw-paypal-agent-demo (mini_gateway).
 *
 * Contract under test: a governed call whose price exceeds the permit cap /
 * wallet budget must be refused BEFORE any wallet debit and BEFORE any
 * dispatch to the rail (PayPal is never called), while the in-budget
 * neighbor call completes normally.
 *
 * R3-D3 guard: passive absence must not produce PASS. The no-dispatch and
 * no-debit assertions therefore require positive proof that the observation
 * channel was live during the run (neighbor dispatch/ledger evidence).
 *
 * Execution boundary: actions[] / faults[] empty on purpose — Block D driver
 * executes (outbound HTTP); no harness fault is used (policy probe).
 *
 * Evidence vocabulary:
 *   source sut-1 (testSubject):
 *     'call_denied'            { idempotencyKey, reason }
 *     'wallet_ledger_observed' { wallet_id, entries: [{ idempotencyKey?, kind, credits }] }
 *     'receipt_collected'      { idempotencyKey, receipt_id, outcome, signature_verified }
 *   source fault-proxy-1 (ARGUS observer on the sut->rail wire):
 *     'wire_dispatch'          { idempotencyKey, op: 'create' | 'capture', order_id? }
 *     'rail_capture_completed' { idempotencyKey, order_id, capture_id }
 *
 * Semantic boundary: refusal must not be converted into UNKNOWN/timeout
 * evidence; a denial is a positive SUT observation with a reason.
 */

const KEY_OVER = 'key-s11-over-budget';
const KEY_OK = 'key-s11-in-budget';

function asRecord(data: unknown): Record<string, unknown> {
  return (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
}

export const S11_OverBudget: ScenarioDefinition = {
  id: 'S11',
  name: 'Over Budget (fiat policy probe)',
  description:
    'Вызов сверх лимита permit/кошелька отклоняется до дебета и до любого обращения к рельсе; соседний вызов в пределах лимита проходит штатно. R3-D3: пассивное отсутствие не даёт PASS — требуется живое доказательство канала наблюдения.',

  participants: [
    { participantId: 'client-1', protocolRole: 'CLIENT', ownership: 'ARGUS' },
    { participantId: 'sut-1', protocolRole: 'FACILITATOR', ownership: 'EXTERNAL' },
    { participantId: 'fault-proxy-1', ownership: 'ARGUS' },
    { participantId: 'rail-1', ownership: 'EXTERNAL' },
  ],

  topology: {
    edges: [
      { from: 'client-1', to: 'sut-1', kind: 'request' },
      { from: 'sut-1', to: 'fault-proxy-1', kind: 'forward' },
      { from: 'fault-proxy-1', to: 'rail-1', kind: 'forward' },
    ],
  },

  testSubject: 'sut-1',

  actions: [], // Block D driver executes; см. шапку файла

  faults: [], // policy probe; активных фейлов нет

  invariants: [
    {
      id: 'over_budget_refused',
      description: 'Вызов сверх лимита получает явный отказ с причиной (budget/permit cap).',
    },
    {
      id: 'no_rail_dispatch_over_budget',
      description: 'Для отклонённого ключа нет ни одного dispatch к рельсе (PayPal не вызывается).',
    },
    {
      id: 'no_debit_on_denial',
      description: 'Для отклонённого ключа нет дебета кошелька.',
    },
    {
      id: 'in_budget_neighbor_captures',
      description: 'Соседний вызов в пределах лимита завершается одним capture и подписанной квитанцией.',
    },
  ],

  assertions: [
    {
      id: 'assert_over_budget_refused',
      invariantId: 'over_budget_refused',
      kind: 'behavioral',
      referencedSources: ['sut-1'],
      evaluate: (evidence: Evidence[]) => {
        const denied = evidence.find(
          (e) => e.source === 'sut-1' && e.type === 'call_denied' &&
                 asRecord(e.data).idempotencyKey === KEY_OVER
        );
        if (denied) {
          const reason = String(asRecord(denied.data).reason ?? 'unspecified');
          return { status: 'PASS', reason: `denied: ${reason}` };
        }
        const receiptInstead = evidence.find(
          (e) => e.source === 'sut-1' && e.type === 'receipt_collected' &&
                 asRecord(e.data).idempotencyKey === KEY_OVER
        );
        if (receiptInstead) {
          return { status: 'FAIL', reason: 'over-budget call produced a receipt instead of a denial' };
        }
        return { status: 'INCONCLUSIVE', reason: 'no denial observation and no receipt for the over-budget key; the call may not have run' };
      },
    },
    {
      id: 'assert_no_rail_dispatch_over_budget',
      invariantId: 'no_rail_dispatch_over_budget',
      kind: 'behavioral',
      referencedSources: ['sut-1', 'fault-proxy-1'],
      evaluate: (evidence: Evidence[]) => {
        // R3-D3 guard: wire log must be proven live by the neighbor traffic.
        const neighborDispatch = evidence.find(
          (e) => e.source === 'fault-proxy-1' && e.type === 'wire_dispatch' &&
                 asRecord(e.data).idempotencyKey === KEY_OK
        );
        if (!neighborDispatch) {
          return { status: 'INCONCLUSIVE', reason: 'wire log shows no neighbor dispatch; the channel cannot be proven live for this run' };
        }
        const overDispatches = evidence.filter(
          (e) => e.source === 'fault-proxy-1' && e.type === 'wire_dispatch' &&
                 asRecord(e.data).idempotencyKey === KEY_OVER
        );
        if (overDispatches.length > 0) {
          return { status: 'FAIL', reason: `over-budget call reached the rail: ${overDispatches.length} dispatch(es) observed` };
        }
        return { status: 'PASS' };
      },
    },
    {
      id: 'assert_no_debit_on_denial',
      invariantId: 'no_debit_on_denial',
      kind: 'behavioral',
      referencedSources: ['sut-1'],
      evaluate: (evidence: Evidence[]) => {
        const ledger = evidence.find(
          (e) => e.source === 'sut-1' && e.type === 'wallet_ledger_observed'
        );
        if (!ledger) {
          return { status: 'INCONCLUSIVE', reason: 'wallet ledger snapshot not collected' };
        }
        const raw = asRecord(ledger.data).entries;
        const entries = Array.isArray(raw) ? raw.map(asRecord) : [];
        const debits = entries.filter(
          (entry) => entry.idempotencyKey === KEY_OVER ||
                     (entry.kind === 'debit' && entry.idempotencyKey === undefined &&
                      String(entry.description ?? '').includes(KEY_OVER))
        );
        if (debits.length > 0) {
          return { status: 'FAIL', reason: `wallet debited for the denied call: ${debits.length} debit entry(ies)` };
        }
        return { status: 'PASS' };
      },
    },
    {
      id: 'assert_in_budget_neighbor_captures',
      invariantId: 'in_budget_neighbor_captures',
      kind: 'behavioral',
      referencedSources: ['sut-1', 'fault-proxy-1'],
      evaluate: (evidence: Evidence[]) => {
        const capture = evidence.find(
          (e) => e.source === 'fault-proxy-1' && e.type === 'rail_capture_completed' &&
                 asRecord(e.data).idempotencyKey === KEY_OK
        );
        const receipt = evidence.find(
          (e) => e.source === 'sut-1' && e.type === 'receipt_collected' &&
                 asRecord(e.data).idempotencyKey === KEY_OK &&
                 asRecord(e.data).signature_verified === true &&
                 asRecord(e.data).outcome === 'success'
        );
        if (!capture && !receipt) {
          return { status: 'INCONCLUSIVE', reason: 'no neighbor completion evidence; the in-budget call may not have run' };
        }
        if (capture && receipt) {
          return { status: 'PASS' };
        }
        return { status: 'FAIL', reason: `in-budget call incomplete: capture=${capture ? 'yes' : 'no'}, verified receipt=${receipt ? 'yes' : 'no'}` };
      },
    },
  ],

  seed: 101,
};
