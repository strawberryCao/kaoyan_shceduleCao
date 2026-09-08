'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  configureMobileAccess,
  createMobileSessionManager,
  publicMobileAuthStatus,
  readMobileAuthConfig,
} = require('../mobile-session-auth.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-mobile-auth-'));
  const configPath = path.join(root, 'secrets', 'mobile-access.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, configPath };
}

function requestWithCookie(cookie) {
  return { headers: { cookie: cookie.split(';')[0] } };
}

test('mobile access stores only password derivation material and issues an HttpOnly session', (t) => {
  const { configPath } = fixture(t);
  const password = 'correct horse battery staple';
  const status = configureMobileAccess(configPath, { username: 'caobiji', password });
  assert.equal(status.configured, true);
  const raw = fs.readFileSync(configPath, 'utf8');
  assert.equal(raw.includes(password), false);
  const config = readMobileAuthConfig(configPath);
  assert.match(config.passwordHash, /^[a-f0-9]{64}$/);
  assert.match(config.sessionSecret, /^[a-f0-9]{64}$/);

  const manager = createMobileSessionManager({ configPath });
  const login = manager.login('caobiji', password, 'device-one');
  assert.match(login.cookie, /__Host-kaoyan-session=/);
  assert.match(login.cookie, /HttpOnly/);
  assert.match(login.cookie, /Secure/);
  assert.match(login.cookie, /SameSite=Strict/);
  assert.equal(login.cookie.includes(password), false);
  assert.equal(manager.requireSession(requestWithCookie(login.cookie)).username, 'caobiji');
  assert.equal(manager.readSession({ headers: {} }), null);
});

test('rotating mobile access invalidates old sessions without exposing a secret in status', (t) => {
  const { configPath } = fixture(t);
  configureMobileAccess(configPath, { username: 'caobiji', password: 'first-password-123' });
  const manager = createMobileSessionManager({ configPath });
  const previous = manager.login('caobiji', 'first-password-123').cookie;
  configureMobileAccess(configPath, { username: 'caobiji', password: 'second-password-456' });
  assert.equal(manager.readSession(requestWithCookie(previous)), null);
  const status = publicMobileAuthStatus(configPath);
  assert.deepEqual(Object.keys(status).sort(), ['configured', 'generation', 'sessionTtlDays', 'updatedAt', 'username']);
  assert.equal(JSON.stringify(status).includes('passwordHash'), false);
  assert.equal(status.generation, 2);
});

test('login failures are throttled after repeated attempts', (t) => {
  const { configPath } = fixture(t);
  let clock = Date.now();
  configureMobileAccess(configPath, { username: 'student', password: 'right-password-123' });
  const manager = createMobileSessionManager({ configPath, now: () => clock });
  assert.throws(() => manager.login('student', 'wrong-password', 'same-device'), (error) => error.code === 'AUTH_INVALID');
  assert.throws(() => manager.login('student', 'wrong-password', 'same-device'), (error) => error.code === 'AUTH_INVALID');
  assert.throws(() => manager.login('student', 'wrong-password', 'same-device'), (error) => error.code === 'AUTH_INVALID' && error.details.retryAfterMs === 1000);
  assert.throws(() => manager.login('student', 'right-password-123', 'same-device'), (error) => error.code === 'AUTH_THROTTLED');
  clock += 1001;
  assert.equal(manager.login('student', 'right-password-123', 'same-device').username, 'student');
});

test('global throttling cannot be bypassed by rotating a forwarded client address', (t) => {
  const { configPath } = fixture(t);
  let clock = Date.now();
  configureMobileAccess(configPath, { username: 'student', password: 'right-password-123' });
  const manager = createMobileSessionManager({ configPath, now: () => clock });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.throws(
      () => manager.login('student', 'wrong-password', `spoofed-${attempt}`),
      (error) => error.code === 'AUTH_INVALID',
    );
  }
  assert.throws(
    () => manager.login('student', 'right-password-123', 'new-address'),
    (error) => error.code === 'AUTH_THROTTLED' && error.statusCode === 429,
  );
  clock += 2_001;
  assert.equal(manager.login('student', 'right-password-123', 'new-address').username, 'student');
});

test('future mobile auth configuration is rejected without downgrade', (t) => {
  const { configPath } = fixture(t);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 99, username: 'future' }));
  assert.throws(() => configureMobileAccess(configPath, { username: 'student', password: 'new-password-123' }), (error) => error.code === 'AUTH_CONFIG_TOO_NEW');
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).schemaVersion, 99);
});
