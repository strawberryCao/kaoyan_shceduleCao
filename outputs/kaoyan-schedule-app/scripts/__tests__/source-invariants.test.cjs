'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('source invariants accept the current attachment-aware learning store', () => {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const result = spawnSync(process.execPath, ['scripts/ensure-source-invariants.cjs'], {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
