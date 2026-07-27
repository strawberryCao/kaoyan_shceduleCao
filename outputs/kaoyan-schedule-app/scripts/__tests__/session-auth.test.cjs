'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('cloud auth uses an HttpOnly session cookie and never exposes credentials to browser storage', async () => {
  const { handleAuthRoute, requireSession } = await import('../../cloudflare/auth.js');
  const env = { APP_USERNAME: 'student', APP_PASSWORD: 'secret', SESSION_SECRET: 'unit-test-session-secret' };
  const readJson = async (request) => request.json();
  const login = await handleAuthRoute(new Request('https://example.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'student', password: 'secret' }),
  }), env, '/auth/login', readJson);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /__Host-kaoyan-session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.equal(cookie.includes('secret'), false);

  const cookieHeader = cookie.split(';')[0];
  const authenticated = await requireSession(new Request('https://example.test/api/entries', {
    headers: { Cookie: cookieHeader },
  }), env);
  assert.equal(authenticated, null);
  const anonymous = await requireSession(new Request('https://example.test/api/entries'), env);
  assert.equal(anonymous.status, 401);
});
