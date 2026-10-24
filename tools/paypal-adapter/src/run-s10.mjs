// Argus Block D — S10 DeliveryUncertain LIVE run against the AMW demo gateway.
//
//   SUT (uvicorn TCP shim :8321) -> fault proxy :8888 -> mock rail :8891
//
// Three phases, one rail reset, zero PayPal keys:
//   A. lost capture response x2 -> SUT recovers via its own idempotent retry
//      (same PayPal-Request-Id replays the rail's original capture response).
//      Rail truth: exactly 1 capture. No double charge.
//   B. lost capture x2 AND lost reconciliation GET -> the SUT refunds the
//      wallet (tool_error) while the rail HAS captured. Money-state
//      divergence is recorded as a Block D finding.
//   C. lost capture x2 AND reconciliation GET stalled -> driver aborts the
//      MCP call mid-flight -> the SUT must keep the charge, sign a
//      delivery_uncertain receipt, and replay it on retry with the same
//      idempotency key. Receipt verified through the SUT's own verify route.
//
// Usage: node run-s10.mjs   (env: AMW_DEMO_ROOT, ADAPTER_* ports)

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {
  GatewayClient, ProxyAdmin, RailClient, startSut, sleep,
  httpJson, abortableJson, Checks,
} from './driver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.resolve(HERE, '..');
const DEMO_ROOT = process.env.AMW_DEMO_ROOT ?? '/home/z/my-project/amw-demo';
const RUNNER = path.join(ADAPTER, 'sut', 'serve_gateway.py');
const SUT_PORT = Number(process.env.ADW_SUT_PORT ?? 8321);
const PRICE = '25.00';
const PRICE_CREDITS = 2500;
const OUT = [
  '/home/z/my-project/download/block-d-s10-verdict.json',
  path.join(ADAPTER, 'evidence', 'block-d-s10-verdict.json'),
];

const rail = new RailClient();
const proxy = new ProxyAdmin();
const c = new Checks();
const log = (m) => console.log(`  ${m}`);

function countLedger(ledger, prefix) {
  return ledger.entries.filter((e) => String(e.description).startsWith(prefix)).length;
}

async function pollRail(fn, deadlineMs = 15_000, everyMs = 100) {
  const t0 = Date.now();
  for (;;) {
    const ev = await rail.evidence();
    if (fn(ev)) return ev;
    if (Date.now() - t0 > deadlineMs) throw new Error('rail poll deadline exceeded');
    await sleep(everyMs);
  }
}

