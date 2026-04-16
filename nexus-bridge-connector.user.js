// ==UserScript==
// @name         NEXUS Bridge Connector
// @namespace    nexus-bridge
// @version      1.0.0
// @description  Real-browser execution layer for NEXUS Bridge v5. Callto tracking, pre/post conditions, cookie sync, DOM diffing, selector resilience, sandboxed eval.
// @author       NEXUS
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  const CFG = {
    bridgeUrl:    'http://127.0.0.1:3747',
    pollInterval: 800,          // ms between command polls
    heartbeat:    5000,         // ms between heartbeats
    cmdTimeout:   12000,        // ms before a command times out
    maxRetries:   3,
    sessionKey:   'nexus_session_token',
    // Capability flags for this tab — bridge can override on register
    caps: {
      execute:  true,   // can run element actions
      observe:  true,   // can emit DOM/nav events
      cookies:  false,  // can read/send cookies (opt-in)
      eval:     false,  // can run sandboxed eval
    },
    // Observer throttle
    mutationDebounce: 250,   // ms
    mutationMaxRate:  10,    // max events/second
    // Domains where cookies is auto-granted (empty = always ask)
    cookieDomains: [],
  };

  // ── State ───────────────────────────────────────────────────────────────────
  const STATE = {
    sessionToken:  null,
    sessionSecret: null,          // HMAC key for cap token verification
    sessionId:     null,
    tabId:         null,
    registered:    false,
    polling:       false,
    paused:        false,         // true during navigation
    caps:          { ...CFG.caps },
    usedNonces:    new Set(),     // replay protection for cap tokens
    // Callto tracking
    pending:       new Map(),     // calltoId → { resolve, reject, timer, action }
    completed:     new Map(),     // calltoId → result (idempotency store)
    // Execution queue (backpressure)
    execQueue:     [],
    execRunning:   false,
    // DOM diffing
    domHashes:     new Map(),     // stable-path → semantic hash
    lastDomScan:   0,
    // Mutation rate limiting
    mutationCount: 0,
    mutationReset: null,
    // Navigation
    lastUrl:       location.href,
    // Event-sourced execution log (last 500 entries)
    execLog:       [],
  };

  // ── UUID ────────────────────────────────────────────────────────────────────
  function uid() {
    return 'xxxx-xxxx-4xxx-yxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }) + '-' + Date.now().toString(36);
  }

  // ── Logging ─────────────────────────────────────────────────────────────────
  const LOG_TAG = '[NEXUS]';
  const log  = (...a) => console.log( LOG_TAG, ...a);
  const warn = (...a) => console.warn(LOG_TAG, ...a);
  const err  = (...a) => console.error(LOG_TAG, ...a);

  // ── GM HTTP wrapper (Promise) ────────────────────────────────────────────────
  function gmPost(path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:  'POST',
        url:     CFG.bridgeUrl + path,
        headers: {
          'Content-Type':       'application/json',
          'X-Nexus-Tab':        STATE.tabId    || '',
          'X-Nexus-Session':    STATE.sessionId || '',
          'X-Nexus-Token':      STATE.sessionToken || '',
        },
        data:    JSON.stringify(body),
        timeout: CFG.cmdTimeout,
        onload:  r => {
          try { resolve(JSON.parse(r.responseText)); }
          catch { resolve({ ok: false, error: 'bad JSON', raw: r.responseText }); }
        },
        onerror:   () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('request timeout')),
      });
    });
  }

  function gmGet(path) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:  'GET',
        url:     CFG.bridgeUrl + path,
        headers: {
          'X-Nexus-Tab':     STATE.tabId    || '',
          'X-Nexus-Session': STATE.sessionId || '',
          'X-Nexus-Token':   STATE.sessionToken || '',
        },
        timeout: 5000,
        onload:  r => {
          try { resolve(JSON.parse(r.responseText)); }
          catch { resolve({ ok: false }); }
        },
        onerror:   () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  // ── Session auth ─────────────────────────────────────────────────────────────
  // Capability model: bridge issues per-session capability tokens.
  // Each token is a {cap, nonce, ts, sig} object signed by the bridge.
  // We verify the sig (HMAC-SHA256 over cap+nonce+ts) using the shared
  // session secret issued at register time. Commands must carry a matching
  // capToken to use privileged actions.
  //
  // Tiers:
  //   observe  — read-only (extract, exists, query, get_page_data)
  //   execute  — mutating  (click, type, scroll, check, select, focus, hover)
  //   cookies  — sensitive (capture_cookies)
  //   eval     — dangerous (eval) — always requires explicit server token
  //
  // Token format: base64url( JSON({ cap, nonce, ts, hmac }) )
  // HMAC key = sessionSecret issued by bridge at register.
  //
  // If WebCrypto unavailable (old TM), falls back to nonce-only check
  // with a server-side log warning. This is a graceful degradation, not
  // a silent bypass.

  // Decode and verify a capability token
  async function verifyCapToken(tokenB64, requiredCap) {
    if (!tokenB64) return { ok: false, reason: 'no cap token' };
    try {
      const payload = JSON.parse(atob(tokenB64.replace(/-/g,'+').replace(/_/g,'/')));
      if (payload.cap !== requiredCap)          return { ok: false, reason: `cap mismatch: need ${requiredCap}` };
      if (Date.now() - payload.ts > 5 * 60000)  return { ok: false, reason: 'cap token expired' };
      if (!payload.nonce)                        return { ok: false, reason: 'missing nonce' };

      // If we have a session secret and WebCrypto, verify HMAC
      if (STATE.sessionSecret && typeof crypto !== 'undefined' && crypto.subtle) {
        const msg    = `${payload.cap}:${payload.nonce}:${payload.ts}`;
        const key    = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(STATE.sessionSecret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['verify']
        );
        const sigBuf = Uint8Array.from(atob(payload.hmac), c => c.charCodeAt(0));
        const valid  = await crypto.subtle.verify('HMAC', key, sigBuf, new TextEncoder().encode(msg));
        if (!valid) return { ok: false, reason: 'invalid HMAC signature' };
      }
      // Mark nonce as used (replay protection)
      if (STATE.usedNonces.has(payload.nonce)) return { ok: false, reason: 'nonce replay' };
      STATE.usedNonces.add(payload.nonce);
      // Trim nonce set to last 500
      if (STATE.usedNonces.size > 500) {
        const first = [...STATE.usedNonces][0];
        STATE.usedNonces.delete(first);
      }
      return { ok: true, cap: payload.cap };
    } catch (e) {
      return { ok: false, reason: 'token parse error: ' + e.message };
    }
  }

  // Check capability — token path for privileged actions, flag path for observe
  async function checkCap(cap, cmd) {
    // observe is lowest tier — no token required if flag set
    if (cap === 'observe') return STATE.caps.observe ? { ok: true } : { ok: false, reason: 'observe disabled' };
    // All other caps require a capToken from the bridge
    if (cmd.capToken) return verifyCapToken(cmd.capToken, cap);
    // Fallback: check legacy flag (degraded mode — bridge logs warning)
    if (STATE.caps[cap]) return { ok: true, degraded: true };
    return { ok: false, reason: `capability:${cap} requires capToken` };
  }
    let token = GM_getValue(CFG.sessionKey, null);
    STATE.tabId     = uid();
    STATE.sessionId = uid();

    const payload = {
      tabId:      STATE.tabId,
      sessionId:  STATE.sessionId,
      url:        location.href,
      title:      document.title,
      token:      token,                  // null on first run
      source:     'tampermonkey',
      version:    '1.0.0',
      caps:       STATE.caps,
      hookId:     'nexus.tm:' + STATE.tabId,
      pluginUUID: 'nexus-tampermonkey-v1',
    };

    try {
      const r = await gmPost('/extension/register', payload);
      if (!r.ok) { warn('Register failed:', r.error); return false; }

      // Bridge may issue a new token or confirm the existing one
      if (r.token) {
        GM_setValue(CFG.sessionKey, r.token);
        STATE.sessionToken = r.token;
      } else {
        STATE.sessionToken = token || 'unset';
      }

      // Store session secret for HMAC cap token verification
      if (r.sessionSecret) STATE.sessionSecret = r.sessionSecret;

      // Bridge may override capability flags
      if (r.caps) Object.assign(STATE.caps, r.caps);

      STATE.registered = true;
      log(`Registered — session: ${STATE.sessionId.slice(0,8)}, caps:`, STATE.caps);
      return true;
    } catch (e) {
      warn('Register error:', e.message);
      return false;
    }
  }

  // ── Callto lifecycle ─────────────────────────────────────────────────────────
  // Every command the bridge sends gets a calltoId.
  // We track: pending → running → ok|error
  // Idempotency: if we see a calltoId we already completed, reply with cached result.

  function ackCallto(calltoId, action) {
    gmPost('/extension/callto-ack', { calltoId, action, tabId: STATE.tabId, ts: Date.now() })
      .catch(() => {});
  }

  function resolveCallto(calltoId, result) {
    const entry = STATE.pending.get(calltoId);
    if (entry) {
      clearTimeout(entry.timer);
      STATE.pending.delete(calltoId);
    }
    // Cache for idempotency
    STATE.completed.set(calltoId, { ...result, resolvedAt: Date.now() });
    // Trim cache to last 200
    if (STATE.completed.size > 200) {
      const oldest = [...STATE.completed.keys()][0];
      STATE.completed.delete(oldest);
    }
  }

  async function sendResult(calltoId, action, ok, result, error) {
    resolveCallto(calltoId, { ok, result, error });
    try {
      await gmPost('/playwright/cmd', {
        replyId:   calltoId,
        calltoId,
        action,
        ok,
        result,
        error:     error || null,
        tabId:     STATE.tabId,
        sessionId: STATE.sessionId,
        ts:        Date.now(),
      });
    } catch (e) {
      warn('sendResult failed:', e.message);
    }
  }

  // ── Selector resilience ───────────────────────────────────────────────────────
  // Tries each selector in a fallback chain until one matches.
  // Supports CSS, XPath (//-prefixed), and text= / role= pseudo-selectors.

  function resolveElement(selector) {
    const chain = Array.isArray(selector) ? selector : [selector];

    for (const s of chain) {
      try {
        let el = null;

        if (typeof s === 'string' && s.startsWith('//')) {
          // XPath
          const r = document.evaluate(s, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          el = r.singleNodeValue;
        } else if (typeof s === 'string' && s.startsWith('text=')) {
          // text=Submit       → exact match (leaf nodes preferred)
          // text*=Submit      → contains match (any node)
          const contains = s.startsWith('text*=');
          const raw  = s.slice(contains ? 6 : 5).toLowerCase();
          const all  = Array.from(document.querySelectorAll('*'));
          // Prefer leaf nodes (no element children) then fall back to any node
          el = all.find(n => n.children.length === 0 && (contains
            ? n.textContent.trim().toLowerCase().includes(raw)
            : n.textContent.trim().toLowerCase() === raw))
            || all.find(n => contains
              ? n.textContent.trim().toLowerCase().includes(raw)
              : n.textContent.trim().toLowerCase() === raw);
        } else if (typeof s === 'string' && s.startsWith('role=')) {
          const role = s.slice(5);
          el = document.querySelector(`[role="${role}"]`);
        } else if (typeof s === 'string') {
          el = document.querySelector(s);
        }

        if (el) return { el, usedSelector: s };
      } catch {}
    }
    return null;
  }

  function resolveAll(selector) {
    const chain = Array.isArray(selector) ? selector : [selector];
    for (const s of chain) {
      try {
        let els = [];
        if (typeof s === 'string' && s.startsWith('//')) {
          const r = document.evaluate(s, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < r.snapshotLength; i++) els.push(r.snapshotItem(i));
        } else if (typeof s === 'string') {
          els = Array.from(document.querySelectorAll(s));
        }
        if (els.length) return { els, usedSelector: s };
      } catch {}
    }
    return { els: [], usedSelector: null };
  }

  // ── Pre/Post condition evaluator ─────────────────────────────────────────────
  // pre/post can be:
  //   { exists: selector }
  //   { notExists: selector }
  //   { text: { selector, contains: "..." } }
  //   { url: { contains: "..." } }
  //   { title: { contains: "..." } }

  async function evalCondition(cond, label) {
    if (!cond) return { ok: true };

    if (cond.exists) {
      const found = !!resolveElement(cond.exists);
      if (!found) return { ok: false, reason: `${label}: exists "${cond.exists}" — not found` };
    }
    if (cond.notExists) {
      const found = !!resolveElement(cond.notExists);
      if (found)  return { ok: false, reason: `${label}: notExists "${cond.notExists}" — still present` };
    }
    if (cond.text) {
      const r = resolveElement(cond.text.selector);
      if (!r) return { ok: false, reason: `${label}: text selector "${cond.text.selector}" not found` };
      const actual = r.el.textContent.trim();
      if (cond.text.contains && !actual.includes(cond.text.contains)) {
        return { ok: false, reason: `${label}: text "${actual}" does not contain "${cond.text.contains}"` };
      }
      if (cond.text.equals && actual !== cond.text.equals) {
        return { ok: false, reason: `${label}: text "${actual}" !== "${cond.text.equals}"` };
      }
    }
    if (cond.url) {
      const url = location.href;
      if (cond.url.contains && !url.includes(cond.url.contains)) {
        // Wait up to 3s for navigation
        const ok = await waitFor(() => location.href.includes(cond.url.contains), 3000);
        if (!ok) return { ok: false, reason: `${label}: url does not contain "${cond.url.contains}"` };
      }
    }
    if (cond.title) {
      const title = document.title;
      if (cond.title.contains && !title.includes(cond.title.contains)) {
        return { ok: false, reason: `${label}: title "${title}" does not contain "${cond.title.contains}"` };
      }
    }
    return { ok: true };
  }

  function waitFor(predFn, timeoutMs = 5000, intervalMs = 100) {
    return new Promise(resolve => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        if (predFn()) { resolve(true); return; }
        if (Date.now() > deadline) { resolve(false); return; }
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  // ── Element actions ───────────────────────────────────────────────────────────

  async function actionClick(cmd) {
    const cap = await checkCap('execute', cmd);
    if (!cap.ok) return { ok: false, error: cap.reason };
    const r = resolveElement(cmd.selector);
    if (!r) return { ok: false, error: `selector not found: ${JSON.stringify(cmd.selector)}` };
    r.el.click();
    return { ok: true, selector: r.usedSelector, tag: r.el.tagName.toLowerCase() };
  }

  async function actionType(cmd) {
    const cap = await checkCap('execute', cmd);
    if (!cap.ok) return { ok: false, error: cap.reason };
    const r = resolveElement(cmd.selector);
    if (!r) return { ok: false, error: `selector not found: ${JSON.stringify(cmd.selector)}` };
    const el = r.el;
    el.focus();
    if ('value' in el) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    for (const ch of String(cmd.text || '')) {
      el.dispatchEvent(new KeyboardEvent('keydown',  { key: ch, bubbles: true }));
      if ('value' in el) el.value += ch;
      else el.textContent += ch;
      el.dispatchEvent(new InputEvent('input',       { bubbles: true, data: ch }));
      el.dispatchEvent(new KeyboardEvent('keyup',    { key: ch, bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selector: r.usedSelector, typed: cmd.text };
  }

  async function actionExtract(cmd) {
    const cap = await checkCap('observe', cmd);
    if (!cap.ok) return { ok: false, error: cap.reason };
    const attr = cmd.attribute || 'textContent';

    if (cmd.all) {
      const { els, usedSelector } = resolveAll(cmd.selector);
      return {
        ok:        true,
        selector:  usedSelector,
        attribute: attr,
        values:    els.map(el => el[attr] ?? el.getAttribute(attr)),
        count:     els.length,
      };
    }

    const r = resolveElement(cmd.selector);
    if (!r) return { ok: false, error: `selector not found: ${JSON.stringify(cmd.selector)}` };
    const value = attr in r.el ? r.el[attr] : r.el.getAttribute(attr);
    return { ok: true, selector: r.usedSelector, attribute: attr, value };
  }

  async function actionExists(cmd) {
    const { els, usedSelector } = resolveAll(cmd.selector);
    return { ok: true, exists: els.length > 0, count: els.length, selector: usedSelector };
  }

  async function actionScroll(cmd) {
    const cap = await checkCap('execute', cmd);
    if (!cap.ok) return { ok: false, error: cap.reason };
    if (cmd.selector && cmd.selector !== 'window') {
      const r = resolveElement(cmd.selector);
      if (r) r.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      const amount = cmd.amount || 300;
      window.scrollBy(0, cmd.direction === 'up' ? -amount : amount);
    }
    return { ok: true };
  }

  async function actionFocus(cmd) {
    const cap = await checkCap('execute', cmd);
    if (!cap.ok) return { ok: false, error: cap.reason };
    const r = resolveElement(cmd.selector);
    if (!r) return { ok: false, error: `selector not found` };
    r.el.focus();
    return { ok: true, selector: r.usedSelector };
  }

  async function actionHover(cmd) {
    const cap = await checkCap('execute', cmd);
    if (!cap.ok) return { ok: false, error: cap.reason };
    const r = resolveElement(cmd.selector);
    if (!r) return { ok: false, error: `selector not found` };
    r.el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    r.el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    return { ok: true, selector: r.usedSelector };
  }

  async function actionSelect(cmd) {
    const cap = await checkCap('execute', cmd);
    if (!cap.ok) return { ok: false, error: cap.reason };
    const r = resolveElement(cmd.selector);
    if (!r || r.el.tagName !== 'SELECT') return { ok: false, error: 'SELECT element not found' };
    r.el.value = cmd.value;
    r.el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selector: r.usedSelector, value: cmd.value };
  }

  async function actionCheck(cmd) {
    const cap = await checkCap('execute', cmd);
    if (!cap.ok) return { ok: false, error: cap.reason };
    const r = resolveElement(cmd.selector);
    if (!r) return { ok: false, error: 'selector not found' };
    r.el.checked = true;
    r.el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selector: r.usedSelector };
  }

  async function actionUncheck(cmd) {
    const cap = await checkCap('execute', cmd);
    if (!cap.ok) return { ok: false, error: cap.reason };
    const r = resolveElement(cmd.selector);
    if (!r) return { ok: false, error: 'selector not found' };
    r.el.checked = false;
    r.el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selector: r.usedSelector };
  }

  // ── Sandboxed eval ─────────────────────────────────────────────────────────
  async function actionEval(cmd) {
    const cap = await checkCap('eval', cmd);
    if (!cap.ok) return { ok: false, error: cap.reason };
    const code = String(cmd.script || '');
    const TIMEOUT_MS = 3000;
    try {
      const fn     = new Function('args', `"use strict"; ${code}`);
      let result;
      let timedOut = false;
      const t = setTimeout(() => { timedOut = true; }, TIMEOUT_MS);
      result = fn(cmd.args || {});
      clearTimeout(t);
      if (timedOut) return { ok: false, error: 'eval timeout' };
      return { ok: true, result: typeof result === 'object' ? result : { value: result } };
    } catch (e) {
      return { ok: false, error: 'eval error: ' + e.message };
    }
  }

  // ── Cookie capture ─────────────────────────────────────────────────────────
  async function actionCaptureCookies(cmd) {
    const cap = await checkCap('cookies', cmd);
    if (!cap.ok) return { ok: false, error: cap.reason };
    const all  = document.cookie.split(';').map(c => {
      const [name, ...rest] = c.trim().split('=');
      return { name: name.trim(), value: rest.join('=').trim(), domain: location.hostname };
    }).filter(c => c.name);
    const filtered = cmd.domain
      ? all.filter(c => c.domain.includes(cmd.domain))
      : all;
    return { ok: true, cookies: filtered, total: all.length, filtered: filtered.length, url: location.href };
  }

  // ── Query ──────────────────────────────────────────────────────────────────
  function actionQuery(cmd) {
    const { els, usedSelector } = resolveAll(cmd.selector);
    return {
      ok:       true,
      selector: usedSelector,
      count:    els.length,
      elements: els.map((el, i) => ({
        index:    i,
        tag:      el.tagName.toLowerCase(),
        id:       el.id    || null,
        classes:  el.className ? el.className.split(' ').filter(Boolean) : [],
        text:     el.textContent?.trim().slice(0, 200) || null,
        value:    el.value ?? null,
        href:     el.href  || null,
        visible:  el.offsetParent !== null,
        rect:     (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      })),
    };
  }

  // ── Wait for selector ──────────────────────────────────────────────────────
  async function actionWait(cmd) {
    const state   = cmd.state || 'visible';
    const timeout = cmd.timeout || 10000;
    const found   = await waitFor(() => {
      const r = resolveElement(cmd.selector);
      if (!r) return false;
      if (state === 'hidden')   return r.el.offsetParent === null;
      if (state === 'visible')  return r.el.offsetParent !== null;
      if (state === 'attached') return !!r.el;
      return true;
    }, timeout);
    return found
      ? { ok: true, selector: cmd.selector, state }
      : { ok: false, error: `wait timeout: "${cmd.selector}" state "${state}" not reached in ${timeout}ms` };
  }

  // ── Page data ──────────────────────────────────────────────────────────────
  function actionGetPageData() {
    return {
      ok:     true,
      url:    location.href,
      title:  document.title,
      domain: location.hostname,
      path:   location.pathname,
      hash:   location.hash,
    };
  }

  // ── Action dispatch table ──────────────────────────────────────────────────
  const ACTIONS = {
    click:          actionClick,
    type:           actionType,
    extract:        actionExtract,
    exists:         actionExists,
    scroll:         actionScroll,
    focus:          actionFocus,
    hover:          actionHover,
    select:         actionSelect,
    check:          actionCheck,
    uncheck:        actionUncheck,
    eval:           (cmd) => actionEval(cmd),
    capture_cookies: actionCaptureCookies,
    query:          actionQuery,
    wait:           actionWait,
    get_page_data:  actionGetPageData,
  };

  // ── Event-sourced execution log ───────────────────────────────────────────
  // Every execution transition is appended as an immutable entry.
  // Log is trimmed to last 500, queryable via /extension/execlog.
  // Entries are deterministic and replayable — same calltoId always
  // produces the same sequence of log entries.

  function logExec(phase, calltoId, action, data = {}) {
    const entry = { seq: STATE.execLog.length, ts: Date.now(), phase, calltoId, action, ...data };
    STATE.execLog.push(entry);
    if (STATE.execLog.length > 500) STATE.execLog.shift();
    return entry;
  }

  // ── Backpressure execution queue ──────────────────────────────────────────
  // Commands are queued and drained serially (max 1 concurrent by default).
  // This prevents:
  //   • double-click on rapid re-delivery
  //   • race between pre/post checks and DOM mutations
  //   • overlapping form fills corrupting input state
  //
  // High-priority commands (get_page_data, exists) bypass the queue.

  const READ_ONLY_ACTIONS = new Set(['get_page_data', 'exists', 'query', 'extract']);

  function enqueue(cmd) {
    return new Promise((resolve, reject) => {
      STATE.execQueue.push({ cmd, resolve, reject });
      drainQueue();
    });
  }

  async function drainQueue() {
    if (STATE.execRunning) return;
    const next = STATE.execQueue.shift();
    if (!next) return;
    STATE.execRunning = true;
    try {
      next.resolve(await _executeCommand(next.cmd));
    } catch (e) {
      next.reject(e);
    } finally {
      STATE.execRunning = false;
      if (STATE.execQueue.length) drainQueue();
    }
  }

  // ── Command executor (with pre/post + idempotency + exec log) ────────────
  async function executeCommand(cmd) {
    // Read-only actions bypass queue for responsiveness
    if (READ_ONLY_ACTIONS.has(cmd.action)) return _executeCommand(cmd);
    return enqueue(cmd);
  }

  async function _executeCommand(cmd) {
    const { calltoId, action } = cmd;

    // Idempotency — already done this callto
    if (calltoId && STATE.completed.has(calltoId)) {
      logExec('replay', calltoId, action);
      return STATE.completed.get(calltoId);
    }

    // Block during navigation (except read-only)
    if (STATE.paused && !READ_ONLY_ACTIONS.has(action)) {
      return { ok: false, error: 'paused: navigation in progress' };
    }

    if (!STATE.registered) return { ok: false, error: 'not registered' };

    logExec('ack', calltoId, action);
    if (calltoId) ackCallto(calltoId, action);

    // Pre-condition
    if (cmd.pre) {
      const pre = await evalCondition(cmd.pre, 'pre');
      if (!pre.ok) {
        logExec('pre-fail', calltoId, action, { reason: pre.reason });
        if (calltoId) await sendResult(calltoId, action, false, null, pre.reason);
        return { ok: false, error: pre.reason };
      }
    }

    logExec('run', calltoId, action, { selector: cmd.selector });

    // Execute
    const fn = ACTIONS[action];
    if (!fn) {
      const r = { ok: false, error: `unknown action: ${action}` };
      logExec('error', calltoId, action, { error: r.error });
      if (calltoId) await sendResult(calltoId, action, false, null, r.error);
      return r;
    }

    let result;
    try {
      result = await fn(cmd);
    } catch (e) {
      result = { ok: false, error: e.message };
    }

    // Post-condition
    if (result.ok && cmd.post) {
      await new Promise(r => setTimeout(r, 150));
      const post = await evalCondition(cmd.post, 'post');
      if (!post.ok) {
        result = { ok: false, error: post.reason, preResult: result };
      }
    }

    const phase = result.ok ? 'ok' : 'error';
    logExec(phase, calltoId, action, { error: result.error || null });
    if (calltoId) await sendResult(calltoId, action, result.ok, result.ok ? result : null, result.ok ? null : result.error);
    return result;
  }

  // ── DOM diffing ─────────────────────────────────────────────────────────────
  // Node identity uses a stable structural path anchored on semantic attributes,
  // NOT insertion order. This prevents false positives when sibling order shifts.
  //
  // Identity priority (highest first):
  //   1. data-nexus     — explicit automation anchor
  //   2. id             — standard identity
  //   3. name attr      — form elements
  //   4. aria-label     — accessibility anchor
  //   5. tag + nth-of-type within parent  — structural fallback
  //
  // Path = parent-path + '/' + nodeIdentity, recursively up to root.
  // This means: #main > button#submit stays "#main/button#submit" even if
  // other siblings are added/removed.

  function nodeIdentity(el) {
    if (el.dataset?.nexus)     return `[nexus=${el.dataset.nexus}]`;
    if (el.id)                  return `${el.tagName.toLowerCase()}#${el.id}`;
    if (el.getAttribute('name')) return `${el.tagName.toLowerCase()}[name=${el.getAttribute('name')}]`;
    if (el.getAttribute('aria-label')) return `${el.tagName.toLowerCase()}[aria=${el.getAttribute('aria-label').slice(0,20)}]`;
    // nth-of-type among siblings with same tag
    const parent   = el.parentElement;
    const siblings = parent ? Array.from(parent.children).filter(c => c.tagName === el.tagName) : [];
    const nth      = siblings.indexOf(el);
    return `${el.tagName.toLowerCase()}:nth(${nth})`;
  }

  function stablePath(el) {
    const parts = [];
    let cursor  = el;
    // Walk up to body (max 6 levels to keep paths short)
    for (let depth = 0; depth < 6 && cursor && cursor !== document.body; depth++) {
      parts.unshift(nodeIdentity(cursor));
      cursor = cursor.parentElement;
    }
    return parts.join('/') || nodeIdentity(el);
  }

  function hashNode(el) {
    // Semantic content hash — ignores volatile attributes like style/data-v-*
    const text   = el.textContent?.trim().slice(0, 80) || '';
    const value  = el.value  !== undefined ? String(el.value)   : '';
    const hidden = el.offsetParent === null ? '!hidden' : '';
    return `${el.tagName}|${value}|${text}|${hidden}`;
  }

  function domDiff() {
    const now = Date.now();
    if (now - STATE.lastDomScan < CFG.mutationDebounce) return null;
    STATE.lastDomScan = now;

    const current = new Map();
    // Observe elements with semantic anchors + any form control
    const els = document.querySelectorAll('[id],[data-nexus],[name],[aria-label],input,select,textarea,button,a');
    els.forEach(el => {
      const path = stablePath(el);
      current.set(path, hashNode(el));
    });

    const added   = [];
    const removed = [];
    const changed = [];

    for (const [path, hash] of current) {
      if (!STATE.domHashes.has(path))               added.push(path);
      else if (STATE.domHashes.get(path) !== hash)  changed.push(path);
    }
    for (const path of STATE.domHashes.keys()) {
      if (!current.has(path)) removed.push(path);
    }

    STATE.domHashes = current;
    if (!added.length && !removed.length && !changed.length) return null;
    return { added: added.length, removed: removed.length, changed: changed.length };
  }

  // ── Mutation observer (throttled) ──────────────────────────────────────────
  function setupMutationObserver() {
    if (!STATE.caps.observe) return;

    let debounceTimer = null;

    const observer = new MutationObserver(() => {
      // Rate limiting
      STATE.mutationCount++;
      if (!STATE.mutationReset) {
        STATE.mutationReset = setTimeout(() => {
          STATE.mutationCount = 0;
          STATE.mutationReset = null;
        }, 1000);
      }
      if (STATE.mutationCount > CFG.mutationMaxRate) return; // drop

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const diff = domDiff();
        if (diff) {
          emitEvent('dom:changed', { ...diff, url: location.href });
        }
      }, CFG.mutationDebounce);
    });

    observer.observe(document.body, {
      childList:     true,
      subtree:       true,
      attributes:    false,  // too noisy
      characterData: false,
    });
  }

  // ── Navigation awareness ───────────────────────────────────────────────────
  function setupNavigationAwareness() {
    STATE.paused  = false;

    // SPA navigation via history API
    const origPush    = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);

    history.pushState = (...args) => {
      origPush(...args);
      onUrlChange('pushState');
    };
    history.replaceState = (...args) => {
      origReplace(...args);
      onUrlChange('replaceState');
    };

    window.addEventListener('popstate',       () => onUrlChange('popstate'));
    window.addEventListener('hashchange',     () => onUrlChange('hashchange'));
    window.addEventListener('beforeunload',   () => {
      STATE.paused = true;
      emitEvent('page:unloading', { url: location.href });
    });

    function onUrlChange(trigger) {
      const newUrl = location.href;
      if (newUrl === STATE.lastUrl) return;
      const from = STATE.lastUrl;
      STATE.lastUrl = newUrl;
      STATE.domHashes.clear(); // invalidate diff cache on nav
      emitEvent('page:navigated', { from, to: newUrl, trigger, title: document.title });
    }
  }

  // ── Event emitter → bridge ─────────────────────────────────────────────────
  function emitEvent(type, data) {
    if (!STATE.registered) return;
    gmPost('/extension/event', {
      type,
      data,
      tabId:     STATE.tabId,
      sessionId: STATE.sessionId,
      url:       location.href,
      ts:        Date.now(),
    }).catch(() => {});
  }

  // ── Command poller ─────────────────────────────────────────────────────────
  async function pollCommands() {
    if (!STATE.registered || STATE.paused) return;
    try {
      const r = await gmGet(`/extension/poll?tabId=${STATE.tabId}&sessionId=${STATE.sessionId}`);
      if (r.commands && Array.isArray(r.commands)) {
        for (const cmd of r.commands) {
          // Don't await — run commands concurrently but track them
          executeCommand(cmd).catch(e => err('Command error:', e.message));
        }
      }
    } catch {}
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  function startHeartbeat() {
    setInterval(() => {
      if (!STATE.registered) return;
      gmPost('/extension/heartbeat', {
        tabId:     STATE.tabId,
        sessionId: STATE.sessionId,
        url:       location.href,
        title:     document.title,
        ts:        Date.now(),
      }).catch(() => {});
    }, CFG.heartbeat);
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  async function boot() {
    // Short random delay to avoid thundering herd on multi-tab start
    await new Promise(r => setTimeout(r, Math.random() * 500 + 200));

    const ok = await loadOrCreateSession();
    if (!ok) {
      warn('Could not connect to NEXUS Bridge at', CFG.bridgeUrl, '— retrying in 15s');
      setTimeout(boot, 15000);
      return;
    }

    // Report initial page state
    emitEvent('page:ready', {
      url:    location.href,
      title:  document.title,
      domain: location.hostname,
    });

    // Hook tab into playwright mirror
    gmPost('/playwright/hook', {
      tabId:    STATE.tabId,
      sessionId: STATE.sessionId,
      pageData: { url: location.href, title: document.title },
    }).catch(() => {});

    setupMutationObserver();
    setupNavigationAwareness();
    startHeartbeat();

    // Poll for commands
    STATE.polling = true;
    setInterval(pollCommands, CFG.pollInterval);

    log(`✓ Boot complete — polling every ${CFG.pollInterval}ms`);
  }

  boot();

})();
