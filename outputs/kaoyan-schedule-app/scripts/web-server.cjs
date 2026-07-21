const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  createAllowedHosts,
  hostnameFromHostHeader,
  isAllowedLanApiRoute,
} = require('./lan-gateway-policy.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_STATIC_ROOT = path.join(PROJECT_ROOT, 'dist');
const DEFAULT_HOST = '0.0.0.0';
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

const sendText = (response, statusCode, body) => {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
};

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

  upstream.setTimeout(30_000, () => upstream.destroy(new Error('Upstream request timed out.')));
  upstream.on('error', () => {
    if (!response.headersSent) sendText(response, 502, 'The local note service is unavailable.');
    else response.destroy();
  });
  request.pipe(upstream);
};

const createKaoyanWebServer = (options = {}) => {
  const staticRoot = path.resolve(options.staticRoot || DEFAULT_STATIC_ROOT);
  const staticRootPrefix = `${staticRoot}${path.sep}`;
  const apiHost = options.apiHost || DEFAULT_API_HOST;
  const apiPort = Number(options.apiPort || DEFAULT_API_PORT);
  const allowedHosts = options.allowedHosts || createAllowedHosts(os.networkInterfaces());

  return http.createServer((request, response) => {
    const requestHost = String(request.headers.host || '').toLowerCase();
    const hostname = hostnameFromHostHeader(requestHost);
    if (!allowedHosts.has(hostname)) {
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

    if (String(request.url || '').startsWith('/api')) {
      if (!isAllowedLanApiRoute(request.method || 'GET', request.url)) {
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
  const server = createKaoyanWebServer();
  server.listen(port, host, () => {
    process.stdout.write(`Kaoyan production web server: http://127.0.0.1:${port}/\n`);
  });

  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
};

if (require.main === module) start();

module.exports = {
  createKaoyanWebServer,
  parseSingleRange,
};
