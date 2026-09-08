#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWriteJson } = require('./runtime-paths.cjs');

const REPORT_SCHEMA_VERSION = 1;
const SOURCE_KINDS = new Set(['notes-directory', 'assistant-directory', 'v2-directory', 'cloudflare-export', 'snapshot-json']);
const HUMAN_FIELDS = new Set(['title', 'remark', 'subject', 'tags', 'facets', 'studyNotes', 'attachments', 'completedTaskIds', 'note', 'debt', 'mistakes', 'deletedAt', 'restoredAt']);
const REMOTE_URI_PATTERN = /^(?:https?:|github:|r2:|data:|blob:)/i;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;
const SENSITIVE_FILE_PATTERN = /(?:^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|ai-providers\.json|mobile-access\.json|cloudflare-tunnel\.token)$/i;

function parseArguments(argv = process.argv.slice(2)) {
  const result = { command: 'plan', manifest: '', output: '', json: false };
  let commandSeen = false;
  for (const argument of argv) {
    if (!argument.startsWith('-') && !commandSeen) {
      result.command = argument;
      commandSeen = true;
    } else if (argument === '--json') result.json = true;
    else if (argument.startsWith('--manifest=')) result.manifest = path.resolve(argument.slice(11).trim());
    else if (argument.startsWith('--output=')) result.output = path.resolve(argument.slice(9).trim());
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function valueHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function fileHash(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

function assertSafeSource(sourcePath) {
  const resolved = path.resolve(sourcePath);
  const parsedRoot = path.parse(resolved).root;
  const home = path.resolve(os.homedir());
  if (resolved === parsedRoot || resolved === home || /FILL_WITH_/i.test(resolved)) {
    throw new Error(`拒绝过宽或尚未填写的迁移来源：${sourcePath}`);
  }
  if (!fs.existsSync(resolved)) throw new Error(`迁移来源不存在：${sourcePath}`);
  return resolved;
}

function loadManifest(manifestPath) {
  if (!manifestPath) throw new Error('请使用 --manifest=<来源清单> 指定迁移来源。');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (Number(manifest?.schemaVersion) !== 1 || !Array.isArray(manifest?.sources) || manifest.sources.length === 0) {
    throw new Error('迁移来源清单格式无效。');
  }
  const ids = new Set();
  return manifest.sources.map((source) => {
    const id = String(source?.id || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(id) || ids.has(id)) throw new Error(`迁移来源 ID 无效或重复：${id || '(empty)'}`);
    ids.add(id);
    const kind = String(source?.kind || '');
    if (!SOURCE_KINDS.has(kind)) throw new Error(`不支持的迁移来源类型：${kind}`);
    return { id, kind, path: assertSafeSource(source.path), priority: Number(source.priority) || 0 };
  });
}

function walk(root) {
  const stats = fs.lstatSync(root);
  if (stats.isSymbolicLink()) throw new Error(`迁移盘点拒绝跟随符号链接：${root}`);
  if (stats.isFile()) return [root];
  if (!stats.isDirectory()) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      const targetStats = fs.lstatSync(target);
      if (targetStats.isSymbolicLink()) throw new Error(`迁移盘点拒绝跟随符号链接：${target}`);
      if (targetStats.isDirectory()) visit(target);
      else if (targetStats.isFile()) files.push(target);
    }
  };
  visit(root);
  return files;
}

function isAbsoluteStoredPath(value) {
  return WINDOWS_ABSOLUTE_PATTERN.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

function recordIdentity(value, contextKey = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const noteUid = String(value.noteUid || value.entryId || '').trim();
  if (noteUid) return `note:${noteUid}`;
  if (contextKey === 'cards') {
    const id = String(value.id || '').trim();
    if (id) return `card:${id}`;
  }
  if ((contextKey === 'canvas' || value.canvasId) && String(value.canvasId || value.id || '').trim()) {
    return `canvas:${String(value.canvasId || value.id).trim()}`;
  }
  return '';
}

function inspectJson(value, state, pointer = '$', contextKey = '') {
  if (typeof value === 'string') {
    if (isAbsoluteStoredPath(value)) state.absolutePathFields.add(pointer);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectJson(item, state, `${pointer}[${index}]`, contextKey));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const identity = recordIdentity(value, contextKey);
  if (identity) {
    const human = Object.fromEntries([...HUMAN_FIELDS].filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]));
    state.records.push({ identity, semanticHash: valueHash(value), humanHash: valueHash(human), fields: Object.keys(value).sort() });
    for (const field of Object.keys(value)) state.fieldCounts.set(field, (state.fieldCounts.get(field) || 0) + 1);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'attachments' && Array.isArray(child)) {
      for (const [index, attachment] of child.entries()) {
        const reference = String(attachment?.filePath || attachment?.path || '').trim();
        if (reference) state.assetReferences.push({ pointer: `${pointer}.attachments[${index}]`, reference });
      }
    }
    inspectJson(child, state, `${pointer}.${key}`, key);
  }
}

