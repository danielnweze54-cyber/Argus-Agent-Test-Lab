// Argus Block D — HTTP driver toolkit for the fiat-rail scenarios (S10/S11).
// Zero dependencies. Speaks three planes:
//   GatewayClient — the SUT's documented surface (wallets, permits, MCP, receipts)
//   ProxyAdmin    — Argus-owned fault-injection proxy (/__argus/*)
//   RailClient    — the rail and its truth endpoint (/__rail/evidence)
// plus a tiny SUT process supervisor for sut/serve_gateway.py.

import http from 'node:http';
import { spawn } from 'node:child_process';

export function httpJson(method, url, { headers = {}, body } = {}, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${method} ${url}`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// A request whose socket can be destroyed mid-flight (S10 phase C abort).
export function abortableJson(method, url, { headers = {}, body } = {}) {
  let req;
  const promise = new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    req = http.request(
      url,
      {
        method,
        headers: {
          ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('error', (e) => reject(e));
    if (data) req.write(data);
    req.end();
  });
  return { promise, abort: () => req.destroy() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- Gateway

export class GatewayClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.adminKey = null;
  }

  async health() {
    return (await httpJson('GET', `${this.baseUrl}/health`)).json;
  }

  _admin() { return { 'x-api-key': this.adminKey }; }

  async sponsorWallet(initialCredits) {
    const r = await httpJson('POST', `${this.baseUrl}/v1/billing/wallets/sponsor`, {
      headers: this._admin(),
      body: { sponsor_name: 'Argus Block D sponsor', email: 'argus@example.com', initial_credits: initialCredits, require_kyc: false },
    });
    if (r.status !== 201) throw new Error(`sponsor wallet ${r.status}: ${r.text}`);
    return r.json;
  }

  async agentWallet(sponsorWalletId, agentId, budgetCredits) {
    const r = await httpJson('POST', `${this.baseUrl}/v1/billing/wallets/agent`, {
      headers: this._admin(),
      body: { sponsor_wallet_id: sponsorWalletId, agent_id: agentId, budget_credits: budgetCredits, daily_limit: budgetCredits },
    });
    if (r.status !== 201) throw new Error(`agent wallet ${r.status}: ${r.text}`);
    return r.json;
  }

  async apiKey(walletId, name) {
    const r = await httpJson('POST', `${this.baseUrl}/v1/api-keys`, {
      headers: this._admin(),
      body: { wallet_id: walletId, key_name: name, expires_in_days: 1 },
    });
    if (r.status !== 201) throw new Error(`api key ${r.status}: ${r.text}`);
    return r.json;
  }

  async permit({ issuer, subject, maxCredits, tools = ['paypal_checkout'], idemKey }) {
    const expires = new Date(Date.now() + 3600_000).toISOString();
    const r = await httpJson('POST', `${this.baseUrl}/v1/permits`, {
      headers: { ...this._admin(), 'idempotency-key': idemKey },
      body: { issuer_wallet_id: issuer, subject_wallet_id: subject, max_credits: String(maxCredits), allowed_tools: tools, expires_at: expires },
    });
    if (r.status !== 201 && r.status !== 200) throw new Error(`permit ${r.status}: ${r.text}`);
    return r.json;
  }

  async provisionAgent(agentId, budgetCredits) {
    const sponsor = await this.sponsorWallet(budgetCredits * 4);
    const agent = await this.agentWallet(sponsor.wallet_id, agentId, budgetCredits);
    const key = await this.apiKey(agent.wallet_id, agentId);
    return { walletId: agent.wallet_id, apiKey: key.api_key };
  }

  async toolsCall({ apiKey, walletId, permitId, idemKey, name = 'paypal_checkout', args }) {
    return httpJson('POST', `${this.baseUrl}/mcp/messages`, {
      headers: { 'x-api-key': apiKey, 'idempotency-key': idemKey },
      body: { jsonrpc: '2.0', id: idemKey, method: 'tools/call', params: { name, arguments: args, mcpContext: { wallet_id: walletId, permit_id: permitId } } },
    }, 20_000);
  }

  async wallet(walletId, apiKey) {
    return (await httpJson('GET', `${this.baseUrl}/v1/billing/wallets/${walletId}`, { headers: { 'x-api-key': apiKey } })).json;
  }

  async ledger(walletId, apiKey) {
    return (await httpJson('GET', `${this.baseUrl}/v1/billing/ledger/${walletId}`, { headers: { 'x-api-key': apiKey } })).json;
  }

  async verifyReceipt(receiptId, apiKey) {
    return httpJson('POST', `${this.baseUrl}/v1/receipts/verify`, {
      headers: { 'x-api-key': apiKey },
      body: { receipt_id: receiptId },
    });
  }
}

// -------------------------------------------------------- proxy and rail

export class ProxyAdmin {
  constructor(baseUrl = 'http://127.0.0.1:8888') { this.baseUrl = baseUrl; }
  async reset() { return httpJson('POST', `${this.baseUrl}/__argus/reset`); }
  async disarm() { return httpJson('POST', `${this.baseUrl}/__argus/disarm`); }
  async arm(def) { return httpJson('POST', `${this.baseUrl}/__argus/arm`, { body: def }); }
  async wireLog() { return (await httpJson('GET', `${this.baseUrl}/__argus/wire-log`)).json; }
  async status() { return (await httpJson('GET', `${this.baseUrl}/__argus/status`)).json; }
}

export class RailClient {
  constructor(baseUrl = 'http://127.0.0.1:8891') { this.baseUrl = baseUrl; }
  async reset() { return httpJson('POST', `${this.baseUrl}/__rail/reset`); }
  async evidence() { return (await httpJson('GET', `${this.baseUrl}/__rail/evidence`)).json; }
}

// ------------------------------------------------------------ SUT process

export async function startSut({ demoRoot, port = 8321, proxyUrl = 'http://127.0.0.1:8888', priceUsd = '25.00', db, adminKey, runnerPath }) {
  const child = spawn('python3', [
    runnerPath,
    '--demo-root', demoRoot,
    '--port', String(port),
    '--proxy-url', proxyUrl,
    '--price-usd', priceUsd,
    '--db', db,
    ...(adminKey ? ['--admin-key', adminKey] : []),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const ready = new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`SUT did not report ready: stdout=${buf}`)), 25_000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const line = buf.split('\n').find((l) => l.includes('"event"'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line.slice(line.indexOf('{'))));
      }
    });
    child.stderr.on('data', (d) => { buf += d.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`SUT exited early (code ${code}): ${buf}`)); });
  });

  const info = await ready;
  const gw = new GatewayClient(`http://127.0.0.1:${port}`);
  for (let i = 0; i < 50; i++) {
    try { if ((await gw.health())?.status === 'ok') break; } catch { /* not up yet */ }
    await sleep(100);
  }
  gw.adminKey = info.admin_key;
  return { child, info, gw };
}

// -------------------------------------------------------------- assertions

export class Checks {
  constructor() { this.list = []; }
  add(name, pass, detail) {
    this.list.push({ name, pass: Boolean(pass), detail: detail === undefined ? null : detail });
    return pass;
  }
  eq(name, actual, expected) {
    return this.add(name, actual === expected, { expected, actual });
  }
  get passed() { return this.list.every((c) => c.pass); }
  summary() { return { verdict: this.passed ? 'PASS' : 'FAIL', checks: this.list }; }
}
