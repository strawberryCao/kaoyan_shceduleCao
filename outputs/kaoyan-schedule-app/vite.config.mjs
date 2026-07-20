import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import os from 'node:os';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const lanHosts = new Set(loopbackHosts);
for (const entries of Object.values(os.networkInterfaces())) {
  for (const entry of entries || []) {
    if (entry?.family === 'IPv4' && !entry.internal) lanHosts.add(entry.address.toLowerCase());
  }
}

const hostnameFromHostHeader = (hostHeader = '') => {
  const normalized = String(hostHeader).trim().toLowerCase();
  if (normalized.startsWith('[')) return normalized.slice(1, normalized.indexOf(']'));
  return normalized.split(':')[0];
};

const isAllowedLanApiRoute = (method, requestUrl) => {
  const url = new URL(requestUrl || '/', 'http://127.0.0.1:5173');
  if (method === 'GET' && url.pathname === '/api/note-file') {
    const keys = [...url.searchParams.keys()];
    return keys.length === 1 && keys[0] === 'path' && Boolean(url.searchParams.get('path'));
  }
  if (url.search) return false;
  if (method === 'GET' && url.pathname === '/api/canvas-projects') return true;
  if (method === 'GET' && url.pathname === '/api/canvas-projects/events') return true;
  if (method === 'POST' && /^\/api\/canvas-projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/live-stroke$/.test(url.pathname)) return true;
  if (method === 'POST' && url.pathname === '/api/save-note') return true;
  if (method === 'GET' && (url.pathname === '/api/learning-data' || url.pathname === '/api/learning-data/events')) return true;
  if (method === 'POST' && (url.pathname === '/api/learning-data/notes' || url.pathname === '/api/learning-data/cards')) return true;
  if (method === 'PATCH' && url.pathname === '/api/learning-data/day') return true;
  if (method === 'PUT' && url.pathname === '/api/learning-data/manual-records') return true;
  if (method === 'POST' && /^\/api\/learning-data\/notes\/[^/]+\/restore$/.test(url.pathname)) return true;
  if ((method === 'PATCH' || method === 'DELETE') && /^\/api\/learning-data\/(?:notes|cards)\/[^/]+$/.test(url.pathname)) return true;
  return (method === 'GET' || method === 'PUT' || method === 'DELETE')
    && /^\/api\/canvas-projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(url.pathname);
};

const lanGatewayGuard = () => ({
  name: 'kaoyan-lan-gateway-guard',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const requestHost = String(req.headers.host || '').toLowerCase();
      const hostname = hostnameFromHostHeader(requestHost);
      if (!lanHosts.has(hostname)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Host is not allowed.');
        return;
      }

      const origin = String(req.headers.origin || '');
      if (origin && origin !== 'null') {
        try {
          if (new URL(origin).host.toLowerCase() !== requestHost) throw new Error('Cross-origin request');
        } catch {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Origin is not allowed.');
          return;
        }
      }

      if (String(req.url || '').startsWith('/api') && !isAllowedLanApiRoute(req.method || 'GET', req.url)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: 'Only canvas and learning-data access is available over LAN.' }));
        return;
      }
      next();
    });
  },
});

export default defineConfig({
  base: './',
  plugins: [lanGatewayGuard(), react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    cors: false,
    fs: { strict: true },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5174',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyRequest) => {
            // The note service stays loopback-only and trusts LAN traffic only
            // when it arrives through this route-limited same-origin gateway.
            proxyRequest.setHeader('x-kaoyan-lan-proxy', '1');
            proxyRequest.setHeader('origin', 'http://127.0.0.1:5173');
            proxyRequest.removeHeader('authorization');
            proxyRequest.removeHeader('cookie');
          });
        },
      },
    },
  },
});
