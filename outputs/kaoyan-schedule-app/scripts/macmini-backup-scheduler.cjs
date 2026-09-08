#!/usr/bin/env node

const path = require('node:path');
const { createBackup, listBackups, verifyBackup } = require('./macmini-backup.cjs');
const { resolveRuntimePaths } = require('./runtime-paths.cjs');

const DEFAULT_MAC_ROOT = '/Library/Application Support/KaoyanStudyCenter';
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const MIN_BACKUP_INTERVAL_MS = 20 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;

function parseArguments(argv = process.argv.slice(2)) {
  const result = { command: 'plan', runtimeRoot: '', json: false };
  let commandSeen = false;
  for (const argument of argv) {
    if (!argument.startsWith('-') && !commandSeen) {
      result.command = argument;
      commandSeen = true;
    } else if (argument === '--json') result.json = true;
    else if (argument.startsWith('--runtime-root=')) result.runtimeRoot = path.resolve(argument.slice(15).trim());
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function latestBackup(runtimePaths) {
  return listBackups(runtimePaths).find((backup) => backup.validManifest) || null;
}

function backupDue(runtimePaths, now = new Date()) {
  const latest = latestBackup(runtimePaths);
  if (!latest?.createdAt) return true;
  const age = now.getTime() - Date.parse(latest.createdAt);
  return !Number.isFinite(age) || age >= MIN_BACKUP_INTERVAL_MS;
}

function runBackupIfDue(runtimePaths, options = {}) {
  const now = options.now || new Date();
  if (!backupDue(runtimePaths, now) && options.force !== true) return { created: false, reason: 'recent-backup-exists', latest: latestBackup(runtimePaths) };
  const created = createBackup(runtimePaths, { now });
  const verification = verifyBackup(created.backupPath);
  if (!verification.ok) throw new Error(`新备份校验失败：${JSON.stringify(verification.errors)}`);
  return { created: true, backupPath: created.backupPath, totals: created.manifest.totals, verification };
}

function serve(runtimePaths, options = {}) {
  const intervalMs = options.intervalMs || CHECK_INTERVAL_MS;
  const initialDelayMs = options.initialDelayMs ?? INITIAL_DELAY_MS;
  let running = false;
  const check = async () => {
    if (running) return;
    running = true;
    try {
      const result = runBackupIfDue(runtimePaths);
      if (result.created) process.stdout.write(`[macmini-backup] 已创建并校验：${result.backupPath}\n`);
    } catch (error) {
      process.stderr.write(`[macmini-backup] 本轮未完成：${error.message}\n`);
    } finally { running = false; }
  };
  const firstTimer = setTimeout(() => void check(), initialDelayMs);
  const interval = setInterval(() => void check(), intervalMs);
  const close = () => {
    clearTimeout(firstTimer);
    clearInterval(interval);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.stdout.write(`[macmini-backup] 每小时检查；最近备份超过 20 小时才创建新快照。\n`);
  return { close, check };
}

function main() {
  const options = parseArguments();
  const requestedRoot = options.runtimeRoot || (process.platform === 'darwin' ? DEFAULT_MAC_ROOT : '');
  const runtime = resolveRuntimePaths({ env: { ...process.env, ...(requestedRoot ? { KAOYAN_RUNTIME_ROOT: requestedRoot } : {}) } });
  if (options.command === 'plan') {
    process.stdout.write(`${JSON.stringify({ intervalHours: 1, minimumSnapshotIntervalHours: 20, initialDelayMinutes: 5, automaticDeletion: false, secretsIncluded: false }, null, 2)}\n`);
    return;
  }
  if (options.command === 'status') {
    process.stdout.write(`${JSON.stringify({ due: backupDue(runtime), latest: latestBackup(runtime), backups: listBackups(runtime).length }, null, 2)}\n`);
    return;
  }
  if (options.command === 'once') {
    process.stdout.write(`${JSON.stringify(runBackupIfDue(runtime, { force: true }), null, 2)}\n`);
    return;
  }
  if (options.command === 'serve') {
    serve(runtime);
    return;
  }
  throw new Error(`Unknown command: ${options.command}`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`Mac mini 自动备份失败：${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { backupDue, latestBackup, parseArguments, runBackupIfDue, serve };
