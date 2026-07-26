'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('shared title policy rejects English refusals and produces deterministic Chinese fallback', async () => {
  const policy = await import(pathToFileURL(path.join(root, 'shared/note-title-policy.js')).href);
  assert.equal(policy.validateNoteTitle('The image does not contain any question or problem statement').ok, false);
  assert.equal(policy.validateNoteTitle('导数定义与切线方程').ok, true);
  assert.equal(policy.createFallbackNoteTitle({ splitIndex: 3 }), '待确认题目·第3题');
  assert.equal(policy.normalizeNoteSubject('普通笔记'), '默认文件夹');
});

test('cloud and LAN naming both consume the same title-policy implementation', () => {
  assert.match(read('cloudflare/rename-job.js'), /shared\/note-title-policy\.js/);
  assert.match(read('scripts/note-server.cjs'), /import\('..\/shared\/note-title-policy\.js'\)/);
  assert.match(read('cloudflare/rename-job.js'), /createFallbackNoteTitle/);
  assert.match(read('scripts/note-server.cjs'), /validateNoteTitle/);
});

test('question region quality gate removes page-footer fragments but keeps normal questions', async () => {
  const module = await import(pathToFileURL(path.join(root, 'cloudflare/ai.js')).href);
  const settings = { options: { minimumRegionPercent: 3.5, minimumConfidence: 0.56, maxQuestions: 12, edgePaddingPercent: 1.2 } };
  const result = module.questionDetectionInternals.normalizeRegions({ regions: [
    { x: 0.1, y: 0.1, width: 0.8, height: 0.28, confidence: 0.94, completeQuestion: true, containsStem: true },
    { x: 0.12, y: 0.935, width: 0.87, height: 0.064, confidence: 0.91, completeQuestion: true, containsStem: true },
  ] }, 1000, 1600, settings);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /页脚|宽高比/);
});

test('mobile multi-question save carries batch subject and remark and reports local-only persistence truthfully', () => {
  const app = read('src/components/NoteDropApp.tsx');
  const queue = read('src/utils/captureUploadQueue.ts');
  assert.match(app, /subject: batchSubject/);
  assert.match(app, /remark: batchRemark/);
  assert.match(app, /过滤.*可疑区域/);
  assert.match(app, /重新打开后会自动续传/);
  assert.match(queue, /重新打开页面会自动续传/);
});
