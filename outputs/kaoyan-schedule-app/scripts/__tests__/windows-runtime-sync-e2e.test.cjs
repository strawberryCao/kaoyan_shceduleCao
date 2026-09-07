const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { provisionRuntimeLayout, resolveRuntimePaths } = require('../runtime-paths.cjs');
const { createDevice, authenticateRequest } = require('../sync-device-auth.cjs');
const { createSyncHttpApi } = require('../sync-http-api.cjs');
const { createSyncStore } = require('../sync-core.cjs');
const { writeWindowsSyncConfig } = require('../windows-sync-config.cjs');
const { run: runWindowsSync } = require('../windows-sync-service.cjs');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Windows note process exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Windows note process did not become ready.');
}

test('the real Windows note and sync processes converge with Mac in one cycle', { timeout: 20_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-runtime-sync-e2e-'));
  const authority = createSyncStore({
    databasePath: path.join(root, 'mac', 'authority.sqlite'),
    assetsRoot: path.join(root, 'mac', 'assets'),
  });
  const deviceConfigPath = path.join(root, 'mac', 'sync-devices.json');
  const credentials = createDevice(deviceConfigPath, { deviceId: 'windows-e2e', label: 'E2E Windows' });
  const api = createSyncHttpApi({ store: authority, authenticate: (request) => authenticateRequest(request, deviceConfigPath) });
  const authorityServer = http.createServer(async (request, response) => {
    if (!await api.handle(request, response)) response.writeHead(404).end();
  });
  await new Promise((resolve) => authorityServer.listen(0, '127.0.0.1', resolve));

  const windowsRoot = path.join(root, 'windows');
  const runtime = resolveRuntimePaths({
    platform: 'win32',
    env: { KAOYAN_RUNTIME_LAYOUT: 'managed', KAOYAN_RUNTIME_ROOT: windowsRoot },
    homeDir: windowsRoot,
  });
  provisionRuntimeLayout(runtime);
  writeWindowsSyncConfig(runtime, {
    deviceId: 'windows-e2e',
    baseUrl: `http://127.0.0.1:${authorityServer.address().port}`,
    token: credentials.token,
  });
  authority.queueLocalMutation({
    deviceId: 'mac-local',
    entityType: 'learning-note',
    entityId: 'mac-existing-note',
    mutation: {
      kind: 'patch',
      source: 'human',
      fields: { noteUid: 'mac-existing-note', capturedDate: '2026-09-05', title: '来自 Mac', subject: '英语' },
    },
  });

  const notePort = await freePort();
  const internalSyncToken = 'runtime-e2e-internal-token-that-is-long-enough';
  const noteProcess = spawn(process.execPath, [path.join(__dirname, '..', 'note-server.cjs')], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: {
      ...process.env,
      KAOYAN_RUNTIME_LAYOUT: 'managed',
      KAOYAN_RUNTIME_ROOT: runtime.runtimeRoot,
      KAOYAN_NOTES_ROOT: runtime.notesRoot,
      KAOYAN_ASSISTANT_ROOT: runtime.assistantRoot,
      KAOYAN_NOTE_PORT: String(notePort),
      KAOYAN_SYNC_ROLE: 'windows-replica',
      KAOYAN_SYNC_DEVICE_ID: 'windows-e2e',
      KAOYAN_INTERNAL_SYNC_TOKEN: internalSyncToken,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  noteProcess.stderr.on('data', (chunk) => { stderr += String(chunk); });
  t.after(async () => {
    if (noteProcess.exitCode === null) noteProcess.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => noteProcess.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    authorityServer.closeAllConnections?.();
    await new Promise((resolve) => authorityServer.close(resolve));
    authority.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const noteBaseUrl = `http://127.0.0.1:${notePort}`;
  await waitForHealth(noteBaseUrl, noteProcess);

  const save = await fetch(`${noteBaseUrl}/save-material-note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      noteUid: 'windows-created-note',
      title: 'Windows 本地速记',
      remark: '先落本机，再交给 Mac',
      subject: '数据结构',
      facets: ['quick'],
      files: [],
    }),
  });
  assert.equal(save.status, 201, stderr);
  assert.equal((await save.json()).sync.state, 'queued');

  await runWindowsSync({
    once: true,
    runtimePaths: runtime,
    internalSyncToken,
    notePort,
  });
  assert.equal(authority.getEntity('learning-note', 'windows-created-note').document.remark, '先落本机，再交给 Mac');
  const status = await (await fetch(`${noteBaseUrl}/replica/status`)).json();
  assert.equal(status.pending, 0);
  assert.equal(status.acknowledged, 1);
  const snapshot = await (await fetch(`${noteBaseUrl}/learning-data`)).json();
  const titles = Object.values(snapshot.days).flatMap((day) => day.autoNotes || []).map((note) => note.title);
  assert.ok(titles.includes('Windows 本地速记'));
  assert.ok(titles.includes('来自 Mac'));
  const workerStatus = JSON.parse(fs.readFileSync(path.join(runtime.runRoot, 'windows-sync-status.json'), 'utf8'));
  assert.equal(workerStatus.state, 'synchronized');
  assert.equal(workerStatus.uiNotification, 'delivered');
});
