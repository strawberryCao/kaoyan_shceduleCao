import { HttpError, json } from './http.js';

const SESSION_COOKIE = '__Host-kaoyan-session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function configuredCredential(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value : '';
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const normalized = String(value || '').replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function timingSafeEqual(left, right) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(String(left));
  const rightBytes = encoder.encode(String(right));
  const sameLength = leftBytes.byteLength === rightBytes.byteLength;
  const compareLeft = sameLength ? leftBytes : rightBytes;
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', compareLeft),
    crypto.subtle.digest('SHA-256', rightBytes),
  ]);
  const a = new Uint8Array(leftDigest);
  const b = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return sameLength && difference === 0;
}

function signingSecret(env) {
  return configuredCredential(env, 'SESSION_SECRET') || configuredCredential(env, 'APP_PASSWORD');
}

async function signature(env, payload) {
  const secret = signingSecret(env);
  if (!secret) throw new HttpError(503, 'Cloud login is not configured.', 'AUTH_NOT_CONFIGURED');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`kaoyan-session-v1\0${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
}

function cookieValue(request) {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return '';
}

async function issueSession(env, username) {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    version: 1,
    username,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  })));
  return `${payload}.${await signature(env, payload)}`;
}

async function readSession(request, env) {
  const token = cookieValue(request);
  const separator = token.lastIndexOf('.');
  if (separator < 1) return null;
  const payload = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  const expectedSignature = await signature(env, payload);
  if (!(await timingSafeEqual(suppliedSignature, expectedSignature))) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    if (session?.version !== 1 || typeof session.username !== 'string') return null;
    if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    if (!(await timingSafeEqual(session.username, configuredCredential(env, 'APP_USERNAME')))) return null;
    return session;
  } catch {
    return null;
  }
}

function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export async function requireSession(request, env) {
  if (!configuredCredential(env, 'APP_USERNAME') || !configuredCredential(env, 'APP_PASSWORD')) {
    return json({ ok: false, authenticated: false, code: 'AUTH_NOT_CONFIGURED', error: 'Cloud login is not configured.' }, 503);
  }
  if (await readSession(request, env)) return null;
  return json({ ok: false, authenticated: false, code: 'AUTH_REQUIRED', error: 'Please sign in to access study data.' }, 401);
}

export async function handleAuthRoute(request, env, pathname, readJson) {
  if (request.method === 'GET' && pathname === '/auth/status') {
    const session = await readSession(request, env);
    return json({
      ok: true,
      authenticated: Boolean(session),
      username: session?.username || '',
      dedicatedSessionSecret: Boolean(configuredCredential(env, 'SESSION_SECRET')),
    });
  }
  if (request.method === 'POST' && pathname === '/auth/login') {
    const payload = await readJson(request, 16 * 1024);
    const username = typeof payload.username === 'string' ? payload.username : '';
    const password = typeof payload.password === 'string' ? payload.password : '';
    const expectedUsername = configuredCredential(env, 'APP_USERNAME');
    const expectedPassword = configuredCredential(env, 'APP_PASSWORD');
    if (!expectedUsername || !expectedPassword) {
      throw new HttpError(503, 'Cloud login is not configured.', 'AUTH_NOT_CONFIGURED');
    }
    const [validUsername, validPassword] = await Promise.all([
      timingSafeEqual(username, expectedUsername),
      timingSafeEqual(password, expectedPassword),
    ]);
    if (!validUsername || !validPassword) {
      throw new HttpError(401, 'Username or password is incorrect.', 'AUTH_INVALID');
    }
    const token = await issueSession(env, expectedUsername);
    return json({ ok: true, authenticated: true, username: expectedUsername }, 200, {
      'Set-Cookie': sessionCookie(token, SESSION_TTL_SECONDS),
    });
  }
  if (request.method === 'POST' && pathname === '/auth/logout') {
    return json({ ok: true, authenticated: false }, 200, {
      'Set-Cookie': sessionCookie('', 0),
    });
  }
  return null;
}

export const authInternals = Object.freeze({
  cookieName: SESSION_COOKIE,
  sessionTtlSeconds: SESSION_TTL_SECONDS,
});
