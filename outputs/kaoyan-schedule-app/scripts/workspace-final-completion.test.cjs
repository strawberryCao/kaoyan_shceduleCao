'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('workspace renders DOCX and runs HTML only in an isolated offline sandbox', () => {
  const renderer = read('src/components/WorkspaceAssetPreview.tsx');
  assert.match(renderer, /mammoth\.convertToHtml/);
  assert.match(renderer, /安全查看/);
  assert.match(renderer, /隔离运行/);
  assert.match(renderer, /allow-scripts allow-forms/);
  assert.doesNotMatch(renderer, /allow-same-origin/);
  assert.match(renderer, /connect-src 'none'/);
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
