import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavedImageNote } from './learning.js';

test('saved cloud image notes expose the image through the attachment collection', () => {
  const note = createSavedImageNote({ noteUid: 'cloud-note', remark: 'test' }, { repoPath: 'data/assets/cloud-note.png' }, '2026-07-25T00:00:00.000Z');
  assert.equal(note.filePath, 'github://data/assets/cloud-note.png');
  assert.equal(note.attachments.length, 1);
  assert.equal(note.attachments[0].kind, 'image');
  assert.equal(note.attachments[0].filePath, note.filePath);
});
