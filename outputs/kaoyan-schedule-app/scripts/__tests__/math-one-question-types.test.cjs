const assert = require('node:assert/strict');
const test = require('node:test');

const {
  allQuestionTypes,
  mathOneQuestionTypePrompt,
  normalizeMathOneQuestionType,
} = require('../math-one-question-types.cjs');

test('math one catalog provides focused reusable leaf types for all three subjects', () => {
  const catalog = allQuestionTypes();
  assert.ok(catalog['高等数学'].length >= 50);
  assert.ok(catalog['线性代数'].length >= 20);
  assert.ok(catalog['概率论'].length >= 20);
  assert.ok(catalog['高等数学'].includes('拉格朗日中值定理应用'));
  assert.ok(catalog['线性代数'].includes('含参数方程组讨论'));
  assert.ok(catalog['概率论'].includes('全概率与贝叶斯公式'));
  assert.match(mathOneQuestionTypePrompt(), /高等数学：/);
});

test('generic paper forms are refined only when the note contains strong evidence', () => {
  assert.equal(
    normalizeMathOneQuestionType('高等数学', '计算题', '使用罗尔定理构造辅助函数证明零点存在'),
    '罗尔定理辅助函数构造',
  );
  assert.equal(
    normalizeMathOneQuestionType('线性代数', '综合题', '讨论含参数线性方程组解的个数'),
    '含参数方程组讨论',
  );
  assert.equal(
    normalizeMathOneQuestionType('概率论', '计算题', '利用全概率公式和贝叶斯公式'),
    '全概率与贝叶斯公式',
  );
  assert.equal(normalizeMathOneQuestionType('高等数学', '计算题', '没有足够证据'), '计算题');
});
