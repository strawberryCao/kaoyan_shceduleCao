import { HttpError } from './http.js';

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';
const DEFAULT_OWNER = 'strawberryCao';
const DEFAULT_REPO = 'Caobijidata';
const DEFAULT_BRANCH = 'main';
const MAX_ERROR_BYTES = 32 * 1024;

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function repositoryConfig(env) {
  const owner = text(env.GITHUB_OWNER, DEFAULT_OWNER);
  const repo = text(env.GITHUB_REPO, DEFAULT_REPO);
  const branch = text(env.GITHUB_BRANCH, DEFAULT_BRANCH);
  const token = text(env.GITHUB_TOKEN);
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new HttpError(500, 'GitHub repository configuration is invalid.', 'GITHUB_CONFIG_INVALID');
  }
  if (!branch || /[\u0000-\u001f\u007f]/.test(branch)) {
    throw new HttpError(500, 'GitHub branch configuration is invalid.', 'GITHUB_CONFIG_INVALID');
  }
  if (!token) {
    throw new HttpError(503, 'GitHub write access is not configured.', 'GITHUB_NOT_CONFIGURED');
  }
  return { owner, repo, branch, token };
}

function encodeRepoPath(path) {
  const normalized = assertRepoPath(path);
  return normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

export function assertRepoPath(path, prefix = '') {
  const normalized = typeof path === 'string' ? path.trim().replaceAll('\\', '/').replace(/^\/+/, '') : '';
  if (!normalized || normalized.includes('\0') || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new HttpError(400, 'Repository path is invalid.', 'GITHUB_PATH_INVALID');
  }
  if (prefix && !normalized.startsWith(prefix)) {
    throw new HttpError(403, 'Repository path is outside the allowed area.', 'GITHUB_PATH_FORBIDDEN');
  }
  return normalized;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || '').replace(/\s+/g, ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new TextEncoder().encode(String(value));
}

async function boundedText(response, maxBytes = MAX_ERROR_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return '';
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) return '';
  return new TextDecoder().decode(buffer);
}

function githubError(status, body, fallbackCode = 'GITHUB_API_FAILED') {
  const message = typeof body?.message === 'string' ? body.message : 'GitHub API request failed.';
  if (status === 401 || status === 403) {
    return new HttpError(503, 'GitHub authentication or repository permission failed.', 'GITHUB_AUTH_FAILED');
  }
  if (status === 404) return new HttpError(404, 'GitHub repository object was not found.', 'GITHUB_OBJECT_NOT_FOUND');
  if (status === 409 || status === 422) {
    return new HttpError(409, 'GitHub repository changed while saving; reload and retry.', 'GITHUB_REVISION_CONFLICT');
  }
  if (status === 429) return new HttpError(429, 'GitHub API rate limit was reached.', 'GITHUB_RATE_LIMITED');
  return new HttpError(502, message, fallbackCode);
}

async function githubRequest(env, endpoint, options = {}) {
  const config = repositoryConfig(env);
  const response = await fetch(`${GITHUB_API}${endpoint}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.token}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'kaoyan-study-center-worker',
      ...(options.headers || {}),
    },
  });
  if (response.status === 404 && options.allow404) return null;
  if (!response.ok) {
    const raw = await boundedText(response);
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch {}
    throw githubError(response.status, body);
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function getBranchHead(env) {
  const { owner, repo, branch } = repositoryConfig(env);
  const result = await githubRequest(env, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const sha = result?.object?.sha;
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/i.test(sha)) {
    throw new HttpError(502, 'GitHub branch head is unavailable.', 'GITHUB_BRANCH_UNAVAILABLE');
  }
  return sha;
}

export async function readFileMetadata(env, path, options = {}) {
  const { owner, repo, branch } = repositoryConfig(env);
  const ref = text(options.ref, branch);
  const encoded = encodeRepoPath(path);
  const result = await githubRequest(
    env,
    `/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
    { allow404: options.allowMissing === true },
  );
  if (!result) return null;
  if (Array.isArray(result) || result.type !== 'file' || typeof result.sha !== 'string') {
    throw new HttpError(502, 'GitHub path is not a regular file.', 'GITHUB_OBJECT_INVALID');
  }
  return result;
}

function rawFileUrl(env, path, ref) {
  const { owner, repo, branch } = repositoryConfig(env);
  const revision = text(ref, branch);
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(revision)}/${encodeRepoPath(path)}`;
}

async function readRawBytes(env, path, ref, maxBytes) {
  const response = await fetch(rawFileUrl(env, path, ref), {
    headers: { 'User-Agent': 'kaoyan-study-center-worker' },
    redirect: 'follow',
  });
  if (!response.ok) {
    if (response.status === 404) throw new HttpError(404, 'GitHub repository file was not found.', 'GITHUB_OBJECT_NOT_FOUND');
    throw new HttpError(502, 'GitHub raw file could not be loaded.', 'GITHUB_RAW_READ_FAILED');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'GitHub repository file is too large.', 'GITHUB_FILE_TOO_LARGE');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new HttpError(413, 'GitHub repository file is too large.', 'GITHUB_FILE_TOO_LARGE');
  return bytes;
}

export async function readFile(env, path, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 24 * 1024 * 1024;
  const ref = text(options.ref, repositoryConfig(env).branch);
  const metadata = await readFileMetadata(env, path, { ref, allowMissing: options.allowMissing });
  if (!metadata) return null;
  let bytes;
  if (metadata.encoding === 'base64' && typeof metadata.content === 'string' && metadata.content.trim()) {
    bytes = base64ToBytes(metadata.content);
    if (bytes.byteLength > maxBytes) throw new HttpError(413, 'GitHub repository file is too large.', 'GITHUB_FILE_TOO_LARGE');
  } else {
    bytes = await readRawBytes(env, path, ref, maxBytes);
  }
  return { path: assertRepoPath(path), sha: metadata.sha, size: Number(metadata.size) || bytes.byteLength, bytes };
}

export async function readJsonFile(env, path, options = {}) {
  const file = await readFile(env, path, options);
  if (!file) return null;
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(file.bytes).replace(/^\uFEFF/, ''));
  } catch {
    throw new HttpError(502, 'GitHub repository JSON is invalid.', 'GITHUB_JSON_INVALID');
  }
  return { ...file, value };
}

async function createBlob(env, bytes) {
  const { owner, repo } = repositoryConfig(env);
  const result = await githubRequest(env, `/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: bytesToBase64(bytes), encoding: 'base64' }),
  });
  if (typeof result?.sha !== 'string') throw new HttpError(502, 'GitHub blob creation failed.', 'GITHUB_BLOB_FAILED');
  return result.sha;
}

