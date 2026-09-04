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
    assert.ok(
      path.relative(notesRoot, first.filePath).split(path.sep).includes('.assets'),
      `provisional image should be private: ${first.filePath}`,
    );
    assert.ok(
      path.relative(notesRoot, first.filePath).split(path.sep).includes('pending'),
      `provisional image should stay in the pending asset store: ${first.filePath}`,
    );
    assert.equal(first.metadata.subjectLocked, false);
    assert.equal(first.metadata.attachments.length, 1);
    assert.equal(first.metadata.attachments[0].filePath, first.filePath);
    assert.equal(first.metadata.attachments[0].name, first.fileName);
    const subjectDir = path.join(notesRoot, path.relative(notesRoot, first.filePath).split(path.sep)[0]);
    const visibleRootImages = fs.readdirSync(subjectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:png|jpe?g|webp)$/i.test(entry.name));
    assert.equal(visibleRootImages.length, 0);

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

test('runs naming once after a new save, never on replay, and keeps manual retry explicit', { timeout: 15_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-note-naming-'));
  const assistantRoot = path.join(tempRoot, 'assistant');
  const notesRoot = path.join(tempRoot, 'notes');
  fs.mkdirSync(assistantRoot, { recursive: true });

  const aiPort = await reservePort();
  const notePort = await reservePort();
  let fakeAiRequests = 0;
  const fakeAi = http.createServer((request, response) => {
    fakeAiRequests += 1;
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
              knowledgePoint: '导数与切线',
              wrongReason: '漏看切线条件',
              wrongReasonPath: ['粗心大意', '审题疏漏', '看漏条件'],
              wrongReasonSource: 'explicit_image',
              wrongReasonEvidence: '图片右侧手写批注“切线条件漏了”',
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
    remark: '高数 p108 3.1题 错题',
  };

  try {
    await waitForHealth(baseUrl, child);
    const preflightResponse = await fetch(`${baseUrl}/search`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-kaoyan-ai-action',
      },
    });
    assert.equal(preflightResponse.status, 204);
    assert.match(
      preflightResponse.headers.get('access-control-allow-headers') || '',
      /X-Kaoyan-AI-Action/i,
      'browser preflight must allow the explicit AI action header',
    );
    const firstResponse = await fetch(`${baseUrl}/save-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 202);
    assert.equal(first.aiStatus, 'pending');

    const automaticDeadline = Date.now() + 5_000;
    while (Date.now() < automaticDeadline && fakeAiRequests < 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(fakeAiRequests, 1, 'a newly saved note must run exactly one naming/classification request');

    const replayResponse = await fetch(`${baseUrl}/save-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const replay = await replayResponse.json();
    assert.equal(replayResponse.status, 200);
    assert.equal(replay.idempotentReplay, true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fakeAiRequests, 1, 'an idempotent save replay must not enqueue AI again');

    const blockedRenameResponse = await fetch(`${baseUrl}/learning-data/notes/${payload.noteUid}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(blockedRenameResponse.status, 409);
    assert.equal(fakeAiRequests, 1, 'a request without an explicit user action marker must be blocked before AI');

    const renameResponse = await fetch(`${baseUrl}/learning-data/notes/${payload.noteUid}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kaoyan-AI-Action': 'user' },
      body: '{}',
    });
    const renameBody = await renameResponse.json();
    assert.equal(renameResponse.status, 202, JSON.stringify(renameBody));
    let renameJob = renameBody.job;
    const renameDeadline = Date.now() + 5_000;
    while (Date.now() < renameDeadline && ['queued', 'processing'].includes(renameJob.status)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      renameJob = await fetch(`${baseUrl}/ai/jobs/${renameJob.id}`)
        .then((response) => response.json())
        .then((body) => body.job);
    }
    assert.equal(renameJob.status, 'completed', renameJob.error || renameJob.message);
    assert.equal(fakeAiRequests, 2, 'one explicit rename must make exactly one additional AI request');

    const completedResponse = await fetch(`${baseUrl}/save-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kaoyan-AI-Action': 'user' },
      body: JSON.stringify(payload),
    });
    const completed = await completedResponse.json();
    assert.equal(completedResponse.status, 200);
    assert.equal(completed.idempotentReplay, true);
    assert.equal(completed.metadata.naming.model, 'successful-test-model');
    assert.equal(completed.metadata.naming.ruleId, 'tank-number');
    assert.equal(completed.metadata.naming.ruleValue, '250626-088');
    assert.equal(completed.metadata.title, '250626-088');
    assert.deepEqual(completed.metadata.learning.knowledgePath, ['高等数学', '导数与切线']);
    assert.equal(completed.metadata.learning.wrongReason, '漏看切线条件');
    assert.deepEqual(completed.metadata.learning.wrongReasonPath, ['粗心大意', '审题疏漏', '看漏条件']);
    assert.equal(completed.metadata.learning.wrongReasonSource, 'explicit_image');
    assert.match(completed.metadata.learning.visualEvidence.wrongReasonEvidence, /切线条件漏了/);
    assert.match(path.basename(completed.filePath), /250626-088/);
    assert.notEqual(completed.filePath, first.filePath);
    assert.ok(fs.existsSync(completed.filePath));
    assert.equal(fs.existsSync(first.filePath), false);
    assert.equal(completed.metadata.attachments.length, 1);
    assert.equal(completed.metadata.attachments[0].filePath, completed.filePath);
    assert.equal(completed.metadata.attachments[0].name, completed.fileName);
    assert.equal(completed.metadata.learning.filePath, completed.filePath);
    assert.equal(completed.metadata.learning.attachments[0].filePath, completed.filePath);

    const subjectDir = path.dirname(completed.filePath);
    const imageFiles = fs.readdirSync(subjectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:png|jpe?g|webp)$/i.test(entry.name));
    assert.equal(imageFiles.length, 1);
    const metadataIndex = JSON.parse(fs.readFileSync(path.join(subjectDir, '.metadata', 'metadata.json'), 'utf8'));
    assert.equal(metadataIndex.filter((item) => item.noteUid === payload.noteUid).length, 1);
    const learningData = JSON.parse(fs.readFileSync(path.join(assistantRoot, 'learning-data.json'), 'utf8'));
    assert.equal(learningData.cards.filter((card) => card.noteUid === payload.noteUid && card.kind === 'mistake').length, 1);

    // Migrated notes may keep a descriptive sidecar filename while metadata.id
    // is already the stable noteUid. A manual retry must keep the actual path
    // in the receipt; otherwise the background worker exits before calling AI.
    const receiptPath = path.join(assistantRoot, 'note-save-receipts', `${payload.noteUid}.json`);
    const migratedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const migratedSidecarPath = path.join(path.dirname(migratedReceipt.sidecarPath), 'legacy-descriptive-name.note.json');
    const migratedMetadata = JSON.parse(fs.readFileSync(migratedReceipt.sidecarPath, 'utf8'));
    migratedMetadata.id = payload.noteUid;
    fs.renameSync(migratedReceipt.sidecarPath, migratedSidecarPath);
    fs.writeFileSync(migratedSidecarPath, JSON.stringify(migratedMetadata, null, 2), 'utf8');
    migratedReceipt.sidecarPath = migratedSidecarPath;
    fs.writeFileSync(receiptPath, JSON.stringify(migratedReceipt, null, 2), 'utf8');

    const retryResponse = await fetch(`${baseUrl}/learning-data/notes/${payload.noteUid}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kaoyan-AI-Action': 'user' },
      body: '{}',
    });
    const retryBody = await retryResponse.json();
    assert.equal(retryResponse.status, 202, JSON.stringify(retryBody));
    let retryJob = retryBody.job;
    const retryDeadline = Date.now() + 5_000;
    while (Date.now() < retryDeadline && ['queued', 'processing'].includes(retryJob.status)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      retryJob = await fetch(`${baseUrl}/ai/jobs/${retryJob.id}`)
        .then((response) => response.json())
        .then((body) => body.job);
    }
    assert.equal(retryJob.status, 'completed', retryJob.error || retryJob.message);
    const repairedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(repairedReceipt.sidecarPath, migratedSidecarPath);
    assert.ok(fs.existsSync(repairedReceipt.sidecarPath));

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
      subject: '高等数学',
      knowledgePath: ['高等数学', 'TargetPoint'],
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

    const targetDir = path.join(notesRoot, '高等数学');
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

test('legacy text notes without local sidecars remain manually editable', { timeout: 15_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-legacy-text-edit-'));
  const assistantRoot = path.join(tempRoot, 'assistant');
  const notesRoot = path.join(tempRoot, 'notes');
  const notePort = await reservePort();
  const noteUid = 'legacy_text_without_sidecar_001';
  fs.mkdirSync(assistantRoot, { recursive: true });
  fs.writeFileSync(path.join(assistantRoot, 'ai-providers.json'), JSON.stringify({ providers: {} }), 'utf8');
  fs.writeFileSync(path.join(assistantRoot, 'learning-data.json'), JSON.stringify({
    version: 1,
    revision: 1,
    updatedAt: '2026-08-05T00:00:00.000Z',
    days: {
      '2026-08-05': {
        manual: { completedTaskIds: [], note: '', debt: '', mistakes: '' },
        autoNotes: [{
          noteUid,
          capturedDate: '2026-08-05',
          title: '旧标题',
          subject: '默认文件夹',
          remark: '只有文字，没有本地图片 sidecar。',
          filePath: '',
          tags: [],
          knowledgePath: [],
          organizationStatus: 'pending',
          classificationSource: 'ai',
          reviewStatus: 'pending',
          decisionRevision: 0,
          manualCreated: false,
        }],
      },
    },
    cards: [],
    deletedNotes: {},
  }, null, 2), 'utf8');

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
  try {
    await waitForHealth(baseUrl, child);
    const response = await fetch(`${baseUrl}/learning-data/notes/${noteUid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patch: {
          title: '手动修改后的标题',
          subject: '高等数学',
          knowledgePath: ['高等数学', '函数性质'],
        },
      }),
    });
    const snapshot = await response.json();
    assert.equal(response.status, 200);
    const note = Object.values(snapshot.days).flatMap((day) => day.autoNotes)
      .find((item) => item.noteUid === noteUid);
    assert.equal(note.title, '手动修改后的标题');
    assert.equal(note.subject, '高等数学');
    assert.deepEqual(note.knowledgePath, ['高等数学', '函数性质']);
    assert.equal(note.reviewStatus, 'corrected');
  } finally {
    await stopChild(child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
