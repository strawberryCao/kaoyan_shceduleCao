const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '..', 'cloudflare', 'github-store.js');
let value = fs.readFileSync(file, 'utf8');

const readerStart = value.indexOf('async function readBlobBytes(');
const readFileStart = value.indexOf('export async function readFile(', readerStart);
if (readerStart < 0 || readFileStart < 0) throw new Error('GitHub blob read block not found');
const rawReader = `async function readRawBytes(env, path, ref, maxBytes) {
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

`;
value = value.slice(0, readerStart) + rawReader + value.slice(readFileStart);
value = value.replace(
  '    bytes = await readBlobBytes(env, metadata.sha, maxBytes);',
  '    bytes = await readRawBytes(env, path, ref, maxBytes);',
);

const responseStart = value.indexOf('export async function publicFileResponse(');
const infoStart = value.indexOf('export function githubStorageInfo(', responseStart);
if (responseStart < 0 || infoStart < 0) throw new Error('GitHub file response block not found');
const publicResponse = `export async function publicFileResponse(env, path, options = {}) {
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

`;
value = value.slice(0, responseStart) + publicResponse + value.slice(infoStart);
fs.writeFileSync(file, value, 'utf8');
