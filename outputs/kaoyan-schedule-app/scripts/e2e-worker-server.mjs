import http from 'node:http';
import { handleAuthRoute, requireSession } from '../cloudflare/auth.js';
import { handleError, HttpError, json, readJson } from '../cloudflare/http.js';

const env = {
  APP_USERNAME: 'caobiji',
  APP_PASSWORD: 'e2e-password',
  SESSION_SECRET: 'e2e-session-secret-at-least-thirty-two-characters',
  PUBLIC_READ_ENABLED: 'false',
  GITHUB_OWNER: 'test-owner',
  GITHUB_REPO: 'test-data',
  GITHUB_BRANCH: 'main',
};

const server = http.createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://127.0.0.1:8787${incoming.url || '/'}`, {
      method: incoming.method,
      headers: incoming.headers,
      body,
    });
    const pathname = new URL(request.url).pathname.replace(/^\/api/, '') || '/';
    let response = await handleAuthRoute(request, env, pathname, readJson);
    if (!response) response = await requireSession(request, env);
    if (!response && request.method === 'DELETE') {
      throw new HttpError(405, '云端不允许发起删除。请在 Windows 本地笔记目录归档或删除。', 'CLOUD_DELETE_DISABLED');
    }
    if (!response) response = json({ ok: true });
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const response = handleError(error);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  }
});

server.listen(8787, '127.0.0.1', () => {
  console.log('E2E Worker adapter: http://127.0.0.1:8787');
});

export { server };
export async function close() {
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
