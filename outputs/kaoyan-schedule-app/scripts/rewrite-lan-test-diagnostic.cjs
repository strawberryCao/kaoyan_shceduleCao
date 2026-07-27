'use strict';
const fs = require('node:fs');
const path = require('node:path');
const testPath = path.join(__dirname, 'lan-note-app-quick-entry.test.cjs');
fs.writeFileSync(testPath, `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/components/NoteDropApp.tsx'), 'utf8');
const center = fs.readFileSync(path.join(root, 'src/components/LearningCenter.tsx'), 'utf8');
const mobileCss = fs.readFileSync(path.join(root, 'src/note-drop-mobile.css'), 'utf8');
const quickCss = fs.readFileSync(path.join(root, 'src/quick-material-composer.css'), 'utf8');
const checks = [
  ['upload queue only runs in cloud', /if \\(!IS_CLOUD_RUNTIME\\) return undefined;[\\s\\S]*installCaptureUploadResumer/.test(app)],
  ['LAN single save calls local server directly', /if \\(IS_CLOUD_RUNTIME\\) \\{[\\s\\S]*enqueueCaptureUpload\\(\\[payload\\]\\)[\\s\\S]*return;[\\s\\S]*saveImageReliably\\(payload/.test(app)],
  ['prominent quick-note button exists', /className="note-drop-quick-entry"[\\s\\S]*<strong>速记<\\/strong>/.test(app)],
  ['embedded quick-note overlay exists', /className="note-drop-quick-overlay"/.test(app)],
  ['ordinary-note top-level tab removed', !/label: '普通笔记'/.test(center)],
  ['uncategorized top-level route removed', !/view === 'uncategorized'/.test(center)],
  ['quick entry styling exists', /LAN quick entry restoration/.test(mobileCss)],
  ['Dunhuang embedded composer styling exists', /Dunhuang note app embedded composer/.test(quickCss)],
];
let failed = false;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
console.log('LAN note app, quick entry and default-folder navigation checks passed.');
`, 'utf8');
