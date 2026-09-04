const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');

(async () => {
  const noteDrop = source('src/components/NoteDropApp.tsx');
  assert.match(noteDrop, /await enqueueMultiQuestionJob\(sourceImage\.src/);
  assert.match(noteDrop, /完成后可从活动中心逐题确认/);
  assert.doesNotMatch(noteDrop, /className="ai"[^>]+setMobileStep\('multi-crop'\)/);
  assert.match(noteDrop, /loadMultiQuestionJobForReview/);
  assert.match(noteDrop, /completeMultiQuestionReview/);
  assert.match(noteDrop, /await enqueueCaptureUpload\(\[payload\]\)/);
  assert.match(noteDrop, /<span>切换到速记<\/span>/);

  const jobs = source('src/utils/noteBackgroundJobs.ts');
  assert.match(jobs, /await createCaptureBatch\(imageDataUrl/);
  assert.match(jobs, /await putJob\(job\)/);
  assert.doesNotMatch(jobs, /cropManyImages|detectQuestionRegions|enqueueCaptureUpload/);

  const capture = source('cloudflare/capture-batches.js');
  assert.match(capture, /processCaptureBatch/);
  assert.match(capture, /configurationHash/);
  assert.match(capture, /workflowHash/);
  assert.match(capture, /env\.IMAGES\.input/);

  const ai = await import('../cloudflare/ai.js');
  const settings = { options: { minimumRegionPercent: 3.5, minimumConfidence: 0.5, maxQuestions: 12, edgePaddingPercent: 0 } };
  const grouped = ai.questionDetectionInternals.normalizeRegions({ regions: [
    { x: 0.05, y: 0.10, width: 0.90, height: 0.20, confidence: 0.9, questionKey: '例4.9', completeQuestion: true, containsStem: true },
    { x: 0.05, y: 0.305, width: 0.90, height: 0.20, confidence: 0.88, questionKey: '例4.9', completeQuestion: false, containsStem: false, containsSolution: true, continuationOfPrevious: true },
    { x: 0.05, y: 0.55, width: 0.90, height: 0.30, confidence: 0.92, questionKey: '例4.10', completeQuestion: true, containsStem: true, containsSolution: true },
  ] }, 1000, 1500, settings);
  assert.equal(grouped.accepted.length, 2, 'same numbered question stem and solution must merge');
  assert.ok(grouped.accepted[0].height > 0.39, 'merged question must cover stem and solution');
  assert.equal(grouped.candidateCount, 3);

  const learning = source('src/components/LearningCenter.tsx');
  assert.match(learning, /AI重命名/);
  assert.match(learning, /enqueueLearningNoteRename\(note\.noteUid\)/);
  console.log('instant capture background flow: ok');
})().catch((error) => { console.error(error); process.exit(1); });
