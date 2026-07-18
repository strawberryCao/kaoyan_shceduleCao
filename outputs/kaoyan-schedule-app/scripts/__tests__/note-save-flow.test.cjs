const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');
const serverScript = path.join(projectRoot, 'scripts', 'note-server.cjs');
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`note server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The child may still be loading modules.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('note server did not become healthy');
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

test('saves locally before a slow AI response and replays the same noteUid without duplication', { timeout: 15_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-note-save-'));
  const assistantRoot = path.join(tempRoot, 'assistant');
  const notesRoot = path.join(tempRoot, 'notes');
  fs.mkdirSync(assistantRoot, { recursive: true });

  const aiPort = await reservePort();
  const notePort = await reservePort();
  const slowAi = http.createServer((_request, _response) => {
    // Intentionally never respond. The capture endpoint must not wait for this.
  });
  await new Promise((resolve, reject) => {
    slowAi.once('error', reject);
    slowAi.listen(aiPort, '127.0.0.1', resolve);
  });

  fs.writeFileSync(path.join(assistantRoot, 'ai-providers.json'), JSON.stringify({
    providers: {
      gemini: {
        enabled: true,
        apiKey: 'test-key-not-a-real-secret',
        baseUrl: `http://127.0.0.1:${aiPort}/v1`,
        models: [{
          id: 'slow-test-model',
          capabilities: ['text', 'vision', 'json'],
          costTier: 1,
          qualityTier: 1,
        }],
      },
    },
    routing: {
      timeoutMs: 10_000,
      networkRetries: 0,
      jsonRepairRetries: 0,
    },
  }, null, 2));

  const child = spawn(process.execPath, [serverScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      KAOYAN_NOTE_PORT: String(notePort),
      KAOYAN_NOTES_ROOT: notesRoot,
      KAOYAN_ASSISTANT_ROOT: assistantRoot,
      KAOYAN_AI_CONFIG_PATH: path.join(assistantRoot, 'ai-providers.json'),
      QWEN_API_KEY: '',
      DASHSCOPE_API_KEY: '',
      GEMINI_API_KEY: '',
      KIMI_API_KEY: '',
      MOONSHOT_API_KEY: '',
    },
    stdio: 'ignore',
    windowsHide: true,
  });

  const baseUrl = `http://127.0.0.1:${notePort}`;
  const noteUid = 'note_test_local_first_001';
  const payload = {
    noteUid,
    imageDataUrl: tinyPng,
    kind: 'single',
    remark: 'p108 3.1题 错因：计算粗心',
  };

  try {
    await waitForHealth(baseUrl, child);
    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/save-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const elapsedMs = Date.now() - startedAt;
    const first = await response.json();

    assert.equal(response.status, 202);
    assert.equal(first.ok, true);
    assert.equal(first.noteUid, noteUid);
    assert.equal(first.aiStatus, 'pending');
    assert.equal(first.idempotentReplay, false);
    assert.ok(elapsedMs < 2_000, `local save took ${elapsedMs}ms`);
    assert.ok(fs.existsSync(first.filePath));

    const replayResponse = await fetch(`${baseUrl}/save-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const replay = await replayResponse.json();
    assert.equal(replayResponse.status, 200);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.filePath, first.filePath);

    const imageFiles = fs.readdirSync(path.dirname(first.filePath), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:png|jpe?g|webp)$/i.test(entry.name));
    assert.equal(imageFiles.length, 1);
    const learningData = JSON.parse(fs.readFileSync(path.join(assistantRoot, 'learning-data.json'), 'utf8'));
    assert.equal(learningData.cards.filter((card) => card.noteUid === noteUid && card.kind === 'mistake').length, 1);
  } finally {
    await stopChild(child);
    await new Promise((resolve) => slowAi.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('finishes AI naming in the background and keeps the idempotency receipt on the renamed file', { timeout: 15_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-note-naming-'));
  const assistantRoot = path.join(tempRoot, 'assistant');
  const notesRoot = path.join(tempRoot, 'notes');
  fs.mkdirSync(assistantRoot, { recursive: true });

  const aiPort = await reservePort();
  const notePort = await reservePort();
  const fakeAi = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              subject: '高等数学',
              title: '导数切线经典错题',
              reason: '测试后台命名',
            }),
          },
        }],
      }));
    });
  });
  await new Promise((resolve, reject) => {
    fakeAi.once('error', reject);
    fakeAi.listen(aiPort, '127.0.0.1', resolve);
  });

  const aiConfigPath = path.join(assistantRoot, 'ai-providers.json');
  fs.writeFileSync(aiConfigPath, JSON.stringify({
    providers: {
      gemini: {
        enabled: true,
        apiKey: 'test-key-not-a-real-secret',
        baseUrl: `http://127.0.0.1:${aiPort}/v1`,
        models: [{
          id: 'successful-test-model',
          capabilities: ['text', 'vision', 'json'],
          costTier: 1,
          qualityTier: 1,
        }],
      },
    },
    routing: { timeoutMs: 2_000, networkRetries: 0, jsonRepairRetries: 0 },
  }, null, 2));

  const child = spawn(process.execPath, [serverScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      KAOYAN_NOTE_PORT: String(notePort),
      KAOYAN_NOTES_ROOT: notesRoot,
      KAOYAN_ASSISTANT_ROOT: assistantRoot,
      KAOYAN_AI_CONFIG_PATH: aiConfigPath,
      QWEN_API_KEY: '',
      DASHSCOPE_API_KEY: '',
      GEMINI_API_KEY: '',
      KIMI_API_KEY: '',
      MOONSHOT_API_KEY: '',
    },
    stdio: 'ignore',
    windowsHide: true,
  });

  const baseUrl = `http://127.0.0.1:${notePort}`;
  const payload = {
    noteUid: 'note_test_background_name_001',
    imageDataUrl: tinyPng,
    kind: 'single',
    remark: '高数 p108 3.1题 错因：切线条件遗漏',
  };

  try {
    await waitForHealth(baseUrl, child);
    const firstResponse = await fetch(`${baseUrl}/save-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 202);
    assert.equal(first.aiStatus, 'pending');

    let completed = null;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const replayResponse = await fetch(`${baseUrl}/save-note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const replay = await replayResponse.json();
      if (replay.aiStatus === 'complete') {
        completed = replay;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.ok(completed, 'background naming did not complete');
    assert.equal(completed.idempotentReplay, true);
    assert.equal(completed.metadata.naming.model, 'successful-test-model');
    assert.notEqual(completed.filePath, first.filePath);
    assert.ok(fs.existsSync(completed.filePath));
    assert.equal(fs.existsSync(first.filePath), false);

    const subjectDir = path.dirname(completed.filePath);
    const imageFiles = fs.readdirSync(subjectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:png|jpe?g|webp)$/i.test(entry.name));
    assert.equal(imageFiles.length, 1);
    const metadataIndex = JSON.parse(fs.readFileSync(path.join(subjectDir, '.metadata', 'metadata.json'), 'utf8'));
    assert.equal(metadataIndex.filter((item) => item.noteUid === payload.noteUid).length, 1);
    const learningData = JSON.parse(fs.readFileSync(path.join(assistantRoot, 'learning-data.json'), 'utf8'));
    assert.equal(learningData.cards.filter((card) => card.noteUid === payload.noteUid && card.kind === 'mistake').length, 1);
  } finally {
    await stopChild(child);
    await new Promise((resolve) => fakeAi.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
