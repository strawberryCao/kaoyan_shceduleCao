const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./runtime-paths.cjs');

const MOBILE_AUTH_SCHEMA_VERSION = 1;
const SESSION_COOKIE_NAME = '__Host-kaoyan-session';
const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_FAILURE_KEYS = 512;

class MobileAuthError extends Error {
  constructor(code, message, statusCode = 401, details = {}) {
    super(message);
    this.name = 'MobileAuthError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function publicMobileAuthStatus(configPath) {
  const config = readMobileAuthConfig(configPath, { allowMissing: true });
  return {
    configured: Boolean(config),
    username: config?.username || '',
    sessionTtlDays: config ? Math.round(config.sessionTtlSeconds / 86_400) : 0,
    generation: Number(config?.generation) || 0,
    updatedAt: config?.updatedAt || null,
  };
}

function readMobileAuthConfig(configPath, options = {}) {
  const requestedPath = String(configPath || '').trim();
  if (!requestedPath) {
    if (options.allowMissing) return null;
    throw new MobileAuthError('AUTH_CONFIG_PATH_REQUIRED', '移动访问配置路径缺失。', 500);
  }
  const resolved = path.resolve(requestedPath);
  if (!fs.existsSync(resolved)) {
    if (options.allowMissing) return null;
    throw new MobileAuthError('AUTH_NOT_CONFIGURED', 'Mac 移动访问尚未配置。', 503);
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new MobileAuthError('AUTH_CONFIG_INVALID', `移动访问配置无法读取：${error.message}`, 500);
  }
  const schemaVersion = Number(config?.schemaVersion || 0);
  if (schemaVersion > MOBILE_AUTH_SCHEMA_VERSION) {
    throw new MobileAuthError('AUTH_CONFIG_TOO_NEW', `移动访问配置版本 ${schemaVersion} 高于当前程序支持的版本。`, 500);
  }
  if (schemaVersion !== MOBILE_AUTH_SCHEMA_VERSION
    || !/^[\p{L}\p{N}_.@-]{2,80}$/u.test(String(config?.username || ''))
    || !/^[a-f0-9]{32}$/i.test(String(config?.passwordSalt || ''))
    || !/^[a-f0-9]{64}$/i.test(String(config?.passwordHash || ''))
    || !/^[a-f0-9]{64}$/i.test(String(config?.sessionSecret || ''))) {
    throw new MobileAuthError('AUTH_CONFIG_INVALID', '移动访问配置格式无效。', 500);
  }
  return config;
}

function configureMobileAccess(configPath, input = {}) {
  const requestedPath = String(configPath || '').trim();
  if (!requestedPath) throw new MobileAuthError('AUTH_CONFIG_PATH_REQUIRED', '移动访问配置路径缺失。', 500);
  const resolved = path.resolve(requestedPath);
  const username = String(input.username || '').normalize('NFKC').trim();
  const password = String(input.password || '');
  if (!/^[\p{L}\p{N}_.@-]{2,80}$/u.test(username)) {
    throw new MobileAuthError('AUTH_USERNAME_INVALID', '用户名需要 2–80 个字符，只能包含文字、数字、点、横线、下划线或 @。', 400);
  }
  if (password.length < 10 || password.length > 256) {
    throw new MobileAuthError('AUTH_PASSWORD_INVALID', '访问密码至少需要 10 个字符。', 400);
  }
  const previous = readMobileAuthConfig(resolved, { allowMissing: true });
  const salt = crypto.randomBytes(16);
  const passwordHash = crypto.scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const sessionTtlSeconds = Math.max(
    60 * 60,
    Math.min(MAX_SESSION_TTL_SECONDS, Number(input.sessionTtlSeconds) || previous?.sessionTtlSeconds || DEFAULT_SESSION_TTL_SECONDS),
  );
  const timestamp = new Date().toISOString();
  const config = {
    schemaVersion: MOBILE_AUTH_SCHEMA_VERSION,
    username,
    passwordSalt: salt.toString('hex'),
    passwordHash: passwordHash.toString('hex'),
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    sessionTtlSeconds,
    generation: (Number(previous?.generation) || 0) + 1,
    createdAt: previous?.createdAt || timestamp,
    updatedAt: timestamp,
  };
  atomicWriteJson(resolved, config);
  try { fs.chmodSync(resolved, 0o600); } catch {}
  return publicMobileAuthStatus(resolved);
}

function removeMobileAccess(configPath) {
  const requestedPath = String(configPath || '').trim();
  if (!requestedPath) throw new MobileAuthError('AUTH_CONFIG_PATH_REQUIRED', '移动访问配置路径缺失。', 500);
  const resolved = path.resolve(requestedPath);
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { force: true });
  return { configured: false, username: '', sessionTtlDays: 0, generation: 0, updatedAt: null };
}

function timingSafeHex(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'hex');
  const rightBuffer = Buffer.from(String(right || ''), 'hex');
  return leftBuffer.length === rightBuffer.length
    && leftBuffer.length > 0
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function headerValue(request, name) {
  if (request?.headers && typeof request.headers.get === 'function') return request.headers.get(name) || '';
  return String(request?.headers?.[name.toLowerCase()] || '');
}

