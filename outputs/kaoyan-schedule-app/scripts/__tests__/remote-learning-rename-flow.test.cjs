'use strict';

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

const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`note server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The child is still starting.
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

test('AI rename accepts a GitHub-backed learning note without a local sidecar', { timeout: 20_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-remote-rename-'));
  const assistantRoot = path.join(root, 'assistant');
  const notesRoot = path.join(root, 'notes');
  const cloneRoot = path.join(root, 'clone');
  const assetRoot = path.join(cloneRoot, 'data', 'assets');
  fs.mkdirSync(assistantRoot, { recursive: true });
  fs.mkdirSync(assetRoot, { recursive: true });
  fs.mkdirSync(notesRoot, { recursive: true });

  const noteUid = 'remote-learning-only-note';
  const remotePath = `github://data/assets/${noteUid}.png`;
  fs.writeFileSync(path.join(assetRoot, `${noteUid}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(assistantRoot, 'learning-data.json'), JSON.stringify({
    version: 1,
    revision: 1,
    updatedAt: '2026-08-12T00:00:00.000Z',
    days: {
      '2026-08-12': {
        manual: { completedTaskIds: [], note: '', debt: '', mistakes: '' },
        autoNotes: [{
          noteUid,
          capturedDate: '2026-08-12',
          title: '错题 难 好题 没有分析条件',
          subject: '默认文件夹',
          remark: '错题 难 好题 没有分析条件',
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
          filePath: remotePath,
          attachments: [{
            id: 'primary-image', kind: 'image', name: `${noteUid}.png`, mimeType: 'image/png',
            filePath: remotePath, createdAt: '2026-08-12T00:00:00.000Z',
          }],
          tags: [], knowledgePath: ['默认文件夹'], noteType: 'note',
          organizationStatus: 'pending', classificationSource: 'local', reviewStatus: 'pending',
          decisionRevision: 0, userEditedFields: ['remark'], sourceType: 'single-capture',
        }],
      },
    },
    cards: [],
    deletedNotes: {},
  }, null, 2));

  const aiPort = await reservePort();
  const notePort = await reservePort();
  const fakeAi = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        subject: '高等数学',
        knowledgePoint: '定积分与数列极限',
        aliases: { subject: ['高数'], knowledgePoint: ['含参积分极限'] },
        title: '夹逼准则求含参积分极限',
        summary: '利用夹逼准则处理含参定积分极限。',
        tags: ['定积分', '夹逼准则'],
        questionType: '极限计算',
        questionTypePath: ['极限', '夹逼准则', '极限计算'],
        learningTypePath: ['题型方法', '标准步骤'],
        goodQuestionType: '方法好题',
        wrongReason: '没有先分析条件与结论',
        wrongReasonPath: ['思路与方法', '条件分析', '未分析条件'],
        wrongReasonSource: 'explicit_remark',
        wrongReasonConfidence: 1,
        intent: { isQuestion: true, isMistake: true, isGood: true, shouldMemorize: false },
        items: [], cards: [], confidence: 0.96,
        reason: '原图包含数列参数、定积分与极限。',
      }) } }] }));
    });
  });
  await new Promise((resolve, reject) => {
    fakeAi.once('error', reject);
    fakeAi.listen(aiPort, '127.0.0.1', resolve);
  });

  const configPath = path.join(assistantRoot, 'ai-providers.json');
  fs.writeFileSync(configPath, JSON.stringify({
    providers: {
      kimi: {
        enabled: true,
        apiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${aiPort}/v1`,
        models: [{ id: 'test-vision', capabilities: ['text', 'vision', 'json'], costTier: 1, qualityTier: 3 }],
      },
    },
    routing: { timeoutMs: 2_000, networkRetries: 0, jsonRepairRetries: 0 },
    tasks: {
      note_enrichment: { provider: 'kimi', model: 'test-vision', options: { collaborationMode: 'single_model' } },
    },
  }, null, 2));

  const child = spawn(process.execPath, [serverScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      KAOYAN_NOTE_PORT: String(notePort),
      KAOYAN_NOTES_ROOT: notesRoot,
      KAOYAN_ASSISTANT_ROOT: assistantRoot,
      KAOYAN_AI_CONFIG_PATH: configPath,
      KAOYAN_DATA_CLONE_PATH: cloneRoot,
      QWEN_API_KEY: '', DASHSCOPE_API_KEY: '', GEMINI_API_KEY: '', KIMI_API_KEY: '', MOONSHOT_API_KEY: '',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const baseUrl = `http://127.0.0.1:${notePort}`;

  try {
    await waitForHealth(baseUrl, child);
    const enqueueResponse = await fetch(`${baseUrl}/learning-data/notes/${noteUid}/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kaoyan-AI-Action': 'user' }, body: '{}',
    });
    const enqueued = await enqueueResponse.json();
    assert.equal(enqueueResponse.status, 202, JSON.stringify(enqueued));
    assert.equal(enqueued.accepted, true);

    let job = enqueued.job;
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline && ['queued', 'processing'].includes(job.status)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = await fetch(`${baseUrl}/ai/jobs/${job.id}`).then((response) => response.json()).then((body) => body.job);
    }
    assert.equal(job.status, 'completed', job.error || job.message);
    assert.equal(job.result.title, '夹逼准则求含参积分极限');
    assert.equal(job.result.subject, '高等数学');
    assert.equal(job.result.provider, 'kimi');

    const snapshot = await fetch(`${baseUrl}/learning-data`).then((response) => response.json());
    const note = findNote(snapshot, noteUid);
    assert.equal(note.title, '夹逼准则求含参积分极限');
    assert.equal(note.subject, '高等数学');
    assert.equal(note.remark, '错题 难 好题 没有分析条件');
    assert.ok(note.userEditedFields.includes('remark'));
    assert.equal(note.filePath, remotePath);
    assert.equal(note.reviewStatus, 'auto_applied');
    assert.equal(fs.readdirSync(notesRoot, { recursive: true }).length, 0, 'rename must not copy or move cloud assets');
  } finally {
    await stopChild(child);
    await new Promise((resolve) => fakeAi.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
