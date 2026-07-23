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
    assert.equal(learningData.cards.filter((card) => card.noteUid === noteUid).length, 0);
    assert.equal(learningData.days[Object.keys(learningData.days)[0]].autoNotes[0].subject, '默认文件夹');
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
              ruleId: 'tank-number',
              ruleValue: '250626-088',
              ruleEvidence: '缸号字段右侧',
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
    tasks: {
      note_naming: {
        namingRules: [{
          id: 'tank-number',
          name: '缸号命名',
          enabled: true,
          when: '图片中出现缸号字段',
          extract: '提取缸号字段值',
          titleTemplate: '{value}',
          validationHint: '格式如 250626-088',
        }],
      },
    },
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
    assert.equal(completed.metadata.naming.ruleId, 'tank-number');
    assert.equal(completed.metadata.naming.ruleValue, '250626-088');
    assert.equal(completed.metadata.title, '250626-088');
    assert.match(path.basename(completed.filePath), /250626-088/);
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

    const correctionResponse = await fetch(`${baseUrl}/learning-data/notes/${payload.noteUid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patch: {
          subject: '线性代数',
          knowledgePath: ['线性代数', '矩阵秩'],
          questionType: '计算题',
          wrongReason: '初等变换出错',
          organizationStatus: 'confirmed',
        },
      }),
    });
    const correctedSnapshot = await correctionResponse.json();
    assert.equal(correctionResponse.status, 200);
    const correctedNote = Object.values(correctedSnapshot.days)
      .flatMap((day) => day.autoNotes)
      .find((note) => note.noteUid === payload.noteUid);
    assert.equal(correctedNote.subject, '线性代数');
    assert.deepEqual(correctedNote.knowledgePath, ['线性代数', '矩阵秩']);
    assert.equal(correctedNote.classificationSource, 'manual');
    assert.equal(path.basename(path.dirname(correctedNote.filePath)), '线性代数');
    assert.ok(fs.existsSync(correctedNote.filePath));
    assert.equal(fs.existsSync(completed.filePath), false);
    assert.equal(correctedSnapshot.cards.find((card) => card.noteUid === payload.noteUid).subject, '线性代数');
  } finally {
    await stopChild(child);
    await new Promise((resolve) => fakeAi.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('review API is durable, idempotent, conflict guarded, and never reports file failures as success', { timeout: 20_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-note-review-'));
  const assistantRoot = path.join(tempRoot, 'assistant');
  const notesRoot = path.join(tempRoot, 'notes');
  fs.mkdirSync(assistantRoot, { recursive: true });
  const aiPort = await reservePort();
  const notePort = await reservePort();
  const slowAi = http.createServer((_request, _response) => {});
  await new Promise((resolve, reject) => {
    slowAi.once('error', reject);
    slowAi.listen(aiPort, '127.0.0.1', resolve);
  });
  const aiConfigPath = path.join(assistantRoot, 'ai-providers.json');
  fs.writeFileSync(aiConfigPath, JSON.stringify({
    providers: {
      gemini: {
        enabled: true,
        apiKey: 'test-key-not-a-real-secret',
        baseUrl: `http://127.0.0.1:${aiPort}/v1`,
        models: [{ id: 'slow-review-model', capabilities: ['text', 'vision', 'json'] }],
      },
    },
    routing: { timeoutMs: 10_000, networkRetries: 0, jsonRepairRetries: 0 },
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
  const noteUid = 'note_review_durable_001';
  const action = {
    noteUid,
    action: 'correct',
    operationId: 'review-correct-operation-1',
    expectedDecisionRevision: 0,
    patch: {
      subject: 'TargetSubject',
      knowledgePath: ['TargetSubject', 'TargetPoint'],
      questionType: 'Calculation',
      wrongReason: 'Manual correction',
    },
  };

  try {
    await waitForHealth(baseUrl, child);
    const savedResponse = await fetch(`${baseUrl}/save-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ noteUid, imageDataUrl: tinyPng, kind: 'single', remark: 'pending review' }),
    });
    const saved = await savedResponse.json();
    assert.equal(savedResponse.status, 202);

    const targetDir = path.join(notesRoot, 'TargetSubject');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, '.metadata'), 'blocks-sidecar-directory', 'utf8');
    const failedResponse = await fetch(`${baseUrl}/learning-data/note-review-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [action] }),
    });
    const failed = await failedResponse.json();
    assert.equal(failedResponse.status, 500);
    assert.equal(failed.ok, false);
    assert.equal(failed.results[0].ok, false);
    let snapshot = await (await fetch(`${baseUrl}/learning-data`)).json();
    let note = Object.values(snapshot.days).flatMap((day) => day.autoNotes).find((item) => item.noteUid === noteUid);
    assert.equal(note.reviewStatus, 'pending');
    assert.equal(note.decisionRevision, 0);

    const legacyFailureResponse = await fetch(`${baseUrl}/learning-data/notes/${noteUid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: action.patch }),
    });
    assert.notEqual(legacyFailureResponse.status, 200);
    snapshot = await (await fetch(`${baseUrl}/learning-data`)).json();
    note = Object.values(snapshot.days).flatMap((day) => day.autoNotes).find((item) => item.noteUid === noteUid);
    assert.equal(note.reviewStatus, 'pending');

    fs.unlinkSync(path.join(targetDir, '.metadata'));
    const correctedResponse = await fetch(`${baseUrl}/learning-data/note-review-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [action] }),
    });
    const corrected = await correctedResponse.json();
    assert.equal(correctedResponse.status, 200);
    assert.equal(corrected.ok, true);
    assert.equal(corrected.results[0].durable, true);
    note = Object.values(corrected.snapshot.days).flatMap((day) => day.autoNotes).find((item) => item.noteUid === noteUid);
    assert.equal(note.reviewStatus, 'corrected');
    assert.equal(note.decisionRevision, 1);
    assert.equal(note.lastReviewOperationId, action.operationId);
    assert.equal(fs.existsSync(note.filePath), true);
    const sidecarPath = path.join(path.dirname(note.filePath), '.metadata', `${path.parse(note.filePath).name}.note.json`);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert.equal(sidecar.learning.reviewStatus, 'corrected');
    assert.equal(sidecar.learning.decisionRevision, 1);

    const revisionAfterCorrect = corrected.snapshot.revision;
    const replayResponse = await fetch(`${baseUrl}/learning-data/note-review-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [action] }),
    });
    const replay = await replayResponse.json();
    assert.equal(replayResponse.status, 200);
    assert.equal(replay.results[0].replayed, true);
    assert.equal(replay.snapshot.revision, revisionAfterCorrect);

    const conflictResponse = await fetch(`${baseUrl}/learning-data/note-review-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{
        noteUid,
        action: 'ignore',
        operationId: 'review-ignore-stale',
        expectedDecisionRevision: 0,
      }] }),
    });
    const conflict = await conflictResponse.json();
    assert.equal(conflictResponse.status, 409);
    assert.equal(conflict.results[0].code, 'NOTE_REVIEW_CONFLICT');

    const ignoredResponse = await fetch(`${baseUrl}/learning-data/note-review-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{
        noteUid,
        action: 'ignore',
        operationId: 'review-ignore-operation-2',
        expectedDecisionRevision: 1,
      }] }),
    });
    const ignored = await ignoredResponse.json();
    assert.equal(ignoredResponse.status, 200);
    note = Object.values(ignored.snapshot.days).flatMap((day) => day.autoNotes).find((item) => item.noteUid === noteUid);
    assert.equal(note.reviewStatus, 'ignored');
    assert.equal(note.decisionRevision, 2);
    assert.equal(ignored.snapshot.cards.some((card) => card.noteUid === noteUid && card.status === 'active'), false);
    const ignoredSidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert.equal(ignoredSidecar.learning.reviewStatus, 'ignored');
    assert.deepEqual(ignoredSidecar.learning.cards, []);
  } finally {
    await stopChild(child);
    await new Promise((resolve) => slowAi.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
