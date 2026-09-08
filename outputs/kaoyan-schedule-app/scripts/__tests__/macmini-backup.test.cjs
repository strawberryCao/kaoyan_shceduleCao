const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createBackup, restorePlan, verifyBackup } = require('../macmini-backup.cjs');
const { provisionRuntimeLayout, resolveRuntimePaths } = require('../runtime-paths.cjs');

test('Mac snapshot verifies files and SQLite without copying secrets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = resolveRuntimePaths({ env: { KAOYAN_RUNTIME_ROOT: root } });
  provisionRuntimeLayout(runtime);
  fs.writeFileSync(path.join(runtime.configRoot, 'appearance.json'), '{"theme":"warm"}\n');
  fs.mkdirSync(path.join(runtime.dataRoot, '资料'), { recursive: true });
  fs.writeFileSync(path.join(runtime.dataRoot, '资料', '高数笔记.txt'), '中文路径也必须可恢复\n');
  fs.writeFileSync(path.join(runtime.secretsRoot, 'ai-providers.json'), '{"apiKey":"never-copy"}\n');
  const databasePath = path.join(runtime.dataRoot, 'study.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT); INSERT INTO notes VALUES (\'n1\', \'保留内容\')');
  database.close();

  const created = createBackup(runtime, { name: '20260908T120000Z-test0001', now: new Date('2026-09-08T12:00:00Z') });
  assert.equal(created.manifest.secretsIncluded, false);
  assert.equal(created.manifest.totals.sqliteFiles, 1);
  assert.equal(created.manifest.files.some((entry) => entry.path.startsWith('secrets/')), false);
  assert.equal(created.manifest.files.some((entry) => entry.path === 'data/资料/高数笔记.txt'), true);
  const verified = verifyBackup(created.backupPath);
  assert.equal(verified.ok, true);
  const plan = restorePlan(runtime, created.backupPath);
  assert.equal(plan.restorable, true);
  assert.equal(plan.writesPerformed, false);
  assert.equal(plan.requiresFreshSafetyBackup, true);

  const configEntry = created.manifest.files.find((entry) => entry.path === 'config/appearance.json');
  fs.appendFileSync(path.join(created.backupPath, ...configEntry.path.split('/')), 'tampered');
  assert.equal(verifyBackup(created.backupPath).ok, false);
});
