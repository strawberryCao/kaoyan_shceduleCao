import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.js';

function environment(overrides = {}) {
  return {
    PUBLIC_READ_ENABLED: 'true',
    APP_USERNAME: 'tester',
    APP_PASSWORD: 'secret',
    GITHUB_TOKEN: 'test-token',
    GITHUB_OWNER: 'owner',
    GITHUB_REPO: 'repo',
    GITHUB_BRANCH: 'main',
    ASSETS: {
      fetch: async (request) => new Response(`asset:${new URL(request.url).pathname}`, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    },
    ...overrides,
  };
}

test('public read mode exposes pages and read-only APIs while protecting writes', async () => {
  const env = environment();

  const page = await worker.fetch(new Request('https://study.example/'), env, {});
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'public, max-age=0, must-revalidate');

  const chunk = await worker.fetch(new Request('https://study.example/assets/index-AbCd1234.js'), env, {});
  assert.equal(chunk.status, 200);
  assert.equal(chunk.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  const readOnlyApi = await worker.fetch(new Request('https://study.example/api/organizer/status'), env, {});
  assert.equal(readOnlyApi.status, 200);
  assert.equal((await readOnlyApi.json()).available, false);

  const write = await worker.fetch(new Request('https://study.example/api/layout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layout: [] }),
  }), env, {});
  assert.equal(write.status, 401);
  assert.equal((await write.json()).code, 'AUTH_REQUIRED');
});

test('public pages remain available when the write password is temporarily missing', async () => {
  const env = environment({ APP_PASSWORD: undefined });
  const page = await worker.fetch(new Request('https://study.example/'), env, {});
  assert.equal(page.status, 200);

  const write = await worker.fetch(new Request('https://study.example/api/layout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layout: [] }),
  }), env, {});
  assert.equal(write.status, 503);
  assert.equal((await write.json()).code, 'AUTH_NOT_CONFIGURED');
});
