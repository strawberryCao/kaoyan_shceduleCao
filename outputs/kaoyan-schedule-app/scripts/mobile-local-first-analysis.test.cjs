'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const text = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('mobile capture persists a stable outbox job before starting remote upload', () => {
  const queue = text('src/utils/captureUploadQueue.ts');
  const capture = text('src/components/NoteDropApp.tsx');
  assert.match(queue, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(queue, /await putJob\(job\)/);
  assert.match(queue, /void resumeCaptureUploads\(\)/);
  assert.match(queue, /saveNoteImagesBatch\(uploading\.payloads\)/);
  assert.match(queue, /nextAttemptAt/);
  assert.match(queue, /noteUids/);
  assert.match(capture, /await enqueueCaptureUpload\(\[payload\]\)/);
  assert.match(capture, /await enqueueCaptureUpload\(payloads\)/);
  assert.match(capture, /可以立即退出/);
  assert.doesNotMatch(capture, /正在一次性上传并归档/);
});

test('cloud naming uses an AI merge path instead of pretending to be a manual edit', () => {
  const learning = text('cloudflare/learning.js');
  const rename = text('cloudflare/rename-job.js');
  assert.match(learning, /export async function applyAiNoteNaming/);
  assert.match(learning, /export async function applyAiNoteEnrichment/);
  assert.match(rename, /applyAiNoteNaming/);
  assert.doesNotMatch(rename, /patchNote/);
  assert.match(learning, /classificationSource: humanDecision \? note\.classificationSource \|\| 'manual' : 'ai'/);
});

test('every saved cloud image runs LAN naming and the full LAN analysis task', () => {
  const jobs = text('cloudflare/background-jobs.js');
  const media = text('cloudflare/media.js');
  const analysis = text('cloudflare/note-analysis-job.js');
  assert.match(media, /enqueueNotePipelineJob/);
  assert.match(jobs, /runConfiguredRename/);
  assert.match(jobs, /runConfiguredNoteAnalysis/);
  assert.match(jobs, /note-pipeline/);
  assert.match(analysis, /taskId = text\(entry\.note\.remark/);
  assert.match(analysis, /'note_enrichment' : 'note_image_understanding'/);
  assert.match(analysis, /applyAiNoteEnrichment/);
});

test('LAN runtime publishes complete note analysis workflows and cloud fails closed without them', () => {
  const contracts = text('scripts/agent-workflow-contracts.cjs');
  const runtime = text('cloudflare/agent-runtime.js');
  assert.match(contracts, /note-enrichment-v4/);
  assert.match(contracts, /note-image-understanding-v4/);
  assert.match(contracts, /wrongReasonSource/);
  assert.match(contracts, /contextPayload/);
  assert.match(runtime, /'note_enrichment'/);
  assert.match(runtime, /'note_image_understanding'/);
  assert.match(runtime, /LOCAL_AGENT_WORKFLOW_MISSING/);
});

test('AI enrichment protects human decisions and reconciles generated cards atomically', () => {
  const learning = text('cloudflare/learning.js');
  assert.match(learning, /aiHumanDecision/);
  assert.match(learning, /userFields\.has\('title'\)/);
  assert.match(learning, /card\.userEdited === true/);
  assert.match(learning, /generatedCards/);
  assert.match(learning, /pendingAiOrganization: false/);
  assert.match(learning, /updateMirroredCloudNote/);
});
