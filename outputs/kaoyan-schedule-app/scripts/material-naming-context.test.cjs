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
  assert.match(localRuntime, /for \(let index = 0; index < sourceAttachments\.length; index \+= 1\)[\s\S]*?image_url/);
  assert.match(cloudRuntime, /for \(let index = 0; index < entry\.assets\.length; index \+= 1\)[\s\S]*?image_url/);
  assert.match(localRuntime, /localeCompare\(original[\s\S]*?&& weakMaterialStem\(original\)/);
  assert.match(cloudRuntime, /localeCompare\(oldName[\s\S]*?&& weakMaterialStem\(oldName\)/);
  assert.doesNotMatch(cloudRuntime, /imageCount < 4/);
});

test('quick-note title length is independently bounded', () => {
  const catalog = read('scripts/ai-router.cjs');
  const localRuntime = read('scripts/note-server.cjs');
  const cloudRuntime = read('cloudflare/material-naming.js');

  assert.match(catalog, /id: 'noteTitleMaxLength'[\s\S]*default: 18/);
  assert.match(localRuntime, /taskOptions\.noteTitleMaxLength\) \|\| 18/);
  assert.match(cloudRuntime, /settings\.options\?\.noteTitleMaxLength\) \|\| 18/);
});

test('quick notes without an image render a quiet edge watcher instead of a generic file icon', () => {
  const learningCenter = read('src/components/LearningCenter.tsx');
  const watcher = read('src/components/QuickNoteWatcher.tsx');
  const stylesheet = read('src/learning-center.css');

  assert.match(learningCenter, /context === 'quick' \? <QuickNoteWatcher noteUid=\{note\.noteUid\} \/>/);
  assert.match(watcher, /const WATCHER_VARIANT_COUNT = 8/);
  assert.match(watcher, /className=\{`lc-quick-watcher is-variant-\$\{variant\}`\}/);
  assert.match(watcher, /aria-hidden="true"/);
  assert.doesNotMatch(watcher, /title=/);
  assert.match(stylesheet, /\.lc-quick-watcher/);
  assert.match(stylesheet, /@media \(prefers-reduced-motion: reduce\)/);
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

test('mistake filters use hierarchical paths but preserve detailed wrong reasons', () => {
  const learningCenter = read('src/components/LearningCenter.tsx');
  const taxonomy = read('src/utils/learningTaxonomy.ts');
  const store = read('scripts/learning-data-store.cjs');
  assert.match(learningCenter, /const noteWrongReasons =/);
  assert.match(taxonomy, /export const WRONG_REASON_PATHS/);
  assert.match(taxonomy, /'粗心大意', '计算疏漏', '算术错误'/);
  assert.match(learningCenter, /wrongReasonPaths: uniquePaths/);
  assert.match(learningCenter, /classificationPathMatches\(wrongReasonPathForNote\(note\), mistakeFilters\.wrongReasonPath\)/);
  assert.match(store, /wrongReasonPath: classificationPath/);
});
