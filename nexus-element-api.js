/**
 * nexus-element-api.js
 * Element API Calltos — v1.0.0
 *
 * Exposes every Playwright element operation as a typed, trackable
 * NEXUS callto object. Calltos persist in data/calltos/ and are
 * replayable. Each callto has a UUID, status, result, and audit trail.
 *
 * HTTP surface:
 *
 *   POST /api/elements/callto          — create + execute a callto
 *   GET  /api/elements/calltos         — list all calltos
 *   GET  /api/elements/callto/:id      — get callto by id
 *   POST /api/elements/callto/:id/retry — retry failed callto
 *   DELETE /api/elements/callto/:id    — delete callto
 *
 *   POST /api/elements/batch           — run multiple calltos in sequence
 *   POST /api/elements/form/fill       — smart form fill (field map)
 *   POST /api/elements/page/extract    — extract structured data from page
 *
 * Callto schema:
 * {
 *   id:         string,        // UUID
 *   action:     string,        // click|type|extract|screenshot|...
 *   selector:   string,        // CSS/XPath/text selector
 *   params:     object,        // action-specific params
 *   status:     'pending'|'running'|'ok'|'error'|'timeout',
 *   result:     any,
 *   error:      string|null,
 *   createdAt:  ISO string,
 *   resolvedAt: ISO string|null,
 *   durationMs: number|null,
 *   retries:    number,
 *   sessionUuid: string|null,
 * }
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── State ─────────────────────────────────────────────────────────────────────
let _mirror   = null;   // nexus-playwright-mirror
let _busEmit  = null;
let _calltoDir = null;
let _log      = (...a) => console.log('[Element-API]', ...a);

// In-memory callto map (also persisted to disk)
const _calltos = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────
function newId() { return 'el_' + crypto.randomBytes(8).toString('hex'); }

function jsonRes(res, status, body) {
  if (res.headersSent) return;
  const d = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type':               'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length':              Buffer.byteLength(d),
  });
  res.end(d);
}

function saveCallto(callto) {
  _calltos.set(callto.id, callto);
  if (!_calltoDir) return;
  try {
    fs.writeFileSync(
      path.join(_calltoDir, `${callto.id}.json`),
      JSON.stringify(callto, null, 2)
    );
  } catch {}
}

function loadCalltos() {
  if (!_calltoDir || !fs.existsSync(_calltoDir)) return;
  for (const f of fs.readdirSync(_calltoDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(_calltoDir, f), 'utf8'));
      _calltos.set(c.id, c);
    } catch {}
  }
  _log(`Loaded ${_calltos.size} persisted calltos`);
}

// ── Callto factory ────────────────────────────────────────────────────────────
function makeCallto(action, selector, params = {}, meta = {}) {
  return {
    id:          newId(),
    action,
    selector,
    params,
    status:      'pending',
    result:      null,
    error:       null,
    createdAt:   new Date().toISOString(),
    resolvedAt:  null,
    durationMs:  null,
    retries:     0,
    sessionUuid: meta.sessionUuid || null,
    tag:         meta.tag         || null,
    batchId:     meta.batchId     || null,
  };
}

// ── Execute a callto via the mirror plugin ────────────────────────────────────
async function executeCallto(callto) {
  callto.status = 'running';
  saveCallto(callto);
  _busEmit?.('element:callto:running', { id: callto.id, action: callto.action, selector: callto.selector }, 'INFO');

  const t0 = Date.now();
  try {
    const r = await _mirror.dispatch(callto.action, {
      selector:   callto.selector,
      ...callto.params,
    });

    callto.status     = r.ok ? 'ok' : 'error';
    callto.result     = r.result || null;
    callto.error      = r.error  || null;
    callto.resolvedAt = new Date().toISOString();
    callto.durationMs = Date.now() - t0;
    saveCallto(callto);

    _busEmit?.('element:callto:resolved', {
      id: callto.id, action: callto.action, status: callto.status, durationMs: callto.durationMs,
    }, callto.status === 'ok' ? 'INFO' : 'WARN');

    return callto;
  } catch (e) {
    callto.status     = 'error';
    callto.error      = e.message;
    callto.resolvedAt = new Date().toISOString();
    callto.durationMs = Date.now() - t0;
    saveCallto(callto);
    _busEmit?.('element:callto:error', { id: callto.id, error: e.message }, 'ERROR');
    return callto;
  }
}

// ── Smart form fill ───────────────────────────────────────────────────────────
// fields: { 'input[name="email"]': 'user@example.com', ... }
async function formFill(fields = {}, meta = {}) {
  const batchId  = newId();
  const results  = [];

  for (const [selector, value] of Object.entries(fields)) {
    const callto = makeCallto('type', selector, { text: String(value) }, { ...meta, batchId });
    saveCallto(callto);
    const done = await executeCallto(callto);
    results.push(done);
    if (done.status !== 'ok') break; // stop on first failure
  }

  return {
    batchId,
    total:   results.length,
    ok:      results.every(r => r.status === 'ok'),
    results,
  };
}

// ── Page data extractor ───────────────────────────────────────────────────────
// schema: { fieldName: { selector, attribute? }, ... }
async function pageExtract(schema = {}, meta = {}) {
  const batchId = newId();
  const out     = {};
  const results = [];

  for (const [field, spec] of Object.entries(schema)) {
    const callto = makeCallto('extract', spec.selector, { attribute: spec.attribute || 'textContent' }, { ...meta, batchId });
    saveCallto(callto);
    const done = await executeCallto(callto);
    results.push({ field, ...done });
    out[field] = done.status === 'ok' ? done.result?.value ?? null : null;
  }

  return {
    batchId,
    ok:     results.every(r => r.status === 'ok'),
    data:   out,
    results,
  };
}

// ── HTTP route handler (/api/elements/*) ──────────────────────────────────────
async function route(parts, method, body, req, res) {
  // POST /api/elements/callto
  if (method === 'POST' && parts[2] === 'callto' && !parts[3]) {
    const { action, selector, params, tag, sessionUuid } = body;
    if (!action)   return jsonRes(res, 400, { ok: false, error: 'action required' });
    if (!selector && !['eval', 'scroll'].includes(action))
                   return jsonRes(res, 400, { ok: false, error: 'selector required for action: ' + action });

    const callto = makeCallto(action, selector, params || {}, { tag, sessionUuid });
    saveCallto(callto);
    const done = await executeCallto(callto);
    return jsonRes(res, done.status === 'ok' ? 200 : 500, { ok: done.status === 'ok', callto: done });
  }

  // GET /api/elements/calltos
  if (method === 'GET' && parts[2] === 'calltos') {
    const all = [..._calltos.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return jsonRes(res, 200, { ok: true, count: all.length, calltos: all.slice(0, 200) });
  }

  // GET /api/elements/callto/:id
  if (method === 'GET' && parts[2] === 'callto' && parts[3]) {
    const c = _calltos.get(parts[3]);
    if (!c) return jsonRes(res, 404, { ok: false, error: 'Callto not found' });
    return jsonRes(res, 200, { ok: true, callto: c });
  }

  // POST /api/elements/callto/:id/retry
  if (method === 'POST' && parts[2] === 'callto' && parts[3] && parts[4] === 'retry') {
    const c = _calltos.get(parts[3]);
    if (!c) return jsonRes(res, 404, { ok: false, error: 'Callto not found' });
    c.retries++;
    c.status     = 'pending';
    c.error      = null;
    c.result     = null;
    c.resolvedAt = null;
    const done = await executeCallto(c);
    return jsonRes(res, done.status === 'ok' ? 200 : 500, { ok: done.status === 'ok', callto: done });
  }

  // DELETE /api/elements/callto/:id
  if (method === 'DELETE' && parts[2] === 'callto' && parts[3]) {
    const id = parts[3];
    _calltos.delete(id);
    try { fs.unlinkSync(path.join(_calltoDir, `${id}.json`)); } catch {}
    return jsonRes(res, 200, { ok: true, deleted: id });
  }

  // POST /api/elements/batch
  if (method === 'POST' && parts[2] === 'batch') {
    const { steps = [], meta = {} } = body;
    const batchId = newId();
    const results = [];

    for (const step of steps) {
      const { action, selector, params, tag } = step;
      if (!action) { results.push({ ok: false, error: 'action required', step }); continue; }
      const callto = makeCallto(action, selector, params || {}, { ...meta, tag, batchId });
      saveCallto(callto);
      const done = await executeCallto(callto);
      results.push({ calltoId: done.id, action, selector, status: done.status, result: done.result, error: done.error });
      if (done.status !== 'ok' && step.stopOnError !== false) break;
    }

    const allOk = results.every(r => r.status === 'ok');
    _busEmit?.('element:batch:resolved', { batchId, total: results.length, allOk }, 'INFO');
    return jsonRes(res, allOk ? 200 : 207, { ok: allOk, batchId, total: results.length, results });
  }

  // POST /api/elements/form/fill
  if (method === 'POST' && parts[2] === 'form' && parts[3] === 'fill') {
    const { fields = {}, meta = {} } = body;
    const r = await formFill(fields, meta);
    return jsonRes(res, r.ok ? 200 : 207, r);
  }

  // POST /api/elements/page/extract
  if (method === 'POST' && parts[2] === 'page' && parts[3] === 'extract') {
    const { schema = {}, meta = {} } = body;
    const r = await pageExtract(schema, meta);
    return jsonRes(res, r.ok ? 200 : 207, r);
  }

  // GET /api/elements/actions
  if (method === 'GET' && parts[2] === 'actions') {
    return jsonRes(res, 200, {
      ok: true,
      endpoints: [
        'POST /api/elements/callto           — { action, selector, params?, tag?, sessionUuid? }',
        'GET  /api/elements/calltos          — list all calltos',
        'GET  /api/elements/callto/:id       — get callto',
        'POST /api/elements/callto/:id/retry — retry',
        'DEL  /api/elements/callto/:id       — delete',
        'POST /api/elements/batch            — { steps: [{ action, selector, params, stopOnError? }] }',
        'POST /api/elements/form/fill        — { fields: { selector: value, ... } }',
        'POST /api/elements/page/extract     — { schema: { name: { selector, attribute? } } }',
      ],
      actions: _mirror ? _mirror.ACTIONS : [],
    });
  }

  return jsonRes(res, 404, { ok: false, error: 'Unknown element API endpoint' });
}

// ── Install ───────────────────────────────────────────────────────────────────
function install({ mirror, busEmit, calltoDir, logger }) {
  _mirror    = mirror;
  _busEmit   = busEmit;
  _calltoDir = calltoDir;
  if (logger) _log = logger;
  if (_calltoDir && !fs.existsSync(_calltoDir)) fs.mkdirSync(_calltoDir, { recursive: true });
  loadCalltos();
  _log('Element API installed');
}

module.exports = { install, route, formFill, pageExtract, makeCallto, executeCallto };
