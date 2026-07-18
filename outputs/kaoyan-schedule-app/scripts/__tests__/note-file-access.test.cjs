const assert = require('node:assert/strict');
const fs = require('node:fs');
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

test('reveals the selected image without invoking a shell', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-file-reveal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, '操作系统', '错题.jpg');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from('image'));
  let invocation = null;

  revealNoteImage(root, imagePath, {
    platform: 'win32',
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { unref() {} };
    },
  });

  assert.equal(invocation.command, 'explorer.exe');
  assert.deepEqual(invocation.args, ['/select,', imagePath]);
  assert.equal(invocation.options.stdio, 'ignore');
});
