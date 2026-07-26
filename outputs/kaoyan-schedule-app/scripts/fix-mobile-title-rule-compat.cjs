'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const write = (relative, content) => fs.writeFileSync(path.join(root, relative), content, 'utf8');

function replaceOnce(source, oldValue, newValue, label) {
  if (source.includes(newValue)) return source;
  if (!source.includes(oldValue)) throw new Error(`${label}: anchor missing`);
  return source.replace(oldValue, newValue);
}

{
  let source = read('scripts/cloud-capture-fast-pipeline.test.cjs');
  source = replaceOnce(
    source,
    "  assert.match(block, /本机后台队列|可以立即退出/);",
    "  assert.match(block, /已安全保存在本机/);\n  assert.match(block, /重新打开后会自动续传/);",
    'truthful batch persistence assertion',
  );
  write('scripts/cloud-capture-fast-pipeline.test.cjs', source);
}

{
  let source = read('scripts/mobile-local-first-analysis.test.cjs');
  source = replaceOnce(
    source,
    "  assert.match(capture, /可以立即退出/);",
    "  assert.match(capture, /已安全保存在本机/);\n  assert.match(capture, /重新打开后会自动续传/);",
    'truthful single persistence assertion',
  );
  write('scripts/mobile-local-first-analysis.test.cjs', source);
}

{
  let source = read('shared/note-title-policy.js');
  source = replaceOnce(
    source,
`  const title = sanitizeNoteTitle(value, titleMaxLength);
  if (!title) return { ok: false, title, problem: '标题为空' };
  if (title.length < Math.min(4, titleMinLength)) return { ok: false, title, problem: '标题过短' };
  const chinese = title.match(/[\\u3400-\\u9fff]/gu)?.length || 0;
  const letters = title.match(/[A-Za-z]/g)?.length || 0;
  if (REFUSAL_PATTERN.test(title)) return { ok: false, title, problem: '标题包含模型拒答或英文说明句' };
  if (chinese < 2 || (letters > 10 && letters > chinese * 1.5)) {
    return { ok: false, title, problem: '标题必须以中文为主，不能输出英文句子' };
  }
`,
`  const title = sanitizeNoteTitle(value, titleMaxLength);
  const ruleValue = sanitizeNoteTitle(options.ruleValue, 80);
  const ruleMatched = options.allowRuleIdentifier === true && Boolean(ruleValue) && title.includes(ruleValue);
  if (!title) return { ok: false, title, problem: '标题为空' };
  if (title.length < (ruleMatched ? 2 : Math.min(4, titleMinLength))) return { ok: false, title, problem: '标题过短' };
  const chinese = title.match(/[\\u3400-\\u9fff]/gu)?.length || 0;
  const letters = title.match(/[A-Za-z]/g)?.length || 0;
  if (REFUSAL_PATTERN.test(title)) return { ok: false, title, problem: '标题包含模型拒答或英文说明句' };
  if (!ruleMatched && (chinese < 2 || (letters > 10 && letters > chinese * 1.5))) {
    return { ok: false, title, problem: '标题必须以中文为主，不能输出英文句子' };
  }
`,
    'explicit naming-rule identifier validation',
  );
  write('shared/note-title-policy.js', source);
}

{
  let source = read('scripts/note-server.cjs');
  source = replaceOnce(
    source,
    "    const titleValidation = validateNoteTitle(title, { ...options, titleMinLength, titleMaxLength });",
    "    const titleValidation = validateNoteTitle(title, { ...options, titleMinLength, titleMaxLength, allowRuleIdentifier: Boolean(matchedRule && ruleValue), ruleValue });",
    'local naming-rule validation context',
  );
  write('scripts/note-server.cjs', source);
}

{
  let source = read('cloudflare/rename-job.js');
  source = replaceOnce(
    source,
`function titleProblem(title, settings) {
  return validateNoteTitle(title, settings.options || {}).problem;
}`,
`function titleProblem(title, settings, ruleValue = '') {
  return validateNoteTitle(title, {
    ...(settings.options || {}),
    allowRuleIdentifier: Boolean(ruleValue),
    ruleValue,
  }).problem;
}`,
    'cloud title validation context',
  );
  source = replaceOnce(
    source,
    "    problem: titleProblem(title, settings),",
    "    problem: titleProblem(title, settings, matchedRule && ruleValue ? ruleValue : ''),",
    'cloud naming-rule validation call',
  );
  write('cloudflare/rename-job.js', source);
}

{
  let source = read('scripts/mobile-capture-contract-behavior.test.cjs');
  source = replaceOnce(
    source,
`  assert.equal(policy.validateNoteTitle('导数定义与切线方程').ok, true);
  assert.equal(policy.createFallbackNoteTitle({ splitIndex: 3 }), '待确认题目·第3题');`,
`  assert.equal(policy.validateNoteTitle('导数定义与切线方程').ok, true);
  assert.equal(policy.validateNoteTitle('250626-088', { allowRuleIdentifier: true, ruleValue: '250626-088' }).ok, true);
  assert.equal(policy.validateNoteTitle('The image does not contain 250626-088', { allowRuleIdentifier: true, ruleValue: '250626-088' }).ok, false);
  assert.equal(policy.createFallbackNoteTitle({ splitIndex: 3 }), '待确认题目·第3题');`,
    'rule identifier behavior assertions',
  );
  write('scripts/mobile-capture-contract-behavior.test.cjs', source);
}

{
  let source = read('cloudflare/agent-provider.test.mjs');
  source = replaceOnce(
    source,
`  assert.equal(regions.length, 1);
  assert.equal(regions[0].x, 0.1);`,
`  assert.equal(regions.accepted.length, 1);
  assert.equal(regions.accepted[0].x, 0.1);
  assert.equal(regions.rejected.length, 0);
  assert.equal(regions.candidateCount, 1);`,
    'structured question-region quality result assertions',
  );
  write('cloudflare/agent-provider.test.mjs', source);
}

console.log('Applied mobile title rule compatibility fixes.');
