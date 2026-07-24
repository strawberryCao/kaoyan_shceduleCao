export class HttpError extends Error {
  constructor(status, message, code, details = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const NOTE_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif']);

function normalizedStoredPath(value) {
  return typeof value === 'string' ? value.trim().replaceAll('\\', '/') : '';
}

function isRemoteNoteAssetPath(value) {
  const normalized = normalizedStoredPath(value);
  return normalized.startsWith('github://data/assets/')
    || normalized.startsWith('data/assets/')
    || normalized.startsWith('r2://note-assets/');
}

function publicNoteAssetPath(noteUid, value) {
  const normalized = normalizedStoredPath(value);
  if (!normalized || isRemoteNoteAssetPath(normalized)) return normalized;
  const safeUid = typeof noteUid === 'string' ? noteUid.replace(/[^A-Za-z0-9._-]/g, '') : '';
  if (!safeUid) return normalized;
  const match = /\.([A-Za-z0-9]+)(?:[?#].*)?$/.exec(normalized);
  const extension = match?.[1]?.toLowerCase() || 'png';
  const safeExtension = NOTE_IMAGE_EXTENSIONS.has(extension) ? extension : 'png';
  return `github://data/assets/${safeUid}.${safeExtension}`;
}

function normalizePublicPayload(value, seen = new WeakMap()) {
  if (Array.isArray(value)) return value.map((item) => normalizePublicPayload(item, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  const normalized = {};
  seen.set(value, normalized);
  for (const [key, item] of Object.entries(value)) {
    normalized[key] = normalizePublicPayload(item, seen);
  }

  const noteUid = typeof normalized.noteUid === 'string' ? normalized.noteUid : '';
  if (noteUid) {
    if (Object.prototype.hasOwnProperty.call(normalized, 'filePath')) {
      normalized.filePath = publicNoteAssetPath(noteUid, normalized.filePath);
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'sourceFilePath')) {
      normalized.sourceFilePath = publicNoteAssetPath(noteUid, normalized.sourceFilePath);
    }
    if (
      typeof normalized.subject === 'string'
      && normalized.subject.trim().toLowerCase() === 'assets'
      && normalized.classificationSource !== 'manual'
    ) {
      normalized.subject = '默认文件夹';
      if (Array.isArray(normalized.knowledgePath)) {
        normalized.knowledgePath = [
          '默认文件夹',
          ...normalized.knowledgePath.filter((item) => typeof item === 'string' && item.trim().toLowerCase() !== 'assets' && item !== '默认文件夹'),
        ].slice(0, 3);
      }
      if (normalized.reviewStatus !== 'ignored') normalized.reviewStatus = 'pending';
      if (normalized.organizationStatus !== 'ignored') normalized.organizationStatus = 'pending';
    }
  }

  return normalized;
}

export function json(data, status = 200, extraHeaders = {}) {
  return Response.json(normalizePublicPayload(data), {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      ...extraHeaders,
    },
  });
}

export async function readJson(request, maxBytes = 24 * 1024 * 1024) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'Request payload is too large', 'PAYLOAD_TOO_LARGE');
  }
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, 'Request payload is too large', 'PAYLOAD_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON', 'INVALID_JSON');
  }
}

function decodeBasic(header) {
  if (!header?.startsWith('Basic ')) return null;
  try {
    const raw = atob(header.slice(6).trim());
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return [decoded.slice(0, separator), decoded.slice(separator + 1)];
  } catch {
    return null;
  }
}

async function timingSafeEqual(left, right) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const sameLength = leftBytes.byteLength === rightBytes.byteLength;
  const compareLeft = sameLength ? leftBytes : rightBytes;
  const timingSafe = crypto.subtle.timingSafeEqual;
  if (typeof timingSafe === 'function') {
    const equal = timingSafe.call(crypto.subtle, compareLeft, rightBytes);
    return sameLength && equal;
  }

  // Node's Web Crypto test runtime does not expose the Workers extension.
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

export async function requireBasicAuth(request, env) {
  const expectedUsername = typeof env.APP_USERNAME === 'string' ? env.APP_USERNAME : '';
  const expectedPassword = typeof env.APP_PASSWORD === 'string' ? env.APP_PASSWORD : '';
  if (!expectedUsername || !expectedPassword) {
    return json({
      ok: false,
      code: 'AUTH_NOT_CONFIGURED',
      error: 'Cloud access is locked until APP_USERNAME and APP_PASSWORD are configured.',
    }, 503);
  }

  const supplied = decodeBasic(request.headers.get('authorization'));
  const username = supplied?.[0] ?? '';
  const password = supplied?.[1] ?? '';
  const [validUsername, validPassword] = await Promise.all([
    timingSafeEqual(username, expectedUsername),
    timingSafeEqual(password, expectedPassword),
  ]);
  if (!validUsername || !validPassword) {
    return json({ ok: false, code: 'AUTH_REQUIRED', error: 'Authentication required.' }, 401, {
      'WWW-Authenticate': 'Basic realm="Kaoyan Study Center", charset="UTF-8"',
    });
  }
  return null;
}

export async function sha256(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function handleError(error) {
  if (error instanceof HttpError) {
    return json({
      ok: false,
      code: error.code,
      error: error.message,
      ...error.details,
    }, error.status);
  }
  console.error(JSON.stringify({
    level: 'error',
    event: 'request_failed',
    error: error instanceof Error ? error.message : String(error),
  }));
  return json({ ok: false, code: 'INTERNAL_ERROR', error: 'Cloud data service failed.' }, 500);
}
