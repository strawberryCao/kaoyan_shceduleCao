'use strict';

const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, 'apply-learning-center-image-display-fix.cjs');
const runtimePath = path.join(__dirname, '.runtime-learning-center-image-display-fix.cjs');
let source = fs.readFileSync(sourcePath, 'utf8');

const brittleBlock = `replaceOnce(
  "       src: noteFileUrl(attachment.filePath),",
  "       src: noteFileUrl(noteAttachmentPrimaryPath(note, attachment)),",
  'note viewer path',
);`;
const robustBlock = `{
  const next = source.replace(
    /src:\\s*noteFileUrl\\(attachment\\.filePath\\),/,
    'src: noteFileUrl(noteAttachmentPrimaryPath(note, attachment)),',
  );
  if (next === source) throw new Error('Patch target not found: note viewer path');
  source = next;
}`;
if (!source.includes(brittleBlock)) throw new Error('Brittle note viewer block not found');
source = source.replace(brittleBlock, robustBlock);

const stableRegexLine = String.raw`const isStableLearningAssetPath = (value: string): boolean => /^(?:github:\/\/data\/assets\/|data\/assets\/|r2:\/\/note-assets\/)/i.test(normalizeLearningAssetPath(value));`;
const stablePrefixBlock = `const isStableLearningAssetPath = (value: string): boolean => {
  const normalized = normalizeLearningAssetPath(value).toLowerCase();
  return normalized.startsWith('github://data/assets/')
    || normalized.startsWith('data/assets/')
    || normalized.startsWith('r2://note-assets/');
};`;
if (!source.includes(stableRegexLine)) throw new Error('Stable path regex line not found');
source = source.replace(stableRegexLine, stablePrefixBlock);

fs.writeFileSync(runtimePath, source, 'utf8');
try {
  globalThis.NOTE_SERVER_URL = '${NOTE_SERVER_URL}';
  require(runtimePath);
} finally {
  fs.rmSync(runtimePath, { force: true });
}
