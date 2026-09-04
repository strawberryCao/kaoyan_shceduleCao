'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/components/LearningCenter.tsx'), 'utf8');
const learningDataSource = fs.readFileSync(path.join(root, 'src/utils/learningData.ts'), 'utf8');

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

test('cloud attachments are not duplicated by a legacy local file path', () => {
  assert.match(learningDataSource, /attachmentMatchesLegacyPath/);
  assert.match(learningDataSource, /\[item\.filePath, item\.cloudPath\]/);
  assert.ok(learningDataSource.includes('data/assets'));
  assert.ok(learningDataSource.includes('.assets'));
});

test('internal asset folders never become a visible learning subject', () => {
  assert.match(learningDataSource, /storedSubjectKey === 'assets' \|\| storedSubjectKey === '\.assets'/);
  assert.match(learningDataSource, /\['\.assets', '\.metadata'\]\.includes\(parentDirectory\.toLowerCase\(\)\)/);
});

test('the preview chooses a stable asset before a legacy image entry', () => {
  assert.match(source, /images\.find\(\(attachment\) => Boolean\(attachment\.assetId\)\)/);
  assert.ok(source.includes(String.raw`github:\/\/data\/assets`));
});
