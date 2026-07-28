const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('multi-material naming uses one shared context and role-aware names', () => {
  const workflow = read('scripts/agent-workflow-contracts.cjs');
  const localRuntime = read('scripts/note-server.cjs');
  const cloudRuntime = read('cloudflare/material-naming.js');

  assert.match(workflow, /先完整理解速记正文和整组附件的共同主题、先后关系与互补关系/);
  assert.match(workflow, /每个附件名称既要表达内容，也要体现它在本条速记中的作用/);
  assert.match(localRuntime, /禁止逐个孤立判断/);
  assert.match(cloudRuntime, /先整体判断共同主题和资料间关系/);
});

test('quick-note title length is independently bounded', () => {
  const catalog = read('scripts/ai-router.cjs');
  const localRuntime = read('scripts/note-server.cjs');
  const cloudRuntime = read('cloudflare/material-naming.js');

  assert.match(catalog, /id: 'noteTitleMaxLength'[\s\S]*default: 18/);
  assert.match(localRuntime, /taskOptions\.noteTitleMaxLength\) \|\| 18/);
  assert.match(cloudRuntime, /settings\.options\?\.noteTitleMaxLength\) \|\| 18/);
});

test('quick notes without an image render a warm mascot instead of a generic file icon', () => {
  const learningCenter = read('src/components/LearningCenter.tsx');
  const stylesheet = read('src/learning-center.css');

  assert.match(learningCenter, /function QuickNoteMascot/);
  assert.match(learningCenter, /const QUICK_NOTE_MASCOTS = \[/);
  assert.equal((learningCenter.match(/\{ kind: '/g) || []).length, 12);
  assert.match(learningCenter, /context === 'quick' \? <QuickNoteMascot noteUid=\{note\.noteUid\} \/>/);
  assert.match(stylesheet, /\.lc-quick-mascot-body/);
});

test('taxonomy consolidation is an active guarded global workflow', () => {
  const catalog = read('scripts/ai-router.cjs');
  const workflows = read('scripts/agent-workflow-contracts.cjs');
  const server = read('scripts/note-server.cjs');

  assert.match(catalog, /taxonomy: Object\.freeze\(\{[\s\S]*label: '全局分类体系整理'[\s\S]*active: true/);
  assert.match(catalog, /id: 'minimumCoverage'[\s\S]*default: 0\.8/);
  assert.match(workflows, /version: 'taxonomy-consolidation-v1'/);
  assert.match(workflows, /每个输入 knowledgePoint 必须且只能原样出现在一个 aliases 数组中/);
  assert.match(server, /function validateTaxonomyGroups/);
  assert.match(server, /function taxonomyCandidateFingerprint/);
  assert.match(server, /for \(let attempt = 0; attempt < 4; attempt \+= 1\)/);
  assert.match(server, /currentFingerprint !== sourceCandidateFingerprint/);
  assert.match(server, /分类整理覆盖率/);
  assert.match(server, /pathname === '\/ai\/taxonomy\/consolidate'/);
});

test('mistake filters use stable categories but preserve detailed wrong reasons', () => {
  const learningCenter = read('src/components/LearningCenter.tsx');
  const server = read('scripts/note-server.cjs');
  assert.match(learningCenter, /const noteWrongReasons =/);
  assert.match(learningCenter, /const noteWrongReasonCategories =/);
  assert.match(server, /错因分类:\$\{category\}/);
  assert.match(learningCenter, /wrongReasons: uniqueText\(mistakeNotes\.flatMap\(\(\{ note \}\) => noteWrongReasonCategories\(note\)\)\)/);
});
