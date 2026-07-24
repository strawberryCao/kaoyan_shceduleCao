const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const assistantRoot = path.resolve(process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手'));
const installRoot = process.env.KAOYAN_SYNC_ROOT || 'D:\\kaoyandata\\NoteFolderSync';
const configPath = process.env.KAOYAN_SYNC_CONFIG || path.join(installRoot, 'config.json');
const syncScript = path.join(installRoot, 'windows-assistant-config-sync.ps1');
const lockPath = path.join(installRoot, 'assistant-config-watch.lock');
const logPath = path.join(installRoot, 'sync.log');
const debounceMs = Math.max(2000, Math.min(30000, Number(process.env.KAOYAN_CONFIG_DEBOUNCE_MS) || 7000));

fs.mkdirSync(installRoot, { recursive: true });
let lockHandle;
try {
  lockHandle = fs.openSync(lockPath, 'wx');
  fs.writeFileSync(lockHandle, `${process.pid}\n`, 'utf8');
} catch (error) {
  if (error?.code === 'EEXIST') process.exit(0);
  throw error;
}

let timer = null;
let running = false;
let pending = false;

function log(message) {
  try { fs.appendFileSync(logPath, `${new Date().toISOString()} CONFIG_WATCH ${message}\n`, 'utf8'); } catch {}
}

function relevant(relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/');
  if (!normalized.toLowerCase().endsWith('.json')) return false;
  if (/(?:^|\/)\.?(?:tmp|temp)(?:\/|$)/i.test(normalized)) return false;
  if (/\.(?:tmp|partial|download)\.json$/i.test(normalized)) return false;
  return true;
}

function runSync() {
  if (running) {
    pending = true;
    return;
  }
  if (!fs.existsSync(configPath) || !fs.existsSync(syncScript)) {
    log('waiting-for-installed-syncer');
    return;
  }
  running = true;
  pending = false;
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-File', syncScript,
    '-ConfigPath', configPath,
  ], {
    cwd: installRoot,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.once('error', (error) => {
    running = false;
    log(`spawn-error=${error.message}`);
    if (pending) schedule();
  });
  child.once('exit', (code) => {
    running = false;
    log(`sync-exit=${code}`);
    if (pending) schedule();
  });
}

function schedule() {
  pending = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    runSync();
  }, debounceMs);
  timer.unref?.();
}

function cleanup() {
  if (timer) clearTimeout(timer);
  try { fs.closeSync(lockHandle); } catch {}
  try { fs.unlinkSync(lockPath); } catch {}
}

process.once('exit', cleanup);
process.once('SIGINT', () => { cleanup(); process.exit(0); });
process.once('SIGTERM', () => { cleanup(); process.exit(0); });
process.once('uncaughtException', (error) => { log(`fatal=${error.stack || error.message}`); cleanup(); process.exit(1); });

if (!fs.existsSync(assistantRoot)) fs.mkdirSync(assistantRoot, { recursive: true });
log(`started root=${assistantRoot} debounceMs=${debounceMs}`);

try {
  const watcher = fs.watch(assistantRoot, { recursive: true }, (_event, filename) => {
    if (relevant(filename)) schedule();
  });
  watcher.on('error', (error) => log(`watch-error=${error.message}`));
} catch (error) {
  log(`watch-start-error=${error.message}`);
  cleanup();
  process.exit(1);
}

// Keep the process alive. The five-minute scheduled task remains the fallback
// when the local service is not running or Windows drops a file-system event.
setInterval(() => {}, 60_000);
