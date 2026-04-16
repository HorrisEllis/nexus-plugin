/**
 * nexus-playwright-mirror.js
 * Playwright Mirror Plugin — v1.0.0
 *
 * Mirrors live browser DOM elements into the NEXUS bus as structured
 * API-callable objects. Every element becomes a first-class callto:
 *
 *   bus.emit('pw:element:click',      { selector, sessionUuid })
 *   bus.emit('pw:element:type',       { selector, text, sessionUuid })
 *   bus.emit('pw:element:extract',    { selector, attribute, sessionUuid })
 *   bus.emit('pw:element:screenshot', { selector, sessionUuid })
 *   bus.emit('pw:element:wait',       { selector, timeout, sessionUuid })
 *   bus.emit('pw:element:exists',     { selector, sessionUuid })
 *   bus.emit('pw:element:query',      { selector, sessionUuid })
 *   bus.emit('pw:element:scroll',     { selector, sessionUuid })
 *   bus.emit('pw:element:hover',      { selector, sessionUuid })
 *   bus.emit('pw:element:select',     { selector, value, sessionUuid })
 *   bus.emit('pw:element:check',      { selector, sessionUuid })
 *   bus.emit('pw:element:uncheck',    { selector, sessionUuid })
 *   bus.emit('pw:element:focus',      { selector, sessionUuid })
 *   bus.emit('pw:element:blur',       { selector, sessionUuid })
 *
 * Results are emitted back as:
 *   bus.emit('pw:element:result', { calltoId, action, selector, ok, result, error })
 *
 * Also exposes HTTP endpoints under /playwright/mirror/* which map 1:1
 * to the bus events — enabling pure REST clients to drive elements.
 *
 * Cookie mirror: captures all cookies from the current page context
 * and emits them as 'pw:cookies:captured' with structured per-domain data.
 */

'use strict';

const crypto = require('crypto');

// ── Module state ──────────────────────────────────────────────────────────────
let _bus     = null;
let _getPage = null;   // () => Playwright Page | null
let _busEmit = null;
let _log     = (...a) => console.log('[PW-Mirror]', ...a);

// ── Helpers ───────────────────────────────────────────────────────────────────
function calltoId() { return 'cto_' + crypto.randomBytes(6).toString('hex'); }

function jsonRes(res, status, body) {
  if (res.headersSent) return;
  const d = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(d),
  });
  res.end(d);
}

// ── Core element actions ──────────────────────────────────────────────────────
const ACTIONS = {

  async click({ page, selector, options = {} }) {
    await page.click(selector, { timeout: options.timeout || 10000, ...options });
    return { ok: true, selector };
  },

  async type({ page, selector, text, options = {} }) {
    await page.fill(selector, text, { timeout: options.timeout || 10000 });
    return { ok: true, selector, text };
  },

  async extract({ page, selector, attribute, options = {} }) {
    const loc = page.locator(selector).first();
    await loc.waitFor({ timeout: options.timeout || 10000 });
    let value;
    if (!attribute || attribute === 'textContent') {
      value = await loc.textContent();
    } else if (attribute === 'innerHTML') {
      value = await loc.innerHTML();
    } else if (attribute === 'innerText') {
      value = await loc.innerText();
    } else {
      value = await loc.getAttribute(attribute);
    }
    return { ok: true, selector, attribute: attribute || 'textContent', value };
  },

  async screenshot({ page, selector, options = {} }) {
    const loc = page.locator(selector).first();
    await loc.waitFor({ timeout: options.timeout || 10000 });
    const buf = await loc.screenshot({ type: 'png' });
    return { ok: true, selector, base64: buf.toString('base64'), mimeType: 'image/png' };
  },

  async wait({ page, selector, state = 'visible', options = {} }) {
    await page.waitForSelector(selector, {
      state,
      timeout: options.timeout || 15000,
    });
    return { ok: true, selector, state };
  },

  async exists({ page, selector, options = {} }) {
    try {
      const loc   = page.locator(selector);
      const count = await loc.count();
      return { ok: true, selector, exists: count > 0, count };
    } catch {
      return { ok: true, selector, exists: false, count: 0 };
    }
  },

  async query({ page, selector, options = {} }) {
    // Returns full structured data for every matching element
    const results = await page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel)).map((el, i) => ({
        index:     i,
        tagName:   el.tagName.toLowerCase(),
        id:        el.id || null,
        className: el.className || null,
        text:      el.textContent?.trim().slice(0, 200) || null,
        href:      el.href  || null,
        src:       el.src   || null,
        value:     el.value !== undefined ? el.value : null,
        type:      el.type  || null,
        name:      el.name  || null,
        disabled:  el.disabled || false,
        checked:   el.checked  !== undefined ? el.checked : null,
        visible:   el.offsetParent !== null,
        rect:      (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
      }));
    }, selector);
    return { ok: true, selector, count: results.length, elements: results };
  },

  async scroll({ page, selector, options = {} }) {
    const { direction = 'down', amount = 300 } = options;
    if (selector && selector !== 'window') {
      await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 10000 });
    } else {
      const delta = direction === 'up' ? -amount : amount;
      await page.evaluate((d) => window.scrollBy(0, d), delta);
    }
    return { ok: true, selector, direction, amount };
  },

  async hover({ page, selector, options = {} }) {
    await page.hover(selector, { timeout: options.timeout || 10000 });
    return { ok: true, selector };
  },

  async select({ page, selector, value, options = {} }) {
    await page.selectOption(selector, value, { timeout: options.timeout || 10000 });
    return { ok: true, selector, value };
  },

  async check({ page, selector, options = {} }) {
    await page.check(selector, { timeout: options.timeout || 10000 });
    return { ok: true, selector };
  },

  async uncheck({ page, selector, options = {} }) {
    await page.uncheck(selector, { timeout: options.timeout || 10000 });
    return { ok: true, selector };
  },

  async focus({ page, selector, options = {} }) {
    await page.focus(selector, { timeout: options.timeout || 10000 });
    return { ok: true, selector };
  },

  async blur({ page, selector, options = {} }) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.blur();
    }, selector);
    return { ok: true, selector };
  },
};

