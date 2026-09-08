const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CLOUDFLARE_SESSION_TTL_SECONDS,
  DEFAULT_HOST,
  TAILSCALE_SESSION_TTL_SECONDS,
  createKaoyanWebServer,
  ingressKindForHostname,
} = require('../web-server.cjs');
const { configureMobileAccess } = require('../mobile-session-auth.cjs');

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

test('serves production assets with ranges and preserves the LAN API guard', async (t) => {
  assert.equal(DEFAULT_HOST, '127.0.0.1', 'production startup must default to loopback');
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
  const liveness = await fetch(`${baseUrl}/healthz`);
  assert.equal(liveness.status, 200);
  assert.deepEqual(await liveness.json(), { ok: true, service: 'kaoyan-web-gateway' });
  const readiness = await fetch(`${baseUrl}/readyz`);
  assert.equal(readiness.status, 200);
  assert.deepEqual(await readiness.json(), {
    ok: true,
    service: 'kaoyan-web-gateway',
    dependencies: { noteService: 'ready' },
  });
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

  const sync = await fetch(`${baseUrl}/sync/v1/status`, {
    headers: { authorization: 'Bearer device-secret' },
  });
  assert.equal(sync.status, 200);
  assert.deepEqual(await sync.json(), {
    path: '/sync/v1/status',
    authorization: 'Bearer device-secret',
    cookie: null,
  });

  const browserSync = await fetch(`${baseUrl}/sync/v1/status`, {
    headers: { origin: baseUrl, authorization: 'Bearer device-secret' },
  });
  assert.equal(browserSync.status, 403);
});

const rawRequest = (port, input = {}) => new Promise((resolve, reject) => {
  const body = input.body ? Buffer.from(input.body) : null;
  const request = http.request({
    host: '127.0.0.1',
    port,
    method: input.method || 'GET',
    path: input.path || '/',
    headers: {
      connection: 'close',
      ...(body ? { 'content-length': body.length } : {}),
      ...(input.headers || {}),
    },
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({
      status: response.statusCode,
      headers: response.headers,
      json: () => JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
    }));
  });
  request.once('error', reject);
  if (body) request.write(body);
  request.end();
});

test('explicit loopback ingress accepts a Tailscale or Cloudflare hostname without weakening LAN defaults', async (t) => {
  const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-loopback-ingress-'));
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>Ingress</title>', 'utf8');
  const webServer = createKaoyanWebServer({
    staticRoot,
    apiPort: 1,
    allowedHosts: new Set(['127.0.0.1']),
    trustLoopbackIngress: true,
  });
  const webPort = await listen(webServer);
  t.after(async () => {
    await close(webServer);
    fs.rmSync(staticRoot, { recursive: true, force: true });
  });
  const response = await new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port: webPort,
      path: '/',
      headers: { host: 'study-mac.tailnet.ts.net', connection: 'close' },
    }, resolve);
    request.once('error', reject);
  });
  response.resume();
  assert.equal(response.statusCode, 200);
});

test('remote ingress classification keeps Tailscale primary and Cloudflare explicit', () => {
  assert.equal(ingressKindForHostname('study-mac.tailnet.ts.net', 'study.example.com'), 'tailscale');
  assert.equal(ingressKindForHostname('study.example.com', 'study.example.com'), 'cloudflare');
  assert.equal(ingressKindForHostname('spoofed.example.com', 'study.example.com'), 'unknown');
  assert.equal(TAILSCALE_SESSION_TTL_SECONDS, 30 * 86400);
  assert.equal(CLOUDFLARE_SESSION_TTL_SECONDS, 7 * 86400);
});

test('remote browser ingress requires a revocable Mac session while local loopback stays frictionless', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-mobile-ingress-'));
  const staticRoot = path.join(root, 'dist');
  const authPath = path.join(root, 'secrets', 'mobile-access.json');
  fs.mkdirSync(staticRoot, { recursive: true });
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>Mobile ingress</title>', 'utf8');
  configureMobileAccess(authPath, { username: 'student', password: 'mobile-password-123' });
  const apiServer = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ path: request.url, cookie: request.headers.cookie || null }));
  });
  const apiPort = await listen(apiServer);
  const webServer = createKaoyanWebServer({
    staticRoot,
    apiPort,
    allowedHosts: new Set(['127.0.0.1']),
    trustLoopbackIngress: true,
    mobileAuthConfigPath: authPath,
  });
  const webPort = await listen(webServer);
  t.after(async () => {
    await close(webServer);
    await close(apiServer);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const remoteHeaders = { host: 'study-mac.tailnet.ts.net' };
  const anonymous = await rawRequest(webPort, { path: '/api/learning-data', headers: remoteHeaders });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json().code, 'AUTH_REQUIRED');
  assert.equal(anonymous.headers['x-frame-options'], 'DENY');
  assert.match(anonymous.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(anonymous.headers['strict-transport-security'], /max-age=31536000/);

  const status = await rawRequest(webPort, { path: '/api/auth/status', headers: remoteHeaders });
  assert.equal(status.status, 200);
  assert.equal(status.json().authenticated, false);

  const missingOrigin = await rawRequest(webPort, {
    method: 'POST', path: '/api/auth/login', headers: { ...remoteHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'student', password: 'mobile-password-123' }),
  });
  assert.equal(missingOrigin.status, 403);

  const login = await rawRequest(webPort, {
    method: 'POST', path: '/api/auth/login',
    headers: { ...remoteHeaders, origin: 'https://study-mac.tailnet.ts.net', 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'student', password: 'mobile-password-123' }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /HttpOnly/);
  assert.match(login.headers['set-cookie'][0], /Max-Age=2592000/);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const protectedResponse = await rawRequest(webPort, {
    path: '/api/learning-data', headers: { ...remoteHeaders, cookie },
  });
  assert.equal(protectedResponse.status, 200);
  assert.deepEqual(protectedResponse.json(), { path: '/learning-data', cookie: null });

  const logoutWithoutOrigin = await rawRequest(webPort, {
    method: 'POST', path: '/api/auth/logout', headers: { ...remoteHeaders, cookie },
  });
  assert.equal(logoutWithoutOrigin.status, 403);

  const logout = await rawRequest(webPort, {
    method: 'POST', path: '/api/auth/logout',
    headers: { ...remoteHeaders, origin: 'https://study-mac.tailnet.ts.net', cookie },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);

  const local = await rawRequest(webPort, { path: '/api/learning-data', headers: { host: `127.0.0.1:${webPort}` } });
  assert.equal(local.status, 200);
});
