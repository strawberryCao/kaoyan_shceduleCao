const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

test('private GitHub assets are fetched through the authenticated Contents API', async () => {
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '..', '..', 'cloudflare', 'github-store.js')).href;
  const { publicFileResponse } = await import(moduleUrl);
  const originalFetch = global.fetch;
  const expectedBytes = Uint8Array.from([137, 80, 78, 71]);
  let request = null;

  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(expectedBytes, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  };

  try {
    const response = await publicFileResponse({
      GITHUB_OWNER: 'owner',
      GITHUB_REPO: 'private-repo',
      GITHUB_BRANCH: 'main',
      GITHUB_TOKEN: 'private-token',
    }, 'data/assets/example image.png', {
      prefix: 'data/assets/',
      contentType: 'image/png',
      contentDisposition: 'inline',
      cacheControl: 'private, max-age=300',
    });

    assert.equal(
      request.url,
      'https://api.github.com/repos/owner/private-repo/contents/data/assets/example%20image.png?ref=main',
    );
    assert.equal(request.options.headers.Authorization, 'Bearer private-token');
    assert.equal(request.options.headers.Accept, 'application/vnd.github.raw+json');
    assert.equal(response.headers.get('Content-Type'), 'image/png');
    assert.equal(response.headers.get('Content-Disposition'), 'inline');
    assert.equal(response.headers.get('Cache-Control'), 'private, max-age=300');
    assert.equal(response.headers.has('Authorization'), false);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expectedBytes);
  } finally {
    global.fetch = originalFetch;
  }
});
