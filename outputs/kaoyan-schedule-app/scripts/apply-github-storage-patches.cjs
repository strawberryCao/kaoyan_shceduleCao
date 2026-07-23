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

replaceOnce(
  'cloudflare/learning.js',
  "    if (/^r2:\/\/note-assets\/[A-Za-z0-9._/-]+$/.test(current) && !current.includes('..')) return current;\n    if (/^note-assets\/[A-Za-z0-9._/-]+$/.test(current) && !current.includes('..')) return `r2://${current}`;\n    return '';",
  "    if (/^github:\/\/data\/assets\/[A-Za-z0-9._/-]+$/.test(current) && !current.includes('..')) return current;\n    if (/^data\/assets\/[A-Za-z0-9._/-]+$/.test(current) && !current.includes('..')) return `github://${current}`;\n    if (/^r2:\/\/note-assets\/[A-Za-z0-9._/-]+$/.test(current) && !current.includes('..')) {\n      return `github://data/assets/${current.slice('r2://note-assets/'.length)}`;\n    }\n    return '';",
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
