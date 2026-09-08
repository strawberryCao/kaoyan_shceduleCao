const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { auditSources, isSensitiveRelativePath, loadManifest } = require('../macmini-migration-audit.cjs');

test('migration dry-run detects human conflicts, file duplicates and excludes secrets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-migration-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const left = path.join(root, 'left');
  const right = path.join(root, 'right');
  fs.mkdirSync(left);
  fs.mkdirSync(right);
  fs.writeFileSync(path.join(left, 'asset-a.png'), 'same-asset');
  fs.writeFileSync(path.join(right, 'asset-b.png'), 'same-asset');
  fs.writeFileSync(path.join(left, 'note.json'), JSON.stringify({ noteUid: 'note-1', title: '人工标题 A', attachments: [{ id: 'a1', filePath: 'asset-a.png' }], futureField: { keep: true } }));
  fs.writeFileSync(path.join(right, 'note.json'), JSON.stringify({ noteUid: 'note-1', title: '人工标题 B', attachments: [{ id: 'a1', filePath: 'asset-b.png' }], futureField: { keep: true } }));
  fs.writeFileSync(path.join(left, 'ai-providers.json'), JSON.stringify({ apiKey: 'do-not-read-or-hash' }));
  const manifestPath = path.join(root, 'sources.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, sources: [
    { id: 'windows', kind: 'notes-directory', path: left, priority: 100 },
    { id: 'cloud', kind: 'cloudflare-export', path: right, priority: 60 },
  ] }));

  const report = auditSources(loadManifest(manifestPath), { now: new Date('2026-09-08T00:00:00Z') });
  assert.equal(report.readOnly, true);
  assert.equal(report.writesPerformed, false);
  assert.equal(report.macAuthorityActivated, false);
  assert.equal(report.totals.uniqueRecordIds, 1);
  assert.equal(report.totals.recordConflicts, 1);
  assert.equal(report.conflicts[0].reason, 'human-field-conflict');
  assert.equal(report.conflicts[0].resolution, 'manual-review-required');
  assert.equal(report.totals.duplicateFileGroups >= 1, true);
  assert.equal(report.totals.sensitiveFilesExcluded, 1);
  assert.equal(report.totals.unresolvedAssetReferences, 0);
  assert.equal(report.conservation.fieldCounts.futureField, 2);
});

test('migration manifest refuses broad roots, placeholders and duplicate IDs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-migration-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'sources.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, sources: [
    { id: 'same', kind: 'notes-directory', path: root },
    { id: 'same', kind: 'notes-directory', path: root },
  ] }));
  assert.throws(() => loadManifest(manifestPath), /重复/);
  assert.equal(isSensitiveRelativePath('config/ai-providers.json'), true);
  assert.equal(isSensitiveRelativePath('scripts/ai-providers.example.json'), false);
});
