const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildPublicWorkflowContracts } = require('./agent-workflow-contracts.cjs');
const { resolveNoteFile } = require('./note-file-access.cjs');

const root = path.resolve(__dirname, '..');
const text = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('local runtime exports complete naming and splitting workflow contracts', () => {
  const workflows = buildPublicWorkflowContracts();
  for (const taskId of ['note_naming', 'question_splitting']) {
    assert.ok(workflows[taskId].version);
    assert.ok(workflows[taskId].steps.length >= 4);
    assert.ok(workflows[taskId].prompt.instructions.length >= 5);
    assert.match(workflows[taskId].prompt.outputFormat, /JSON/);
  }
});

test('public mobile capture waits longer than the local splitting timeout and does not block on explicit rename calls', () => {
  const notes = text('src/utils/notes.ts');
  const capture = text('src/components/NoteDropApp.tsx');
  assert.match(notes, /AI_REQUEST_TIMEOUT_MS = 180_000/);
  assert.doesNotMatch(capture, /renameLearningNoteWithAi/);
  assert.match(capture, /后台队列|局域网规则.*命名|完整分类/);
  assert.match(capture, /读取局域网 AI 配置/);
});

test('Windows synchronization directly merges cloud learning data', () => {
  const sync = text('scripts/windows-note-folder-sync.ps1');
  assert.match(sync, /merge-learning-data\.cjs/);
  assert.match(sync, /data\/cloud\/learning-data\.json/);
  assert.match(sync, /Learning data merge failed/);
});

test('local note access maps synchronized cloud attachments into the Caobijidata clone', () => {
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kaoyan-cloud-file-'));
  const clone = path.join(temp, 'Caobijidata');
  const file = path.join(clone, 'data', 'assets', 'quick-1', '01-note.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'hello');
  const resolved = resolveNoteFile(path.join(temp, 'notes'), 'github://data/assets/quick-1/01-note.txt', { cloneRoot: clone });
  assert.equal(resolved.filePath, file);
  assert.match(resolved.mime, /^text\/plain/);
});

test('single cloud captures and multi-question notes are both eligible for LAN-controlled naming', () => {
  const rename = text('cloudflare/rename-job.js');
  const media = text('cloudflare/media.js');
  assert.match(rename, /sourceType === 'single-capture'/);
  assert.match(text('cloudflare/learning.js'), /updateMirroredCloudNote/);
  assert.match(media, /enqueueNotePipelineJob/);
  assert.match(media, /sourceType: (?:payload|item\.payload)\.sourceType \|\| 'single-capture'/);
});
