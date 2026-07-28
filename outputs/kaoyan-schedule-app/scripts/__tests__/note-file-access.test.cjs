const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  isInside,
  resolveNoteImage,
  revealNoteImage,
} = require('../note-file-access.cjs');

test('only resolves supported images inside the notes root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-file-access-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, '高等数学', '题目.png');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from('image'));

  assert.equal(isInside(root, imagePath), true);
  assert.equal(resolveNoteImage(root, imagePath).mime, 'image/png');
  assert.throws(() => resolveNoteImage(root, path.join(root, '..', 'outside.png')), { code: 'NOTE_PATH_FORBIDDEN' });
});

test('resolves a hash-addressed V2 asset without exposing its repository path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-file-asset-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const notesRoot = path.join(root, 'notes');
  const cloneRoot = path.join(root, 'clone');
  const assetId = 'a'.repeat(64);
  const assetPath = path.join(cloneRoot, 'data', 'assets', `${assetId}.png`);
  const recordPath = path.join(cloneRoot, 'data', 'v2', 'assets', `${assetId}.json`);
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(assetPath, Buffer.from('image'));
  fs.writeFileSync(recordPath, JSON.stringify({
    schemaVersion: 2,
    assetId,
    path: `data/assets/${assetId}.png`,
  }));

  const resolved = resolveNoteImage(notesRoot, `asset://${assetId}`, { cloneRoot });
  assert.equal(resolved.filePath, assetPath);
  assert.equal(resolved.mime, 'image/png');
});

test('reveals the selected image without invoking a shell', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-file-reveal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, '操作系统', '错题.jpg');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from('image'));
  let invocation = null;

  await revealNoteImage(root, imagePath, {
    platform: 'win32',
    windowsRoot: 'C:\\Windows',
    spawn(command, args, options) {
      invocation = { command, args, options };
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });

  assert.equal(invocation.command, path.join('C:\\Windows', 'explorer.exe'));
  assert.deepEqual(invocation.args, ['/select,', imagePath]);
  assert.equal(invocation.options.stdio, 'ignore');
});

test('reports an Explorer launch failure without leaving an unhandled child error', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-file-reveal-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, '高等数学', '错题.png');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from('image'));

  await assert.rejects(revealNoteImage(root, imagePath, {
    platform: 'win32',
    windowsRoot: 'C:\\Windows',
    spawn() {
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => {
        const error = new Error('spawn explorer.exe ENOENT');
        error.code = 'ENOENT';
        child.emit('error', error);
      });
      return child;
    },
  }), { code: 'NOTE_REVEAL_LAUNCH_FAILED' });
});
