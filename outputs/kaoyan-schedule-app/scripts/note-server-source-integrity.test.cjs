'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'note-server.cjs'), 'utf8');
const organizerSource = fs.readFileSync(path.join(__dirname, 'organize-notes.cjs'), 'utf8');
const startupSource = fs.readFileSync(path.join(__dirname, '..', '启动考研桌面助手.cmd'), 'utf8');

function count(pattern) {
  return [...source.matchAll(pattern)].length;
}

test('note server keeps one authoritative material and organizer-lock implementation', () => {
  assert.equal(count(/^function materialReceiptPath\(/gm), 1);
  assert.equal(count(/^function materialKind\(/gm), 1);
  assert.equal(count(/^function safeMaterialFileName\(/gm), 1);
  assert.equal(count(/^function decodeMaterialFile\(/gm), 1);
  assert.equal(count(/^function findMaterialLearningNote\(/gm), 1);
  assert.equal(count(/^function readMaterialReceipt\(/gm), 1);
  assert.equal(count(/^function writeMaterialReceipt\(/gm), 1);
  assert.equal(count(/^async function handleSaveMaterial\(/gm), 1);
  assert.equal(count(/^async function acquireOrganizerLockForHumanAction\(/gm), 1);
});

test('note server maps each public error code only once', () => {
  assert.equal(count(/error\?\.code === 'PAYLOAD_TOO_LARGE' \? 413/g), 1);
});

test('startup cannot trigger library-wide AI scans and each new note may enqueue its own naming job', () => {
  assert.doesNotMatch(source, /function resumePendingAiNamingJobs\(/);
  assert.doesNotMatch(source, /pendingAiNamingResumeTimer\s*=/);
  assert.doesNotMatch(source, /taxonomyConsolidationTimer\s*=\s*setTimeout/);
  assert.equal(count(/if \(!isCaptureOriginal && aiSelection\?\.mode !== 'off'\) queueAiNamingJob\(noteUid\);/g), 1);
  assert.doesNotMatch(source, /naming\?\.status === 'pending'\) queueAiNamingJob\(/);
  assert.doesNotMatch(source, /await runAiNamingJob\(noteUid\);\s*queueNoteEnrichment\(noteUid\)/);
  assert.match(source, /AI startup scans are disabled/);
  const saveMaterialBody = source.match(/async function handleSaveMaterial[\s\S]*?\r?\n}\r?\n\r?\nasync function handleAppendMaterial/)?.[0] || '';
  const appendMaterialBody = source.match(/async function handleAppendMaterial[\s\S]*?\r?\n}\r?\n\r?\nfunction /)?.[0] || '';
  assert.match(saveMaterialBody, /if \(files\.length > 0 \|\| !title\) queueMaterialNamingJob\(noteUid/);
  assert.match(appendMaterialBody, /queueMaterialNamingJob\(noteUid/);
  assert.match(source, /queueMaterialNamingJob\(noteUid, \{ explicit: true,/);
  assert.doesNotMatch(source, /function queueMaterialNamingJob[\s\S]*?options\.explicit !== true[\s\S]*?AI_EXPLICIT_ACTION_REQUIRED/);

  assert.doesNotMatch(startupSource, /schtasks\s+\/Create/i);
  assert.doesNotMatch(startupSource, /call\s+[^\r\n]*run-smart-note-organizer-hidden/i);
  assert.match(startupSource, /KaoyanNotesSmartOrganizer[^\r\n]*\/Disable/i);
});

test('AI organizer is opt-in and limited to one explicit note', () => {
  assert.match(organizerSource, /flags\.has\('--allow-ai'\)/);
  assert.match(organizerSource, /allowAi\s*&&\s*!noteUidFlag/);
  assert.match(organizerSource, /full-library AI scans are disabled/);
});

test('a note without remarks uses the dedicated high-quality vision route on save', () => {
  assert.match(source, /const route = noteAiRoute\(aiSelection, kind, effectiveRemark\);/);
  assert.match(source, /remarkMissing \? 'note_image_understanding' : 'note_naming'/);
  assert.match(source, /if \(remarkMissing\) \{[\s\S]*?return \{ task, difficulty: 'high' \};/);
});
