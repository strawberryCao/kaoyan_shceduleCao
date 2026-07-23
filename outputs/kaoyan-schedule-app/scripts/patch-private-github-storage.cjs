const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '..', 'cloudflare', 'github-store.js');
let value = fs.readFileSync(file, 'utf8');

const rawStart = value.indexOf('async function readRawBytes(');
const readFileStart = value.indexOf('export async function readFile(', rawStart);
if (rawStart < 0 || readFileStart < 0) throw new Error('GitHub raw read block not found');
const blobReader = `async function readBlobBytes(env, sha, maxBytes) {
  const { owner, repo } = repositoryConfig(env);
  const result = await githubRequest(env, \`/repos/\${owner}/\${repo}/git/blobs/\${encodeURIComponent(sha)}\`);
  if (result?.encoding !== 'base64' || typeof result?.content !== 'string') {
    throw new HttpError(502, 'GitHub blob content is unavailable.', 'GITHUB_BLOB_READ_FAILED');
  }
  const declared = Number(result.size);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'GitHub repository file is too large.', 'GITHUB_FILE_TOO_LARGE');
  }
  const bytes = base64ToBytes(result.content);
  if (bytes.byteLength > maxBytes) throw new HttpError(413, 'GitHub repository file is too large.', 'GITHUB_FILE_TOO_LARGE');
  return bytes;
}

`;
value = value.slice(0, rawStart) + blobReader + value.slice(readFileStart);
value = value.replace(
  '    bytes = await readRawBytes(env, path, ref, maxBytes);',
  '    bytes = await readBlobBytes(env, metadata.sha, maxBytes);',
);

const responseStart = value.indexOf('export async function publicFileResponse(');
const infoStart = value.indexOf('export function githubStorageInfo(', responseStart);
if (responseStart < 0 || infoStart < 0) throw new Error('GitHub public response block not found');
const privateResponse = `export async function publicFileResponse(env, path, options = {}) {
  path = assertRepoPath(path, options.prefix || '');
  const file = await readFile(env, path, { maxBytes: Number(options.maxBytes) || 24 * 1024 * 1024 });
  const headers = new Headers();
  headers.set('Cache-Control', options.cacheControl || 'private, max-age=300');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Type', options.contentType || 'application/octet-stream');
  headers.set('Content-Length', String(file.bytes.byteLength));
  return new Response(file.bytes, { status: 200, headers });
}

`;
value = value.slice(0, responseStart) + privateResponse + value.slice(infoStart);
fs.writeFileSync(file, value, 'utf8');
