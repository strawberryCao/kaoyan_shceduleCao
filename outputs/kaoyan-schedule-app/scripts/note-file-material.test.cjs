'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveNoteFile, resolveNoteImage } = require('./note-file-access.cjs');

test('generic local note access serves safe materials and keeps HTML non-inline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-file-material-'));
  try {
    const html = path.join(root, 'demo.html');
    fs.writeFileSync(html, '<h1>demo</h1>');
    const resolved = resolveNoteFile(root, html);
    assert.match(resolved.mime, /^text\/html/);
    assert.equal(resolved.inline, false);
    assert.throws(() => resolveNoteImage(root, html), (error) => error.code === 'NOTE_FILE_UNSUPPORTED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generic local note access rejects executable and escaped paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-file-security-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'note-file-outside-'));
  try {
    const executable = path.join(root, 'run.exe');
    const escaped = path.join(outside, 'note.txt');
    fs.writeFileSync(executable, 'MZ');
    fs.writeFileSync(escaped, 'outside');
    assert.throws(() => resolveNoteFile(root, executable), (error) => error.code === 'NOTE_FILE_UNSUPPORTED');
    assert.throws(() => resolveNoteFile(root, escaped), (error) => error.code === 'NOTE_PATH_FORBIDDEN');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
