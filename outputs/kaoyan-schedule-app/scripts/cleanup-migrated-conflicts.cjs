'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const result = { apply: false };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--apply') result.apply = true;
    else if (argv[index].startsWith('--')) result[argv[index].slice(2)] = argv[++index];
  }
  return result;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function inside(root, candidate) {
  const normalizedRoot = `${path.resolve(root)}${path.sep}`.toLowerCase();
  return path.resolve(candidate).toLowerCase().startsWith(normalizedRoot);
}

function main() {
  const options = parseArgs(process.argv);
  const inventoryPath = path.resolve(options.inventory || '');
  const sourceRoots = {
    repo: path.resolve(options['repo-root'] || ''),
    notes: path.resolve(options['notes-root'] || ''),
  };
  if (!fs.existsSync(inventoryPath)) throw new Error('Conflict archive inventory is required.');
  if (!fs.existsSync(sourceRoots.repo) || !fs.existsSync(sourceRoots.notes)) {
    throw new Error('Both source roots must exist.');
  }
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8').replace(/^\uFEFF/, ''));
  if (inventory.storage !== 'flat-numbered-files' || !Array.isArray(inventory.files)) {
    throw new Error('Unsupported conflict archive inventory.');
  }
  const flatRoot = path.join(path.dirname(inventoryPath), 'flat-files');
  const verified = [];
  const issues = [];
  const seenSources = new Set();
  for (const record of inventory.files) {
    const root = sourceRoots[record.source];
    const sourcePath = root ? path.resolve(root, String(record.relativePath || '')) : '';
    const archivePath = path.resolve(flatRoot, String(record.archivePath || ''));
    const sourceKey = sourcePath.toLowerCase();
    if (!root || !inside(root, sourcePath) || !/sync-conflict-/i.test(path.basename(sourcePath))) {
      issues.push({ relativePath: record.relativePath, reason: 'unsafe-source-path' });
      continue;
    }
    if (!inside(flatRoot, archivePath)) {
      issues.push({ relativePath: record.relativePath, reason: 'unsafe-archive-path' });
      continue;
    }
    if (seenSources.has(sourceKey)) {
      issues.push({ relativePath: record.relativePath, reason: 'duplicate-source-record' });
      continue;
    }
    seenSources.add(sourceKey);
    if (!fs.existsSync(sourcePath)) {
      issues.push({ relativePath: record.relativePath, reason: 'source-missing' });
      continue;
    }
    if (!fs.existsSync(archivePath)) {
      issues.push({ relativePath: record.relativePath, reason: 'archive-missing' });
      continue;
    }
    const sourceHash = sha256(sourcePath);
    const archiveHash = sha256(archivePath);
    if (sourceHash !== record.sha256 || archiveHash !== record.sha256) {
      issues.push({ relativePath: record.relativePath, reason: 'sha256-mismatch' });
      continue;
    }
    verified.push({ sourcePath, archivePath });
  }

  const report = {
    schemaVersion: 1,
    mode: options.apply ? 'apply' : 'dry-run',
    inventoryCount: inventory.files.length,
    verified: verified.length,
    issues,
    removed: 0,
  };
  if (issues.length) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.apply) {
    for (const item of verified) fs.unlinkSync(item.sourcePath);
    report.removed = verified.length;
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (require.main === module) main();

module.exports = { inside, sha256 };
