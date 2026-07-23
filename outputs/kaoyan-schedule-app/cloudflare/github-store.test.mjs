import assert from 'node:assert/strict';
import test from 'node:test';
import { commitFiles, readJsonFile } from './github-store.js';

const env = {
  GITHUB_TOKEN: 'test-token',
  GITHUB_OWNER: 'owner',
  GITHUB_REPO: 'repo',
  GITHUB_BRANCH: 'main',
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('reads a JSON file from GitHub Contents API', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const payload = { version: 1, cards: [1, 2] };
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.match(String(url), /\/repos\/owner\/repo\/contents\/data\/cloud\/learning-data\.json\?ref=main$/);
    return json({
      type: 'file',
      sha: 'a'.repeat(40),
      size: 20,
      encoding: 'base64',
      content: Buffer.from(JSON.stringify(payload)).toString('base64'),
    });
  };
  const result = await readJsonFile(env, 'data/cloud/learning-data.json');
  assert.deepEqual(result.value, payload);
  assert.equal(result.sha, 'a'.repeat(40));
});

test('creates an atomic multi-file Git commit and advances the branch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  const head = '1'.repeat(40);
  globalThis.fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (pathname.endsWith('/git/ref/heads/main')) return json({ object: { sha: head } });
    if (pathname.endsWith(`/git/commits/${head}`)) return json({ tree: { sha: '2'.repeat(40) } });
    if (pathname.endsWith('/git/blobs')) return json({ sha: `${calls.filter((call) => call.pathname.endsWith('/git/blobs')).length}`.repeat(40).slice(0, 40) }, 201);
    if (pathname.endsWith('/git/trees')) return json({ sha: '3'.repeat(40) }, 201);
    if (pathname.endsWith('/git/commits')) return json({ sha: '4'.repeat(40) }, 201);
    if (pathname.endsWith('/git/refs/heads/main')) return json({ object: { sha: '4'.repeat(40) } });
    throw new Error(`Unexpected request: ${pathname}`);
  };

  const result = await commitFiles(env, {
    expectedHeadSha: head,
    message: 'cloud: test commit',
    files: [
      { path: 'data/cloud/a.json', content: '{"a":1}\n' },
      { path: 'data/cloud/b.json', content: '{"b":2}\n' },
    ],
  });
  assert.equal(result.commitSha, '4'.repeat(40));
  assert.equal(calls.filter((call) => call.pathname.endsWith('/git/blobs')).length, 2);
  const treeCall = calls.find((call) => call.pathname.endsWith('/git/trees'));
  assert.equal(treeCall.body.tree.length, 2);
  const refCall = calls.at(-1);
  assert.equal(refCall.method, 'PATCH');
  assert.equal(refCall.body.force, false);
});
