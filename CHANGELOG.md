# CHANGELOG

All changes to the NEXUS Bridge Service Layer since initial creation.

---

## [1.2.0] — 2026-04-15

### test-bridge-connector.js — v2.0.0 (complete rewrite)

**Mock DOM — full rewrite**
- Added real parent/child tree via `appendChild` — v1 had flat element lists with no structural relationships
- Added event bubbling: `dispatchEvent` propagates up the parent chain
- Added `nth-of-type` calculation among same-tag siblings
- Fixed `_matchesSelector` to handle `*` wildcard — without this, `text=`, `role=`, and the entire diffing suite resolved zero elements
- Fixed `_matchesSelector` to handle bare attribute-existence selectors (`[id]`, `[name]`, `[aria-label]`) — required by the DOM diff's multi-selector query
- Fixed `_matchesSelector` attribute value operators: `*=`, `^=`, `$=`
- `buildDom()` now constructs a realistic nested page: `body > div#main > header > nav > a[×2]`, `main > h1 + form[fields] + span#price + div.card[×2]`, `div#loader[hidden]`

**Cookie model — full rewrite (Suite 5)**
- RFC 6265 domain matching: `.example.com` matches `sub.example.com` and `example.com` but not `evil.com`
- Path prefix boundary rule: `/app` does not match `/application` (must be followed by `/` or be exact)
- Path normalization: requestPath without leading `/` now handled correctly
- Handles `=` in cookie values (JWT tokens, base64 payloads)
- Handles whitespace around `=` and `;`
- `filterDomain` and `filterPath` tested independently

**DOM diffing — stable-path (Suite 6)**
- `domDiff` now issues separate queries per selector type instead of a single compound selector the mock couldn't parse
- `nodeIdentity` priority chain: `data-nexus` > `id` > `name` > `aria-label` > `tag:nth-of-type`
- `stablePath` walks up to 6 levels to body, building a `/`-separated structural path
- Tests verify: value change detection, text content change detection, path stability across re-scans, all four identity tiers

**Async DOM simulation — new (Suite 8)**
- `makeAsyncDomSimulator` queues mutations and flushes via `setImmediate` — accurately models browser microtask queue
- Tests verify: pre-flush invisibility, post-flush visibility, SPA navigation (title change + form clear), 20-mutation burst, multi-cycle independence
- `domDiff` after async flush correctly detects changes

**State lifecycle model — new (Suite 9)**
- Formal phase transition table: `unregistered → registering → registered → polling ↔ paused → closing`
- `makeStateModel()` enforces valid transitions, throws on invalid ones
- Terminal state (`closing`) tested explicitly
- Retry path tested: `registering → unregistered → registering`
- Transition log records `from`, `to`, `ts` for every hop

**Selector resilience — expanded (Suite 1)**
- `text=` now tested against deep nested tree (not flat list)
- `text*=` (contains) variant added and tested
- `role=` tested against real aria attribute in nested element
- `[type*="pass"]` partial attribute match tested
- XPath `//a` tested for count (2 anchors)
- Fallback chain with intentionally broken first selector (`[[[bad`) tested

**Eval AST guard — expanded (Suite 4)**
- 7 blocked patterns tested individually: `eval()`, `new Function()`, `__proto__`, `fetch()`, `location.href=`, `document.cookie=`, `XMLHttpRequest`
- Guard verified to run before `new Function()` construction

---

## [1.1.0] — 2026-04-15

### nexus-bridge-connector.user.js — v1.0.0 (new file)

Tampermonkey userscript — real-browser execution agent.

**Session auth**
- Registers with `POST /extension/register` on every page load
- Token stored in `GM_getValue`/`GM_setValue` across sessions
- Bridge can respond with `{ token, caps, sessionSecret }` to override capabilities

**Capability gating**
- Per-tab flags: `execute`, `observe`, `cookies`, `eval`
- `execute` and `observe` on by default; `cookies` and `eval` off
- `checkCap()` called before every action — returns structured error on denial

**Selector resilience**
- Fallback chain support: any selector can be `string | string[]`
- Types: CSS, XPath (`//` prefix), `text=` (exact, case-insensitive, leaf-preferred), `text*=` (contains), `role=`

**Pre/Post conditions**
- `pre` checked before execution; `post` checked 150ms after (DOM settle)
- Condition types: `exists`, `notExists`, `text.contains`, `text.equals`, `url.contains`, `title.contains`
- Execution result replaced with `{ ok: false, error: post.reason }` on post-condition failure

