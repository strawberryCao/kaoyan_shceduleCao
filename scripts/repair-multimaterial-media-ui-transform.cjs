'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, 'apply-multimaterial-media-ui.cjs');
let source = fs.readFileSync(target, 'utf8');

const replacements = [
  [
    "        setError(`${file.name} 超过 8 MB，未加入。`);",
    "        setError(file.name + ' 超过 8 MB，未加入。');",
  ],
  [
    "      onSaved(`已保存${files.length ? ` · ${files.length} 个资料` : '文字速记'}`);",
    "      onSaved('已保存' + (files.length ? ' · ' + files.length + ' 个资料' : '文字速记'));",
  ],
  [
    "<li key={`${file.name}:${file.size}:${file.lastModified}`}>",
    "<li key={[file.name, file.size, file.lastModified].join(':')}>",
  ],
  [
    "aria-label={`移除 ${file.name}`}",
    "aria-label={'移除 ' + file.name}",
  ],
];

for (const [before, after] of replacements) {
  if (!source.includes(before)) throw new Error(`Missing transform repair anchor: ${before}`);
  source = source.replace(before, after);
}

fs.writeFileSync(target, source, 'utf8');
console.log('Repaired nested templates in multimaterial transform.');
