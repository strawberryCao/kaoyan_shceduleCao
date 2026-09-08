#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { atomicWriteJson, ensurePrivateDirectory, resolveRuntimePaths } = require('./runtime-paths.cjs');

const BACKUP_SCHEMA_VERSION = 1;
const DEFAULT_MAC_ROOT = '/Library/Application Support/KaoyanStudyCenter';
const SQLITE_PATTERN = /\.(?:sqlite3?|db)$/i;
const SQLITE_TRANSIENT_PATTERN = /\.(?:sqlite3?|db)-(?:wal|shm)$/i;

function parseArguments(argv = process.argv.slice(2)) {
  const result = { command: 'plan', runtimeRoot: '', backup: '', json: false };
  let commandSeen = false;
  for (const argument of argv) {
    if (!argument.startsWith('-') && !commandSeen) {
      result.command = argument;
      commandSeen = true;
    } else if (argument === '--json') result.json = true;
    else if (argument.startsWith('--runtime-root=')) result.runtimeRoot = path.resolve(argument.slice(15).trim());
    else if (argument.startsWith('--backup=')) result.backup = path.resolve(argument.slice(9).trim());
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function walkFiles(root, relativeRoot = '') {
  const directory = path.join(root, relativeRoot);
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.join(relativeRoot, entry.name);
    const absolute = path.join(root, relative);
    const stats = fs.lstatSync(absolute);
    if (stats.isSymbolicLink()) throw new Error(`备份拒绝跟随符号链接：${absolute}`);
    if (stats.isDirectory()) files.push(...walkFiles(root, relative));
    else if (stats.isFile() && !SQLITE_TRANSIENT_PATTERN.test(entry.name)) files.push(relative);
  }
  return files;
}

function snapshotSqlite(sourcePath, destinationPath) {
  ensurePrivateDirectory(path.dirname(destinationPath));
  const database = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA quick_check').all();
    if (!integrity.every((row) => Object.values(row).every((value) => value === 'ok'))) {
      throw new Error(`SQLite 快速校验未通过：${sourcePath}`);
    }
    const escapedDestination = destinationPath.replaceAll("'", "''");
    database.exec(`VACUUM INTO '${escapedDestination}'`);
  } finally {
    database.close();
  }
}