**Callto tracking**
- Every command acked to `POST /extension/callto-ack`
- Completed calltos cached in `STATE.completed` (max 200, LRU)
- Replay: if `calltoId` is in completed map, returns cached result without re-executing

**Sandboxed eval**
- Wrapped in `new Function('args', '"use strict"; ' + code)`
- AST guard: 10 blocked regex patterns run before construction
- `cap.eval` must be `true` or action is denied before guard runs

**DOM diffing**
- `nodeIdentity()` priority: `data-nexus` > `#id` > `[name]` > `[aria-label]` > `tag:nth(n)`
- `stablePath()` walks up to 6 levels — path is `/`-separated structural address
- `hashNode()` hashes: tagName, value, textContent (first 80 chars), visibility
- MutationObserver: 250ms debounce, 10 events/sec hard cap

**Navigation awareness**
- Intercepts `history.pushState`, `history.replaceState`, `popstate`, `hashchange`
- `beforeunload` sets `STATE.paused = true` — blocks all non-read-only commands
- `STATE.domHashes` cleared on navigation (diff cache invalidated)
- Emits `page:navigated` with `{ from, to, trigger, title }`

**Execution queue**
- Read-only actions (`get_page_data`, `exists`, `query`, `extract`) bypass queue
- Mutating actions serialized through `enqueue()` / `drainQueue()`
- Prevents: double-click on re-delivery, race between pre/post and DOM mutations

**Heartbeat + poll**
- `POST /extension/heartbeat` every 5s
- `GET /extension/poll` every 800ms
- Random 200–700ms boot delay to prevent thundering herd on multi-tab start

### test-bridge-connector.js — v1.0.0 (new file)

Initial test suite for connector logic, 62 tests passing.

---

## [1.0.0] — 2026-04-14

### nexus-bridge-service.js — v1.0.0 (new file)

- Windows NT service wrapper via `node-windows`
- Commands: `install`, `uninstall`, `start`, `stop`, `status`, `run`
- Restart policy: exponential backoff `[1000, 2000, 5000, 10000, 30000, 60000]` ms, max 5 attempts
- Health check: `GET /health` every 15s — kills and restarts child on failure
- PID file: `data/bridge.pid`
- Rolling daily log: `data/service-logs/bridge-svc-YYYY-MM-DD.log` (JSON lines)
- Graceful shutdown: SIGTERM → SIGKILL after 5s
- SIGHUP resets restart counter and triggers clean restart
- Non-Windows: falls back to foreground mode with same lifecycle management

### nexus-playwright-mirror.js — v1.0.0 (new file)

- 14 element actions dispatched via bus or HTTP
- Cookie capture with domain filter, `byDomain` grouping, `capturedAt` timestamp
- Cookie inject via `context.addCookies`
- DOM snapshot: recursive element tree with rect, visibility, attrs (max depth configurable)
- All actions emit `pw:element:result` on the bus
- HTTP surface: `POST /playwright/mirror/element`, `GET|POST /playwright/mirror/cookies/*`, `POST /playwright/mirror/dom/snapshot`, `GET /playwright/mirror/actions`
- `install({ bus, busEmit, getPage })` wires all 14 bus event listeners

### nexus-element-api.js — v1.0.0 (new file)

- Callto schema: `id`, `action`, `selector`, `params`, `status`, `result`, `error`, `durationMs`, `retries`, `createdAt`, `resolvedAt`, `sessionUuid`, `tag`, `batchId`
- Disk persistence: each callto written as `data/calltos/{id}.json` immediately on creation and resolution
- Persisted calltos reloaded on startup (bridge restart survival)
- Batch execution: sequential steps with optional `stopOnError` per step
- `formFill`: field map `{ selector: value }` executed in order, stops on first failure
- `pageExtract`: schema `{ fieldName: { selector, attribute? } }` → `{ data: { fieldName: value } }`
- Bus events: `element:callto:running`, `element:callto:resolved`, `element:callto:error`, `element:batch:resolved`

### test-bridge-service.js — v1.0.0 (new file)

- 64 tests across 9 suites
- Mock page: records all method calls, returns realistic values
- Mock bus: event emission and subscription tracking
- Mock HTTP response: accumulates status/headers/body
- Tests: all 14 element actions, cookie capture/inject/round-trip, DOM snapshot shape, callto CRUD + persistence, all HTTP routes + error codes, bus event routing, service file structure + restart policy shape
