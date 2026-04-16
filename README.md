# NEXUS Bridge — Service Layer

Six files that extend **NEXUS Bridge v5** (`nexus-bridge-server.js`) with a Windows service wrapper, a real-browser execution layer, a DOM element API, and full test coverage.

```
nexus-bridge-service.js          Windows NT service wrapper
nexus-playwright-mirror.js       DOM elements → bus events + REST
nexus-element-api.js             Element operations as tracked calltos
nexus-bridge-connector.user.js   Tampermonkey real-browser agent
test-bridge-service.js           Test suite — service + mirror + element API  (64 tests)
test-bridge-connector.js         Test suite — connector logic                  (98 tests)
```

---

## Quick start

```bash
# Install (bridge root)
npm install node-windows --save   # Windows service support

# Windows service
node nexus-bridge-service.js install
node nexus-bridge-service.js start

# Foreground / Linux / dev
node nexus-bridge-service.js run

# Tests (no browser, no running bridge needed)
node test-bridge-service.js      # 64/64
node test-bridge-connector.js    # 98/98
```

**Tampermonkey**: paste `nexus-bridge-connector.user.js` into Tampermonkey → Create new script. Works on any page while the bridge is running at `127.0.0.1:3747`.

---

## nexus-bridge-service.js

Wraps `nexus-bridge-server.js` as a proper Windows NT service.

**Commands**

| Command | Effect |
|---|---|
| `install` | Register with Windows SCM, auto-start on boot |
| `uninstall` | Deregister |
| `start` | `net start NexusBridge` |
| `stop` | `net stop NexusBridge` |
| `status` | `sc query NexusBridge` |
| `run` | Foreground mode (what SCM calls internally, also works on Linux/Mac) |

**Restart policy** — exponential backoff: 1s → 2s → 5s → 10s → 30s → 60s, up to 5 attempts before giving up.

**Health check** — polls `GET /health` every 15 seconds. Kills and restarts the child process if it stops responding.

**Environment**

| Var | Default | Purpose |
|---|---|---|
| `NEXUS_BRIDGE_ROOT` | `..` | Path to bridge root |
| `NEXUS_PORT` | `3666` | Health check port |
| `NODE_ENV` | `production` | Passed to child |

**Files written**
- `data/bridge.pid` — current child PID
- `data/service-logs/bridge-svc-YYYY-MM-DD.log` — rolling daily log (JSON lines)

---

## nexus-playwright-mirror.js

Mirrors live browser DOM elements onto the NEXUS bus and as REST endpoints. Installs alongside the existing `PlaywrightController`.

**Wire-up** (add to `nexus-bridge-server.js`):
```js
const Mirror = require('./nexus-playwright-mirror');
Mirror.install({ bus, busEmit, getPage: () => PlaywrightController.getState().page });

// In route handler:
if (parts[0] === 'playwright' && parts[1] === 'mirror')
  return Mirror.route(parts, method, body, req, res);
```

**Element actions** — available via bus event or HTTP:

```js
// Bus
bus.emit('pw:element:click', { selector: '#submit' });
bus.on('pw:element:result', ({ data }) => console.log(data));

// HTTP
POST /playwright/mirror/element
{ "action": "click", "selector": "#submit" }
```

| Action | Key params | Returns |
|---|---|---|
| `click` | `selector` | `{ ok, selector }` |
| `type` | `selector`, `text` | `{ ok, typed }` |
| `extract` | `selector`, `attribute?` | `{ ok, value }` |
| `screenshot` | `selector` | `{ ok, base64 }` |
| `wait` | `selector`, `state?` | `{ ok, state }` |
| `exists` | `selector` | `{ ok, exists, count }` |
| `query` | `selector` | `{ ok, count, elements[] }` |
| `scroll` | `selector`, `direction?` | `{ ok }` |
| `hover` | `selector` | `{ ok }` |
| `select` | `selector`, `value` | `{ ok, value }` |
| `check` | `selector` | `{ ok }` |
| `uncheck` | `selector` | `{ ok }` |
| `focus` | `selector` | `{ ok }` |
| `blur` | `selector` | `{ ok }` |

`attribute` defaults to `textContent`. Also accepts `innerHTML`, `innerText`, or any HTML attribute name.

