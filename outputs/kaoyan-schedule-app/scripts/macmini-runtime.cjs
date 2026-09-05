#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  assertNoRuntimeSymlinks,
  assertSafeRuntimePaths,
  createRuntimeEnvironment,
  ensurePrivateDirectory,
  provisionRuntimeLayout,
  publicRuntimeSummary,
  resolveRuntimePaths,
  withoutLegacyAiProviderEnvironment,
} = require('./runtime-paths.cjs');
const {
  providerStatus,
  readAiConfig,
} = require('./secure-ai-config.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_NOTE_PORT = 5174;
const DEFAULT_WEB_PORT = 5173;
const DEFAULT_MAC_RUNTIME_ROOT = '/Library/Application Support/KaoyanStudyCenter';

function parseArguments(argv = process.argv.slice(2)) {
  const result = { command: 'serve', json: false, runtimeRoot: '', notePort: DEFAULT_NOTE_PORT, webPort: DEFAULT_WEB_PORT };
  for (const argument of argv) {
    if (!argument.startsWith('-') && result.command === 'serve') {
      result.command = argument;
      continue;
    }
    if (argument === '--json') result.json = true;
    else if (argument.startsWith('--runtime-root=')) result.runtimeRoot = argument.slice('--runtime-root='.length).trim();
    else if (argument.startsWith('--note-port=')) result.notePort = Number(argument.slice('--note-port='.length));
    else if (argument.startsWith('--web-port=')) result.webPort = Number(argument.slice('--web-port='.length));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function assertPort(value, label) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${label} must be an integer between 1024 and 65535.`);
  }
  return value;
}

function runtimePathsForArguments(arguments_, baseEnvironment = process.env) {
  const env = { ...baseEnvironment };
  if (arguments_.runtimeRoot) env.KAOYAN_RUNTIME_ROOT = path.resolve(arguments_.runtimeRoot);
  else if (process.platform === 'darwin') env.KAOYAN_RUNTIME_ROOT = DEFAULT_MAC_RUNTIME_ROOT;
  if (process.platform === 'darwin' && env.KAOYAN_RUNTIME_ROOT?.startsWith('/Library/')) {
    env.KAOYAN_SERVICE_MODE = 'system';
  }
  return resolveRuntimePaths({ env });
}

function processIsRunning(pid, processKill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    processKill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquireRuntimeLock(lockPath, options = {}) {
  const fsModule = options.fsModule || fs;
  const pid = options.pid || process.pid;
  const processKill = options.processKill || process.kill;
  ensurePrivateDirectory(path.dirname(lockPath), fsModule);

  if (fsModule.existsSync(lockPath)) {
    let current = null;
    try {
      current = JSON.parse(fsModule.readFileSync(lockPath, 'utf8'));
    } catch {}
    if (processIsRunning(Number(current?.pid), processKill)) {
      throw new Error(`Mac mini runtime is already running with PID ${current.pid}.`);
    }
    fsModule.rmSync(lockPath, { force: true });
  }

  const token = crypto.randomUUID();
  const descriptor = fsModule.openSync(lockPath, 'wx', 0o600);
  try {
    fsModule.writeFileSync(descriptor, `${JSON.stringify({
      schemaVersion: 1,
      pid,
      token,
      startedAt: new Date().toISOString(),
      projectRoot: PROJECT_ROOT,
    }, null, 2)}\n`, 'utf8');
    fsModule.fsyncSync(descriptor);
  } finally {
    fsModule.closeSync(descriptor);
  }

  return {
    lockPath,
    pid,
    token,
    release() {
      let current = null;
      try {
        current = JSON.parse(fsModule.readFileSync(lockPath, 'utf8'));
      } catch {}
      if (current?.pid === pid && current?.token === token) fsModule.rmSync(lockPath, { force: true });
    },
  };
}

function createChildSpecifications(runtimePaths, options = {}) {
  const notePort = assertPort(Number(options.notePort || DEFAULT_NOTE_PORT), 'note port');
  const webPort = assertPort(Number(options.webPort || DEFAULT_WEB_PORT), 'web port');
  if (notePort === webPort) throw new Error('note port and web port must be different.');
  const nodePath = path.resolve(options.nodePath || process.execPath);
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const sanitizedBaseEnvironment = withoutLegacyAiProviderEnvironment({
    ...process.env,
    ...(options.environment || {}),
  });
  const environment = createRuntimeEnvironment(runtimePaths, {
    ...sanitizedBaseEnvironment,
    NODE_ENV: 'production',
    KAOYAN_NOTE_PORT: String(notePort),
    KAOYAN_WEB_PORT: String(webPort),
    KAOYAN_WEB_HOST: '127.0.0.1',
  });

  return [
    Object.freeze({ id: 'note-service', command: nodePath, args: [path.join(projectRoot, 'scripts', 'note-server.cjs')], environment }),
    Object.freeze({ id: 'web-gateway', command: nodePath, args: [path.join(projectRoot, 'scripts', 'web-server.cjs')], environment }),
  ];
}

function commandAvailable(command, options = {}) {
  const checker = process.platform === 'win32' ? 'where.exe' : '/usr/bin/which';
  const result = spawnSync(checker, [command], { encoding: 'utf8', windowsHide: true, ...options });
  if (result.status === 0) return String(result.stdout || '').trim().split(/\r?\n/)[0];
  if (process.platform !== 'darwin') return '';
  const commonMacPaths = {
    tailscale: [
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      '/opt/homebrew/bin/tailscale',
      '/usr/local/bin/tailscale',
    ],
    cloudflared: [
      '/opt/homebrew/bin/cloudflared',
      '/usr/local/bin/cloudflared',
    ],
  };
  return (commonMacPaths[command] || []).find((candidate) => fs.existsSync(candidate)) || '';
}

function runDoctor(runtimePaths, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const checks = [];
  const add = (id, ok, severity, detail) => checks.push({ id, ok: Boolean(ok), severity, detail });
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node-version', nodeMajor >= 22, 'error', `Node ${process.versions.node}; require >=22`);
  add('project-note-service', fs.existsSync(path.join(projectRoot, 'scripts', 'note-server.cjs')), 'error', 'note-server.cjs');
  add('project-web-gateway', fs.existsSync(path.join(projectRoot, 'scripts', 'web-server.cjs')), 'error', 'web-server.cjs');
  add('production-build', fs.existsSync(path.join(projectRoot, 'dist', 'index.html')), 'error', 'dist/index.html');
  try {
    const notePort = assertPort(Number(options.notePort || DEFAULT_NOTE_PORT), 'note port');
    const webPort = assertPort(Number(options.webPort || DEFAULT_WEB_PORT), 'web port');
    add('service-ports', notePort !== webPort, 'error', `${webPort} (web), ${notePort} (note); require distinct unprivileged ports`);
  } catch (error) {
    add('service-ports', false, 'error', error.message);
  }
  try {
    assertSafeRuntimePaths(runtimePaths);
    assertNoRuntimeSymlinks(runtimePaths);
    add('runtime-root', true, 'error', runtimePaths.runtimeRoot);
  } catch (error) {
    add('runtime-root', false, 'error', error.message);
  }

  if (process.platform === 'darwin') {
    add('apple-silicon', process.arch === 'arm64', 'error', `${process.platform}/${process.arch}`);
    const tailscale = commandAvailable('tailscale');
    add('tailscale-cli', Boolean(tailscale), 'warning', tailscale || 'not found in launchd-safe PATH; required before the ingress phase');
    const cloudflared = commandAvailable('cloudflared');
    add('cloudflared-cli', Boolean(cloudflared), 'warning', cloudflared || 'optional public fallback is unavailable');
  } else {
    add('host-platform', true, 'info', `${process.platform}/${process.arch}; Mac-only probes skipped`);
  }

  if (fs.existsSync(runtimePaths.runtimeRoot)) {
    try {
      fs.accessSync(runtimePaths.runtimeRoot, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
      add('runtime-access', true, 'error', 'read/write/execute available to the current service user');
      if (process.platform !== 'win32') {
        const rootMode = fs.statSync(runtimePaths.runtimeRoot).mode & 0o777;
        const secretsMode = fs.existsSync(runtimePaths.secretsRoot)
          ? fs.statSync(runtimePaths.secretsRoot).mode & 0o777
          : rootMode;
        add('runtime-permissions', (rootMode & 0o077) === 0 && (secretsMode & 0o077) === 0, 'error',
          `runtime ${rootMode.toString(8).padStart(3, '0')}; secrets ${secretsMode.toString(8).padStart(3, '0')}`);
      }
    } catch (error) {
      add('runtime-access', false, 'error', error.message);
    }
  } else {
    add('runtime-access', false, 'warning', 'runtime root has not been provisioned yet');
  }

  if (typeof fs.statfsSync === 'function') {
    let diskProbePath = runtimePaths.runtimeRoot;
    while (!fs.existsSync(diskProbePath) && path.dirname(diskProbePath) !== diskProbePath) diskProbePath = path.dirname(diskProbePath);
    try {
      const disk = fs.statfsSync(diskProbePath);
      const availableBytes = Number(disk.bavail) * Number(disk.bsize);
      const availableGiB = availableBytes / (1024 ** 3);
      add('disk-space', availableGiB >= 5, availableGiB < 1 ? 'error' : 'warning', `${availableGiB.toFixed(1)} GiB available; target >= 5 GiB`);
    } catch (error) {
      add('disk-space', false, 'warning', `unable to inspect free space: ${error.message}`);
    }
  }

  if (fs.existsSync(runtimePaths.aiConfigPath)) {
    try {
      const config = readAiConfig(runtimePaths.aiConfigPath);
      const statuses = providerStatus(config);
      const configured = statuses.filter((provider) => provider.configured && provider.enabled).map((provider) => provider.id);
      const incomplete = Object.keys(config.providers || {}).filter((id) => {
        const status = statuses.find((provider) => provider.id === id);
        return status && !status.configured;
      });
      add('ai-config-json', true, 'error', runtimePaths.aiConfigPath);
      add('ai-provider-config', incomplete.length === 0, 'error', incomplete.length > 0
        ? `Incomplete provider configuration: ${incomplete.join(', ')}`
        : `Configured providers: ${configured.join(', ') || 'none'}`);
      if (process.platform !== 'win32') {
        const mode = fs.statSync(runtimePaths.aiConfigPath).mode & 0o777;
        add('ai-config-permissions', (mode & 0o077) === 0, 'error', `mode ${mode.toString(8).padStart(3, '0')}`);
      }
    } catch (error) {
      add('ai-config-json', false, 'error', error.message);
    }
  } else {
    add('ai-config-json', false, 'warning', 'No AI provider is configured yet.');
  }

  return {
    ok: checks.every((check) => check.severity !== 'error' || check.ok),
    generatedAt: new Date().toISOString(),
    runtime: publicRuntimeSummary(runtimePaths),
    checks,
  };
}

function startManagedRuntime(runtimePaths, options = {}) {
  process.umask(0o077);
  provisionRuntimeLayout(runtimePaths);
  const buildEntry = path.join(options.projectRoot || PROJECT_ROOT, 'dist', 'index.html');
  if (!fs.existsSync(buildEntry)) throw new Error('Production assets are missing. Run npm run build before starting the service.');
  const specifications = createChildSpecifications(runtimePaths, options);
  const lock = acquireRuntimeLock(path.join(runtimePaths.runRoot, 'macmini-runtime.lock'));
  const children = new Map();
  let stopping = false;
  let exitCode = 0;

  const stop = (signal = 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    for (const child of children.values()) {
      if (!child.killed) child.kill(signal);
    }
    if (children.size === 0) {
      lock.release();
      process.exitCode = exitCode;
    }
  };

  for (const specification of specifications) {
    const child = spawn(specification.command, specification.args, {
      cwd: options.projectRoot || PROJECT_ROOT,
      env: specification.environment,
      stdio: 'inherit',
      windowsHide: true,
    });
    children.set(specification.id, child);
    child.once('error', (error) => {
      process.stderr.write(`[macmini-runtime] ${specification.id} failed to start: ${error.message}\n`);
      exitCode = 1;
      stop();
    });
    child.once('close', (code, signal) => {
      children.delete(specification.id);
      if (!stopping) {
        process.stderr.write(`[macmini-runtime] ${specification.id} exited unexpectedly (${signal || code}).\n`);
        exitCode = Number.isInteger(code) && code !== 0 ? code : 1;
        stop();
      }
      if (children.size === 0) {
        lock.release();
        process.exitCode = exitCode;
      }
    });
  }

  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.stdout.write(`[macmini-runtime] starting ${specifications.length} services from ${PROJECT_ROOT}\n`);
  process.stdout.write(`[macmini-runtime] runtime root: ${runtimePaths.runtimeRoot}\n`);
  return { children, lock, stop };
}

function printDoctor(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Mac mini runtime doctor: ${report.ok ? 'PASS' : 'FAIL'}\n`);
  for (const check of report.checks) {
    process.stdout.write(`${check.ok ? 'OK' : check.severity === 'warning' ? 'WARN' : 'FAIL'}  ${check.id}: ${check.detail}\n`);
  }
}

function main() {
  const arguments_ = parseArguments();
  const runtimePaths = runtimePathsForArguments(arguments_);
  if (arguments_.command === 'doctor') {
    const report = runDoctor(runtimePaths);
    printDoctor(report, arguments_.json);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (arguments_.command === 'paths') {
    process.stdout.write(`${JSON.stringify(publicRuntimeSummary(runtimePaths), null, 2)}\n`);
    return;
  }
  if (arguments_.command !== 'serve') throw new Error(`Unknown command: ${arguments_.command}`);
  startManagedRuntime(runtimePaths, { notePort: arguments_.notePort, webPort: arguments_.webPort });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Mac mini runtime error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  acquireRuntimeLock,
  assertPort,
  createChildSpecifications,
  parseArguments,
  processIsRunning,
  runDoctor,
  runtimePathsForArguments,
  startManagedRuntime,
};
