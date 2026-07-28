'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scriptsRoot = path.resolve(__dirname, '..');
const migrationScript = path.join(scriptsRoot, 'migrate-learning-data-v2.cjs');
const adapterScript = path.join(scriptsRoot, 'v2-local-adapter.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('migration classifies every JSON and writes hash-addressed V2 data without absolute paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-v2-migration-'));
  const repoRoot = path.join(root, 'repo');
  const notesRoot = path.join(root, 'notes');
  const imagePath = path.join(notesRoot, '默认文件夹', 'question.png');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from('not-a-real-image-but-stable-test-bytes'));
  fs.mkdirSync(path.join(notesRoot, 'pdf'), { recursive: true });
  fs.writeFileSync(path.join(notesRoot, 'pdf', '背诵整理.pdf'), Buffer.from('%PDF-orphan-test'));
  writeJson(path.join(notesRoot, '默认文件夹', '.metadata', 'entry-a.note.json'), {
    schemaVersion: 2,
    noteUid: 'entry-a',
    subject: '不应成为一级目录',
    title: '测试题',
    remark: '正文',
    filePath: imagePath,
    facets: ['knowledge', 'method'],
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
  });
  writeJson(path.join(repoRoot, 'data', 'cloud', 'learning-data.json'), {
    version: 1,
    days: { '2026-07-27': { autoNotes: [{ noteUid: 'legacy-b', subject: '高等数学', title: '旧题', remark: '' }] } },
    cards: [],
    deletedNotes: {},
  });
  fs.mkdirSync(path.join(repoRoot, 'data', 'cloud'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'data', 'cloud', 'learning-data.json'),
    path.join(repoRoot, 'data', 'cloud', 'learning-data.sync-conflict-local-copy.json'),
  );
  const manifestPath = path.join(root, 'manifest.json');

  try {
    execFileSync(process.execPath, [
      migrationScript,
      '--repo-root', repoRoot,
      '--notes-root', notesRoot,
      '--output', manifestPath,
      '--apply',
    ], { stdio: 'pipe' });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.files.length, 3);
    assert.equal(manifest.files.every((item) => ['adopt', 'duplicate', 'manual'].includes(item.classification)), true);
    assert.equal(manifest.summary.duplicateFiles, 1);
    assert.equal(manifest.summary.orphanAssetsImported, 1);
    assert.equal(manifest.orphanAssets[0].relativePath, 'pdf/背诵整理.pdf');
    const entry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'v2', 'entries', 'entry-a.json'), 'utf8'));
    assert.equal(entry.subject, '默认文件夹');
    assert.deepEqual(entry.facets, ['knowledge', 'method']);
    assert.match(entry.assets[0].path, /^data\/assets\/[a-f0-9]{64}\.png$/);
    assert.doesNotMatch(JSON.stringify(entry), /[A-Za-z]:[\\/]/);
    assert.equal(fs.existsSync(path.join(repoRoot, entry.assets[0].path)), true);
    const assetRecord = JSON.parse(fs.readFileSync(
      path.join(repoRoot, 'data', 'v2', 'assets', `${entry.assets[0].assetId}.json`),
      'utf8',
    ));
    assert.equal(assetRecord.sourcePath, undefined);
    assert.doesNotMatch(JSON.stringify(assetRecord), /[A-Za-z]:[\\/]/);
    execFileSync(process.execPath, [
      migrationScript,
      '--repo-root', repoRoot,
      '--notes-root', notesRoot,
      '--output', manifestPath,
      '--apply',
    ], { stdio: 'pipe' });
    const repeatedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(repeatedManifest.files.length, 3);
    assert.equal(repeatedManifest.summary.assets, 2);
    assert.equal(repeatedManifest.summary.orphanAssetsImported, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('V2 local adapter converges after one apply cycle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-v2-adapter-'));
  const repoRoot = path.join(root, 'repo');
  const notesRoot = path.join(root, 'notes');
  const configPath = path.join(root, 'config.json');
  const localImage = path.join(notesRoot, '默认文件夹', 'local.png');
  fs.mkdirSync(path.dirname(localImage), { recursive: true });
  fs.writeFileSync(localImage, Buffer.from('stable-local-asset'));
  const originalSidecarPath = path.join(notesRoot, '默认文件夹', '.metadata', '原始描述文件名.note.json');
  writeJson(originalSidecarPath, {
    schemaVersion: 2,
    noteUid: 'stable-entry',
    subject: '默认文件夹',
    title: '稳定条目',
    remark: '一次发布后不应反复变化',
    filePath: localImage,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
  });
  writeJson(configPath, { clonePath: repoRoot, localPath: notesRoot });

  try {
    execFileSync(process.execPath, [adapterScript, '--config', configPath, '--apply']);
    const entryPath = path.join(repoRoot, 'data', 'v2', 'entries', 'stable-entry.json');
    const firstHash = fileHash(entryPath);
    const indexPath = path.join(repoRoot, 'data', 'v2', 'index.json');
    const firstIndexHash = fileHash(indexPath);
    execFileSync(process.execPath, [adapterScript, '--config', configPath, '--apply']);
    assert.equal(fileHash(entryPath), firstHash);
    assert.equal(fileHash(indexPath), firstIndexHash);
    const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
    const materialized = JSON.parse(fs.readFileSync(
      originalSidecarPath,
      'utf8',
    ));
    assert.equal(path.isAbsolute(materialized.filePath), true);
    assert.equal(fs.existsSync(materialized.filePath), true);
    assert.equal(materialized.attachments[0].cloudPath, `github://${entry.assets[0].path}`);
    assert.equal(materialized.v2Version, entry.version);
    assert.equal(fs.existsSync(path.join(notesRoot, '默认文件夹', '.metadata', 'stable-entry.note.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
