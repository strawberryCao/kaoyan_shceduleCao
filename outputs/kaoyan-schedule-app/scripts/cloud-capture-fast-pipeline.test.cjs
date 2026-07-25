'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('cloud capture uses one atomic batch commit', () => {
  const media = read('cloudflare/media.js');
  const worker = read('cloudflare/worker.js');
  const store = read('cloudflare/github-store.js');
  assert.match(media, /export async function saveNoteBatch/);
  assert.match(media, /STORAGE_PATHS\.learning/);
  assert.match(media, /cloud: save \$\{staged\.length\} captured questions/);
  assert.match(worker, /pathname === '\/save-note-batch'/);
  assert.match(store, /const tree = await Promise\.all\(files\.map/);
});

test('mobile multi-question detection keeps Safari connection alive', () => {
  const worker = read('cloudflare/worker.js');
  const notes = read('src/utils/notes.ts');
  assert.match(worker, /application\/x-ndjson/);
  assert.match(worker, /AI 仍在识别，连接正常/);
  assert.match(notes, /ai\/detect-questions\/stream/);
  assert.match(notes, /response\.body\.getReader\(\)/);
});

test('mobile batch save no longer performs cloud saves one by one', () => {
  const app = read('src/components/NoteDropApp.tsx');
  const start = app.indexOf('const saveBatch = async () =>');
  const end = app.indexOf('const cancelPending', start);
  const block = app.slice(start, end);
  assert.match(block, /enqueueCaptureUpload\(payloads\)/);
  assert.match(block, /本机后台队列|可以立即退出/);
  assert.match(app, /cropManyImages\(src, detection\.regions, 1800, 0\.9\)/);
});
