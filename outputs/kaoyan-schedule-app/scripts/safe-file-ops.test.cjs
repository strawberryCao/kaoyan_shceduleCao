const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { unlinkFileIfExists } = require('./safe-file-ops.cjs');

test('unlinkFileIfExists removes a Windows file and treats a missing file as success', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-safe-unlink-'));
  const filePath = path.join(directory, '过期锁.lock');
  fs.writeFileSync(filePath, 'stale', 'utf8');

  assert.equal(unlinkFileIfExists(filePath), true);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(unlinkFileIfExists(filePath), false);

  fs.rmdirSync(directory);
});

test('unlinkFileIfExists refuses to recursively delete a directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-safe-unlink-dir-'));
  assert.throws(() => unlinkFileIfExists(directory), (error) => (
    error?.code === 'EPERM' || error?.code === 'EISDIR'
  ));
  fs.rmdirSync(directory);
});
