'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { repairLearningAssets } = require('../repair-learning-assets.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test('repairs a moved legacy image with a stable asset id and V2 entry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-learning-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const notesRoot = path.join(root, 'notes');
  const repoRoot = path.join(root, 'repo');
  const learningData = path.join(root, 'learning-data.json');
  const noteUid = 'b5a85e66-6d6c-473d-9763-4be824f169fa';
  const actualImage = path.join(notesRoot, '高等数学', '高等数学_单调性判别定义_20260721_090811.png');
  const staleImage = path.join(notesRoot, '默认文件夹', '默认文件夹_单调性判别定义_20260721_090811.png');
  fs.mkdirSync(path.dirname(actualImage), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
  fs.writeFileSync(actualImage, Buffer.from('valid image bytes'));
  writeJson(learningData, {
    version: 1,
    revision: 10,
    days: {
      '2026-07-21': {
        autoNotes: [{
          noteUid,
          title: '单调性判别定义',
          filePath: staleImage,
          attachments: [],
          createdAt: '2026-07-21T01:08:11.189Z',
        }],
      },
    },
  });
  writeJson(path.join(repoRoot, 'data', 'v2', 'entries', `${noteUid}.json`), {
    schemaVersion: 2,
    entryId: noteUid,
    kind: 'note',
    title: '单调性判别定义',
    subject: '高等数学',
    facets: ['knowledge'],
    assets: [],
    version: 1,
    state: 'active',
    createdAt: '2026-07-21T01:08:11.189Z',
    updatedAt: '2026-07-21T01:08:11.189Z',
  });
  writeJson(path.join(repoRoot, 'data', 'v2', 'index.json'), {
    schemaVersion: 2,
    revision: 1,
    entries: [],
  });

  const dryRun = repairLearningAssets({ learningData, notesRoot, repoRoot, apply: false });
  assert.equal(dryRun.repairedNotes, 1);
  assert.equal(fs.existsSync(path.join(repoRoot, 'data', 'v2', 'assets')), false);

  const applied = repairLearningAssets({ learningData, notesRoot, repoRoot, apply: true });
  assert.equal(applied.repairedNotes, 1);
  const snapshot = JSON.parse(fs.readFileSync(learningData, 'utf8'));
  const note = snapshot.days['2026-07-21'].autoNotes[0];
  assert.equal(note.filePath, actualImage);
  assert.match(note.attachments[0].assetId, /^[a-f0-9]{64}$/);
  assert.equal(note.attachments[0].cloudPath, `github://data/assets/${note.attachments[0].assetId}.png`);
  const entry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'v2', 'entries', `${noteUid}.json`), 'utf8'));
  assert.equal(entry.version, 2);
  assert.equal(entry.assets[0].assetId, note.attachments[0].assetId);
});
