const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createMobileSessionManager, MobileAuthError } = require('./mobile-session-auth.cjs');
const {
  createAllowedHosts,
  hostnameFromHostHeader,
  isAllowedLanApiRoute,
} = require('./lan-gateway-policy.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_STATIC_ROOT = path.join(PROJECT_ROOT, 'dist');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 5173;
const DEFAULT_API_HOST = '127.0.0.1';
const DEFAULT_API_PORT = 5174;

const MIME_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
]);

const applySecurityHeaders = (response, remoteBrowserIngress = false) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "base-uri 'none'; object-src 'none'; frame-ancestors 'none'");
  response.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  if (remoteBrowserIngress) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
};

const sendText = (response, statusCode, body) => {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
};

const sendJson = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(payload));
};

const readJsonBody = (request, maxBytes = 16 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Payload too large.');
      error.code = 'PAYLOAD_TOO_LARGE';
      reject(error);
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    } catch {
      const error = new Error('Malformed JSON payload.');
      error.code = 'INVALID_JSON';
      reject(error);
    }
  });
  request.once('error', reject);
});

const ingressClientKey = (request) => {
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (forwarded || String(request.socket?.remoteAddress || 'unknown')).slice(0, 180);
};

const handleMobileAuthRoute = async (request, response, requestUrl, manager, origin) => {
  const pathname = requestUrl.pathname;
  if (request.method === 'GET' && pathname === '/api/auth/status') {
    try {
      const session = manager.readSession(request);
      const status = manager.status();
      sendJson(response, 200, {
        ok: true,
        authenticated: Boolean(session),
        username: session?.username || status.username || '',
        access: 'macmini-private-session',
      });
    } catch (error) {
      if (error?.code !== 'AUTH_NOT_CONFIGURED') throw error;
      sendJson(response, 503, { ok: false, authenticated: false, code: error.code, error: error.message });
    }
    return;
  }
  if (request.method === 'POST' && pathname === '/api/auth/login') {
    if (!origin) throw new MobileAuthError('AUTH_ORIGIN_REQUIRED', '登录请求缺少同源证明。', 403);
    const payload = await readJsonBody(request);
    const session = manager.login(payload.username, payload.password, ingressClientKey(request));
    response.setHeader('Set-Cookie', session.cookie);
    sendJson(response, 200, { ok: true, authenticated: true, username: session.username, expiresAt: session.expiresAt });
    return;
  }
  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    if (!origin) throw new MobileAuthError('AUTH_ORIGIN_REQUIRED', '退出请求缺少同源证明。', 403);
    response.setHeader('Set-Cookie', manager.logoutCookie());
    sendJson(response, 200, { ok: true, authenticated: false });
    return;
  }
  sendJson(response, 404, { ok: false, code: 'AUTH_ROUTE_NOT_FOUND', error: '登录接口不存在。' });
};

const probeNoteService = (apiHost, apiPort, timeoutMs = 2_000) => new Promise((resolve) => {
  const request = http.request({
    host: apiHost,
    port: apiPort,
    method: 'GET',
    path: '/health',
    headers: { host: `${apiHost}:${apiPort}` },
  }, (upstreamResponse) => {
    upstreamResponse.resume();
    resolve(upstreamResponse.statusCode === 200);
  });
  request.setTimeout(timeoutMs, () => request.destroy(new Error('Readiness probe timed out.')));
  request.once('error', () => resolve(false));
  request.end();
});

const parseSingleRange = (rangeHeader, size) => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || '').trim());
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : Number.NaN;
  let end = match[2] ? Number(match[2]) : Number.NaN;

  if (!Number.isFinite(start) && Number.isFinite(end)) {
    const suffixLength = Math.min(end, size);
    start = size - suffixLength;
    end = size - 1;
  } else {
    if (!Number.isFinite(start)) return null;
    if (!Number.isFinite(end)) end = size - 1;
  }

  if (start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
};

const cacheControlFor = (pathname) => {
  if (/^\/assets\/.*-[A-Za-z0-9_-]{8,}\./.test(pathname)) {
    return 'public, max-age=31536000, immutable';
  }
  if (pathname === '/' || pathname.endsWith('.html')) {
    return 'no-cache';
  }
  return 'public, max-age=3600';
};

