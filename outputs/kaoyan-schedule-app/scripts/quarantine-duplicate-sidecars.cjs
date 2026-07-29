'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicJson, walk } = require('./migrate-learning-data-v2.cjs');

function parseArgs(argv) {
  const result = { apply: false };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--apply') result.apply = true;
    else if (argv[index].startsWith('--')) result[argv[index].slice(2)] = argv[++index];
  }
  return result;
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; }
}

function stableId(value) {
  const candidate = String(value?.entryId || value?.noteUid || value?.id || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(candidate) ? candidate : '';
}

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function main() {
  const options = parseArgs(process.argv);
  const notesRoot = path.resolve(options['notes-root'] || '');
  const outputRoot = path.resolve(options['output-root'] || '');
  if (!fs.existsSync(notesRoot)) throw new Error('Notes root is required.');
  if (!options['output-root']) throw new Error('Quarantine output root is required.');
  const groups = new Map();
  for (const filePath of walk(notesRoot).filter((candidate) => (
    /\.note\.json$/i.test(candidate) && !/sync-conflict-/i.test(candidate)
  ))) {
    const value = readJson(filePath);
    const entryId = stableId(value);
    if (!entryId) continue;
    const current = groups.get(entryId) || [];
    current.push({ filePath, value });
    groups.set(entryId, current);
  }
  const duplicates = [];
  const issues = [];
  for (const [entryId, records] of groups) {
    if (records.length < 2) continue;
    const canonical = records.filter((record) => Number(record.value?.v2Version) > 0);
    if (canonical.length !== 1) {
      issues.push({ entryId, reason: 'canonical-sidecar-is-ambiguous', paths: records.map((item) => path.relative(notesRoot, item.filePath)) });
      continue;
    }
    for (const record of records) {
      if (record === canonical[0]) continue;
      duplicates.push({
        entryId,
        sourcePath: record.filePath,
        relativePath: path.relative(notesRoot, record.filePath).replaceAll('\\', '/'),
        canonicalPath: path.relative(notesRoot, canonical[0].filePath).replaceAll('\\', '/'),
      });
    }
  }
  const report = {
    schemaVersion: 1,
    mode: options.apply ? 'apply' : 'dry-run',
    duplicateCount: duplicates.length,
    issues,
    quarantined: [],
  };
  if (issues.length) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.apply) {
    const filesRoot = path.join(outputRoot, 'files');
    fs.mkdirSync(filesRoot, { recursive: true });
    for (let index = 0; index < duplicates.length; index += 1) {
      const duplicate = duplicates[index];
      const archivePath = path.join(filesRoot, `${String(index + 1).padStart(4, '0')}.note.json`);
      fs.copyFileSync(duplicate.sourcePath, archivePath);
      const sourceHash = hash(duplicate.sourcePath);
      if (hash(archivePath) !== sourceHash) throw new Error(`Quarantine hash mismatch: ${duplicate.relativePath}`);
      report.quarantined.push({
        entryId: duplicate.entryId,
        relativePath: duplicate.relativePath,
        canonicalPath: duplicate.canonicalPath,
        archivePath: path.relative(outputRoot, archivePath).replaceAll('\\', '/'),
        sha256: sourceHash,
      });
    }
    atomicJson(path.join(outputRoot, 'inventory.json'), {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      files: report.quarantined,
    });
    for (const duplicate of duplicates) fs.unlinkSync(duplicate.sourcePath);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (require.main === module) main();
