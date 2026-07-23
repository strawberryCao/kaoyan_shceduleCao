const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-note-review-test-'));
const bundledModulePath = path.join(tempDirectory, 'note-review.cjs');

buildSync({
  entryPoints: [path.resolve(__dirname, '../src/utils/noteReview.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: bundledModulePath,
  logLevel: 'silent',
});

const noteReview = require(bundledModulePath);

test.after(() => {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('normalizes every supported default note bucket alias', () => {
  for (const subject of ['默认文件夹', '未分类', '默认', '收件箱', '  收件箱  ', '']) {
    assert.equal(noteReview.isDefaultNoteBucket(subject), true);
    assert.equal(noteReview.normalizeNoteBucket(subject), '默认文件夹');
  }
  assert.equal(noteReview.isDefaultNoteBucket('高等数学'), false);
});

test('prefers reviewStatus, then reviewState, over the legacy organizationStatus', () => {
  assert.equal(noteReview.resolveNoteReviewState({
    subject: '默认文件夹',
    reviewStatus: 'accepted',
    reviewState: 'pending',
    organizationStatus: 'ignored',
  }), 'accepted');
  assert.equal(noteReview.resolveNoteReviewState({
    subject: '默认文件夹',
    reviewState: 'corrected',
    organizationStatus: 'pending',
  }), 'corrected');
  assert.equal(noteReview.resolveNoteReviewState({
    subject: '高等数学',
    reviewState: 'pending',
    organizationStatus: 'ignored',
  }), 'pending');
});

test('maps current organization statuses and falls back to the subject only when needed', () => {
  assert.equal(noteReview.resolveNoteReviewState({ organizationStatus: 'confirmed' }), 'accepted');
  assert.equal(noteReview.resolveNoteReviewState({ organizationStatus: 'ignored' }), 'ignored');
  assert.equal(noteReview.resolveNoteReviewState({ subject: '收件箱' }), 'pending');
  assert.equal(noteReview.resolveNoteReviewState({ subject: '数据结构' }), 'auto_applied');
});

test('selects every pending note regardless of its current subject and excludes ignored notes', () => {
  const notes = [
    { noteUid: 'specific-pending', subject: '线性代数', reviewState: 'pending' },
    { noteUid: 'legacy-pending', subject: '收件箱', organizationStatus: 'pending' },
    { noteUid: 'ignored', subject: '收件箱', reviewState: 'ignored', organizationStatus: 'pending' },
    { noteUid: 'accepted', subject: '高等数学', reviewState: 'accepted' },
  ];

  assert.deepEqual(
    noteReview.selectPendingNoteReviews(notes).map((note) => note.noteUid),
    ['specific-pending', 'legacy-pending'],
  );
  assert.equal(noteReview.isKnowledgeEligibleNote(notes[0]), true);
  assert.equal(noteReview.isKnowledgeEligibleNote(notes[2]), false);
});