**Cookie endpoints**

```
GET  /playwright/mirror/cookies
GET  /playwright/mirror/cookies?domain=example.com
POST /playwright/mirror/cookies/capture   { domain? }
POST /playwright/mirror/cookies/inject    { cookies: [...] }
POST /playwright/mirror/dom/snapshot      { maxDepth?, includeHidden? }
GET  /playwright/mirror/actions
```

---

## nexus-element-api.js

Wraps mirror actions as **callto objects** — trackable, persisted, retryable. Follows the NEXUS invariant: calltos survive bridge restarts.

**Wire-up**:
```js
const ElementApi = require('./nexus-element-api');
ElementApi.install({ mirror: Mirror, busEmit, calltoDir: path.join(dataDir, 'calltos') });

if (parts[0] === 'api' && parts[1] === 'elements')
  return ElementApi.route(parts, method, body, req, res);
```

**Callto schema**
```json
{
  "id": "el_a1b2c3d4",
  "action": "click",
  "selector": "#submit",
  "status": "ok",
  "result": { "ok": true },
  "durationMs": 43,
  "retries": 0,
  "createdAt": "2026-04-14T12:00:00.000Z"
}
```

**Endpoints**

```
POST   /api/elements/callto              { action, selector, params?, tag? }
GET    /api/elements/calltos             list (last 200)
GET    /api/elements/callto/:id
POST   /api/elements/callto/:id/retry
DELETE /api/elements/callto/:id

POST   /api/elements/batch               { steps: [{ action, selector, params }] }
POST   /api/elements/form/fill           { fields: { selector: value } }
POST   /api/elements/page/extract        { schema: { name: { selector, attribute? } } }
GET    /api/elements/actions
```

**Form fill example**
```json
POST /api/elements/form/fill
{
  "fields": {
    "input[name='email']": "user@example.com",
    "input[name='password']": "secret"
  }
}
```

**Page extract example**
```json
POST /api/elements/page/extract
{
  "schema": {
    "title":    { "selector": "h1" },
    "price":    { "selector": ".price" },
    "imageUrl": { "selector": "img.hero", "attribute": "src" }
  }
}
```

---

## nexus-bridge-connector.user.js

Tampermonkey userscript. Turns any browser tab into a controlled execution node connected to the bridge.

**Install**: Tampermonkey → Create new script → paste file contents.

**What it does**

```
Bridge Server (3747)
       ↓  poll commands
Tampermonkey Agent (this script)
       ↓  execute
Real DOM + Live Session
       ↓  emit events
Bridge Server
```

**Session auth** — on first load, registers with `POST /extension/register`. Bridge may issue a session token and override capability flags per tab. Token persisted in `GM_setValue`.

**Capability flags** — all off by default except `execute` and `observe`. Bridge grants per-session:

| Flag | Default | Controls |
|---|---|---|
| `execute` | `true` | click, type, scroll, check, select, focus, hover |
| `observe` | `true` | extract, exists, query, dom:changed events |
| `cookies` | `false` | capture_cookies action |
| `eval` | `false` | sandboxed eval action |

**Selector resilience** — every selector can be a fallback chain:
```json
["#submit", "button[type=submit]", "text=Submit", "role=button"]
```
Supports: CSS, XPath (`//`-prefixed), `text=` (exact), `text*=` (contains), `role=`.

**Pre/Post conditions**
```json
{
  "action": "click",
  "selector": "#submit",
  "pre":  { "exists": "#submit" },
  "post": { "url": { "contains": "dashboard" } }
}
```
Supported: `exists`, `notExists`, `text.contains`, `text.equals`, `url.contains`, `title.contains`.

**Callto tracking** — every command is acked, tracked, and result-correlated by `calltoId`. Completed calltos cached for idempotent replay — reconnects cannot cause double-execution.

**Sandboxed eval** — wrapped in `new Function` with `"use strict"`. AST guard blocks 7 dangerous patterns before execution: `eval()`, `new Function()`, `__proto__`, `prototype[`, `Object.defineProperty`, `location.href=`, `document.cookie=`, `fetch()`, `XMLHttpRequest`, `importScripts()`.