// ── Dispatch an element action ────────────────────────────────────────────────
async function dispatch(action, params) {
  const id  = params.calltoId || calltoId();
  const page = _getPage?.();

  if (!page) {
    const r = { calltoId: id, action, ok: false, error: 'No active Playwright page. Launch first.' };
    _busEmit?.('pw:element:result', r, 'WARN');
    return r;
  }

  const fn = ACTIONS[action];
  if (!fn) {
    const r = { calltoId: id, action, ok: false, error: `Unknown element action: ${action}` };
    _busEmit?.('pw:element:result', r, 'WARN');
    return r;
  }

  try {
    const result = await fn({ page, ...params });
    const r = { calltoId: id, action, selector: params.selector, ok: true, result };
    _busEmit?.('pw:element:result', r, 'INFO');
    _log(`✓ ${action} "${params.selector || '(window)'}"`);
    return r;
  } catch (e) {
    const r = { calltoId: id, action, selector: params.selector, ok: false, error: e.message };
    _busEmit?.('pw:element:result', r, 'WARN');
    _log(`✗ ${action} "${params.selector}": ${e.message}`);
    return r;
  }
}

// ── Cookie capture ────────────────────────────────────────────────────────────
async function captureCookies(opts = {}) {
  const page = _getPage?.();
  if (!page) return { ok: false, error: 'No active Playwright page' };

  const context = page.context();
  const all     = await context.cookies();

  // Group by domain
  const byDomain = {};
  for (const c of all) {
    const d = c.domain.replace(/^\./, '');
    (byDomain[d] = byDomain[d] || []).push({
      name:     c.name,
      value:    c.value,
      domain:   c.domain,
      path:     c.path,
      expires:  c.expires,
      httpOnly: c.httpOnly,
      secure:   c.secure,
      sameSite: c.sameSite,
    });
  }

  // Filter to target domain if provided
  const filtered = opts.domain
    ? all.filter(c => c.domain.includes(opts.domain))
    : all;

  const result = {
    ok:        true,
    total:     all.length,
    filtered:  filtered.length,
    byDomain,
    cookies:   filtered,
    url:       page.url(),
    capturedAt: new Date().toISOString(),
  };

  _busEmit?.('pw:cookies:captured', result, 'INFO');
  _log(`🍪 Captured ${all.length} cookies (${filtered.length} matching)`);
  return result;
}

// ── Cookie inject ─────────────────────────────────────────────────────────────
async function injectCookies(cookies = []) {
  const page = _getPage?.();
  if (!page) return { ok: false, error: 'No active Playwright page' };

  const context = page.context();
  await context.addCookies(cookies.map(c => ({
    name:     c.name,
    value:    c.value,
    domain:   c.domain,
    path:     c.path     || '/',
    expires:  c.expires  || -1,
    httpOnly: c.httpOnly || false,
    secure:   c.secure   || false,
    sameSite: c.sameSite || 'Lax',
  })));

  _busEmit?.('pw:cookies:injected', { count: cookies.length, url: page.url() }, 'INFO');
  return { ok: true, count: cookies.length };
}

