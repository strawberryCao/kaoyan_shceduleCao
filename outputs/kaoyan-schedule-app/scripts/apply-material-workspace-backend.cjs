'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const write = (relative, content) => fs.writeFileSync(path.join(root, relative), content, 'utf8');

function replaceOnce(source, oldValue, newValue, label) {
  if (source.includes(newValue)) return source;
  if (!source.includes(oldValue)) throw new Error(`${label}: anchor missing`);
  return source.replace(oldValue, newValue);
}

{
  let source = read('scripts/note-file-access.cjs');
  source = replaceOnce(
    source,
`function resolveNoteImage(notesRoot, requestedPath) {
`,
`function noteFileContentDisposition(resolved, fileName, preview = false) {
  const inline = resolved.inline || (preview === true && resolved.extension === '.pdf');
  return inline ? 'inline' : \`attachment; filename*=UTF-8''\${encodeURIComponent(fileName)}\`;
}

function resolveNoteImage(notesRoot, requestedPath) {
`,
    'local note-file disposition helper',
  );
  source = replaceOnce(
    source,
`  isInside,
  resolveNoteFile,
`,
`  isInside,
  noteFileContentDisposition,
  resolveNoteFile,
`,
    'export note-file disposition helper',
  );
  write('scripts/note-file-access.cjs', source);
}

{
  let source = read('scripts/note-server.cjs');
  source = replaceOnce(
    source,
`const { resolveNoteFile, revealNoteImage } = require('./note-file-access.cjs');`,
`const { noteFileContentDisposition, resolveNoteFile, revealNoteImage } = require('./note-file-access.cjs');`,
    'import note-file disposition helper',
  );
  source = replaceOnce(
    source,
`  if (method === 'GET' && pathname === '/note-file') {
    return queryKeys.length === 1 && queryKeys[0] === 'path' && Boolean(searchParams.get('path'));
  }
`,
`  if (method === 'GET' && pathname === '/note-file') {
    const allowedKeys = new Set(['path', 'preview']);
    return queryKeys.every((key) => allowedKeys.has(key))
      && Boolean(searchParams.get('path'))
      && (searchParams.get('preview') === null || searchParams.get('preview') === '1');
  }
`,
    'LAN note-file preview query allowlist',
  );
  source = replaceOnce(
    source,
`    if (req.method === 'GET' && pathname === '/note-file') {
      const file = resolveNoteFile(NOTES_ROOT, requestUrl.searchParams.get('path'));
      const stat = fs.statSync(file.filePath);
      const fileName = path.basename(file.filePath);
      res.writeHead(200, {
        'Content-Type': file.mime,
        'Content-Length': stat.size,
        'Content-Disposition': file.inline ? 'inline' : \`attachment; filename*=UTF-8''\${encodeURIComponent(fileName)}\`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(file.filePath).pipe(res);
      return;
    }
`,
`    if (req.method === 'GET' && pathname === '/note-file') {
      const file = resolveNoteFile(NOTES_ROOT, requestUrl.searchParams.get('path'));
      const stat = fs.statSync(file.filePath);
      const fileName = path.basename(file.filePath);
      const preview = requestUrl.searchParams.get('preview') === '1';
      res.writeHead(200, {
        'Content-Type': file.mime,
        'Content-Length': stat.size,
        'Content-Disposition': noteFileContentDisposition(file, fileName, preview),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      fs.createReadStream(file.filePath).pipe(res);
      return;
    }
`,
    'local note-file secure PDF preview',
  );
  write('scripts/note-server.cjs', source);
}

{
  let source = read('cloudflare/media.js');
  source = replaceOnce(
    source,
`export async function getNoteFile(env, path) {
  const asset = noteAssetPath(path);
  const image = (EXTENSION_MIME.get(asset.extension) || '').startsWith('image/');
  return publicFileResponse(env, asset.repoPath, {
    prefix: asset.prefix,
    contentType: EXTENSION_MIME.get(asset.extension) || 'application/octet-stream',
    contentDisposition: image ? 'inline' : \`attachment; filename*=UTF-8''\${encodeURIComponent(asset.repoPath.split('/').at(-1) || 'material')}\`,
    cacheControl: 'private, max-age=31536000, immutable',
  });
}
`,
`export async function getNoteFile(env, path, options = {}) {
  const asset = noteAssetPath(path);
  const mime = EXTENSION_MIME.get(asset.extension) || 'application/octet-stream';
  const image = mime.startsWith('image/');
  const inline = image || (options.preview === true && asset.extension === 'pdf');
  return publicFileResponse(env, asset.repoPath, {
    prefix: asset.prefix,
    contentType: mime,
    contentDisposition: inline ? 'inline' : \`attachment; filename*=UTF-8''\${encodeURIComponent(asset.repoPath.split('/').at(-1) || 'material')}\`,
    cacheControl: 'private, max-age=31536000, immutable',
  });
}
`,
    'cloud note-file secure PDF preview',
  );
  write('cloudflare/media.js', source);
}

