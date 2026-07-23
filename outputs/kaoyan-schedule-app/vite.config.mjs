import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import os from 'node:os';
import gatewayPolicy from './scripts/lan-gateway-policy.cjs';

const { createAllowedHosts, hostnameFromHostHeader, isAllowedLanApiRoute } = gatewayPolicy;
const lanHosts = createAllowedHosts(os.networkInterfaces());

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
