// Argus Block D — S11 OverBudget LIVE run against the AMW demo gateway.
//
// Policy probe: the permit cap is below the price. The gateway must refuse
// BEFORE the tool runs and before any charge — zero rail traffic, wallet
// untouched. Boundary probes pin the limit to be inclusive at exactly the
// price. A timeout must never turn a refusal into UNKNOWN (refusals here are
// synchronous, deterministic responses).
//
// Usage: node run-s11.mjs

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {
  GatewayClient, ProxyAdmin, RailClient, startSut,
  httpJson, Checks,
} from './driver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.resolve(HERE, '..');
const DEMO_ROOT = process.env.AMW_DEMO_ROOT ?? '/home/z/my-project/amw-demo';
const RUNNER = path.join(ADAPTER, 'sut', 'serve_gateway.py');
const SUT_PORT = Number(process.env.ADW_SUT_PORT ?? 8322);
const PRICE = '25.00';
const PRICE_CREDITS = 2500;
const OUT = [
  '/home/z/my-project/download/block-d-s11-verdict.json',
  path.join(ADAPTER, 'evidence', 'block-d-s11-verdict.json'),
];

const rail = new RailClient();
const proxy = new ProxyAdmin();
const c = new Checks();
const log = (m) => console.log(`  ${m}`);

const run = async () => {
  await rail.reset();
  await proxy.reset();
  fs.rmSync('/tmp/argus-s11-sut.db', { force: true });

  const sut = await startSut({ demoRoot: DEMO_ROOT, port: SUT_PORT, priceUsd: PRICE, db: '/tmp/argus-s11-sut.db', runnerPath: RUNNER });
  const gw = sut.gw;
  log(`SUT up on :${SUT_PORT} (price ${sut.info.price_credits} credits = $${PRICE})`);

  async function probe(agentId, budget) {
    const a = await gw.provisionAgent(agentId, budget);
    const p = await gw.permit({ issuer: a.walletId, subject: a.walletId, maxCredits: budget, idemKey: `argus-permit-${agentId}` });
    const before = await gw.wallet(a.walletId, a.apiKey);
    const r = await gw.toolsCall({ apiKey: a.apiKey, walletId: a.walletId, permitId: p.permit_id, idemKey: `argus-key-${agentId}`, args: { item: `S11 ${agentId} sticker pack` } });
    return { a, p, r, balanceBefore: before.balance };
  }

  // Probe 1: cap strictly below price -> refusal before tool runs.
  log('Probe 1: permit cap 1250 credits < price 2500');
  const p1 = await probe('s11-under', 1250);
  c.eq('P1: refused (JSON-RPC error -32001)', p1.r.json?.error?.code, -32001);
  c.add('P1: refusal reason is budget/permit denial', ['permit_budget_exceeded', 'insufficient_funds'].includes(p1.r.json?.error?.message), p1.r.json?.error?.message);
  const w1 = await gw.wallet(p1.a.walletId, p1.a.apiKey);
  c.eq('P1: wallet balance untouched', w1.balance, p1.balanceBefore);
  const l1 = await gw.ledger(p1.a.walletId, p1.a.apiKey);
  c.eq('P1: no charge entries', l1.entries.filter((e) => String(e.description).startsWith('charge:')).length, 0);

  // Probe 2: boundary just under the price -> still refused.
  log('Probe 2: boundary probe, permit cap 2499 < 2500');
  const p2 = await probe('s11-boundary-minus', 2499);
  c.eq('P2: refused at boundary-1', p2.r.json?.error?.code, -32001);

  // Probe 3: boundary exactly at the price -> allowed, capture completes.
  log('Probe 3: boundary probe, permit cap == price 2500 (inclusive)');
  const p3 = await probe('s11-boundary-eq', 2500);
  c.eq('P3: not refused at boundary', p3.r.json?.result?.isError ?? null, false);
  c.eq('P3: receipt outcome', p3.r.json?.result?.receipt?.outcome, 'success');

  const fin = (await rail.evidence()).evidence;
  c.eq('rail: orders created only by the allowed probe', fin.orders_created, 1);
  c.eq('rail: captures completed only by the allowed probe', fin.captures_completed, 1);
  c.eq('rail: zero capture attempts below the boundary', fin.capture_attempts, 1);
  const wl = await proxy.wireLog();
  c.eq('wire: no rail traffic before refusals (refusal is SUT-local)',
    wl.entries.filter((e) => e.kind === 'wire' && String(e.path).includes('/v2/checkout')).length, 2); // create+capture of probe 3 only

  const verdict = {
    scenario: 'S11 OverBudget',
    sut: 'agentmiddleware/amw-paypal-agent-demo (mini_gateway over TCP)',
    rail: 'Argus mock PayPal rail (mock-first loop)',
    price_usd: PRICE,
    checks: c.summary().checks,
    verdict: c.summary().verdict,
    rail_evidence: fin,
  };
  for (const p of OUT) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(verdict, null, 2));
  }
  const failed = c.summary().checks.filter((x) => !x.pass);
  log(`verdict: ${verdict.verdict} (${c.summary().checks.length - failed.length}/${c.summary().checks.length} checks)`);
  failed.forEach((f) => log(`FAILED ${f.name}: ${JSON.stringify(f.detail)}`));
  return verdict.verdict === 'PASS' ? 0 : 1;
};

try {
  process.exit(await run());
} catch (e) {
  console.error('RUN ERROR:', e?.stack ?? e);
  process.exit(2);
}
