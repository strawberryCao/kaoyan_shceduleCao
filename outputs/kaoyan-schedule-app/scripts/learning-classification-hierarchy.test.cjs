const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-learning-taxonomy-test-'));
const bundledModulePath = path.join(tempDirectory, 'learning-taxonomy.cjs');

buildSync({
  entryPoints: [path.resolve(__dirname, '../src/utils/learningTaxonomy.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: bundledModulePath,
  logLevel: 'silent',
});

const taxonomy = require(bundledModulePath);

test.after(() => {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('upgrades a legacy flat math question type to a hierarchical path', () => {
  assert.deepEqual(taxonomy.questionTypePathForNote({
    subject: '高等数学',
    questionType: '反常积分收敛条件分析',
    knowledgePath: ['高等数学', '反常积分敛散性'],
  }), ['一元函数积分学', '反常积分收敛条件分析']);
});

test('keeps common carelessness causes distinct at the third level', () => {
  assert.deepEqual(taxonomy.wrongReasonPathForNote({ wrongReason: '因为粗心把最后一步计算错了' }), [
    '粗心大意', '计算疏漏', '算术错误',
  ]);
  assert.deepEqual(taxonomy.wrongReasonPathForNote({ wrongReason: '做题时走神，没有继续检查' }), [
    '粗心大意', '注意力', '走神分心',
  ]);
  assert.deepEqual(taxonomy.wrongReasonPathForNote({ wrongReason: '看漏了定义域条件' }), [
    '粗心大意', '审题疏漏', '看漏条件',
  ]);
});

test('classifies knowledge, question-method and conclusion memorization separately', () => {
  assert.deepEqual(taxonomy.learningTypePathForNote({ title: '进程与线程的定义区别', subject: '操作系统' }), [
    '基础知识', '定义概念',
  ]);
  assert.deepEqual(taxonomy.learningTypePathForNote({ title: '反常积分题型的标准解题步骤', subject: '高等数学' }), [
    '题型方法', '标准步骤',
  ]);
  assert.deepEqual(taxonomy.learningTypePathForNote({ title: '常用极限结论与推论', subject: '高等数学' }), [
    '结论规律', '常用结论',
  ]);
});

test('keeps good-question categories compact and stable', () => {
  assert.deepEqual([...taxonomy.GOOD_QUESTION_TYPES], [
    '经典母题', '方法好题', '易错辨析', '综合提升', '新颖拓展',
  ]);
  assert.equal(taxonomy.goodQuestionTypeForNote({
    goodQuestion: true,
    title: '一题多解的创新构造',
  }), '新颖拓展');
});

test('supports prefix filtering and cascading options up to three levels', () => {
  const paths = taxonomy.WRONG_REASON_PATHS;
  assert.deepEqual([...new Set(paths.map((path) => path[0]))], [
    '粗心大意', '知识与记忆', '思路与方法', '推理与计算', '时间与策略', '其他',
  ]);
  assert.equal(taxonomy.classificationPathMatches(
    ['粗心大意', '计算疏漏', '算术错误'],
    ['粗心大意', '计算疏漏'],
  ), true);
  assert.equal(taxonomy.classificationPathMatches(
    ['粗心大意', '注意力', '走神分心'],
    ['粗心大意', '计算疏漏'],
  ), false);
  assert.ok(taxonomy.classificationOptionsAtLevel(paths, ['粗心大意'], 1).includes('计算疏漏'));
  assert.ok(taxonomy.classificationOptionsAtLevel(paths, ['粗心大意', '计算疏漏'], 2).includes('算术错误'));
  assert.deepEqual(taxonomy.normalizeLearningPath(['一级', '二级', '三级', '第四级']), ['一级', '二级', '三级']);
});

test('learning center uses one hover-or-click cascade and resets subject-dependent filters', () => {
  const center = fs.readFileSync(path.resolve(__dirname, '../src/components/LearningCenter.tsx'), 'utf8');
  const styles = fs.readFileSync(path.resolve(__dirname, '../src/learning-center.css'), 'utf8');
  assert.match(center, /className="lc-path-trigger"/);
  assert.match(center, /onMouseEnter=\{openMenu\}/);
  assert.match(center, /className="lc-path-popover"/);
  assert.match(center, /subject: event\.target\.value, knowledgePoint: '', learningTypePath: \[\]/);
  assert.match(center, /learningTypePathsForSubject/);
  assert.match(styles, /\.lc-path-popover\s*\{/);
});
