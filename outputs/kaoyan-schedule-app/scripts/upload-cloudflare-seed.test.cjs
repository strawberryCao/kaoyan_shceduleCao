const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseCliOptions,
  uploadCloudflareSeed,
} = require('./upload-cloudflare-seed.cjs');

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function createSeed(t, records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-seed-upload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = records.map(({ r2Key, content, contentType }) => {
    const buffer = Buffer.from(content);
    const filePath = path.join(root, 'objects', ...r2Key.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
    return {
      r2Key,
      ...(contentType ? { contentType } : {}),
      bytes: buffer.length,
      sha256: hash(buffer),
    };
  });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version: 1, files }));
  return { root, files };
}

test('parses supported upload flags', () => {
  assert.deepEqual(
    parseCliOptions(['--seed-root', 'D:\\seed', '--bucket=study-bucket', '--dry-run']),
    { seedRoot: 'D:\\seed', bucket: 'study-bucket', dryRun: true },
  );
});

test('dry run verifies every object without invoking Wrangler or logging contents', (t) => {
  const secretMarker = 'FILE_CONTENT_MUST_NOT_BE_LOGGED';
  const seed = createSeed(t, [
    { r2Key: 'bootstrap/learning-data.json', content: secretMarker },
    { r2Key: 'note-assets/example.png', content: 'image-bytes' },
  ]);
  const calls = [];
  const logs = [];
  const result = uploadCloudflareSeed({
    seedRoot: seed.root,
    dryRun: true,
    commandRunner: (...args) => { calls.push(args); return { status: 0 }; },
    logger: { log: (message) => logs.push(message) },
  });
  assert.equal(result.objectCount, 2);
  assert.equal(result.uploaded, 0);
  assert.deepEqual(calls, []);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs.join('\n'), new RegExp(secretMarker));
});

test('uploads verified files with argument-array Wrangler calls', (t) => {
  const seed = createSeed(t, [
    { r2Key: 'bootstrap/learning-data.json', content: '{"version":1}' },
    { r2Key: `bootstrap/canvases/canvas-1/${'a'.repeat(64)}.json`, content: '{"id":"canvas-1"}' },
  ]);
  const calls = [];
  const result = uploadCloudflareSeed({
    seedRoot: seed.root,
    bucket: 'study-bucket',
    commandRunner: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '', stderr: '' };
    },
    logger: { log() {} },
  });
  assert.equal(result.uploaded, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'npx.cmd');
  assert.deepEqual(calls[0].args, [
    'wrangler', 'r2', 'object', 'put',
    'study-bucket/bootstrap/learning-data.json',
    '--file',
    path.join(seed.root, 'objects', 'bootstrap', 'learning-data.json'),
    '--content-type',
    'application/json',
    '--remote',
  ]);
  assert.deepEqual(calls[1].args, [
    'wrangler', 'r2', 'object', 'put',
    `study-bucket/bootstrap/canvases/canvas-1/${'a'.repeat(64)}.json`,
    '--file',
    path.join(seed.root, 'objects', 'bootstrap', 'canvases', 'canvas-1', `${'a'.repeat(64)}.json`),
    '--content-type',
    'application/json',
    '--remote',
  ]);
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('assigns safe content types for seed objects and downgrades SVG', (t) => {
  const expected = new Map([
    ['note-assets/a.png', 'image/png'],
    ['note-assets/a.jpeg', 'image/jpeg'],
    ['note-assets/a.webp', 'image/webp'],
    ['note-assets/a.gif', 'image/gif'],
    ['note-assets/a.avif', 'image/avif'],
    ['note-assets/a.heic', 'image/heic'],
    ['note-assets/a.heif', 'image/heif'],
    ['bootstrap/data.json', 'application/json'],
    ['note-assets/a.pdf', 'application/pdf'],
    ['note-assets/a.svg', 'application/octet-stream'],
  ]);
  const seed = createSeed(t, [...expected.keys()].map((r2Key) => ({ r2Key, content: r2Key })));
  const calls = [];
  uploadCloudflareSeed({
    seedRoot: seed.root,
    commandRunner: (_command, args) => { calls.push(args); return { status: 0 }; },
    logger: { log() {} },
  });
  assert.equal(calls.length, expected.size);
  for (const args of calls) {
    const r2Key = args[4].slice('kaoyan-study-private/'.length);
    const contentTypeIndex = args.indexOf('--content-type');
    assert.equal(args[contentTypeIndex + 1], expected.get(r2Key));
    assert.equal(args.at(-1), '--remote');
  }
});

test('refuses seed manifests that target any live canvas object', (t) => {
  const seed = createSeed(t, [
    { r2Key: 'canvases/canvas-1/document.json', content: '{"id":"canvas-1"}' },
  ]);
  const calls = [];
  assert.throws(
    () => uploadCloudflareSeed({
      seedRoot: seed.root,
      commandRunner: (...args) => { calls.push(args); return { status: 0 }; },
      logger: { log() {} },
    }),
    /refuses to overwrite a live canvas object/,
  );
  assert.deepEqual(calls, []);

  const revisionSeed = createSeed(t, [
    { r2Key: `canvases/canvas-1/revisions/2-${'a'.repeat(64)}.json`, content: '{"id":"canvas-1"}' },
  ]);
  assert.throws(
    () => uploadCloudflareSeed({ seedRoot: revisionSeed.root, dryRun: true, logger: { log() {} } }),
    /refuses to overwrite a live canvas object/,
  );
});

test('rejects executable SVG content types supplied by a manifest', (t) => {
  const seed = createSeed(t, [
    { r2Key: 'note-assets/vector.svg', content: '<svg/>', contentType: 'image/svg+xml' },
  ]);
  assert.throws(
    () => uploadCloudflareSeed({ seedRoot: seed.root, dryRun: true, logger: { log() {} } }),
    /unsafe or mismatched content type/,
  );
});

test('validates the complete seed before making the first upload call', (t) => {
  const seed = createSeed(t, [
    { r2Key: 'bootstrap/learning-data.json', content: 'valid' },
    { r2Key: 'note-assets/damaged.png', content: 'original' },
  ]);
  fs.writeFileSync(path.join(seed.root, 'objects', 'note-assets', 'damaged.png'), 'tampered');
  const calls = [];
  assert.throws(
    () => uploadCloudflareSeed({
      seedRoot: seed.root,
      commandRunner: (...args) => { calls.push(args); return { status: 0 }; },
      logger: { log() {} },
    }),
    /byte count does not match|SHA-256 does not match/,
  );
  assert.deepEqual(calls, []);
});

test('rejects manifest keys that escape the objects directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-seed-unsafe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    files: [{ r2Key: '../manifest.json', bytes: 1, sha256: '0'.repeat(64) }],
  }));
  assert.throws(
    () => uploadCloudflareSeed({ seedRoot: root, dryRun: true, logger: { log() {} } }),
    /unsafe R2 key/,
  );
});
