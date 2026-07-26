import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMaterialFile, getNoteFile } from './media.js';

test('material decoder accepts PDF and preserves a safe filename', () => {
  const decoded = decodeMaterialFile({ name: '推导/证明.pdf', dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK' });
  assert.equal(decoded.kind, 'pdf');
  assert.equal(decoded.mime, 'application/pdf');
  assert.equal(decoded.fileName, '推导_证明.pdf');
  assert.ok(decoded.bytes.byteLength > 0);
});

test('material decoder rejects unsupported executable files', () => {
  assert.throws(() => decodeMaterialFile({ name: 'run.exe', dataUrl: 'data:application/octet-stream;base64,AA==' }), /not supported/i);
});


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
