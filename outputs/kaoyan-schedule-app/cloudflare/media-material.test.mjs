import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMaterialFile } from './media.js';

test('material decoder accepts PDF and preserves a safe filename', () => {
  const decoded = decodeMaterialFile({ name: '推导/证明.pdf', dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK' });
  assert.equal(decoded.kind, 'pdf');
  assert.equal(decoded.mime, 'application/pdf');
  assert.equal(decoded.fileName, '推导_证明.pdf');
  assert.ok(decoded.bytes.byteLength > 0);
});

test('material decoder rejects unsupported executable files', () => {
  assert.throws(() => decodeMaterialFile({ name: 'run.exe', dataUrl: 'data:application/octet-stream;base64,AA==' }), /not supported/i);
});
