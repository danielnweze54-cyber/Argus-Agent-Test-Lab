#!/usr/bin/env node
// Argus Block D — mock PayPal rail (Orders v2 subset) for the offline dev loop.
// Mirrors the semantics the AMW demo (fakes.py) relies on:
//   POST /v1/oauth2/token                     — client credentials
//   POST /v2/checkout/orders                  — create order (idempotent by PayPal-Request-Id)
//   POST /v2/checkout/orders/{id}/capture     — at most one capture. Retries with the
//                 SAME PayPal-Request-Id replay the original capture response
//                 (real PayPal idempotency semantics); a different request id
//                 on a captured order -> 422 ORDER_ALREADY_CAPTURED.
//   GET  /v2/checkout/orders/{id}             — reconciliation polling
//   GET  /__rail/evidence                     — rail-side truth for Argus assertions
//
// This server plays "the rail" in the mock-first loop:
//   AMW demo (PAYPAL_BASE_URL) -> fault proxy :8888 -> mock rail :8891
// No dependencies. Node >= 18.

import http from 'node:http';
import crypto from 'node:crypto';

const HOST = process.env.RAIL_MOCK_HOST ?? '127.0.0.1';
const PORT = Number(process.env.RAIL_MOCK_PORT ?? 8891);
const MOCK_CLIENT_ID = process.env.RAIL_MOCK_CLIENT_ID ?? ''; // empty = accept any credentials
const MOCK_CLIENT_SECRET = process.env.RAIL_MOCK_CLIENT_SECRET ?? '';

const orders = new Map();       // orderId -> order object
const byRequestId = new Map();  // PayPal-Request-Id -> orderId (rail idempotency)
const evidence = { tokens_issued: 0, orders_created: 0, capture_attempts: 0, captures_completed: 0, capture_replays: 0, duplicate_capture_rejections: 0 };
const tokens = new Set();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

function orderId() {
  return crypto.randomBytes(9).toString('hex').toUpperCase();
}

// Serialize an order the way real PayPal Orders v2 serves it: the capture
// lives inside purchase_units[0].payments.captures[], not as a sibling field.
// The AMW demo's reconcile path (paypal_tool._first_capture) depends on it.
function orderView(order) {
  if (!order.capture) return { ...order };
  const cap = {
    id: order.capture.id,
    status: order.capture.status,
    amount: order.capture.amount,
    final_capture: true,
    update_time: order.capture.update_time,
  };
  const units = (order.purchase_units ?? []).map((u, i) =>
    i === 0 ? { ...u, payments: { captures: [cap] } } : { ...u }
  );
  return { ...order, purchase_units: units };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/v1/oauth2/token') {
    evidence.tokens_issued += 1;
    if (MOCK_CLIENT_ID || MOCK_CLIENT_SECRET) {
      const auth = req.headers.authorization ?? '';
      const [scheme, b64] = auth.split(' ');
      const ok = scheme === 'Basic' && (() => {
        const [id, secret] = Buffer.from(b64 ?? '', 'base64').toString('utf8').split(':');
        return id === MOCK_CLIENT_ID && secret === MOCK_CLIENT_SECRET;
      })();
      if (!ok) return sendJson(res, 401, { error: 'invalid_client' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    tokens.add(token);
    return sendJson(res, 200, { scope: 'https://uri.paypal.com/services/payments', access_token: token, token_type: 'Bearer', app_id: 'APP-80W284485P519543T', expires_in: 32400 });
  }

  const bearer = (req.headers.authorization ?? '').startsWith('Bearer ');
  if (!bearer && url.pathname.startsWith('/v2/')) {
    return sendJson(res, 401, { error: 'authentication_required' });
  }

  if (req.method === 'POST' && url.pathname === '/v2/checkout/orders') {
    const rid = req.headers['paypal-request-id'] ?? '';
    // Rail-side idempotency: same PayPal-Request-Id returns the same order.
    if (rid && byRequestId.has(rid)) {
      const existing = orders.get(byRequestId.get(rid));
      return sendJson(res, 200, orderView(existing));
    }
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { /* keep {} */ }
    const id = orderId();
    const order = {
      id,
      status: 'CREATED',
      intent: body.intent ?? 'CAPTURE',
      purchase_units: body.purchase_units ?? [],
      create_time: new Date().toISOString(),
      capture: null,
      request_id: rid,
    };
    orders.set(id, order);
    if (rid) byRequestId.set(rid, id);
    evidence.orders_created += 1;
    return sendJson(res, 201, order);
  }

  const captureMatch = url.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
  if (req.method === 'POST' && captureMatch) {
    evidence.capture_attempts += 1;
    const order = orders.get(captureMatch[1]);
    if (!order) return sendJson(res, 404, { name: 'INVALID_RESOURCE_ID', message: 'order not found' });
    if (order.capture) {
      const rid = req.headers['paypal-request-id'] ?? '';
      if (rid && order.capture.request_id === rid) {
        // Same PayPal-Request-Id: real PayPal replays the original response.
        evidence.capture_replays += 1;
        return sendJson(res, 201, orderView(order));
      }
      evidence.duplicate_capture_rejections += 1;
      return sendJson(res, 422, { name: 'ORDER_ALREADY_CAPTURED', message: 'Order already captured. Repeated captures are not allowed.', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
    }
    order.status = 'COMPLETED';
    order.capture = {
      id: `CAP-${orderId()}`,
      status: 'COMPLETED',
      amount: order.purchase_units?.[0]?.amount ?? null,
      final_capture: true,
      update_time: new Date().toISOString(),
      request_id: req.headers['paypal-request-id'] ?? '',
    };
    evidence.captures_completed += 1;
    return sendJson(res, 201, orderView(order));
  }

  const orderMatch = url.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)$/);
  if (req.method === 'GET' && orderMatch) {
    const order = orders.get(orderMatch[1]);
    if (!order) return sendJson(res, 404, { name: 'INVALID_RESOURCE_ID', message: 'order not found' });
    return sendJson(res, 200, orderView(order));
  }

  if (req.method === 'GET' && url.pathname === '/__rail/evidence') {
    return sendJson(res, 200, { evidence, orders: [...orders.values()] });
  }

  if (req.method === 'POST' && url.pathname === '/__rail/reset') {
    orders.clear(); byRequestId.clear(); tokens.clear();
    for (const k of Object.keys(evidence)) evidence[k] = 0;
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'unknown route', path: url.pathname });
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-rail] PayPal Orders v2 mock listening on http://${HOST}:${PORT}`);
});
