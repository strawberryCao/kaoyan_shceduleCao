'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'components', 'NoteDropApp.tsx'), 'utf8');
const jobs = fs.readFileSync(path.join(root, 'src', 'utils', 'noteBackgroundJobs.ts'), 'utf8');
const queue = fs.readFileSync(path.join(root, 'src', 'utils', 'captureUploadQueue.ts'), 'utf8');

test('mobile multi-question capture leaves the foreground after durable local enqueue', () => {
  const start = source.indexOf('const startMultiQuestion');
  const end = source.indexOf('const confirmBatchCrop', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /await enqueueMultiQuestionJob\(sourceImage\.src/);
  assert.match(block, /setMobileStep\('success'\)/);
  assert.match(block, /无需停留或逐题确认/);
  assert.doesNotMatch(block, /detectQuestionRegions/);
  assert.doesNotMatch(block, /cropManyImages/);
  assert.doesNotMatch(block, /setMobileStep\('batch'\)/);
});

test('single, multi-question and resulting image batches all use durable idempotent queues', () => {
  assert.match(source, /await enqueueCaptureUpload\(\[payload\]\)/);
  assert.match(source, /await enqueueMultiQuestionJob\(sourceImage\.src/);
  assert.match(jobs, /await putJob\(job\)/);
  assert.match(jobs, /await enqueueCaptureUpload\(payloads\)/);
  assert.match(jobs, /multi_\$\{batchToken\}_\$\{index \+ 1\}/);
  assert.match(queue, /noteUids/);
  assert.match(queue, /UPLOAD_LEASE_MS/);
  assert.match(queue, /上次上传被系统中断/);
});