function cookieValue(request) {
  const cookie = headerValue(request, 'cookie');
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) return part.slice(separator + 1).trim();
  }
  return '';
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(config, payload) {
  return crypto.createHmac('sha256', Buffer.from(config.sessionSecret, 'hex')).update(payload).digest('base64url');
}

function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function createMobileSessionManager(options = {}) {
  const requestedPath = String(options.configPath || '').trim();
  const configPath = requestedPath ? path.resolve(requestedPath) : '';
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const failures = new Map();
  let globalFailure = { attempts: 0, blockedUntil: 0 };

  function status() {
    return publicMobileAuthStatus(configPath);
  }

  function login(username, password, clientKey = 'unknown', loginOptions = {}) {
    const config = readMobileAuthConfig(configPath);
    const key = String(clientKey || 'unknown').slice(0, 180);
    const failure = failures.get(key);
    const currentTime = now();
    const blockedUntil = Math.max(Number(failure?.blockedUntil) || 0, globalFailure.blockedUntil);
    if (blockedUntil > currentTime) {
      const retryAfterMs = blockedUntil - currentTime;
      throw new MobileAuthError('AUTH_THROTTLED', '登录尝试过于频繁，请稍后再试。', 429, { retryAfterMs });
    }
    const derived = crypto.scryptSync(String(password || ''), Buffer.from(config.passwordSalt, 'hex'), 32, {
      N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
    });
    const usernameHash = crypto.createHash('sha256').update(String(username || '')).digest('hex');
    const expectedUsernameHash = crypto.createHash('sha256').update(config.username).digest('hex');
    const valid = timingSafeHex(derived.toString('hex'), config.passwordHash)
      && timingSafeHex(usernameHash, expectedUsernameHash);
    if (!valid) {
      const attempts = (Number(failure?.attempts) || 0) + 1;
      const delay = attempts < 3 ? 0 : Math.min(30_000, 1_000 * (2 ** Math.min(5, attempts - 3)));
      if (!failures.has(key) && failures.size >= MAX_FAILURE_KEYS) {
        failures.delete(failures.keys().next().value);
      }
      failures.set(key, { attempts, blockedUntil: currentTime + delay });
      const globalAttempts = globalFailure.attempts + 1;
      const globalDelay = globalAttempts < 8 ? 0 : Math.min(60_000, 2_000 * (2 ** Math.min(5, globalAttempts - 8)));
      globalFailure = { attempts: globalAttempts, blockedUntil: currentTime + globalDelay };
      const retryAfterMs = Math.max(delay, globalDelay);
      throw new MobileAuthError('AUTH_INVALID', '用户名或密码不正确。', 401, retryAfterMs ? { retryAfterMs } : {});
    }
    failures.delete(key);
    globalFailure = { attempts: 0, blockedUntil: 0 };
    const issuedAt = Math.floor(currentTime / 1000);
    const requestedTtl = Number(loginOptions.sessionTtlSeconds);
    const sessionTtlSeconds = Number.isFinite(requestedTtl)
      ? Math.max(60 * 60, Math.min(MAX_SESSION_TTL_SECONDS, Math.round(requestedTtl)))
      : Math.max(60 * 60, Math.min(MAX_SESSION_TTL_SECONDS, Number(config.sessionTtlSeconds) || DEFAULT_SESSION_TTL_SECONDS));
    const payload = encode(JSON.stringify({
      version: 1,
      username: config.username,
      generation: config.generation,
      issuedAt,
      expiresAt: issuedAt + sessionTtlSeconds,
      nonce: crypto.randomBytes(12).toString('base64url'),
    }));
    const token = `${payload}.${sign(config, payload)}`;
    return {
      username: config.username,
      expiresAt: new Date((issuedAt + sessionTtlSeconds) * 1000).toISOString(),
      cookie: sessionCookie(token, sessionTtlSeconds),
    };
  }

  function readSession(request) {
    const config = readMobileAuthConfig(configPath);
    const token = cookieValue(request);
    const separator = token.lastIndexOf('.');
    if (separator < 1) return null;
    const payload = token.slice(0, separator);
    const supplied = token.slice(separator + 1);
    const expected = sign(config, payload);
    const suppliedHash = crypto.createHash('sha256').update(supplied).digest('hex');
    const expectedHash = crypto.createHash('sha256').update(expected).digest('hex');
    if (!timingSafeHex(suppliedHash, expectedHash)) return null;
    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (session?.version !== 1
        || session.username !== config.username
        || Number(session.generation) !== Number(config.generation)
        || !Number.isFinite(session.expiresAt)
        || session.expiresAt <= Math.floor(now() / 1000)) return null;
      return { username: session.username, expiresAt: new Date(session.expiresAt * 1000).toISOString() };
    } catch {
      return null;
    }
  }

  function requireSession(request) {
    const session = readSession(request);
    if (!session) throw new MobileAuthError('AUTH_REQUIRED', '请先登录这台 Mac mini。', 401);
    return session;
  }

  return {
    status,
    login,
    readSession,
    requireSession,
    logoutCookie: () => sessionCookie('', 0),
  };
}

module.exports = {
  DEFAULT_SESSION_TTL_SECONDS,
  MOBILE_AUTH_SCHEMA_VERSION,
  MobileAuthError,
  SESSION_COOKIE_NAME,
  configureMobileAccess,
  createMobileSessionManager,
  publicMobileAuthStatus,
  readMobileAuthConfig,
  removeMobileAccess,
};
