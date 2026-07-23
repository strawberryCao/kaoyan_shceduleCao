import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const currentFile = path.resolve(import.meta.dirname, path.basename(import.meta.filename));

function collect(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...collect(full));
    else if (/\.test\.(?:cjs|mjs)$/i.test(entry.name) && path.resolve(full) !== currentFile) files.push(full);
  }
  return files;
}

async function publish(payload) {
  const token = process.env.CAOBIJI_GITHUB_TOKEN;
  if (!token) return;
  const repository = process.env.DATA_REPOSITORY || 'strawberryCao/Caobijidata';
  const branch = process.env.DATA_BRANCH || 'main';
  const filePath = 'data/diagnostics/token-environment-test.json';
  const endpoint = `https://api.github.com/repos/${repository}/contents/${filePath}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'kaoyan-test-diagnostic',
    'X-GitHub-Api-Version': '2026-03-10',
  };
  const current = await fetch(`${endpoint}?ref=${encodeURIComponent(branch)}`, { headers });
  let sha;
  if (current.ok) sha = (await current.json()).sha;
  else if (current.status !== 404) throw new Error(`diagnostic read failed: ${current.status}`);
  const response = await fetch(endpoint, {
    method: 'PUT', headers,
    body: JSON.stringify({
      message: 'ci: record token environment diagnostic',
      branch,
      content: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`).toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!response.ok) throw new Error(`diagnostic write failed: ${response.status}`);
}

test('records the full-suite result with the production token environment retained', async () => {
  if (!process.env.CAOBIJI_GITHUB_TOKEN) return;
  const appRoot = path.resolve(import.meta.dirname, '..');
  const files = [path.resolve(import.meta.dirname), path.resolve(appRoot, 'scripts')].flatMap(collect).sort();
  const childEnv = { ...process.env, KAOYAN_DIAGNOSTIC_CHILD: '1' };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('NODE_TEST')) delete childEnv[key];
  }
  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: appRoot,
    encoding: 'utf8',
    env: childEnv,
    maxBuffer: 32 * 1024 * 1024,
  });
  const payload = {
    checkedAt: new Date().toISOString(),
    tokenPresent: Boolean(process.env.CAOBIJI_GITHUB_TOKEN),
    ok: result.status === 0,
    exitCode: result.status,
    stdout: String(result.stdout || '').slice(-150000),
    stderr: String(result.stderr || '').slice(-30000),
  };
  await publish(payload);
  assert.equal(result.status, 0, 'Nested suite with token retained failed; inspect data/diagnostics/token-environment-test.json');
});
