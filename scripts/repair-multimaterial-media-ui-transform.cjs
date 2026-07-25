'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
  [
    "noteDrop = replaceOnce(noteDrop, \"  if (isMobileCapture) {\", \"  if (materialOpen) {\\n    return <QuickMaterialComposer onClose={() => setMaterialOpen(false)} onSaved={(message) => { setSaved(true); setStatus(message); }} />;\\n  }\\n\\n  if (isMobileCapture) {\", 'note drop composer branch');",
    "noteDrop = replaceOnce(noteDrop, \"  if (isMobileCapture) {\\n    if (mobileStep === 'multi-crop'\", \"  if (materialOpen) {\\n    return <QuickMaterialComposer onClose={() => setMaterialOpen(false)} onSaved={(message) => { setSaved(true); setStatus(message); }} />;\\n  }\\n\\n  if (isMobileCapture) {\\n    if (mobileStep === 'multi-crop'\", 'note drop composer branch');",
  ],
  [
    "write('outputs/kaoyan-schedule-app/quick-material-composer.css', composerCss);",
    "write('outputs/kaoyan-schedule-app/src/quick-material-composer.css', composerCss);",
  ],
  [
    "let learningCss = read('outputs/kaoyan-schedule-app/learning-center.css');",
    "let learningCss = read('outputs/kaoyan-schedule-app/src/learning-center.css');",
  ],
  [
    "write('outputs/kaoyan-schedule-app/learning-center.css', learningCss);",
    "write('outputs/kaoyan-schedule-app/src/learning-center.css', learningCss);",
  ],
];

for (const [before, after] of replacements) {
  if (!source.includes(before)) {
    if (source.includes(after)) continue;
    throw new Error(`Missing transform repair anchor: ${before}`);
  }
  source = source.replace(before, after);
}

fs.writeFileSync(target, source, 'utf8');
const checked = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
if (checked.status !== 0) {
  throw new Error(checked.stderr || checked.stdout || 'Transform syntax check failed');
}
console.log('Repaired and syntax-checked multimaterial transform.');
