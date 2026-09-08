const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { backupDue, runBackupIfDue } = require('../macmini-backup-scheduler.cjs');
const { provisionRuntimeLayout, resolveRuntimePaths } = require('../runtime-paths.cjs');

test('daily scheduler creates and verifies at most one snapshot inside twenty hours', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-backup-scheduler-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = resolveRuntimePaths({ env: { KAOYAN_RUNTIME_ROOT: root } });
  provisionRuntimeLayout(runtime);
  fs.writeFileSync(path.join(runtime.dataRoot, 'learning.json'), '{"revision":1}\n');
  const firstTime = new Date('2026-09-08T00:00:00Z');
  assert.equal(backupDue(runtime, firstTime), true);
  const first = runBackupIfDue(runtime, { now: firstTime });
  assert.equal(first.created, true);
  assert.equal(first.verification.ok, true);
  assert.equal(backupDue(runtime, new Date('2026-09-08T12:00:00Z')), false);
  assert.equal(runBackupIfDue(runtime, { now: new Date('2026-09-08T12:00:00Z') }).created, false);
  assert.equal(backupDue(runtime, new Date('2026-09-08T21:00:00Z')), true);
});
