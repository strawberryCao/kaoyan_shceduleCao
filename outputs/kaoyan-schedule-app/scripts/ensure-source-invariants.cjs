const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function patchFile(relativePath, patches) {
  const filePath = path.join(root, relativePath);
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;
  for (const patch of patches) {
    if (content.includes(patch.replacementMarker || patch.replacement)) continue;
    if (!content.includes(patch.search)) {
      throw new Error(`Source invariant anchor was not found in ${relativePath}: ${patch.name}`);
    }
    content = content.replace(patch.search, patch.replacement);
    changed = true;
  }
  if (changed) fs.writeFileSync(filePath, content, 'utf8');
}

patchFile('cloudflare/worker.js', [{
  name: 'pass execution context to saveNote',
  search: "const result = await saveNote(env, await readJson(request, 28 * 1024 * 1024));",
  replacement: "const result = await saveNote(env, await readJson(request, 28 * 1024 * 1024), ctx);",
}]);

const remotePathReplacement = (filePathLine, subjectLine) => [
  filePathLine,
  "  const normalizedFilePath = filePath.replaceAll(String.fromCharCode(92), '/').toLowerCase();",
  "  const isRemoteAssetPath = normalizedFilePath.startsWith('github://data/assets/')",
  "    || normalizedFilePath.startsWith('data/assets/')",
  "    || normalizedFilePath.startsWith('r2://note-assets/');",
  subjectLine,
].join('\n');

patchFile('src/utils/learningData.ts', [
  {
    name: 'identify remote asset paths',
    search: "  const filePath = typeof value.filePath === 'string' ? value.filePath : '';\n  const rawSubject = typeof value.subject === 'string' ? value.subject : '默认文件夹';",
    replacement: remotePathReplacement(
      "  const filePath = typeof value.filePath === 'string' ? value.filePath : '';",
      "  const storedSubject = typeof value.subject === 'string' ? value.subject : '默认文件夹';\n  const rawSubject = isRemoteAssetPath && storedSubject.trim().toLowerCase() === 'assets' ? '默认文件夹' : storedSubject;",
    ),
    replacementMarker: "const normalizedFilePath = filePath.replaceAll(String.fromCharCode(92), '/')",
  },
  {
    name: 'do not infer subject from remote storage path',
    search: "  const inferredFromFile = value.classificationSource !== 'manual'\n    && DEFAULT_SUBJECT_NAMES.has(rawSubject)",
    replacement: "  const inferredFromFile = value.classificationSource !== 'manual'\n    && !isRemoteAssetPath\n    && DEFAULT_SUBJECT_NAMES.has(rawSubject)",
    replacementMarker: "&& !isRemoteAssetPath\n    && DEFAULT_SUBJECT_NAMES.has(rawSubject)",
  },
]);

patchFile('scripts/learning-data-store.cjs', [
  {
    name: 'identify remote asset paths in local store',
    search: "  const filePath = asString(value.filePath);\n  const rawSubject = asString(value.subject, '默认文件夹');",
    replacement: remotePathReplacement(
      '  const filePath = asString(value.filePath);',
      "  const storedSubject = asString(value.subject, '默认文件夹');\n  const rawSubject = isRemoteAssetPath && storedSubject.trim().toLowerCase() === 'assets' ? '默认文件夹' : storedSubject;",
    ),
    replacementMarker: "const normalizedFilePath = filePath.replaceAll(String.fromCharCode(92), '/')",
  },
  {
    name: 'do not infer local subject from remote storage path',
    search: "  const inferredFromFile = value.classificationSource !== 'manual'\n    && DEFAULT_SUBJECT_NAMES.has(rawSubject)",
    replacement: "  const inferredFromFile = value.classificationSource !== 'manual'\n    && !isRemoteAssetPath\n    && DEFAULT_SUBJECT_NAMES.has(rawSubject)",
    replacementMarker: "&& !isRemoteAssetPath\n    && DEFAULT_SUBJECT_NAMES.has(rawSubject)",
  },
]);

console.log('Source invariants are satisfied.');
