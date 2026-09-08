'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const text = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('mobile capture persists stable single and multi-question jobs before remote work', () => {
  const queue = text('src/utils/captureUploadQueue.ts');
  const capture = text('src/components/NoteDropApp.tsx');
  const background = text('src/utils/noteBackgroundJobs.ts');
  assert.match(queue, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(queue, /await putStoredJob\(job\)/);
  assert.match(queue, /void resumeCaptureUploads\(\)/);
  assert.match(queue, /saveNoteImagesBatch\(payloads\)/);
  assert.match(queue, /decryptPayloads\(uploading\)/);
  assert.match(queue, /window\.crypto\.subtle\.generateKey\(\{ name: 'AES-GCM', length: 256 \}, false/);
  assert.match(queue, /encryptedItems: \[\]/);
  assert.match(queue, /nextAttemptAt/);
  assert.match(queue, /noteUids/);
  assert.match(capture, /await enqueueCaptureUpload\(\[payload\]\)/);
  assert.match(capture, /await enqueueMultiQuestionJob\(sourceImage\.src/);
  assert.match(capture, /图片已加密暂存；送达 Mac 后会自动清除/);
  assert.match(capture, /setStatus\(job\.message/);
  assert.match(background, /await putJob\(job\)/);
  assert.match(background, /await resumeOne\(job\.id\)/);
  assert.match(background, /resumeMultiQuestionJobs/);
  assert.match(background, /await createCaptureBatch\(imageDataUrl/);
  assert.match(background, /sealTransientBytes\('multi-question-image'/);
  assert.match(background, /openTransientBytes\('multi-question-image'/);
  assert.doesNotMatch(background, /detectQuestionRegions|cropManyImages|enqueueCaptureUpload/);
  assert.doesNotMatch(capture.slice(capture.indexOf('const startMultiQuestion'), capture.indexOf('const confirmBatchCrop')), /detectQuestionRegions/);
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

test('every saved cloud image runs one full visual analysis task while manual rename remains available', () => {
  const jobs = text('cloudflare/background-jobs.js');
  const media = text('cloudflare/media.js');
  const analysis = text('cloudflare/note-analysis-job.js');
  assert.match(media, /enqueueNotePipelineJob/);
  assert.match(jobs, /job\.type === 'note-rename'/);
  assert.match(jobs, /runConfiguredNoteAnalysis/);
  assert.match(jobs, /note-pipeline/);
  assert.match(analysis, /resolveImageRepoPath/);
  assert.match(analysis, /collaborationEnabled/);
  assert.match(analysis, /'note_image_understanding'/);
  assert.match(analysis, /requiredCapabilities: \['text', 'json'\]/);
  assert.match(analysis, /applyAiNoteEnrichment/);
});

test('LAN runtime publishes complete note analysis workflows and cloud fails closed without them', () => {
  const contracts = text('scripts/agent-workflow-contracts.cjs');
  const runtime = text('cloudflare/agent-runtime.js');
  assert.match(contracts, /note-enrichment-v6/);
  assert.match(contracts, /note-image-understanding-v6/);
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

test('local and cloud analysis render the same LAN-published prompt contract', () => {
  const analyzer = text('scripts/note-ai-analyzer.cjs');
  const contracts = text('scripts/agent-workflow-contracts.cjs');
  assert.match(analyzer, /NOTE_ANALYSIS_INSTRUCTIONS/);
  assert.match(analyzer, /NOTE_ANALYSIS_OUTPUT/);
  assert.match(analyzer, /fillAnalysisTemplate/);
  assert.match(contracts, /note-enrichment-v6/);
});

test('interrupted cloud AI processing jobs stop before any automatic paid retry', () => {
  const jobs = text('cloudflare/background-jobs.js');
  assert.match(jobs, /PROCESSING_STALE_MS/);
  assert.match(jobs, /isStaleProcessing/);
  assert.match(jobs, /EXECUTION_RECEIPT_SCOPE/);
  assert.match(jobs, /claimJobExecution/);
  assert.match(jobs, /AI_JOB_INTERRUPTED/);
  assert.match(jobs, /\.filter\(\(job\) => job\.status === 'queued'\)/);
  assert.doesNotMatch(jobs, /job\.status === 'queued' \|\| isStaleProcessing/);
});

test('full enrichment supplies the automatic title while preserving capture source tags', () => {
  const analysis = text('cloudflare/note-analysis-job.js');
  const learning = text('cloudflare/learning.js');
  assert.match(analysis, /preserveTitle: false/);
  assert.match(learning, /Array\.isArray\(note\.tags\)/);
  assert.match(learning, /Array\.isArray\(input\.tags\)/);
});

test('mobile outbox resumes transport after Safari lifecycle events without replaying paid AI work', () => {
  const queue = text('src/utils/captureUploadQueue.ts');
  const background = text('src/utils/noteBackgroundJobs.ts');
  const app = text('src/App.tsx');
  assert.match(queue, /transactionDone/);
  assert.match(queue, /await committed/);
  assert.match(queue, /UPLOAD_LEASE_MS/);
  assert.match(queue, /current\.status === 'uploading'/);
  assert.match(queue, /Safari 上次被系统中断/);
  assert.match(app, /installCaptureUploadResumer/);
  assert.match(queue, /window\.addEventListener\('pageshow', resume\)/);
  assert.match(app, /installMultiQuestionJobResumer/);
  assert.match(background, /window\.addEventListener\('online', resume\)/);
  assert.match(background, /window\.addEventListener\('pageshow', resume\)/);
  assert.match(background, /stable batch id makes a lost upload response safe to replay/);
  assert.doesNotMatch(app, /retryCaptureBatchJob/);
  assert.doesNotMatch(app, /retryAuthorityAiTask/);
});

test('V11 config synchronization cannot delete the compatibility control-plane file', () => {
  const sync = text('scripts/windows-assistant-config-sync.ps1');
  const runtime = text('cloudflare/agent-runtime.js');
  assert.match(sync, /data\\config\\local-assistant/);
  assert.match(sync, /git.*add.*data\/config\/local-assistant/s);
  assert.match(runtime, /control-plane\/compatibility\/legacy-v11-analysis-workflows\.json/);
  assert.doesNotMatch(runtime, /data\/config\/local-assistant\/legacy-v11-analysis-workflows\.json/);
});