function portableRelative(root, filePath) {
  if (fs.statSync(root).isFile()) return path.basename(filePath);
  return path.relative(root, filePath).split(path.sep).join('/');
}

function isSensitiveRelativePath(relativePath) {
  const portable = String(relativePath || '').replaceAll('\\', '/');
  if (/\.(?:example|sample)\.(?:json|env)$/i.test(portable)) return false;
  return SENSITIVE_FILE_PATTERN.test(portable)
    || /(?:^|\/)secrets\//i.test(portable)
    || /(?:^|\/)(?:cert\.pem|[^/]+\.key|[^/]*credentials?[^/]*\.json)$/i.test(portable);
}

function auditSources(sources, options = {}) {
  const state = {
    records: [],
    assetReferences: [],
    absolutePathFields: new Set(),
    fieldCounts: new Map(),
  };
  const files = [];
  const parseFailures = [];
  for (const source of sources) {
    const sourceFiles = walk(source.path);
    let totalBytes = 0;
    for (const filePath of sourceFiles) {
      const stats = fs.statSync(filePath);
      totalBytes += stats.size;
      const relativePath = portableRelative(source.path, filePath);
      if (isSensitiveRelativePath(relativePath)) {
        files.push({ sourceId: source.id, path: relativePath, size: stats.size, sha256: null, json: false, excluded: 'sensitive-config' });
        continue;
      }
      const sha256 = fileHash(filePath);
      const recordStart = state.records.length;
      const assetReferenceStart = state.assetReferences.length;
      if (/\.json$/i.test(filePath) && stats.size <= 256 * 1024 * 1024) {
        try {
          const value = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
          inspectJson(value, state, `$source:${source.id}/${relativePath}`);
        } catch (error) {
          parseFailures.push({ sourceId: source.id, path: relativePath, error: error.message });
        }
      }
      for (const record of state.records.slice(recordStart)) {
        record.sourceId = source.id;
        record.sourcePriority = source.priority;
        record.path = relativePath;
      }
      for (const reference of state.assetReferences.slice(assetReferenceStart)) {
        reference.sourceId = source.id;
        reference.sourceFile = relativePath;
        reference.baseDirectory = path.dirname(filePath);
      }
      files.push({ sourceId: source.id, path: relativePath, size: stats.size, sha256, json: /\.json$/i.test(filePath) });
    }
    source.fileCount = sourceFiles.length;
    source.totalBytes = totalBytes;
  }

  const recordsByIdentity = new Map();
  for (const record of state.records) {
    const existing = recordsByIdentity.get(record.identity) || [];
    existing.push(record);
    recordsByIdentity.set(record.identity, existing);
  }
  const conflicts = [];
  let exactRecordDuplicates = 0;
  for (const [identity, records] of recordsByIdentity) {
    const semanticHashes = new Set(records.map((record) => record.semanticHash));
    if (semanticHashes.size === 1 && records.length > 1) exactRecordDuplicates += records.length - 1;
    if (semanticHashes.size > 1) {
      const humanHashes = new Set(records.map((record) => record.humanHash));
      conflicts.push({
        identity,
        reason: humanHashes.size > 1 ? 'human-field-conflict' : 'non-human-version-difference',
        resolution: humanHashes.size > 1 ? 'manual-review-required' : 'highest-priority-then-newest-safe-merge',
        candidates: records.map((record) => ({ sourceId: record.sourceId, path: record.path, priority: record.sourcePriority, fields: record.fields })),
      });
    }
  }

  const fileHashes = new Map();
  for (const file of files.filter((candidate) => candidate.sha256)) {
    const group = fileHashes.get(file.sha256) || [];
    group.push(file);
    fileHashes.set(file.sha256, group);
  }
  const duplicateFileGroups = [...fileHashes.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([sha256, group]) => ({ sha256, size: group[0].size, copies: group.length, locations: group.map((file) => ({ sourceId: file.sourceId, path: file.path })) }));

  const sourceRoots = sources.map((source) => source.path);
  const unresolvedAssetReferences = state.assetReferences.filter(({ reference, baseDirectory }) => {
    if (REMOTE_URI_PATTERN.test(reference)) return false;
    if (isAbsoluteStoredPath(reference)) return !fs.existsSync(reference);
    if (baseDirectory && fs.existsSync(path.resolve(baseDirectory, reference))) return false;
    return !sourceRoots.some((root) => fs.statSync(root).isDirectory() && fs.existsSync(path.resolve(root, reference)));
  });

  const generatedAt = (options.now || new Date()).toISOString();
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: 'kaoyan-macmini-migration-dry-run',
    generatedAt,
    readOnly: true,
    writesPerformed: false,
    macAuthorityActivated: false,
    sources: sources.map(({ id, kind, path: sourcePath, priority, fileCount, totalBytes }) => ({ id, kind, path: sourcePath, priority, fileCount, totalBytes })),
    totals: {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      jsonFiles: files.filter((file) => file.json).length,
      stableRecords: state.records.length,
      uniqueRecordIds: recordsByIdentity.size,
      exactRecordDuplicates,
      recordConflicts: conflicts.length,
      duplicateFileGroups: duplicateFileGroups.length,
      unresolvedAssetReferences: unresolvedAssetReferences.length,
      absolutePathFields: state.absolutePathFields.size,
      parseFailures: parseFailures.length,
      sensitiveFilesExcluded: files.filter((file) => file.excluded === 'sensitive-config').length,
    },
    conservation: {
      fieldCounts: Object.fromEntries([...state.fieldCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
      humanFieldsProtected: [...HUMAN_FIELDS].sort(),
      stableIdsRequired: true,
      attachmentSha256Required: true,
      unknownFieldsPolicy: 'preserve',
    },
    conflicts: conflicts.slice(0, 500),
    duplicateFileGroups: duplicateFileGroups.slice(0, 500),
    unresolvedAssetReferences: unresolvedAssetReferences.slice(0, 500),
    absolutePathFields: [...state.absolutePathFields].slice(0, 500),
    parseFailures: parseFailures.slice(0, 500),
    sensitiveFilesExcluded: files.filter((file) => file.excluded === 'sensitive-config').map((file) => ({ sourceId: file.sourceId, path: file.path })),
    importPlan: {
      target: 'Mac shadow store',
      deduplicateRecordsBy: 'stable entity ID and semantic hash',
      deduplicateAssetsBy: 'SHA-256',
      automaticMerge: 'independent fields and identical content only',
      manualReview: 'same stable ID with different human fields',
      activationRequiresUserApproval: true,
      executableInThisReport: false,
    },
  };
}

function printPlan(json = false) {
  const plan = {
    action: 'read-only migration inventory and dry-run',
    manifestTemplate: path.join(__dirname, 'macmini-migration-sources.example.json'),
    scans: ['Windows notes export', 'Windows assistant export', 'V2/private data checkout', 'Cloudflare export'],
    reports: ['file and byte totals', 'stable IDs', 'SHA-256 duplicates', 'human-field conflicts', 'unresolved attachments', 'absolute stored paths', 'JSON parse failures', 'field conservation'],
    movesFiles: false,
    changesSources: false,
    activatesMacAuthority: false,
  };
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

function main() {
  const options = parseArguments();
  if (options.command === 'plan') {
    printPlan(options.json);
    return;
  }
  if (!['audit', 'dry-run'].includes(options.command)) throw new Error(`Unknown command: ${options.command}`);
  const sources = loadManifest(options.manifest);
  const report = auditSources(sources);
  if (options.output) atomicWriteJson(options.output, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.totals.parseFailures > 0 || report.totals.unresolvedAssetReferences > 0 || report.totals.recordConflicts > 0) process.exitCode = 2;
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`Mac mini 迁移盘点失败：${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  HUMAN_FIELDS,
  REPORT_SCHEMA_VERSION,
  assertSafeSource,
  auditSources,
  canonical,
  fileHash,
  inspectJson,
  isSensitiveRelativePath,
  loadManifest,
  parseArguments,
  recordIdentity,
  valueHash,
  walk,
};
