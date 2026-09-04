import assert from 'node:assert/strict';
import test from 'node:test';
import { renameWorkflowInternals } from './rename-job.js';

test('cloud rename routes notes without remarks through image understanding', () => {
  assert.equal(renameWorkflowInternals.namingTaskId(''), 'note_image_understanding');
  assert.equal(renameWorkflowInternals.namingTaskId('   '), 'note_image_understanding');
  assert.equal(renameWorkflowInternals.namingTaskId('高数错题'), 'note_naming');
});
