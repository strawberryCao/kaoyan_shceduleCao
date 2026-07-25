'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'NoteDropApp.tsx'), 'utf8');

test('mobile multi-question capture stays in the foreground', () => {
  const start = source.indexOf('const buildDetectedBatch');
  const end = source.indexOf('const confirmBatchCrop', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /detectQuestionRegions\(src(?:,|\))/);
  assert.match(block, /setBatchProgress\(message\)/);
  assert.match(block, /cropManyImages\(src, detection\.regions(?:,|\))/);
  assert.doesNotMatch(block, /enqueueMultiQuestionJob/);
  assert.match(block, /setMobileStep\('batch'\)/);
  assert.match(block, /detectionRunRef/);
});

test('single and batch image saves retry idempotently after mobile network loss', () => {
  assert.match(source, /const saveImageReliably/);
  assert.match(source, /load failed\|failed to fetch\|network/);
  assert.equal((source.match(/await saveImageReliably\(/g) || []).length, 2);
  assert.match(source, /连接中断，正在自动确认保存结果/);
});
