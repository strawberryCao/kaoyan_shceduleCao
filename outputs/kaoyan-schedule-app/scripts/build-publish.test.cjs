'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { publishStaticBuild } = require('./build-with-diagnostic.cjs');

test('publishes a complete staged build without deleting the live build first', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-build-publish-'));
  const live = path.join(root, 'dist');
  const staged = path.join(root, 'dist-next');
  const backup = path.join(root, 'dist-previous');
  fs.mkdirSync(live);
  fs.mkdirSync(staged);
  fs.writeFileSync(path.join(live, 'index.html'), 'old', 'utf8');
  fs.writeFileSync(path.join(staged, 'index.html'), 'new', 'utf8');

  publishStaticBuild(staged, live, backup);

  assert.equal(fs.readFileSync(path.join(live, 'index.html'), 'utf8'), 'new');
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.existsSync(backup), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('rejects an incomplete staged build and preserves the live build', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-build-incomplete-'));
  const live = path.join(root, 'dist');
  const staged = path.join(root, 'dist-next');
  const backup = path.join(root, 'dist-previous');
  fs.mkdirSync(live);
  fs.mkdirSync(staged);
  fs.writeFileSync(path.join(live, 'index.html'), 'old', 'utf8');

  assert.throws(() => publishStaticBuild(staged, live, backup), /incomplete/);
  assert.equal(fs.readFileSync(path.join(live, 'index.html'), 'utf8'), 'old');
  fs.rmSync(root, { recursive: true, force: true });
});
