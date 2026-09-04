'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { consolidate } = require('./consolidate-note-artifacts.cjs');

test('archives duplicate hash artifacts and restores one readable canonical sidecar', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-consolidate-note-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const notesRoot = path.join(root, 'notes');
  const assistantRoot = path.join(root, 'assistant');
  const subjectDir = path.join(notesRoot, 'Mathematics');
  const metadataDir = path.join(subjectDir, '.metadata');
  const assetDir = path.join(subjectDir, '.assets');
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.mkdirSync(assetDir, { recursive: true });
  const bytes = Buffer.from('identical-image');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const namedImage = path.join(subjectDir, 'Mathematics_integral.png');
  const strayImage = path.join(subjectDir, `${digest}_2.png`);
  const hiddenAsset = path.join(assetDir, `${digest}.png`);
  fs.writeFileSync(namedImage, bytes);
  fs.writeFileSync(strayImage, bytes);
  fs.writeFileSync(hiddenAsset, bytes);
  const uid = 'stable-note-123';
  const duplicateSidecar = path.join(metadataDir, `${digest}_2.note.json`);
  fs.writeFileSync(duplicateSidecar, JSON.stringify({
    schemaVersion: 2,
    v2Version: 3,
    entryId: uid,
    noteUid: uid,
    id: `${digest}_2`,
    kind: 'note',
    subject: 'Mathematics',
    title: 'Wrong title',
    fileName: path.basename(strayImage),
    filePath: strayImage,
    attachments: [{ id: digest, assetId: digest, filePath: hiddenAsset }],
    learning: {
      title: 'Human title',
      subject: 'Mathematics',
      reviewStatus: 'corrected',
      classificationSource: 'manual',
      decisionRevision: 2,
      userEditedFields: ['title', 'subject'],
    },
  }));

  const dryRun = consolidate({ notesRoot, assistantRoot, noteUid: uid, preferredFile: namedImage });
  assert.equal(dryRun.mode, 'dry-run');
  assert.deepEqual(dryRun.redundantImages, [strayImage]);
  assert.equal(fs.existsSync(strayImage), true);

  const applied = consolidate({ notesRoot, assistantRoot, noteUid: uid, preferredFile: namedImage, apply: true });
  const canonical = JSON.parse(fs.readFileSync(applied.preferredSidecar, 'utf8'));
  assert.equal(canonical.title, 'Human title');
  assert.equal(canonical.filePath, namedImage);
  assert.equal(canonical.attachments[0].filePath, namedImage);
  assert.equal(canonical.attachments[1].filePath, hiddenAsset);
  assert.equal(fs.existsSync(strayImage), false);
  assert.equal(fs.existsSync(duplicateSidecar), false);
  assert.equal(fs.existsSync(path.join(applied.archiveRoot, 'inventory.json')), true);
  assert.equal(applied.archived.length, 2);
});
