#!/usr/bin/env node
// Argus Block D — fault-injection proxy (S10/S11 evidence point).
// Sits between the SUT (AMW demo) and the rail (PayPal sandbox or local mock rail).
// Forwards all traffic to the upstream; admin routes under /__argus/ let Argus
// arm deterministic wire faults and read the wire log as rail-side evidence.
//
// Faults:
//   lost_response_after_capture — forwards the request upstream, waits for the
//     upstream response, then destroys the SUT socket WITHOUT sending the
//     response. The capture completes upstream; the SUT sees a lost response.
//   timeout — destroys the SUT socket after FAULT_PROXY_TIMEOUT_MS without
//     forwarding anything (request lost in transit).
//
// No dependencies. Node >= 18.

import http from 'node:http';
import https from 'node:https';

const LISTEN_HOST = process.env.FAULT_PROXY_LISTEN_HOST ?? '127.0.0.1';
const LISTEN_PORT = Number(process.env.FAULT_PROXY_LISTEN_PORT ?? 8888);
const UPSTREAM = new URL(process.env.FAULT_PROXY_UPSTREAM_URL ?? 'http://127.0.0.1:8891');
const TIMEOUT_MS = Number(process.env.FAULT_PROXY_TIMEOUT_MS ?? 5000);
const UP_LIB = UPSTREAM.protocol === 'https:' ? https : http;

const state = {
  armed: null, // {scenario, method, pathSuffix, times}
  wire: [],    // ring buffer of wire-log entries (S10/S11 evidence)
  seq: 0,
};

function logWire(entry) {
  state.wire.push({ seq: ++state.seq, ts: new Date().toISOString(), ...entry });
  if (state.wire.length > 2000) state.wire.shift();
}

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

function armMatches(req, url) {
  const a = state.armed;
  if (!a) return false;
  if (a.method && req.method !== a.method) return false;
  if (a.pathSuffix && !url.pathname.endsWith(a.pathSuffix)) return false;
  return true;
}

// Returns the armed fault (and decrements/retires it) or null.
function consumeArm() {
  const a = state.armed;
  if (!a) return null;
  a.times -= 1;
  if (a.times <= 0) state.armed = null;
  return a;
}

async function admin(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/__argus/arm') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const scenario = body.scenario ?? '';
    if (!['lost_response_after_capture', 'timeout'].includes(scenario)) {
      return sendJson(res, 400, { error: 'unknown scenario', supported: ['lost_response_after_capture', 'timeout'] });
    }
    state.armed = {
      scenario,
      method: body.method ?? 'POST',
      pathSuffix: body.pathSuffix ?? '/capture',
      times: Number(body.times ?? 1),
    };
    logWire({ kind: 'admin', action: 'arm', armed: state.armed });
    return sendJson(res, 200, { ok: true, armed: state.armed });
  }
  if (req.method === 'POST' && url.pathname === '/__argus/disarm') {
    state.armed = null;
    logWire({ kind: 'admin', action: 'disarm' });
    return sendJson(res, 200, { ok: true, armed: null });
  }
  if (req.method === 'GET' && url.pathname === '/__argus/status') {
    return sendJson(res, 200, { armed: state.armed, upstream: UPSTREAM.toString(), wire_entries: state.wire.length });
  }
  if (req.method === 'GET' && url.pathname === '/__argus/wire-log') {
    return sendJson(res, 200, { entries: state.wire });
  }
  if (req.method === 'POST' && url.pathname === '/__argus/reset') {
    state.wire = [];
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'unknown admin route' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname.startsWith('/__argus/')) {
    admin(req, res, url).catch((e) => sendJson(res, 500, { error: String(e) }));
    return;
  }

  const armed = armMatches(req, url);

  // timeout fault: request never reaches the rail
  if (armed && armed.scenario === 'timeout') {
    const a = consumeArm();
    logWire({ kind: 'wire', method: req.method, path: url.pathname + url.search, fault: a.scenario, note: `socket destroyed after ${TIMEOUT_MS}ms, request not forwarded` });
    setTimeout(() => res.destroy(), TIMEOUT_MS);
    req.resume();
    return;
  }

  const headers = { ...req.headers, host: `${UPSTREAM.hostname}:${UPSTREAM.port}` };
  const upReq = UP_LIB.request(
    { hostname: UPSTREAM.hostname, port: UPSTREAM.port, path: url.pathname + url.search, method: req.method, headers },
    (upRes) => {
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        if (armed) {
          const a = consumeArm();
          if (a && a.scenario === 'lost_response_after_capture') {
            logWire({ kind: 'wire', method: req.method, path: url.pathname + url.search, upstream_status: upRes.statusCode, fault: a.scenario, note: 'upstream completed; response dropped, SUT socket destroyed' });
            res.destroy(); // S10: capture happened, response is lost
            return;
          }
        }
        logWire({ kind: 'wire', method: req.method, path: url.pathname + url.search, upstream_status: upRes.statusCode, fault: null });
        const body = Buffer.concat(chunks);
        res.writeHead(upRes.statusCode, upRes.headers);
        res.end(body);
      });
    }
  );
  upReq.on('error', (e) => {
    logWire({ kind: 'wire', method: req.method, path: url.pathname + url.search, fault: null, note: `upstream error: ${e.message}` });
    if (!res.destroyed) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream_unreachable' })); }
  });
  req.pipe(upReq);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[fault-proxy] listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM.toString()}`);
});
