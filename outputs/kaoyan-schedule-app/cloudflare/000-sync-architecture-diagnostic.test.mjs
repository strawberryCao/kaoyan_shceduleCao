import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const currentFile = path.resolve(import.meta.dirname, path.basename(import.meta.filename));

function collectTests(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...collectTests(full));
    else if (/\.test\.(?:cjs|mjs)$/i.test(entry.name) && path.resolve(full) !== currentFile) result.push(full);
  }
  return result;
}

async function publishDiagnostic(payload) {
  const token = process.env.CAOBIJI_GITHUB_TOKEN;
  if (!token) return;
  const repository = process.env.DATA_REPOSITORY || 'strawberryCao/Caobijidata';
  const branch = process.env.DATA_BRANCH || 'main';
  const diagnosticPath = 'data/diagnostics/sync-architecture-test-failure.json';
  const endpoint = `https://api.github.com/repos/${repository}/contents/${diagnosticPath}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'kaoyan-sync-diagnostic',
    'X-GitHub-Api-Version': '2026-03-10',
  };
  const current = await fetch(`${endpoint}?ref=${encodeURIComponent(branch)}`, { headers });
  let sha;
  if (current.ok) sha = (await current.json()).sha;
  else if (current.status !== 404) throw new Error(`Unable to read diagnostic file: HTTP ${current.status}`);
  const body = {
    message: 'ci: record concurrent test diagnostic',
    branch,
    content: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8').toString('base64'),
    ...(sha ? { sha } : {}),
  };
  const response = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Unable to publish diagnostic file: HTTP ${response.status}`);
}

test('captures the concurrent full-suite failure for synchronized architecture validation', async () => {
  if (!process.env.CAOBIJI_GITHUB_TOKEN) return;
  const appRoot = path.resolve(import.meta.dirname, '..');
  const roots = [path.resolve(import.meta.dirname), path.resolve(appRoot, 'scripts')];
  const files = roots.flatMap(collectTests).sort();
  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: appRoot,
    encoding: 'utf8',
    env: { ...process.env, CAOBIJI_GITHUB_TOKEN: '' },
    maxBuffer: 32 * 1024 * 1024,
  });
  const failure = result.status === 0 ? null : {
    exitCode: result.status,
    stdout: String(result.stdout || '').slice(-120000),
    stderr: String(result.stderr || '').slice(-24000),
  };
  await publishDiagnostic({
    checkedAt: new Date().toISOString(),
    ok: failure === null,
    concurrentFiles: files.length,
    failure,
  });
  assert.equal(failure, null, 'Nested concurrent test suite failed; see data/diagnostics/sync-architecture-test-failure.json');
});