const run = async () => {
  await rail.reset();
  await proxy.reset();
  fs.rmSync('/tmp/argus-s10-sut.db', { force: true });
  fs.rmSync('/tmp/argus-s10-sut.db-journal', { force: true });

  let sut = await startSut({ demoRoot: DEMO_ROOT, port: SUT_PORT, priceUsd: PRICE, db: '/tmp/argus-s10-sut.db', runnerPath: RUNNER });
  const gw = sut.gw;
  log(`SUT up on :${SUT_PORT} (price ${sut.info.price_credits} credits = $${PRICE})`);

  const tools = await httpJson('GET', `${gw.baseUrl}/mcp/tools.json`, { headers: { 'x-api-key': gw.adminKey } });
  c.eq('tools list advertises paypal_checkout', tools.json?.tools?.some((t) => t.name === 'paypal_checkout'), true);

  // ------------------------------------------------ Phase A: idempotent retry
  log('Phase A: capture response lost twice, SUT retry replays the rail');
  const a = await gw.provisionAgent('agent-a', PRICE_CREDITS);
  const pa = await gw.permit({ issuer: a.walletId, subject: a.walletId, maxCredits: PRICE_CREDITS, idemKey: 'argus-permit-a' });
  await proxy.arm({ scenario: 'lost_response_after_capture', method: 'POST', pathSuffix: '/capture', times: 2 });
  const ra = await gw.toolsCall({ apiKey: a.apiKey, walletId: a.walletId, permitId: pa.permit_id, idemKey: 'argus-key-a', args: { item: 'S10 phase A sticker pack' } });
  await pollRail((ev) => ev.evidence.capture_attempts >= 2);
  await proxy.disarm();

  c.eq('A: envelope is success (not error)', ra.json?.result?.isError ?? null, false);
  c.eq('A: receipt outcome', ra.json?.result?.receipt?.outcome, 'success');
  c.eq('A: rail captures completed (1 per checkout)', (await rail.evidence()).evidence.captures_completed, 1);
  c.eq('A: rail capture attempts (2, replay not recount)', (await rail.evidence()).evidence.capture_attempts, 2);
  c.eq('A: rail replayed same-request-id capture', (await rail.evidence()).evidence.capture_replays, 1);
  c.eq('A: distinct double-captures rejected', (await rail.evidence()).evidence.duplicate_capture_rejections, 0);
  const la = await gw.ledger(a.walletId, a.apiKey);
  c.eq('A: wallet charged once', countLedger(la, 'charge:'), 1);
  c.eq('A: no refund', countLedger(la, 'refund'), 0);

  // ------------------------------------------------ Phase B: full blackout
  log('Phase B: capture lost x2 AND reconciliation GET lost');
  const b = await gw.provisionAgent('agent-b', PRICE_CREDITS);
  const pb = await gw.permit({ issuer: b.walletId, subject: b.walletId, maxCredits: PRICE_CREDITS, idemKey: 'argus-permit-b' });
  await proxy.arm({ scenario: 'lost_response_after_capture', method: 'POST', pathSuffix: '/capture', times: 2 });
  await proxy.arm({ scenario: 'lost_response_after_capture', method: 'GET', pathSuffix: '', times: 1 });
  const rb = await gw.toolsCall({ apiKey: b.apiKey, walletId: b.walletId, permitId: pb.permit_id, idemKey: 'argus-key-b', args: { item: 'S10 phase B sticker pack' } });
  await pollRail((ev) => ev.evidence.capture_attempts >= 4);
  await proxy.disarm();

  c.eq('B: envelope reports tool failure', rb.json?.result?.isError ?? null, true);
  c.add('B: failure came from unrecoverable transport loss', /RemoteProtocolError|ReadError|TransportError/.test(rb.json?.result?.content?.[0]?.text ?? ''), rb.json?.result?.content?.[0]?.text);
  c.eq('B: receipt outcome', rb.json?.result?.receipt?.outcome, 'tool_error');
  c.eq('B: receipt charged 0 (refunded)', rb.json?.result?.receipt?.credits_charged, '0');
  c.eq('B: rail captures completed so far', (await rail.evidence()).evidence.captures_completed, 2);
  const lb = await gw.ledger(b.walletId, b.apiKey);
  c.eq('B: wallet refunded', countLedger(lb, 'refund'), 1);
  const wb = await gw.wallet(b.walletId, b.apiKey);
  c.add('B: FINDING rail/SUT money divergence (rail captured $25, SUT balance restored)', Number(wb.balance) === PRICE_CREDITS && (await rail.evidence()).evidence.captures_completed >= 2, { sut_balance: wb.balance, rail_captures: (await rail.evidence()).evidence.captures_completed });

  // ------------------------------------------------ Phase C: delivery_uncertain
  log('Phase C: abort mid-call while reconciliation GET is stalled');
  const ag = await gw.provisionAgent('agent-c', PRICE_CREDITS);
  const pc = await gw.permit({ issuer: ag.walletId, subject: ag.walletId, maxCredits: PRICE_CREDITS, idemKey: 'argus-permit-c' });
  await proxy.arm({ scenario: 'lost_response_after_capture', method: 'POST', pathSuffix: '/capture', times: 2 });
  await proxy.arm({ scenario: 'timeout', method: 'GET', pathSuffix: '', times: 1, timeoutMs: 6000 });
  const call = abortableJson('POST', `${gw.baseUrl}/mcp/messages`, {
    headers: { 'x-api-key': ag.apiKey, 'idempotency-key': 'argus-key-c' },
    body: { jsonrpc: '2.0', id: 'argus-key-c', method: 'tools/call', params: { name: 'paypal_checkout', arguments: { item: 'S10 phase C sticker pack' }, mcpContext: { wallet_id: ag.walletId, permit_id: pc.permit_id } } },
  });
  const callPromise = call.promise.catch((e) => ({ aborted: String(e?.message ?? e) }));
  await pollRail((ev) => ev.evidence.capture_attempts >= 6);
  await sleep(400); // let the SUT enter its stalled reconciliation GET
  call.abort();
  await sleep(1500);
  log('  MCP call aborted mid-flight; retrying with the SAME idempotency key');
  const rc = await gw.toolsCall({ apiKey: ag.apiKey, walletId: ag.walletId, permitId: pc.permit_id, idemKey: 'argus-key-c', args: { item: 'S10 phase C sticker pack' } });
  const firstCallResult = await callPromise;

  c.add('C: first call never delivered a verdict to the client', firstCallResult?.aborted !== undefined || firstCallResult?.json === null, firstCallResult?.aborted ?? 'delivered');
  let uncertain = rc.json?.error?.code === -32010 && rc.json?.error?.message === 'delivery_uncertain';

  if (!uncertain) {
    log('  in-process abort did not surface uncertainty -> hard-kill recovery path');
    sut.child.kill('SIGKILL');
    await sleep(500);
    sut = await startSut({ demoRoot: DEMO_ROOT, port: SUT_PORT, priceUsd: PRICE, db: '/tmp/argus-s10-sut.db', adminKey: gw.adminKey, runnerPath: RUNNER });
    c.add('C: restart recovered stale in-flight op(s)', sut.info.stale_recovered >= 1, { stale_recovered: sut.info.stale_recovered });
    const rc2 = await gw.toolsCall({ apiKey: ag.apiKey, walletId: ag.walletId, permitId: pc.permit_id, idemKey: 'argus-key-c', args: { item: 'S10 phase C sticker pack' } });
    uncertain = rc2.json?.error?.code === -32010 && rc2.json?.error?.message === 'delivery_uncertain';
    rc.json = rc2.json;
  }

  c.eq('C: retry returns SUT-owned delivery_uncertain (-32010)', uncertain, true);
  c.eq('C: receipt outcome', rc.json?.error?.data?.receipt?.outcome, 'delivery_uncertain');
  c.eq('C: charge kept (not refunded)', Number(rc.json?.error?.data?.receipt?.credits_charged), PRICE_CREDITS);
  const receiptId = rc.json?.error?.data?.receipt?.receipt_id;
  const ver = await gw.verifyReceipt(receiptId, gw.adminKey);
  c.eq('C: SUT-side receipt signature verifies', ver.json?.valid, true);
  const lc = await gw.ledger(ag.walletId, ag.apiKey);
  c.eq('C: wallet charged once', countLedger(lc, 'charge:'), 1);
  c.eq('C: no refund', countLedger(lc, 'refund'), 0);
  const fin = (await rail.evidence()).evidence;
  c.eq('C: rail captures frozen at 3 (retry did NOT dispatch)', fin.captures_completed, 3);
  c.eq('C: rail capture attempts frozen at 6', fin.capture_attempts, 6);

  // ------------------------------------------------------------- verdict
  const wl = await proxy.wireLog();
  const verdict = {
    scenario: 'S10 DeliveryUncertain',
    sut: 'agentmiddleware/amw-paypal-agent-demo (mini_gateway over TCP)',
    rail: 'Argus mock PayPal rail (mock-first loop)',
    price_usd: PRICE,
    checks: c.summary().checks,
    verdict: c.summary().verdict,
    rail_evidence: fin,
    wire_log_tail: wl.entries.slice(-12),
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