const serveFile = (request, response, filePath, pathname) => {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    sendText(response, 404, 'Not found.');
    return;
  }
  if (!stats.isFile()) {
    sendText(response, 404, 'Not found.');
    return;
  }

  const contentType = MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
  const range = request.headers.range ? parseSingleRange(request.headers.range, stats.size) : null;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Cache-Control', cacheControlFor(pathname));
  response.setHeader('X-Content-Type-Options', 'nosniff');

  if (request.headers.range && !range) {
    response.statusCode = 416;
    response.setHeader('Content-Range', `bytes */${stats.size}`);
    response.end();
    return;
  }

  if (range) {
    response.statusCode = 206;
    response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stats.size}`);
    response.setHeader('Content-Length', range.end - range.start + 1);
  } else {
    response.statusCode = 200;
    response.setHeader('Content-Length', stats.size);
  }

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  const stream = fs.createReadStream(filePath, range || undefined);
  stream.on('error', () => {
    if (!response.headersSent) sendText(response, 500, 'Unable to read the requested file.');
    else response.destroy();
  });
  stream.pipe(response);
};

const proxyApiRequest = (request, response, apiHost, apiPort) => {
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1:5173');
  const headers = { ...request.headers };
  delete headers.authorization;
  delete headers.cookie;
  delete headers.host;
  headers.host = `${apiHost}:${apiPort}`;
  headers.origin = 'http://127.0.0.1:5173';
  headers['x-kaoyan-lan-proxy'] = '1';

  const upstream = http.request({
    host: apiHost,
    port: apiPort,
    method: request.method,
    path: `${requestUrl.pathname.slice(4) || '/'}${requestUrl.search}`,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  const upstreamTimeoutMs = /^\/api\/ai\/(?:widget|html-note)$/.test(requestUrl.pathname)
    ? 610_000
    : 30_000;
  upstream.setTimeout(upstreamTimeoutMs, () => upstream.destroy(new Error('Upstream request timed out.')));
  upstream.on('error', () => {
    if (!response.headersSent) sendText(response, 502, 'The local note service is unavailable.');
    else response.destroy();
  });
  request.pipe(upstream);
};

const proxySyncRequest = (request, response, apiHost, apiPort) => {
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1:5173');
  const headers = { ...request.headers };
  delete headers.cookie;
  delete headers.host;
  delete headers.origin;
  delete headers['x-kaoyan-lan-proxy'];
  headers.host = `${apiHost}:${apiPort}`;

  const upstream = http.request({
    host: apiHost,
    port: apiPort,
    method: request.method,
    path: `${requestUrl.pathname}${requestUrl.search}`,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(5 * 60_000, () => upstream.destroy(new Error('Sync upstream timed out.')));
  upstream.on('error', () => {
    if (!response.headersSent) sendText(response, 502, 'The local sync service is unavailable.');
    else response.destroy();
  });
  request.pipe(upstream);
};

const isLoopbackAddress = (value) => {
  const address = String(value || '').toLowerCase();
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
};

const createKaoyanWebServer = (options = {}) => {
  const staticRoot = path.resolve(options.staticRoot || DEFAULT_STATIC_ROOT);
  const staticRootPrefix = `${staticRoot}${path.sep}`;
  const apiHost = options.apiHost || DEFAULT_API_HOST;
  const apiPort = Number(options.apiPort || DEFAULT_API_PORT);
  const allowedHosts = options.allowedHosts || createAllowedHosts(os.networkInterfaces());
  const trustLoopbackIngress = options.trustLoopbackIngress === true;
  const mobileAuthManager = options.mobileAuthManager || (trustLoopbackIngress
    ? createMobileSessionManager({ configPath: options.mobileAuthConfigPath || process.env.KAOYAN_MOBILE_AUTH_CONFIG_PATH })
    : null);

  return http.createServer((request, response) => {
    applySecurityHeaders(response);
    const requestHost = String(request.headers.host || '').toLowerCase();
    const hostname = hostnameFromHostHeader(requestHost);
    const trustedIngress = trustLoopbackIngress && isLoopbackAddress(request.socket?.remoteAddress);
    const remoteBrowserIngress = trustedIngress && !allowedHosts.has(hostname);
    if (remoteBrowserIngress) applySecurityHeaders(response, true);
    if (!allowedHosts.has(hostname) && !trustedIngress) {
      sendText(response, 403, 'Host is not allowed.');
      return;
    }

    const origin = String(request.headers.origin || '');
    if (origin && origin !== 'null') {
      try {
        if (new URL(origin).host.toLowerCase() !== requestHost) throw new Error('Cross-origin request');
      } catch {
        sendText(response, 403, 'Origin is not allowed.');
        return;
      }
    }

    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1:5173');
    if (requestUrl.pathname.startsWith('/sync/v1/')) {
      if (origin || !['GET', 'HEAD', 'POST', 'PUT'].includes(request.method || 'GET')) {
        sendJson(response, 403, { ok: false, code: 'SYNC_INGRESS_REJECTED', error: 'Sync ingress is only available to registered device clients.' });
        return;
      }
      proxySyncRequest(request, response, apiHost, apiPort);
      return;
    }
    if (remoteBrowserIngress && requestUrl.pathname.startsWith('/api/auth/')) {
      void handleMobileAuthRoute(request, response, requestUrl, mobileAuthManager, origin).catch((error) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const status = Number(error?.statusCode)
          || (error?.code === 'PAYLOAD_TOO_LARGE' ? 413 : error?.code === 'INVALID_JSON' ? 400 : 500);
        if (error?.details?.retryAfterMs) response.setHeader('Retry-After', String(Math.max(1, Math.ceil(error.details.retryAfterMs / 1000))));
        sendJson(response, status, { ok: false, authenticated: false, code: error?.code || 'AUTH_FAILED', error: error?.message || '登录失败。' });
      });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
      sendJson(response, 200, { ok: true, service: 'kaoyan-web-gateway' });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/readyz') {
      void probeNoteService(apiHost, apiPort).then((ready) => {
        sendJson(response, ready ? 200 : 503, {
          ok: ready,
          service: 'kaoyan-web-gateway',
          dependencies: { noteService: ready ? 'ready' : 'unavailable' },
        });
      });
      return;
    }

    if (String(request.url || '').startsWith('/api')) {
      if (remoteBrowserIngress) {
        try {
          mobileAuthManager.requireSession(request);
        } catch (error) {
          sendJson(response, Number(error?.statusCode) || 401, {
            ok: false,
            authenticated: false,
            code: error?.code || 'AUTH_REQUIRED',
            error: error?.message || '请先登录这台 Mac mini。',
          });
          return;
        }
      }
      const remoteAddress = String(request.socket?.remoteAddress || '').toLowerCase();
      const isLoopback = remoteAddress === '::1'
        || remoteAddress === '127.0.0.1'
        || remoteAddress === '::ffff:127.0.0.1';
      const isLocalAiRequest = isLoopback
        && !requestUrl.search
        && request.method === 'POST'
        && ['/api/ai/widget', '/api/ai/html-note'].includes(requestUrl.pathname);
      if (!isLocalAiRequest && !isAllowedLanApiRoute(request.method || 'GET', request.url)) {
        response.statusCode = 403;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ ok: false, error: 'Only canvas and learning-data access is available over LAN.' }));
        return;
      }
      proxyApiRequest(request, response, apiHost, apiPort);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, 405, 'Method not allowed.');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname);
    } catch {
      sendText(response, 400, 'Malformed request path.');
      return;
    }

    const requestedPath = pathname === '/' ? '/index.html' : pathname;
    const resolvedPath = path.resolve(staticRoot, `.${requestedPath}`);
    if (resolvedPath !== staticRoot && !resolvedPath.startsWith(staticRootPrefix)) {
      sendText(response, 403, 'Path is not allowed.');
      return;
    }

    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
      serveFile(request, response, resolvedPath, pathname);
      return;
    }

    // All application screens use one HTML entry point; query parameters pick
    // the screen, while this fallback keeps future history routes functional.
    serveFile(request, response, path.join(staticRoot, 'index.html'), '/index.html');
  });
};

const start = () => {
  if (!fs.existsSync(path.join(DEFAULT_STATIC_ROOT, 'index.html'))) {
    process.stderr.write('Production assets are missing. Run node scripts/ensure-web-build.cjs first.\n');
    process.exitCode = 1;
    return;
  }

  const host = process.env.KAOYAN_WEB_HOST || DEFAULT_HOST;
  const port = Number(process.env.KAOYAN_WEB_PORT || DEFAULT_PORT);
  const apiPort = Number(process.env.KAOYAN_NOTE_PORT || DEFAULT_API_PORT);
  const server = createKaoyanWebServer({
    apiHost: DEFAULT_API_HOST,
    apiPort,
    trustLoopbackIngress: process.env.KAOYAN_TRUST_LOOPBACK_INGRESS === '1',
    mobileAuthConfigPath: process.env.KAOYAN_MOBILE_AUTH_CONFIG_PATH,
  });
  server.listen(port, host, () => {
    process.stdout.write(`Kaoyan production web server: http://127.0.0.1:${port}/\n`);
    process.stdout.write(`Kaoyan internal note upstream: http://${DEFAULT_API_HOST}:${apiPort}/\n`);
  });

  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
};

if (require.main === module) start();

module.exports = {
  DEFAULT_HOST,
  applySecurityHeaders,
  createKaoyanWebServer,
  parseSingleRange,
  probeNoteService,
};
