'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('workspace renders DOCX and isolates offline HTML plus the vetted GeoGebra runtime', () => {
  const renderer = read('src/components/WorkspaceAssetPreview.tsx');
  assert.match(renderer, /mammoth\.convertToHtml/);
  assert.match(renderer, /sandbox="allow-scripts"/);
  assert.match(renderer, /referrerPolicy="no-referrer"/);
  assert.doesNotMatch(renderer, /allow-forms|allow-modals|allow-downloads/);
  assert.match(renderer, /runtimeProfile === 'geogebra'/);
  assert.match(renderer, /createGeoGebraPreviewSession/);
  assert.match(renderer, /\/html-preview-sessions/);
  assert.match(renderer, /frameUrl\.origin === window\.location\.origin/);
  assert.match(renderer, /sandbox="allow-scripts allow-same-origin"/);
  assert.match(renderer, /src=\{documentSource\.frameUrl\}/);
  assert.doesNotMatch(renderer, /srcDoc=\{documentSource\.html\}[\s\S]{0,240}allow-same-origin/);
  assert.doesNotMatch(renderer, /data:text\/html|createObjectURL\([^)]*html/i);
  assert.doesNotMatch(renderer, /安全查看|隔离运行/);
  assert.match(renderer, /connect-src 'none'/);
  assert.match(renderer, /name="viewport"/);
  assert.match(renderer, /#kaoyan-fit-root\{display:inline-block;width:max-content/);
  assert.match(renderer, /img,video,svg\{height:auto\}/);
});

test('historical paths derive stable GitHub asset paths and persist after recovery', () => {
  const workspace = read('src/components/LearningRecordWorkspacePreview.tsx');
  assert.match(workspace, /note\.noteUid \+ '\.'/);
  assert.match(workspace, /note\.noteUid \+ '\/'/);
  assert.match(workspace, /patchLearningNote\(note\.noteUid, \{ attachments \}\)/);
  assert.match(workspace, /WorkspaceAssetPreview/);
});

test('速记 accepts web project resources on local and cloud storage', () => {
  const composer = read('src/components/QuickMaterialComposer.tsx');
  const local = read('scripts/note-file-access.cjs');
  const cloud = read('cloudflare/media.js');
  assert.match(composer, /\.css,\.js,\.mjs,\.json,\.svg/);
  assert.match(local, /text\/css/);
  assert.match(cloud, /text\/css/);
});
