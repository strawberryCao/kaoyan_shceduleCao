#!/usr/bin/env node

const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  createRuntimeEnvironment,
  provisionRuntimeLayout,
  resolveRuntimePaths,
  withoutLegacyAiProviderEnvironment,
} = require('./runtime-paths.cjs');
const { acquireRuntimeLock, assertPort } = require('./macmini-runtime.cjs');
const { readWindowsSyncConfig } = require('./windows-sync-config.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function parseArguments(argv = process.argv.slice(2)) {
  const result = { runtimeRoot: '', notePort: 5174 };
  for (const argument of argv) {
    if (argument.startsWith('--runtime-root=')) result.runtimeRoot = path.resolve(argument.slice('--runtime-root='.length).trim());
    else if (argument.startsWith('--note-port=')) result.notePort = Number(argument.slice('--note-port='.length));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function runtimePathsForArguments(arguments_, baseEnvironment = process.env) {
  const env = { ...baseEnvironment, KAOYAN_RUNTIME_LAYOUT: 'managed' };
  if (arguments_.runtimeRoot) env.KAOYAN_RUNTIME_ROOT = arguments_.runtimeRoot;
  return resolveRuntimePaths({ env, platform: 'win32' });
}

function createChildSpecifications(runtimePaths, options = {}) {
  const notePort = assertPort(Number(options.notePort || 5174), 'note port');
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const nodePath = path.resolve(options.nodePath || process.execPath);
  const internalSyncToken = String(options.internalSyncToken || crypto.randomBytes(32).toString('base64url'));
  const environment = createRuntimeEnvironment(runtimePaths, {
    ...withoutLegacyAiProviderEnvironment({ ...process.env, ...(options.environment || {}) }),
    NODE_ENV: 'production',
    KAOYAN_NOTE_PORT: String(notePort),
    KAOYAN_SYNC_ROLE: 'windows-replica',
    KAOYAN_SYNC_DEVICE_ID: String(options.deviceId || 'windows-main'),
    KAOYAN_INTERNAL_SYNC_TOKEN: internalSyncToken,
  });
  delete environment.KAOYAN_AI_CONFIG_PATH;
  return [
    { id: 'windows-note-service', command: nodePath, args: [path.join(projectRoot, 'scripts', 'note-server.cjs')], environment },
    { id: 'windows-sync-service', command: nodePath, args: [path.join(projectRoot, 'scripts', 'windows-sync-service.cjs')], environment },
  ];
}

function start(options = {}) {
  const arguments_ = options.arguments || parseArguments();
  const runtimePaths = options.runtimePaths || runtimePathsForArguments(arguments_);
  provisionRuntimeLayout(runtimePaths);
  const syncConfig = options.syncConfig || readWindowsSyncConfig(runtimePaths);
  const lock = acquireRuntimeLock(path.join(runtimePaths.runRoot, 'windows-replica-runtime.lock'));
  const specifications = createChildSpecifications(runtimePaths, {
    notePort: arguments_.notePort,
    ...options,
    deviceId: syncConfig.deviceId,
  });
  const children = new Map();
  let stopping = false;
  let exitCode = 0;
  const stop = (signal = 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    for (const child of children.values()) if (!child.killed) child.kill(signal);
    if (children.size === 0) lock.release();
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
      process.stderr.write(`[windows-runtime] ${specification.id} failed: ${error.message}\n`);
      exitCode = 1;
      stop();
    });
    child.once('close', (code) => {
      children.delete(specification.id);
      if (!stopping) {
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
  process.stdout.write(`[windows-runtime] local note service and Mac synchronization started for ${runtimePaths.runtimeRoot}\n`);
  return { children, lock, runtimePaths, stop };
}

if (require.main === module) {
  try { start(); } catch (error) {
    process.stderr.write(`Windows replica runtime failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { createChildSpecifications, parseArguments, runtimePathsForArguments, start };
