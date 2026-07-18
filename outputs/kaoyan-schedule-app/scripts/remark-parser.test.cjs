const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRemark } = require('./remark-parser.cjs');

test('extracts page, question, tags, memory intent and explicit wrong reason', () => {
  const parsed = parseRemark('高数 p108 3.1题 #错题 #背诵 经典题\n错因：符号看反了；注意：先检查定义域\n来源：张宇高数18讲');
  assert.deepEqual(parsed.pages, [108]);
  assert.deepEqual(parsed.questions, ['3.1']);
  assert.deepEqual(parsed.explicitTags, ['错题', '背诵']);
  assert.equal(parsed.flags.isMistake, true);
  assert.equal(parsed.flags.isClassic, true);
  assert.equal(parsed.flags.shouldMemorize, true);
  assert.deepEqual(parsed.wrongReasons, ['符号看反了']);
  assert.deepEqual(parsed.cautions, ['先检查定义域']);
  assert.deepEqual(parsed.sources, ['张宇高数18讲']);
});

test('normalizes page ranges and several question syntaxes', () => {
  const parsed = parseRemark('第20-22页，第4.2题，Q5-1，例题 6.3，需要复习');
  assert.deepEqual(parsed.pages, [20, 21, 22]);
  assert.deepEqual(parsed.questions, ['4.2', '5-1', '6.3']);
  assert.equal(parsed.flags.needsReview, true);
});

test('treats standalone memory prompts as strong intent without substring false positives', () => {
  for (const remark of ['记', '背', '要记', '记一下', '背下来', '需记', '高数 p18，记', '#背']) {
    assert.equal(parseRemark(remark).flags.shouldMemorize, true, remark);
  }
  for (const remark of ['这是普通笔记', '图片背面有字', '背景较暗', '背面背景是蓝色']) {
    assert.equal(parseRemark(remark).flags.shouldMemorize, false, remark);
  }
});
