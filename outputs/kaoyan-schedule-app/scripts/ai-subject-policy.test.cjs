const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AI_408_SUBJECTS,
  filterTaxonomyForAi,
  pruneUnknownAiSubjects,
  resolveAiSubject,
} = require('./ai-subject-policy.cjs');

function taxonomyFixture() {
  return {
    revision: 7,
    subjects: [
      ...AI_408_SUBJECTS.map((name) => ({ name, aliases: [], knowledgePoints: [] })),
      { name: '默认文件夹', aliases: ['未分类'], knowledgePoints: [] },
      { name: '计算机视觉', aliases: ['CV'], createdBy: 'ai', knowledgePoints: [] },
    ],
  };
}

test('keeps existing 408 subjects and resolves their common aliases', () => {
  const taxonomy = taxonomyFixture();
  assert.equal(resolveAiSubject(taxonomy, { requestedSubject: '计网' }).subject, '计算机网络');
  assert.equal(resolveAiSubject(taxonomy, { requestedSubject: '计算机组成原理' }).subject, '计算机组成');
  assert.equal(resolveAiSubject(taxonomy, { requestedSubject: 'OS' }).subject, '操作系统');
  assert.equal(resolveAiSubject(taxonomy, { requestedSubject: '数据结构与算法' }).subject, '数据结构');
});

test('unknown first-level subjects never become AI subjects and ambiguous content uses the default bucket', () => {
  const taxonomy = taxonomyFixture();
  const result = resolveAiSubject(taxonomy, {
    requestedSubject: '计算机视觉',
    knowledgePoint: '卷积神经网络',
    title: '图像分类模型',
  });
  assert.equal(result.subject, '默认文件夹');
  assert.equal(result.fallback, true);
  assert.equal(taxonomy.subjects.some((subject) => subject.name === '计算机视觉'), true);
});

test('unknown model labels can be semantically remapped without creating a top-level subject', () => {
  const taxonomy = taxonomyFixture();
  const result = resolveAiSubject(taxonomy, {
    requestedSubject: '网络编程专题',
    knowledgePoint: 'TCP 拥塞控制',
    summary: '分析滑动窗口和超时重传。',
  });
  assert.equal(result.subject, '计算机网络');
  assert.equal(result.reason, 'semantic');
  assert.equal(taxonomy.subjects.some((subject) => subject.name === '网络编程专题'), false);
});

test('AI prompt taxonomy hides legacy unknown subjects without deleting persisted data', () => {
  const taxonomy = taxonomyFixture();
  const filtered = filterTaxonomyForAi(taxonomy);
  assert.deepEqual(filtered.subjects.map((subject) => subject.name), [
    ...AI_408_SUBJECTS,
    '默认文件夹',
  ]);
  assert.equal(taxonomy.subjects.some((subject) => subject.name === '计算机视觉'), true);
});

test('an unknown node cannot enter the allowlist by claiming a 408 alias', () => {
  const taxonomy = taxonomyFixture();
  taxonomy.subjects.find((subject) => subject.name === '计算机视觉').aliases.push('数据结构');
  const filtered = filterTaxonomyForAi(taxonomy);
  assert.equal(filtered.subjects.some((subject) => subject.name === '计算机视觉'), false);
  assert.equal(resolveAiSubject(taxonomy, { requestedSubject: '数据结构' }).subject, '数据结构');
});

test('prunes only AI-created unknown roots and preserves user-created custom roots', () => {
  const taxonomy = taxonomyFixture();
  taxonomy.subjects.push({ name: '自定义专题', aliases: [], createdBy: 'user', knowledgePoints: [] });
  const removed = pruneUnknownAiSubjects(taxonomy);
  assert.deepEqual(removed.map((subject) => subject.name), ['计算机视觉']);
  assert.equal(taxonomy.subjects.some((subject) => subject.name === '计算机视觉'), false);
  assert.equal(taxonomy.subjects.some((subject) => subject.name === '自定义专题'), true);
  assert.ok(AI_408_SUBJECTS.every((name) => taxonomy.subjects.some((subject) => subject.name === name)));
});
