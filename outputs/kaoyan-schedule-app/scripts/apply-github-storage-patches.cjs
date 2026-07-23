const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function replaceOnce(relativePath, before, after) {
  const filePath = path.join(root, relativePath);
  const source = fs.readFileSync(filePath, 'utf8');
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${relativePath}: expected one patch target, found ${count}`);
  fs.writeFileSync(filePath, source.replace(before, after), 'utf8');
}

function replaceFirst(relativePath, before, after) {
  const filePath = path.join(root, relativePath);
  const source = fs.readFileSync(filePath, 'utf8');
  if (!source.includes(before)) throw new Error(`${relativePath}: patch target is missing`);
  fs.writeFileSync(filePath, source.replace(before, after), 'utf8');
}

function replaceSection(relativePath, startMarker, endMarker, replacement) {
  const filePath = path.join(root, relativePath);
  const source = fs.readFileSync(filePath, 'utf8');
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`${relativePath}: structured patch markers are missing`);
  fs.writeFileSync(filePath, `${source.slice(0, start)}${replacement}${source.slice(end)}`, 'utf8');
}

replaceOnce(
  'cloudflare/learning.js',
  '    const stored = await compareAndSwapLearningState(env, current.revision, snapshot, updatedAt);',
  '    const stored = await compareAndSwapLearningState(env, current, snapshot, updatedAt);',
);

replaceOnce(
  'cloudflare/learning.js',
  "    wrongReason: text(input.wrongReason, 1000),\n    organizationStatus: 'confirmed',",
  "    wrongReason: text(input.wrongReason, 1000),\n    wrongReasonSource: text(input.wrongReason).trim() ? 'manual' : '',\n    wrongReasonConfidence: null,\n    organizationStatus: 'confirmed',",
);

replaceFirst(
  'cloudflare/learning.js',
  "      ...(Object.hasOwn(patch, 'wrongReason') ? { wrongReason: text(patch.wrongReason, 500) } : {}),",
  "      ...(Object.hasOwn(patch, 'wrongReason') ? {\n        wrongReason: text(patch.wrongReason, 500),\n        wrongReasonSource: 'manual',\n        wrongReasonConfidence: null,\n      } : {}),",
);

replaceSection(
  'cloudflare/learning.js',
  "  const noteAssetKey = (note, fallback = '') => {",
  '  for (const day of Object.values(snapshot.days)) {',
  `  const noteAssetKey = (note, fallback = '') => {
    const current = text(note?.filePath || fallback, 2000).replaceAll('\\\\', '/');
    const safeRelative = (value) => /^[A-Za-z0-9._/-]+$/.test(value) && !value.includes('..');
    if (current.startsWith('github://data/assets/')) {
      const relative = current.slice('github://data/assets/'.length);
      return safeRelative(relative) ? current : '';
    }
    if (current.startsWith('data/assets/')) {
      const relative = current.slice('data/assets/'.length);
      return safeRelative(relative) ? \`github://\${current}\` : '';
    }
    if (current.startsWith('r2://note-assets/')) {
      const relative = current.slice('r2://note-assets/'.length);
      return safeRelative(relative) ? \`github://data/assets/\${relative}\` : '';
    }
    return '';
  };
`,
);

replaceOnce(
  'cloudflare/learning.js',
  '    filePath: `r2://${file.r2Key}`,',
  '    filePath: `github://${file.repoPath}`,'
);

replaceOnce(
  'cloudflare/worker.js',
  "import { readAppState, writeAppState } from './storage.js';",
  "import { githubStorageInfo } from './github-store.js';\nimport { readAppState, writeAppState } from './storage.js';",
);

replaceOnce(
  'cloudflare/worker.js',
  "    return json({\n      ok: true,\n      runtime: 'cloudflare-workers',\n      authConfigured: Boolean(env.APP_USERNAME && env.APP_PASSWORD),\n      d1Bound: Boolean(env.DB),\n      r2Bound: Boolean(env.BUCKET),\n    });",
  "    const github = githubStorageInfo(env);\n    return json({\n      ok: true,\n      runtime: 'cloudflare-workers',\n      storage: 'github',\n      authConfigured: Boolean(env.APP_USERNAME && env.APP_PASSWORD),\n      githubConfigured: github.configured,\n      repository: github.repository,\n      branch: github.branch,\n      d1Bound: false,\n      r2Bound: false,\n    });",
);

console.log('Applied GitHub storage compatibility patches.');
