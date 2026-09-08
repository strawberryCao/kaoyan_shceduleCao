'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('remote browsers keep authoritative business snapshots in memory only', () => {
  const learning = read('src/utils/learningData.ts');
  const schedule = read('src/utils/scheduleRecords.ts');
  const canvas = read('src/components/NoteCapturePage.tsx');
  const policy = read('src/utils/remoteDataPolicy.ts');

  assert.match(learning, /if \(IS_CLOUD_RUNTIME\) \{\s*const snapshot = learningDataMemoryCache/);
  assert.match(learning, /if \(IS_CLOUD_RUNTIME\) \{\s*window\.dispatchEvent/);
  assert.match(schedule, /if \(IS_CLOUD_RUNTIME\) return normalizeRecords\(remoteMemoryRecords/);
  assert.match(schedule, /if \(IS_CLOUD_RUNTIME\) remoteMemoryRecords = structuredClone/);
  assert.match(canvas, /draftKey=\{IS_CLOUD_RUNTIME \? false/);
  assert.match(policy, /kaoyan-learning-data-v1/);
  assert.match(policy, /kaoyan\.canvas\.draft\.v1\./);
});

test('only unsent browser content persists and every such payload is encrypted', () => {
  const capture = read('src/utils/captureUploadQueue.ts');
  const crop = read('src/utils/noteBackgroundJobs.ts');
  const draft = read('src/utils/quickMaterialDraft.ts');

  assert.match(capture, /generateKey\(\{ name: 'AES-GCM', length: 256 \}, false/);
  assert.match(capture, /metadataCiphertext/);
  assert.match(capture, /encryptedItems: \[\]/);
  assert.match(crop, /sealedMetadata/);
  assert.match(crop, /sealedImage/);
  assert.match(crop, /schemaVersion: 2/);
  assert.match(draft, /IS_CLOUD_RUNTIME \? await encryptDraft\(draft\) : draft/);
  assert.match(draft, /fileDescriptors/);
});
