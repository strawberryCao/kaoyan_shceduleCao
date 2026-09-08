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
  assert.match(block, /稍后从活动中心逐题确认/);
  assert.doesNotMatch(block, /detectQuestionRegions/);
  assert.doesNotMatch(block, /cropManyImages/);
  assert.doesNotMatch(block, /setMobileStep\('batch'\)/);
});

test('single, multi-question and resulting image batches all use durable idempotent queues', () => {
  assert.match(source, /await enqueueCaptureUpload\(\[payload\]\)/);
  assert.match(source, /await enqueueMultiQuestionJob\(sourceImage\.src/);
  assert.match(jobs, /await putJob\(job\)/);
  assert.match(jobs, /imageBlob\?: Blob/);
  assert.match(jobs, /uploading\.imageBlob \? await blobToDataUrl\(uploading\.imageBlob\) : uploading\.imageDataUrl/);
  assert.match(jobs, /await createCaptureBatch\(imageDataUrl/);
  assert.match(jobs, /serverJobId/);
  assert.match(jobs, /loadMultiQuestionJobForReview/);
  assert.match(jobs, /completeMultiQuestionReview/);
  assert.doesNotMatch(jobs, /cropManyImages|detectQuestionRegions|enqueueCaptureUpload/);
  assert.match(queue, /noteUids/);
  assert.match(queue, /UPLOAD_LEASE_MS/);
  assert.match(queue, /Safari 上次被系统中断/);
  assert.match(jobs, /encryption: 'AES-GCM'/);
});
