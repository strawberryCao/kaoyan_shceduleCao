const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('normalized learning schema preserves entities, assets, reviews, tombstones and a change log', () => {
  const sql = read('migrations/0002_normalized_learning_domain.sql');
  for (const table of [
    'learning_entries',
    'learning_attachments',
    'learning_cards',
    'learning_review_events',
    'learning_study_notes',
    'learning_tags',
    'learning_entry_tags',
    'learning_tombstones',
    'learning_change_log',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(sql, /REFERENCES learning_entries\(entry_id\) ON DELETE CASCADE/);
  assert.match(sql, /rating IN \('again', 'hard', 'good', 'easy'\)/);
  assert.match(sql, /operation_id TEXT NOT NULL UNIQUE/);
  assert.match(sql, /user_edited_fields_json TEXT NOT NULL/);
  assert.match(sql, /source_image_hash TEXT NOT NULL/);

  const database = new DatabaseSync(':memory:');
  database.exec(read('migrations/0001_cloud_study_store.sql'));
  database.exec(sql);
  const result = database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'learning_%'").get();
  database.close();
  assert.equal(result.count, 10);
});

test('snapshot compatibility writes stay atomic and compact', () => {
  const localStore = read('scripts/learning-data-store.cjs');
  const cloudStore = read('cloudflare/storage.js');
  assert.match(localStore, /const serialized = `\$\{JSON\.stringify\(snapshot\)\}\\n`/);
  assert.match(localStore, /fs\.renameSync\(tempPath, filePath\)/);
  assert.match(localStore, /fs\.copyFileSync\(filePath, backupPath\)/);
  assert.match(cloudStore, /content: `\$\{JSON\.stringify\(stored\)\}\\n`/);
  assert.match(cloudStore, /latest\.revision !== currentRevision/);
});

test('live event streaming suppresses redundant polling while the page is visible', () => {
  const client = read('src/utils/learningData.ts');
  assert.match(client, /learningDataStreamConnected = true/);
  assert.match(client, /!document\.hidden\) && !learningDataStreamConnected/);
  assert.match(client, /document\.addEventListener\('visibilitychange'/);
  assert.match(client, /IS_CLOUD_RUNTIME \? 30_000 : 15_000/);
});
