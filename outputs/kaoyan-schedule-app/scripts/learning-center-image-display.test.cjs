'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/components/LearningCenter.tsx'), 'utf8');

test('learning note images prefer hash-addressed assets and retain legacy fallbacks', () => {
  assert.match(source, /asset:\/\/\$\{attachment\.assetId\}/);
  assert.match(source, /NOTE_SERVER_URL}\/assets\/\$\{assetId\}/);
  assert.match(source, /github:\/\/data\/assets\/\$\{note\.noteUid\}/);
  assert.match(source, /IS_CLOUD_RUNTIME\s*\?\s*\[assetPath, cloudPath, stable, current, currentPrimary\]\s*:\s*\[current, assetPath, cloudPath, currentPrimary, stable\]/);
});

test('all learning-center image surfaces use the shared resolver', () => {
  assert.match(source, /ResilientNoteImage paths=\{thumbnailPaths\}/);
  assert.match(source, /noteAttachmentPrimaryPath\(note, attachment\)/);
  assert.match(source, /resolveCardImagePath\(item\)/);
  assert.match(source, /currentCardResolvedPath/);
});

test('failed thumbnails try fallback paths instead of being permanently hidden', () => {
  assert.match(source, /pathIndex \+ 1 < usablePaths\.length/);
  assert.doesNotMatch(source, /event\.currentTarget\.hidden = true/);
});