function copyStableFile(sourcePath, destinationPath) {
  const before = fs.statSync(sourcePath);
  ensurePrivateDirectory(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  const after = fs.statSync(sourcePath);
  const contentStable = before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && sha256File(sourcePath) === sha256File(destinationPath);
  if (!contentStable) {
    fs.rmSync(destinationPath, { force: true });
    throw new Error(`文件在备份过程中发生变化，请稍后重试：${sourcePath}`);
  }
}

function backupName(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function createBackup(runtimePaths, options = {}) {
  ensurePrivateDirectory(runtimePaths.backupsRoot);
  const name = options.name || backupName(options.now || new Date());
  if (!/^[A-Za-z0-9TZ-]{12,80}$/.test(name)) throw new Error('备份名称格式无效。');
  const destinationRoot = path.join(runtimePaths.backupsRoot, name);
  const partialRoot = path.join(runtimePaths.backupsRoot, `.partial-${name}`);
  if (fs.existsSync(destinationRoot) || fs.existsSync(partialRoot)) throw new Error(`备份目标已存在：${name}`);
  ensurePrivateDirectory(partialRoot);
  const entries = [];
  const sources = [
    { id: 'data', root: runtimePaths.dataRoot },
    { id: 'config', root: runtimePaths.configRoot },
  ];
  try {
    for (const source of sources) {
      for (const relativePath of walkFiles(source.root)) {
        const sourcePath = path.join(source.root, relativePath);
        const portablePath = path.posix.join(source.id, relativePath.split(path.sep).join('/'));
        const destinationPath = path.join(partialRoot, ...portablePath.split('/'));
        const kind = SQLITE_PATTERN.test(sourcePath) ? 'sqlite-snapshot' : 'file';
        if (kind === 'sqlite-snapshot') snapshotSqlite(sourcePath, destinationPath);
        else copyStableFile(sourcePath, destinationPath);
        const stats = fs.statSync(destinationPath);
        entries.push({ path: portablePath, kind, size: stats.size, sha256: sha256File(destinationPath) });
      }
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const manifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      kind: 'kaoyan-macmini-snapshot',
      createdAt: (options.now || new Date()).toISOString(),
      runtimeLayout: runtimePaths.layout,
      sources: ['data', 'config'],
      secretsIncluded: false,
      files: entries,
      totals: {
        files: entries.length,
        bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
        sqliteFiles: entries.filter((entry) => entry.kind === 'sqlite-snapshot').length,
      },
    };
    atomicWriteJson(path.join(partialRoot, 'manifest.json'), manifest);
    fs.renameSync(partialRoot, destinationRoot);
    return { ok: true, backupPath: destinationRoot, manifest };
  } catch (error) {
    fs.rmSync(partialRoot, { recursive: true, force: true });
    throw error;
  }
}

function readManifest(backupPath) {
  const manifestPath = path.join(path.resolve(backupPath), 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('备份缺少 manifest.json。');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (Number(manifest?.schemaVersion) !== BACKUP_SCHEMA_VERSION
    || manifest?.kind !== 'kaoyan-macmini-snapshot'
    || !Array.isArray(manifest?.files)) throw new Error('备份清单格式无效或版本不受支持。');
  for (const entry of manifest.files) {
    const portablePath = String(entry?.path || '');
    const segments = portablePath.split('/');
    const hasUnsafeSegment = segments.some((segment) => !segment
      || segment === '.'
      || segment === '..'
      || segment.includes('\\')
      || segment.includes('\0'));
    if (!['data', 'config'].includes(segments[0])
      || segments.length < 2
      || hasUnsafeSegment
      || !/^[a-f0-9]{64}$/.test(String(entry?.sha256 || ''))
      || !Number.isSafeInteger(Number(entry?.size))
      || Number(entry.size) < 0) throw new Error('备份清单包含无效文件记录。');
  }
  return manifest;
}

function verifyBackup(backupPath) {
  const root = path.resolve(backupPath);
  const manifest = readManifest(root);
  const errors = [];
  let verifiedBytes = 0;
  for (const entry of manifest.files) {
    const relative = String(entry.path || '');
    const filePath = path.resolve(root, ...relative.split('/'));
    const safeRelative = path.relative(root, filePath);
    if (!safeRelative || safeRelative.startsWith(`..${path.sep}`) || safeRelative === '..' || path.isAbsolute(safeRelative)) {
      errors.push({ path: relative, reason: 'unsafe-path' });
      continue;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      errors.push({ path: relative, reason: 'missing' });
      continue;
    }
    const stats = fs.statSync(filePath);
    if (stats.size !== Number(entry.size)) {
      errors.push({ path: relative, reason: 'size-mismatch' });
      continue;
    }
    if (sha256File(filePath) !== entry.sha256) {
      errors.push({ path: relative, reason: 'hash-mismatch' });
      continue;
    }
    if (entry.kind === 'sqlite-snapshot') {
      const database = new DatabaseSync(filePath, { readOnly: true });
      try {
        const rows = database.prepare('PRAGMA quick_check').all();
        if (!rows.every((row) => Object.values(row).every((value) => value === 'ok'))) {
          errors.push({ path: relative, reason: 'sqlite-integrity' });
          continue;
        }
      } finally { database.close(); }
    }
    verifiedBytes += stats.size;
  }
  return {
    ok: errors.length === 0,
    backupPath: root,
    createdAt: manifest.createdAt,
    verifiedFiles: manifest.files.length - errors.length,
    verifiedBytes,
    errors,
  };
}

function listBackups(runtimePaths) {
  if (!fs.existsSync(runtimePaths.backupsRoot)) return [];
  return fs.readdirSync(runtimePaths.backupsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.partial-'))
    .map((entry) => {
      const backupPath = path.join(runtimePaths.backupsRoot, entry.name);
      try {
        const manifest = readManifest(backupPath);
        return { name: entry.name, backupPath, createdAt: manifest.createdAt, totals: manifest.totals, validManifest: true };
      } catch (error) {
        return { name: entry.name, backupPath, createdAt: null, totals: null, validManifest: false, error: error.message };
      }
    })
    .sort((left, right) => String(right.createdAt || right.name).localeCompare(String(left.createdAt || left.name)));
}

function restorePlan(runtimePaths, backupPath) {
  const verification = verifyBackup(backupPath);
  const actions = verification.ok ? readManifest(backupPath).files.map((entry) => ({
    source: path.join(path.resolve(backupPath), ...entry.path.split('/')),
    destination: entry.path.startsWith('data/')
      ? path.join(runtimePaths.dataRoot, ...entry.path.slice(5).split('/'))
      : path.join(runtimePaths.configRoot, ...entry.path.slice(7).split('/')),
    action: 'replace-after-service-stop',
  })) : [];
  return {
    restorable: verification.ok,
    requiresServiceStop: true,
    requiresFreshSafetyBackup: true,
    secretsRestored: false,
    writesPerformed: false,
    verification,
    actions,
  };
}

function print(value, json = false) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const options = parseArguments();
  const requestedRoot = options.runtimeRoot || (process.platform === 'darwin' ? DEFAULT_MAC_ROOT : '');
  const runtime = resolveRuntimePaths({ env: { ...process.env, ...(requestedRoot ? { KAOYAN_RUNTIME_ROOT: requestedRoot } : {}) } });
  if (options.command === 'plan') {
    print({
      action: 'create-snapshot',
      runtimeRoot: runtime.runtimeRoot,
      backupRoot: runtime.backupsRoot,
      includes: ['data', 'non-secret config'],
      excludes: ['API keys', 'mobile password material', 'Cloudflare token', 'logs', 'runtime locks'],
      sqliteMethod: 'quick_check + VACUUM INTO',
      writesProductionData: false,
      deletesOldBackups: false,
    }, options.json);
    return;
  }
  if (options.command === 'status') {
    print({ backupRoot: runtime.backupsRoot, backups: listBackups(runtime) }, options.json);
    return;
  }
  if (options.command === 'create') {
    print(createBackup(runtime), options.json);
    return;
  }
  if (!options.backup) throw new Error(`${options.command} 需要 --backup=<备份目录>。`);
  if (options.command === 'verify') {
    const result = verifyBackup(options.backup);
    print(result, options.json);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (options.command === 'restore-plan') {
    const result = restorePlan(runtime, options.backup);
    print(result, options.json);
    if (!result.restorable) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command: ${options.command}`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`Mac mini 备份失败：${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  BACKUP_SCHEMA_VERSION,
  backupName,
  copyStableFile,
  createBackup,
  listBackups,
  parseArguments,
  readManifest,
  restorePlan,
  sha256File,
  snapshotSqlite,
  verifyBackup,
  walkFiles,
};
