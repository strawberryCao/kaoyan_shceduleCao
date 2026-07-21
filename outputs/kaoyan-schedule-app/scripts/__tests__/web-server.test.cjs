const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createKaoyanWebServer } = require('../web-server.cjs');

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

test('serves production assets with ranges and preserves the LAN API guard', async (t) => {
  const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-web-server-'));
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>Kaoyan</title>', 'utf8');
  fs.writeFileSync(path.join(staticRoot, 'sample.mp4'), Buffer.from('0123456789', 'ascii'));

  const apiServer = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      path: request.url,
      proxy: request.headers['x-kaoyan-lan-proxy'],
      authorization: request.headers.authorization || null,
      cookie: request.headers.cookie || null,
    }));
  });
  const apiPort = await listen(apiServer);
  const webServer = createKaoyanWebServer({
    staticRoot,
    apiPort,
    allowedHosts: new Set(['127.0.0.1']),
  });
  const webPort = await listen(webServer);

  t.after(async () => {
    await close(webServer);
    await close(apiServer);
    fs.rmSync(staticRoot, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${webPort}`;
  const page = await fetch(`${baseUrl}/?console=1`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Kaoyan/);
  assert.equal(page.headers.get('cache-control'), 'no-cache');

  const range = await fetch(`${baseUrl}/sample.mp4`, { headers: { range: 'bytes=2-5' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await range.text(), '2345');

  const blocked = await fetch(`${baseUrl}/api/health`);
  assert.equal(blocked.status, 403);

  const proxied = await fetch(`${baseUrl}/api/learning-data`, {
    headers: { authorization: 'secret', cookie: 'session=secret' },
  });
  assert.equal(proxied.status, 200);
  assert.deepEqual(await proxied.json(), {
    path: '/learning-data',
    proxy: '1',
    authorization: null,
    cookie: null,
  });
});