export async function commitFiles(env, options) {
  const files = Array.isArray(options?.files) ? options.files : [];
  if (files.length < 1 || files.length > 100) {
    throw new HttpError(500, 'A GitHub commit must contain between 1 and 100 files.', 'GITHUB_COMMIT_INVALID');
  }
  const { owner, repo, branch } = repositoryConfig(env);
  const currentHead = await getBranchHead(env);
  if (options.expectedHeadSha && options.expectedHeadSha !== currentHead) {
    throw new HttpError(409, 'GitHub repository changed while saving; reload and retry.', 'GITHUB_REVISION_CONFLICT');
  }
  const baseCommit = await githubRequest(env, `/repos/${owner}/${repo}/git/commits/${currentHead}`);
  const baseTree = baseCommit?.tree?.sha;
  if (typeof baseTree !== 'string') throw new HttpError(502, 'GitHub base tree is unavailable.', 'GITHUB_BRANCH_UNAVAILABLE');
  const tree = [];
  for (const file of files) {
    const path = assertRepoPath(file.path);
    if (file.delete === true) {
      tree.push({ path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const sha = await createBlob(env, toBytes(file.content));
    tree.push({ path, mode: '100644', type: 'blob', sha });
  }
  const treeResult = await githubRequest(env, `/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_tree: baseTree, tree }),
  });
  const commitResult = await githubRequest(env, `/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: text(options.message, 'cloud: update study data').slice(0, 240),
      tree: treeResult.sha,
      parents: [currentHead],
    }),
  });
  await githubRequest(env, `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: commitResult.sha, force: false }),
  });
  return { commitSha: commitResult.sha, previousHeadSha: currentHead };
}

export async function writeJsonFile(env, path, value, options = {}) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const head = await getBranchHead(env);
    const current = await readFileMetadata(env, path, { ref: head, allowMissing: true });
    if (options.createOnly && current) {
      throw new HttpError(409, 'GitHub repository file already exists.', 'GITHUB_FILE_EXISTS');
    }
    try {
      return await commitFiles(env, {
        expectedHeadSha: head,
        message: options.message,
        files: [{ path, content: serialized }],
      });
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'GITHUB_REVISION_CONFLICT' || attempt === 3) throw error;
    }
  }
  throw new HttpError(409, 'GitHub repository changed while saving; reload and retry.', 'GITHUB_REVISION_CONFLICT');
}

export async function writeBinaryFile(env, path, bytes, options = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const head = await getBranchHead(env);
    const current = await readFileMetadata(env, path, { ref: head, allowMissing: true });
    if (options.createOnly && current) throw new HttpError(409, 'GitHub repository file already exists.', 'GITHUB_FILE_EXISTS');
    try {
      return await commitFiles(env, {
        expectedHeadSha: head,
        message: options.message,
        files: [{ path, content: toBytes(bytes) }],
      });
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'GITHUB_REVISION_CONFLICT' || attempt === 3) throw error;
    }
  }
  throw new HttpError(409, 'GitHub repository changed while saving; reload and retry.', 'GITHUB_REVISION_CONFLICT');
}

export async function publicFileResponse(env, path, options = {}) {
  path = assertRepoPath(path, options.prefix || '');
  const response = await fetch(rawFileUrl(env, path), {
    headers: { 'User-Agent': 'kaoyan-study-center-worker' },
    redirect: 'follow',
  });
  if (!response.ok || !response.body) {
    if (response.status === 404) throw new HttpError(404, 'Repository file was not found.', 'GITHUB_OBJECT_NOT_FOUND');
    throw new HttpError(502, 'Repository file could not be loaded.', 'GITHUB_RAW_READ_FAILED');
  }
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', options.cacheControl || 'private, max-age=300');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (options.contentType) headers.set('Content-Type', options.contentType);
  return new Response(response.body, { status: 200, headers });
}

export function githubStorageInfo(env) {
  const owner = text(env.GITHUB_OWNER, DEFAULT_OWNER);
  const repo = text(env.GITHUB_REPO, DEFAULT_REPO);
  const branch = text(env.GITHUB_BRANCH, DEFAULT_BRANCH);
  return {
    configured: Boolean(text(env.GITHUB_TOKEN)),
    owner,
    repo,
    branch,
    repository: `${owner}/${repo}`,
  };
}
