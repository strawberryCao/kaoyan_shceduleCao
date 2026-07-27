'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { sha256 } = require('../cleanup-migrated-conflicts.cjs');

const script = path.resolve(__dirname, '..', 'cleanup-migrated-conflicts.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('conflict cleanup verifies every source and archive hash before removing exact files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-conflict-cleanup-'));
  const repoRoot = path.join(root, 'repo');
  const notesRoot = path.join(root, 'notes');
  const recoveryRoot = path.join(root, 'recovery');
  const source = path.join(repoRoot, 'data', 'item.sync-conflict-local-1.json');
  const archive = path.join(recoveryRoot, 'flat-files', 'repo', '000001.json');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(notesRoot, { recursive: true });
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(source, '{"stable":true}\n', 'utf8');
  fs.copyFileSync(source, archive);
  const inventoryPath = path.join(recoveryRoot, 'inventory.json');
  writeJson(inventoryPath, {
    storage: 'flat-numbered-files',
    files: [{
      source: 'repo',
      relativePath: 'data/item.sync-conflict-local-1.json',
      archivePath: 'repo/000001.json',
      sha256: sha256(source),
    }],
  });
  const common = [
    script,
    '--inventory', inventoryPath,
    '--repo-root', repoRoot,
    '--notes-root', notesRoot,
  ];

  try {
    const preview = JSON.parse(execFileSync(process.execPath, common, { encoding: 'utf8' }));
    assert.equal(preview.verified, 1);
    assert.equal(preview.removed, 0);
    fs.writeFileSync(archive, 'tampered', 'utf8');
    const rejected = spawnSync(process.execPath, [...common, '--apply'], { encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.equal(fs.existsSync(source), true);
    fs.copyFileSync(source, archive);
    const applied = JSON.parse(execFileSync(process.execPath, [...common, '--apply'], { encoding: 'utf8' }));
    assert.equal(applied.removed, 1);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.existsSync(archive), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