**DOM diffing** — throttled MutationObserver (250ms debounce, 10 events/sec cap). Node identity anchored on `data-nexus` > `id` > `name` > `aria-label` > `tag:nth-of-type` — not insertion order.

**Navigation awareness** — intercepts `pushState`, `replaceState`, `popstate`, `hashchange`, `beforeunload`. Blocks command execution during page unload. Emits `page:navigated` on every URL change.

**Bus events emitted**

| Event | When |
|---|---|
| `page:ready` | Script boots, page loaded |
| `page:navigated` | URL changes |
| `page:unloading` | `beforeunload` fires |
| `dom:changed` | DOM mutation detected (throttled) |

**Bridge endpoints used**

| Method | Path | Purpose |
|---|---|---|
| POST | `/extension/register` | Session handshake |
| POST | `/extension/heartbeat` | Keepalive every 5s |
| POST | `/extension/callto-ack` | Ack receipt of command |
| POST | `/extension/event` | Emit page/dom events |
| GET | `/extension/poll` | Poll for pending commands |
| POST | `/playwright/hook` | Register active tab |
| POST | `/playwright/cmd` | Send command result |

---

## Bus event reference

| Event (in) | Payload | Description |
|---|---|---|
| `pw:element:<action>` | `{ selector, ...params }` | Trigger element action |
| `pw:cookies:capture` | `{ domain? }` | Capture cookies |
| `pw:cookies:inject` | `{ cookies: [...] }` | Inject cookies |
| `pw:dom:snapshot` | `{ maxDepth?, includeHidden? }` | DOM snapshot |

| Event (out) | Payload | Description |
|---|---|---|
| `pw:element:result` | `{ calltoId, action, ok, result, error }` | Element action result |
| `pw:cookies:captured` | full capture result | After cookie capture |
| `pw:cookies:injected` | `{ count, url }` | After inject |
| `element:callto:running` | `{ id, action, selector }` | Callto started |
| `element:callto:resolved` | `{ id, status, durationMs }` | Callto finished |
| `element:batch:resolved` | `{ batchId, total, allOk }` | Batch finished |

---

## Test suites

```bash
node test-bridge-service.js      # 64 tests
node test-bridge-connector.js    # 98 tests
```

Both suites run without a browser, without a running bridge, and without any external dependencies beyond Node.

**test-bridge-service.js** (64 tests)

| Suite | Tests | Covers |
|---|---|---|
| 1 — Module loading | 3 | exports, action inventory |
| 2 — Element actions | 18 | all 14 actions + error paths |
| 3 — Cookie capture | 8 | capture, filter, inject, bus events |
| 4 — DOM snapshot | 2 | shape, fields |
| 5 — Element API calltos | 6 | CRUD, disk persistence, formFill, pageExtract |
| 6 — HTTP routes | 16 | every endpoint, error codes |
| 7 — Bus wire-up | 4 | events route to dispatch |
| 8 — Service structure | 5 | file presence, restart policy |
| 9 — Cookie invariants | 4 | schema, domain stripping, round-trip |

**test-bridge-connector.js** (98 tests)

| Suite | Tests | Covers |
|---|---|---|
| 1 — Selector resilience | 16 | CSS, XPath, text=, text*=, role=, fallback chains |
| 2 — Pre/Post conditions | 11 | all condition types, combined |
| 3 — Element actions | 12 | click/type/extract/check/select/focus/query |
| 4 — Sandboxed eval | 15 | arithmetic, args, errors, 7 AST blocks |
| 5 — Cookie model | 14 | RFC 6265 domain/path rules, = in value |
| 6 — Stable-path diffing | 9 | added/removed/changed, identity hierarchy |
| 7 — Idempotency store | 4 | cache, LRU trim |
| 8 — Async DOM simulation | 5 | microtask queue, SPA nav, mutation bursts |
| 9 — State lifecycle | 8 | valid transitions, terminal state, retry |
| 10 — Callto lifecycle | 4 | ack→run→ok/error, concurrency |

The mock DOM in suite 9 has a real parent/child tree, nth-of-type among siblings, event bubbling, `*` wildcard and attribute-existence selectors, and a microtask-accurate async flush — so tests validate behaviour that will hold in a real browser, not just in a simplified model.