// ── DOM snapshot (full page element tree) ─────────────────────────────────────
async function domSnapshot(opts = {}) {
  const page = _getPage?.();
  if (!page) return { ok: false, error: 'No active Playwright page' };

  const { maxDepth = 4, includeHidden = false } = opts;

  const snapshot = await page.evaluate(({ maxDepth, includeHidden }) => {
    function walk(el, depth) {
      if (depth > maxDepth) return null;
      const rect    = el.getBoundingClientRect();
      const visible = el.offsetParent !== null || el === document.body;
      if (!includeHidden && !visible) return null;

      return {
        tag:      el.tagName?.toLowerCase(),
        id:       el.id       || null,
        classes:  el.className ? el.className.split(' ').filter(Boolean) : [],
        text:     el.textContent?.trim().slice(0, 100) || null,
        attrs: {
          href:     el.href     || null,
          src:      el.src      || null,
          type:     el.type     || null,
          name:     el.name     || null,
          value:    el.value    !== undefined ? el.value : null,
          role:     el.getAttribute('role')       || null,
          ariaLabel: el.getAttribute('aria-label') || null,
        },
        rect:     { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        visible,
        children: Array.from(el.children).map(c => walk(c, depth + 1)).filter(Boolean),
      };
    }
    return walk(document.body, 0);
  }, { maxDepth, includeHidden });

  const result = {
    ok:       true,
    url:      page.url(),
    title:    await page.title(),
    snapshot,
    snapshotAt: new Date().toISOString(),
  };

  _busEmit?.('pw:dom:snapshot', { url: result.url, snapshotAt: result.snapshotAt }, 'INFO');
  return result;
}

// ── Bus wire-up: every pw:element:* event dispatches through the action table ─
function wireBus() {
  if (!_bus) return;

  for (const action of Object.keys(ACTIONS)) {
    _bus.on(`pw:element:${action}`, async (event) => {
      const params = event.data || event;
      await dispatch(action, { ...params, calltoId: params.calltoId || calltoId() });
    });
  }

  _bus.on('pw:cookies:capture', async (event) => {
    const params = event.data || event;
    await captureCookies(params);
  });

  _bus.on('pw:cookies:inject', async (event) => {
    const params = event.data || event;
    await injectCookies(params.cookies || []);
  });

  _bus.on('pw:dom:snapshot', async (event) => {
    const params = event.data || event;
    await domSnapshot(params);
  });

  _log('Bus wired — element actions: ' + Object.keys(ACTIONS).join(', '));
}

// ── HTTP route handler (/playwright/mirror/*) ─────────────────────────────────
async function route(parts, method, body, req, res) {
  // POST /playwright/mirror/element
  if (method === 'POST' && parts[2] === 'element') {
    const { action, ...params } = body;
    if (!action) return jsonRes(res, 400, { ok: false, error: 'action required' });
    const r = await dispatch(action, params);
    return jsonRes(res, r.ok ? 200 : (r.error?.includes('No active') ? 503 : 500), r);
  }

  // POST /playwright/mirror/cookies/capture
  if (method === 'POST' && parts[2] === 'cookies' && parts[3] === 'capture') {
    const r = await captureCookies(body);
    return jsonRes(res, r.ok ? 200 : 503, r);
  }

  // POST /playwright/mirror/cookies/inject
  if (method === 'POST' && parts[2] === 'cookies' && parts[3] === 'inject') {
    const r = await injectCookies(body.cookies || []);
    return jsonRes(res, r.ok ? 200 : 503, r);
  }

  // GET /playwright/mirror/cookies
  if (method === 'GET' && parts[2] === 'cookies') {
    const r = await captureCookies({ domain: req.url.includes('domain=') ? new URL('http://x' + req.url).searchParams.get('domain') : null });
    return jsonRes(res, r.ok ? 200 : 503, r);
  }

  // POST /playwright/mirror/dom/snapshot
  if (method === 'POST' && parts[2] === 'dom' && parts[3] === 'snapshot') {
    const r = await domSnapshot(body);
    return jsonRes(res, r.ok ? 200 : 503, r);
  }

  // GET /playwright/mirror/actions — list available actions
  if (method === 'GET' && parts[2] === 'actions') {
    return jsonRes(res, 200, {
      ok: true,
      actions: Object.keys(ACTIONS).map(a => ({
        name: a,
        busEvent: `pw:element:${a}`,
        httpEndpoint: 'POST /playwright/mirror/element',
        params: `{ action: "${a}", selector, ...opts }`,
      })),
      cookieEndpoints: [
        'GET  /playwright/mirror/cookies',
        'POST /playwright/mirror/cookies/capture  { domain? }',
        'POST /playwright/mirror/cookies/inject   { cookies: [...] }',
      ],
      domEndpoints: [
        'POST /playwright/mirror/dom/snapshot  { maxDepth?, includeHidden? }',
      ],
    });
  }

  return jsonRes(res, 404, { ok: false, error: 'Unknown mirror endpoint: /' + parts.join('/') });
}

// ── Install ───────────────────────────────────────────────────────────────────
function install({ bus, busEmit, getPage, logger }) {
  _bus     = bus;
  _busEmit = busEmit;
  _getPage = getPage;
  if (logger) _log = logger;
  wireBus();
  _log('Playwright Mirror Plugin installed');
}

module.exports = {
  install,
  route,
  dispatch,
  captureCookies,
  injectCookies,
  domSnapshot,
  ACTIONS: Object.keys(ACTIONS),
};
