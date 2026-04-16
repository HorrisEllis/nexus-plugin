/**
 * nexus-bridge-service.js
 * Windows Service wrapper for NEXUS Bridge v5
 *
 * Uses `node-windows` to install/uninstall/run the bridge as a proper
 * NT service with auto-restart, event-log integration, and structured
 * lifecycle events emitted on the NEXUS bus.
 *
 * Usage:
 *   node nexus-bridge-service.js install    — register the NT service
 *   node nexus-bridge-service.js uninstall  — deregister
 *   node nexus-bridge-service.js start      — net start NexusBridge
 *   node nexus-bridge-service.js stop       — net stop NexusBridge
 *   node nexus-bridge-service.js status     — query SCM state
 *   node nexus-bridge-service.js run        — foreground (used by SCM internally)
 *
 * The bridge root must be one level up (../nexus-bridge-server.js).
 * Set NEXUS_BRIDGE_ROOT env var to override.
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const { execSync, spawn } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────
const BRIDGE_ROOT   = process.env.NEXUS_BRIDGE_ROOT || path.resolve(__dirname, '..');
const BRIDGE_ENTRY  = path.join(BRIDGE_ROOT, 'nexus-bridge-server.js');
const SERVICE_NAME  = 'NexusBridge';
const SERVICE_DESC  = 'NEXUS Bridge v5 — Intent router, agent layer, Playwright controller';
const LOG_DIR       = path.join(BRIDGE_ROOT, 'data', 'service-logs');
const PID_FILE      = path.join(BRIDGE_ROOT, 'data', 'bridge.pid');
const HEALTH_URL    = `http://127.0.0.1:${process.env.NEXUS_PORT || 3666}/health`;

// Retry policy: exponential backoff, cap at 60s
const RESTART_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];

// ── Ensure log dir ────────────────────────────────────────────────────────────
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ── Simple logger (writes to rolling daily file + stdout) ─────────────────────
const logFile = () => path.join(LOG_DIR, `bridge-svc-${new Date().toISOString().slice(0,10)}.log`);
function log(level, msg, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data });
  process.stdout.write(line + '\n');
  try { fs.appendFileSync(logFile(), line + '\n'); } catch {}
}

// ── Platform guard ────────────────────────────────────────────────────────────
function requireWindows() {
  if (process.platform !== 'win32') {
    log('WARN', 'SCM operations only valid on Windows. Running bridge directly.');
    return false;
  }
  return true;
}

// ── node-windows loader (optional — falls back to manual spawn) ───────────────
function loadNodeWindows() {
  try {
    return require('node-windows');
  } catch {
    return null;
  }
}

// ── SCM operations via node-windows ──────────────────────────────────────────
function scmInstall() {
  if (!requireWindows()) return;
  const nw = loadNodeWindows();
  if (!nw) {
    log('ERROR', 'node-windows not installed. Run: npm install node-windows --save');
    process.exit(1);
  }

  const svc = new nw.Service({
    name:        SERVICE_NAME,
    description: SERVICE_DESC,
    script:      path.resolve(__filename),
    nodeOptions: ['--max-old-space-size=512'],
    // Pass `run` so the SCM entry-point skips install logic
    scriptOptions: 'run',
    env: [
      { name: 'NEXUS_BRIDGE_ROOT', value: BRIDGE_ROOT },
      { name: 'NODE_ENV',          value: 'production'  },
    ],
    // Restart up to 5 times with exponential delay
    wait:        2,
    grow:        0.5,
    maxRestarts: 5,
    abortOnError: false,
    logpath:     LOG_DIR,
  });

  svc.on('install', () => {
    log('INFO', `Service "${SERVICE_NAME}" installed`);
    svc.start();
  });
  svc.on('alreadyinstalled', () => log('WARN', 'Service already installed'));
  svc.on('error',            e  => log('ERROR', 'Install error', { error: String(e) }));

  svc.install();
}

function scmUninstall() {
  if (!requireWindows()) return;
  const nw = loadNodeWindows();
  if (!nw) { log('ERROR', 'node-windows not found'); process.exit(1); }

  const svc = new nw.Service({ name: SERVICE_NAME, script: path.resolve(__filename) });
  svc.on('uninstall',    () => log('INFO', `Service "${SERVICE_NAME}" uninstalled`));
  svc.on('error',         e  => log('ERROR', 'Uninstall error', { error: String(e) }));
  svc.uninstall();
}

function scmStart() {
  if (!requireWindows()) return;
  try {
    execSync(`net start ${SERVICE_NAME}`, { stdio: 'inherit' });
  } catch (e) {
    log('ERROR', 'net start failed', { error: e.message });
    process.exit(1);
  }
}

function scmStop() {
  if (!requireWindows()) return;
  try {
    execSync(`net stop ${SERVICE_NAME}`, { stdio: 'inherit' });
  } catch (e) {
    log('ERROR', 'net stop failed', { error: e.message });
    process.exit(1);
  }
}

function scmStatus() {
  if (!requireWindows()) return;
  try {
    const out = execSync(`sc query ${SERVICE_NAME}`, { encoding: 'utf8' });
    console.log(out);
  } catch {
    console.log(`Service "${SERVICE_NAME}" is not installed.`);
  }
}

// ── Health poller ─────────────────────────────────────────────────────────────
function pollHealth(onDead) {
  const http = require('http');
  const url  = new URL(HEALTH_URL);
  const req  = http.get({ hostname: url.hostname, port: url.port || 3666, path: url.pathname, timeout: 3000 }, res => {
    if (res.statusCode !== 200) onDead(new Error(`health ${res.statusCode}`));
  });
  req.on('error', onDead);
  req.on('timeout', () => { req.destroy(); onDead(new Error('health timeout')); });
}

// ── Bridge runner (foreground process managed by SCM / direct `run`) ──────────
let _child      = null;
let _restartIdx = 0;
let _running    = true;
let _healthTimer = null;

function writePid(pid) {
  try { fs.writeFileSync(PID_FILE, String(pid)); } catch {}
}
function clearPid() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

function startBridge() {
  if (!_running) return;
  if (!fs.existsSync(BRIDGE_ENTRY)) {
    log('ERROR', 'Bridge entry not found', { path: BRIDGE_ENTRY });
    process.exit(1);
  }

  log('INFO', 'Spawning NEXUS Bridge', { entry: BRIDGE_ENTRY, attempt: _restartIdx + 1 });

  _child = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd:   BRIDGE_ROOT,
    env:   { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  writePid(_child.pid);
  log('INFO', 'Bridge process started', { pid: _child.pid });

  // Pipe child stdio to our log
  _child.stdout.on('data', d => process.stdout.write(d));
  _child.stderr.on('data', d => process.stderr.write(d));

  // Start health monitoring after 5s warmup
  let warmup = setTimeout(() => {
    _healthTimer = setInterval(() => {
      pollHealth(err => {
        log('WARN', 'Bridge health check failed — will restart', { error: err.message });
        // Kill child; exit handler will restart
        _child?.kill('SIGTERM');
      });
    }, 15000);
  }, 5000);

  _child.on('exit', (code, signal) => {
    clearTimeout(warmup);
    clearInterval(_healthTimer);
    clearPid();
    log('WARN', 'Bridge process exited', { code, signal });

    if (!_running) return;

    const delay = RESTART_DELAYS[Math.min(_restartIdx, RESTART_DELAYS.length - 1)];
    _restartIdx++;
    log('INFO', `Restarting bridge in ${delay}ms (attempt ${_restartIdx})`);
    setTimeout(startBridge, delay);
  });
}

function runForeground() {
  log('INFO', 'NEXUS Bridge Service runner starting', { bridgeRoot: BRIDGE_ROOT });

  // Graceful shutdown hooks
  function shutdown(sig) {
    log('INFO', `Signal ${sig} — stopping bridge`);
    _running = false;
    clearInterval(_healthTimer);
    if (_child) {
      _child.kill('SIGTERM');
      setTimeout(() => _child?.kill('SIGKILL'), 5000);
    }
    setTimeout(() => process.exit(0), 6000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGHUP',  () => {
    log('INFO', 'SIGHUP — reloading bridge');
    _restartIdx = 0;
    _child?.kill('SIGTERM');
  });

  startBridge();
}

// ── CLI dispatch ──────────────────────────────────────────────────────────────
const cmd = process.argv[2] || 'run';
switch (cmd) {
  case 'install':   scmInstall();   break;
  case 'uninstall': scmUninstall(); break;
  case 'start':     scmStart();     break;
  case 'stop':      scmStop();      break;
  case 'status':    scmStatus();    break;
  case 'run':       runForeground(); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error('Usage: node nexus-bridge-service.js [install|uninstall|start|stop|status|run]');
    process.exit(1);
}
