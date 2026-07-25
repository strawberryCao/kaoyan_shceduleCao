'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve('outputs/kaoyan-schedule-app/scripts');

function update(fileName, before, after, label) {
  const filePath = path.join(root, fileName);
  const source = fs.readFileSync(filePath, 'utf8');
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 anchor, found ${count}`);
  fs.writeFileSync(filePath, source.replace(before, after), 'utf8');
}

update(
  'note-capture-foreground.test.cjs',
  "  assert.match(block, /detectQuestionRegions\\(src\\)/);",
  "  assert.match(block, /detectQuestionRegions\\(src(?:,|\\))/);\n  assert.match(block, /setBatchProgress\\(message\\)/);",
  'foreground streaming detection assertion',
);

update(
  'note-capture-foreground.test.cjs',
  "  assert.match(block, /cropManyImages\\(src, detection\\.regions\\)/);",
  "  assert.match(block, /cropManyImages\\(src, detection\\.regions(?:,|\\))/);",
  'foreground compressed crop assertion',
);

update(
  'public-lan-parity.test.cjs',
  "  assert.match(media, /sourceType: payload\\.sourceType \\|\\| 'single-capture'/);",
  "  assert.match(media, /sourceType: (?:payload|item\\.payload)\\.sourceType \\|\\| 'single-capture'/);",
  'LAN naming source assertion',
);

console.log('mobile capture compatibility tests updated');
