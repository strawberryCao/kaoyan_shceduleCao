'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('cloud capture uses one atomic batch commit', () => {
  const media = read('cloudflare/media.js');
  const worker = read('cloudflare/worker.js');
  const store = read('cloudflare/github-store.js');
  assert.match(media, /export async function saveNoteBatch/);
  assert.match(media, /STORAGE_PATHS\.learning/);
  assert.match(media, /cloud: save \$\{staged\.length\} captured questions/);
  assert.match(worker, /pathname === '\/save-note-batch'/);
  assert.match(store, /const tree = await Promise\.all\(files\.map/);
});

test('mobile multi-question detection keeps Safari connection alive while the background job is running', () => {
  const worker = read('cloudflare/worker.js');
  const notes = read('src/utils/notes.ts');
  assert.match(worker, /application\/x-ndjson/);
  assert.match(worker, /AI 仍在识别，连接正常/);
  assert.match(notes, /ai\/detect-questions\/stream/);
  assert.match(notes, /response\.body\.getReader\(\)/);
});

test('mobile capture exits immediately and the background worker performs one queued batch save', () => {
  const app = read('src/components/NoteDropApp.tsx');
  const jobs = read('src/utils/noteBackgroundJobs.ts');
  const start = app.indexOf('const startMultiQuestion = async () =>');
  const end = app.indexOf('const confirmBatchCrop', start);
  const block = app.slice(start, end);
  assert.match(block, /await enqueueMultiQuestionJob\(sourceImage\.src/);
  assert.doesNotMatch(block, /detectQuestionRegions/);
  assert.doesNotMatch(block, /cropManyImages/);
  assert.match(block, /无需停留或逐题确认/);
  assert.match(jobs, /cropImageDataUrl\(initial\.imageDataUrl, FULL_PAGE, 1500, 0\.72\)/);
  assert.match(jobs, /cropManyImages\(initial\.imageDataUrl, detection\.regions, 1800, 0\.86\)/);
  assert.match(jobs, /await enqueueCaptureUpload\(payloads\)/);
  assert.doesNotMatch(jobs, /await saveNoteImage\(/);
});
