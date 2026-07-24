const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'src', 'utils', 'learningData.ts');
const workflow = path.resolve(root, '..', '..', '.github', 'workflows', 'apply-cloud-image-path-fix.yml');
const self = __filename;
const testFile = path.join(root, 'scripts', '__tests__', 'cloud-image-path.test.cjs');

function replaceRequired(text, search, replacement, label) {
  if (!text.includes(search)) {
    throw new Error(`Missing required patch anchor: ${label}`);
  }
  return text.replace(search, replacement);
}

let text = fs.readFileSync(target, 'utf8');

text = replaceRequired(
  text,
  "const DEFAULT_SUBJECT_NAMES = new Set(['默认文件夹', '未分类', '默认', '收件箱']);",
  `const DEFAULT_SUBJECT_NAMES = new Set(['默认文件夹', '未分类', '默认', '收件箱']);\nconst NOTE_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif']);\n\nconst normalizeStoredPath = (value: unknown): string => typeof value === 'string'\n  ? value.trim().replace(/\\\\/g, '/')\n  : '';\n\nconst isRemoteAssetPath = (value: unknown): boolean => {\n  const normalized = normalizeStoredPath(value);\n  return normalized.startsWith('github://data/assets/')\n    || normalized.startsWith('data/assets/')\n    || normalized.startsWith('r2://note-assets/');\n};\n\nconst cloudAssetPath = (noteUid: unknown, value: unknown): string => {\n  const normalized = normalizeStoredPath(value);\n  if (!IS_CLOUD_RUNTIME || isRemoteAssetPath(normalized)) return normalized;\n  const safeUid = typeof noteUid === 'string' ? noteUid.replace(/[^A-Za-z0-9._-]/g, '') : '';\n  if (!safeUid) return normalized;\n  const extensionMatch = /\\.([A-Za-z0-9]+)(?:[?#].*)?$/.exec(normalized);\n  const extension = extensionMatch?.[1]?.toLowerCase() || 'png';\n  const safeExtension = NOTE_IMAGE_EXTENSIONS.has(extension) ? extension : 'png';\n  return \\`github://data/assets/\\${safeUid}.\\${safeExtension}\\`;\n};`,
  'cloud image path helpers',
);

text = replaceRequired(
  text,
  "  const filePath = typeof value.filePath === 'string' ? value.filePath : '';",
  "  const filePath = cloudAssetPath(value.noteUid, value.filePath);",
  'note file path normalization',
);

text = replaceRequired(
  text,
  "  const inferredFromFile = value.classificationSource !== 'manual'\n    && DEFAULT_SUBJECT_NAMES.has(rawSubject)",
  "  const inferredFromFile = value.classificationSource !== 'manual'\n    && !isRemoteAssetPath(filePath)\n    && DEFAULT_SUBJECT_NAMES.has(rawSubject)",
  'remote asset classification guard',
);

text = replaceRequired(
  text,
  "    sourceFilePath: typeof value.sourceFilePath === 'string' ? value.sourceFilePath : '',",
  "    sourceFilePath: cloudAssetPath(value.noteUid, value.sourceFilePath),",
  'card source image path normalization',
);

fs.writeFileSync(target, text, 'utf8');

fs.mkdirSync(path.dirname(testFile), { recursive: true });
fs.writeFileSync(testFile, `const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst path = require('node:path');\n\nconst source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'utils', 'learningData.ts'), 'utf8');\n\ntest('cloud learning data rebuilds note and card image paths from noteUid', () => {\n  assert.match(source, /const cloudAssetPath =/);\n  assert.match(source, /github:\\/\\/data\\/assets\\/\\$\\{safeUid\\}\\.\\$\\{safeExtension\\}/);\n  assert.match(source, /const filePath = cloudAssetPath\\(value\\.noteUid, value\\.filePath\\)/);\n  assert.match(source, /sourceFilePath: cloudAssetPath\\(value\\.noteUid, value\\.sourceFilePath\\)/);\n});\n\ntest('cloud asset paths never become a subject classification', () => {\n  assert.match(source, /&& !isRemoteAssetPath\\(filePath\\)/);\n});\n`, 'utf8');

for (const temporary of [workflow, self]) {
  if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
}

console.log('Cloud image path repair applied.');