{
  let source = read('cloudflare/worker.js');
  source = replaceOnce(
    source,
`  if (request.method === 'GET' && pathname === '/note-file') return getNoteFile(env, url.searchParams.get('path'));`,
`  if (request.method === 'GET' && pathname === '/note-file') {
    return getNoteFile(env, url.searchParams.get('path'), { preview: url.searchParams.get('preview') === '1' });
  }`,
    'cloud worker note-file preview flag',
  );
  source = replaceOnce(
    source,
`    // narrow exception because ordinary <img> requests cannot attach the
    // authorization header stored by the application fetch wrapper.
    const publicImageRead = request.method === 'GET' && pathname === '/note-file';
    if (!publicImageRead) {
`,
`    // narrow exception because ordinary image/PDF frames cannot attach the
    // authorization header stored by the application fetch wrapper. The path
    // remains restricted to stored note assets by getNoteFile().
    const publicStoredAssetRead = request.method === 'GET' && pathname === '/note-file';
    if (!publicStoredAssetRead) {
`,
    'cloud stored asset auth comment',
  );
  write('cloudflare/worker.js', source);
}

{
  let source = read('scripts/note-file-material.test.cjs');
  source = replaceOnce(
    source,
`const { resolveNoteFile, resolveNoteImage } = require('./note-file-access.cjs');`,
`const { noteFileContentDisposition, resolveNoteFile, resolveNoteImage } = require('./note-file-access.cjs');`,
    'local preview test import',
  );
  if (!source.includes("test('PDF preview is inline only when explicitly requested'")) {
    source += `

test('PDF preview is inline only when explicitly requested', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-file-pdf-preview-'));
  try {
    const pdf = path.join(root, '讲义.pdf');
    const html = path.join(root, '页面.html');
    fs.writeFileSync(pdf, '%PDF-1.4');
    fs.writeFileSync(html, '<h1>demo</h1>');
    const resolvedPdf = resolveNoteFile(root, pdf);
    const resolvedHtml = resolveNoteFile(root, html);
    assert.match(noteFileContentDisposition(resolvedPdf, '讲义.pdf', false), /^attachment/);
    assert.equal(noteFileContentDisposition(resolvedPdf, '讲义.pdf', true), 'inline');
    assert.match(noteFileContentDisposition(resolvedHtml, '页面.html', true), /^attachment/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
`;
  }
  write('scripts/note-file-material.test.cjs', source);
}

{
  let source = read('cloudflare/media-material.test.mjs');
  source = replaceOnce(
    source,
`import { decodeMaterialFile } from './media.js';`,
`import { decodeMaterialFile, getNoteFile } from './media.js';`,
    'cloud preview test import',
  );
  if (!source.includes("test('stored PDF becomes inline only for explicit preview'")) {
    source += `

test('stored PDF becomes inline only for explicit preview', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([37, 80, 68, 70]), {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  const env = { GITHUB_OWNER: 'owner', GITHUB_REPO: 'repo', GITHUB_BRANCH: 'main', GITHUB_TOKEN: 'token' };
  try {
    const download = await getNoteFile(env, 'github://data/assets/note/讲义.pdf');
    const preview = await getNoteFile(env, 'github://data/assets/note/讲义.pdf', { preview: true });
    const html = await getNoteFile(env, 'github://data/assets/note/页面.html', { preview: true });
    assert.match(download.headers.get('content-disposition') || '', /^attachment/);
    assert.equal(preview.headers.get('content-disposition'), 'inline');
    assert.match(html.headers.get('content-disposition') || '', /^attachment/);
    assert.equal(preview.headers.get('content-type'), 'application/pdf');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
`;
  }
  write('cloudflare/media-material.test.mjs', source);
}

console.log('Applied secure material preview backend patch.');
