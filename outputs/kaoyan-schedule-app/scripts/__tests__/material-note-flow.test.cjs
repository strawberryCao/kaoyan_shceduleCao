'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');
const serverScript = path.join(__dirname, '..', 'note-server.cjs');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`note server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('note server health check timed out');
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function findNote(snapshot, noteUid) {
  return Object.values(snapshot.days || {})
    .flatMap((day) => Array.isArray(day.autoNotes) ? day.autoNotes : [])
    .find((note) => note.noteUid === noteUid);
}

test('local material endpoint saves text and PDF attachments idempotently', { timeout: 20_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-material-flow-'));
  const assistantRoot = path.join(tempRoot, 'assistant');
  const notesRoot = path.join(tempRoot, 'notes');
  fs.mkdirSync(assistantRoot, { recursive: true });
  const notePort = await reservePort();
  const child = spawn(process.execPath, [serverScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      KAOYAN_NOTE_PORT: String(notePort),
      KAOYAN_NOTES_ROOT: notesRoot,
      KAOYAN_ASSISTANT_ROOT: assistantRoot,
      QWEN_API_KEY: '',
      DASHSCOPE_API_KEY: '',
      GEMINI_API_KEY: '',
      KIMI_API_KEY: '',
      MOONSHOT_API_KEY: '',
      CAOBIJI_GITHUB_TOKEN: '',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const baseUrl = `http://127.0.0.1:${notePort}`;
  const pdfBytes = Buffer.from('%PDF-1.4\nlocal-material-test\n', 'utf8');
  const payload = {
    noteUid: 'material_test_pdf_001',
    title: '拉格朗日中值定理资料',
    remark: '保存一份推导 PDF，并标记为知识点和背诵。',
    subject: '高等数学',
    facets: ['quick', 'knowledge', 'memory'],
    files: [{
      name: '推导/证明.pdf',
      mimeType: 'application/pdf',
      size: pdfBytes.length,
      dataUrl: `data:application/pdf;base64,${pdfBytes.toString('base64')}`,
    }],
  };

  try {
    await waitForHealth(baseUrl, child);
    const firstResponse = await fetch(`${baseUrl}/save-material-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-kaoyan-lan-proxy': '1' },
      body: JSON.stringify(payload),
    });
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 201);
    assert.equal(first.ok, true);
    assert.equal(first.idempotentReplay, false);
    assert.equal(first.attachments.length, 1);
    assert.equal(first.attachments[0].kind, 'pdf');
    assert.equal(first.attachments[0].name, '推导_证明.pdf');
    assert.ok(fs.existsSync(first.attachments[0].filePath));
    assert.equal(path.dirname(first.attachments[0].filePath), path.join(notesRoot, '.materials', payload.noteUid));

    const note = findNote(first.learningData, payload.noteUid);
    assert.ok(note);
    assert.equal(note.subject, '高等数学');
    assert.deepEqual(note.facets, ['quick', 'knowledge', 'memory']);
    assert.equal(note.attachments[0].filePath, first.attachments[0].filePath);

    const fileResponse = await fetch(`${baseUrl}/note-file?path=${encodeURIComponent(first.attachments[0].filePath)}`, {
      headers: { 'x-kaoyan-lan-proxy': '1' },
    });
    assert.equal(fileResponse.status, 200);
    assert.match(fileResponse.headers.get('content-type') || '', /^application\/pdf/);
    assert.match(fileResponse.headers.get('content-disposition') || '', /^attachment;/);
    assert.deepEqual(Buffer.from(await fileResponse.arrayBuffer()), pdfBytes);

    const replayResponse = await fetch(`${baseUrl}/save-material-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const replay = await replayResponse.json();
    assert.equal(replayResponse.status, 200);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.attachments[0].filePath, first.attachments[0].filePath);

    const conflictingResponse = await fetch(`${baseUrl}/save-material-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, remark: '不同内容' }),
    });
    const conflict = await conflictingResponse.json();
    assert.equal(conflictingResponse.status, 409);
    assert.equal(conflict.code, 'SAVE_OPERATION_REUSED');
  } finally {
    await stopChild(child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('local material endpoint accepts a pure text quick note', { timeout: 15_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-text-note-'));
  const assistantRoot = path.join(tempRoot, 'assistant');
  const notesRoot = path.join(tempRoot, 'notes');
  fs.mkdirSync(assistantRoot, { recursive: true });
  const notePort = await reservePort();
  const child = spawn(process.execPath, [serverScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      KAOYAN_NOTE_PORT: String(notePort),
      KAOYAN_NOTES_ROOT: notesRoot,
      KAOYAN_ASSISTANT_ROOT: assistantRoot,
      QWEN_API_KEY: '',
      DASHSCOPE_API_KEY: '',
      GEMINI_API_KEY: '',
      KIMI_API_KEY: '',
      MOONSHOT_API_KEY: '',
      CAOBIJI_GITHUB_TOKEN: '',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const baseUrl = `http://127.0.0.1:${notePort}`;
  try {
    await waitForHealth(baseUrl, child);
    const response = await fetch(`${baseUrl}/save-material-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        noteUid: 'material_text_001',
        remark: '纯文字速记：构造辅助函数时先观察零点数量。',
        subject: '高等数学',
        facets: ['quick'],
        files: [],
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.deepEqual(result.attachments, []);
    const note = findNote(result.learningData, 'material_text_001');
    assert.equal(note.noteType, 'quick');
    assert.equal(note.remark, '纯文字速记：构造辅助函数时先观察零点数量。');
  } finally {
    await stopChild(child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
