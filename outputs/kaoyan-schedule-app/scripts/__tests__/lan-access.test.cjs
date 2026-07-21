const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');
const serverScript = path.join(projectRoot, 'scripts', 'note-server.cjs');
const proxyHeaders = { 'X-Kaoyan-LAN-Proxy': '1' };
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

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`note server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The server may still be loading its modules.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('note server did not become healthy');
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

async function openCanvasEvents(baseUrl) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/canvas-projects/events`, {
    headers: proxyHeaders,
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream\b/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const nextCanvasEvent = async () => {
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim();
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (event === 'canvas-project' && data) return JSON.parse(data);
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error('canvas event stream closed');
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
    }
  };

  return {
    nextCanvasEvent,
    close() {
      controller.abort();
      reader.cancel().catch(() => {});
    },
  };
}

test('LAN access needs no device authentication and exposes canvas plus learning CRUD routes only', { timeout: 15_000 }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-lan-access-'));
  const assistantRoot = path.join(tempRoot, 'assistant');
  const notesRoot = path.join(tempRoot, 'notes');
  fs.mkdirSync(assistantRoot, { recursive: true });
  fs.writeFileSync(path.join(assistantRoot, 'ai-providers.json'), JSON.stringify({
    providers: {
      gemini: { apiKey: 'lan-test-secret-key', model: 'gemini-test-model' },
    },
    routing: { timeoutMs: 12_345 },
    extensionField: { preserve: true },
  }, null, 2));
  const port = await reservePort();
  const child = spawn(process.execPath, [serverScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      KAOYAN_NOTE_PORT: String(port),
      KAOYAN_NOTES_ROOT: notesRoot,
      KAOYAN_ASSISTANT_ROOT: assistantRoot,
      QWEN_API_KEY: '',
      DASHSCOPE_API_KEY: '',
      GEMINI_API_KEY: '',
      KIMI_API_KEY: '',
      MOONSHOT_API_KEY: '',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(async () => {
    await stopChild(child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child);

  const localHealth = await fetch(`${baseUrl}/health`);
  assert.equal(localHealth.status, 200, 'loopback desktop access must keep its existing routes');

  const localAiConfig = await fetch(`${baseUrl}/ai/config`);
  assert.equal(localAiConfig.status, 200);
  const initialAiConfig = await localAiConfig.json();
  assert.ok(initialAiConfig.taskDefinitions.some((task) => task.id === 'note_naming'));
  assert.ok(initialAiConfig.taskDefinitions.find((task) => task.id === 'note_enrichment').parameters.some((parameter) => parameter.id === 'maxCards'));
  assert.ok(initialAiConfig.taskDefinitions.find((task) => task.id === 'canvas_organization').parameters.some((parameter) => parameter.id === 'layoutDirection'));
  assert.doesNotMatch(JSON.stringify(initialAiConfig), /apiKey/i);
  assert.doesNotMatch(JSON.stringify(initialAiConfig), /lan-test-secret-key/);
  const saveAiConfig = await fetch(`${baseUrl}/ai/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks: {
      note_naming: { customInstructions: '命名不超过 12 个字。', temperature: 0.2, options: { titleMaxLength: 12 } },
      note_enrichment: { options: { maxCards: 1, goodQuestionPolicy: 'explicit_only' } },
    } }),
  });
  assert.equal(saveAiConfig.status, 200);
  const savedAiConfig = await saveAiConfig.json();
  assert.equal(savedAiConfig.tasks.note_naming.customInstructions, '命名不超过 12 个字。');
  assert.equal(savedAiConfig.tasks.note_naming.temperature, 0.2);
  assert.equal(savedAiConfig.tasks.note_naming.options.titleMaxLength, 12);
  assert.equal(savedAiConfig.tasks.note_enrichment.options.maxCards, 1);
  const storedAiConfig = JSON.parse(fs.readFileSync(path.join(assistantRoot, 'ai-providers.json'), 'utf8'));
  assert.deepEqual(storedAiConfig.tasks, savedAiConfig.tasks);
  assert.equal(storedAiConfig.providers.gemini.apiKey, 'lan-test-secret-key');
  assert.deepEqual(storedAiConfig.extensionField, { preserve: true });

  const directCanvas = await fetch(`${baseUrl}/canvas-projects`, { headers: proxyHeaders });
  assert.equal(directCanvas.status, 200);

  const noteImageDir = path.join(notesRoot, '数据结构');
  const noteImagePath = path.join(noteImageDir, 'lan-source.png');
  fs.mkdirSync(noteImageDir, { recursive: true });
  fs.writeFileSync(noteImagePath, Buffer.from(tinyPng.split(',')[1], 'base64'));
  const noteFile = await fetch(`${baseUrl}/note-file?path=${encodeURIComponent(noteImagePath)}`, {
    headers: proxyHeaders,
  });
  assert.equal(noteFile.status, 200);
  assert.match(noteFile.headers.get('content-type') || '', /^image\/png\b/);
  assert.ok((await noteFile.arrayBuffer()).byteLength > 0);

  const document = {
    id: 'ipad-canvas-001',
    version: 1,
    title: 'iPad 手写测试',
    images: [],
    texts: [{
      id: 'text-sync-1', kind: 'text', text: 'Windows 与 iPad 都要同步这段文字',
      x: 120, y: 160, width: 300, height: 96, fontSize: 18, color: '#403329', z: 2,
    }],
    anchors: [
      { id: 'anchor-text-sync', nodeId: 'text-sync-1', nodeKind: 'text', shape: 'point', x: 1, y: 0.5, width: 0, height: 0, label: '文字' },
      { id: 'anchor-note-sync', nodeId: 'note-sync-1', nodeKind: 'annotation', shape: 'point', x: 0, y: 0.5, width: 0, height: 0, label: '批注' },
    ],
    annotations: [{
      id: 'note-sync-1', kind: 'annotation', text: '这条批注也必须同步',
      x: 520, y: 160, width: 280, height: 110, anchorIds: [], relationType: '解释', color: '#eca76d', z: 3,
    }],
    relations: [{
      id: 'arrow-sync-1', kind: 'arrow', fromAnchorId: 'anchor-text-sync', toAnchorId: 'anchor-note-sync',
      relationType: '我的自定义箭头说明', color: '#a35d30', z: 4,
    }],
    strokes: [{
      id: 'stroke-1',
      kind: 'ink',
      tool: 'pen',
      points: [{ x: 10, y: 20, pressure: 0.5 }, { x: 30, y: 40, pressure: 0.8 }],
      color: '#1f2937',
      width: 3,
      opacity: 1,
      z: 1,
    }],
    groups: [],
    viewport: { zoom: 1, scrollLeft: 0, scrollTop: 0 },
  };
  const save = await fetch(`${baseUrl}/canvas-projects/ipad-canvas-001`, {
    method: 'PUT',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ document, expectedRevision: 0, clientId: 'ipad-client' }),
  });
  assert.equal(save.status, 200);
  const savePayload = await save.json();
  assert.equal(savePayload.document.syncRevision, 1);
  assert.equal(savePayload.summary.syncRevision, 1);
  assert.equal(savePayload.document.texts[0].text, 'Windows 与 iPad 都要同步这段文字');
  assert.equal(savePayload.document.annotations[0].text, '这条批注也必须同步');
  assert.equal(savePayload.document.relations[0].relationType, '我的自定义箭头说明');
  assert.equal(savePayload.document.anchors[1].nodeId, 'note-sync-1');

  const events = await openCanvasEvents(baseUrl);
  t.after(() => events.close());
  const activeSelectionPromise = fetch(`${baseUrl}/canvas-projects/active`, {
    method: 'POST',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'ipad-canvas-001', clientId: 'ipad-client' }),
  });
  const [activeSelection, activeSelectionEvent] = await Promise.all([activeSelectionPromise, events.nextCanvasEvent()]);
  assert.equal(activeSelection.status, 200);
  const activeSelectionPayload = await activeSelection.json();
  assert.deepEqual(activeSelectionEvent, activeSelectionPayload.active);
  assert.equal(activeSelectionEvent.type, 'active');
  assert.equal(activeSelectionEvent.projectId, 'ipad-canvas-001');
  assert.equal(activeSelectionEvent.sourceClientId, 'ipad-client');
  assert.equal(activeSelectionEvent.selectionRevision, 1);

  const reconnectingEvents = await openCanvasEvents(baseUrl);
  t.after(() => reconnectingEvents.close());
  assert.deepEqual(await reconnectingEvents.nextCanvasEvent(), activeSelectionEvent, 'new devices must receive the current canvas immediately');

  const liveStroke = {
    id: 'stroke_live_1',
    kind: 'ink',
    tool: 'pen',
    points: [
      { x: 100.25, y: 200.5, pressure: 0.45 },
      { x: 102.75, y: 203.5, pressure: 0.7 },
    ],
    color: '#315F9C',
    width: 4,
    opacity: 0.98,
    z: 2,
  };
  const liveStrokePromise = fetch(`${baseUrl}/canvas-projects/ipad-canvas-001/live-stroke`, {
    method: 'POST',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'ipad-client', stroke: liveStroke }),
  });
  const [liveStrokeResponse, liveStrokeEvent] = await Promise.all([liveStrokePromise, events.nextCanvasEvent()]);
  assert.equal(liveStrokeResponse.status, 202);
  assert.deepEqual(liveStrokeEvent, {
    type: 'live-stroke',
    projectId: 'ipad-canvas-001',
    sourceClientId: 'ipad-client',
    stroke: { ...liveStroke, color: '#315f9c' },
  });
  const afterLiveStroke = await fetch(`${baseUrl}/canvas-projects/ipad-canvas-001`, { headers: proxyHeaders });
  const afterLiveStrokePayload = await afterLiveStroke.json();
  assert.equal(afterLiveStrokePayload.document.strokes.length, 1, 'live strokes must never be persisted');
  assert.equal(afterLiveStrokePayload.document.strokes[0].id, 'stroke-1');

  const invalidLiveStroke = await fetch(`${baseUrl}/canvas-projects/ipad-canvas-001/live-stroke`, {
    method: 'POST',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: '', stroke: liveStroke }),
  });
  assert.equal(invalidLiveStroke.status, 400);

  const tooManyPoints = await fetch(`${baseUrl}/canvas-projects/ipad-canvas-001/live-stroke`, {
    method: 'POST',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: 'ipad-client',
      stroke: { ...liveStroke, points: Array.from({ length: 4097 }, () => ({ x: 1, y: 2, pressure: 0.5 })) },
    }),
  });
  assert.equal(tooManyPoints.status, 400);

  const oversizedLiveStroke = await fetch(`${baseUrl}/canvas-projects/ipad-canvas-001/live-stroke`, {
    method: 'POST',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'ipad-client', stroke: liveStroke, padding: 'x'.repeat(513 * 1024) }),
  });
  assert.equal(oversizedLiveStroke.status, 413);

  const secondSavePromise = fetch(`${baseUrl}/canvas-projects/ipad-canvas-001`, {
    method: 'PUT',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      document: { ...savePayload.document, title: 'desktop update' },
      expectedRevision: 1,
      clientId: 'desktop-client',
    }),
  });
  const [secondSave, savedEvent] = await Promise.all([secondSavePromise, events.nextCanvasEvent()]);
  assert.equal(secondSave.status, 200);
  const secondSavePayload = await secondSave.json();
  assert.equal(secondSavePayload.document.syncRevision, 2);
  assert.deepEqual(savedEvent, {
    type: 'saved',
    projectId: 'ipad-canvas-001',
    revision: 2,
    updatedAt: secondSavePayload.document.updatedAt,
    sourceClientId: 'desktop-client',
  });

  const staleSave = await fetch(`${baseUrl}/canvas-projects/ipad-canvas-001`, {
    method: 'PUT',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      document: { ...savePayload.document, title: 'stale overwrite' },
      expectedRevision: 1,
      clientId: 'ipad-client',
    }),
  });
  assert.equal(staleSave.status, 409);
  const conflict = await staleSave.json();
  assert.equal(conflict.code, 'CANVAS_REVISION_CONFLICT');
  assert.equal(conflict.actualRevision, 2);
  const current = await fetch(`${baseUrl}/canvas-projects/ipad-canvas-001`, { headers: proxyHeaders });
  const currentPayload = await current.json();
  assert.equal(currentPayload.document.title, 'desktop update');
  assert.equal(currentPayload.document.syncRevision, 2);
  assert.deepEqual(currentPayload.document.texts, savePayload.document.texts);
  assert.deepEqual(currentPayload.document.annotations, savePayload.document.annotations);
  assert.deepEqual(currentPayload.document.anchors, savePayload.document.anchors);
  assert.deepEqual(currentPayload.document.relations, savePayload.document.relations);

  const list = await fetch(`${baseUrl}/canvas-projects`, { headers: proxyHeaders });
  assert.equal(list.status, 200);
  const listPayload = await list.json();
  assert.equal(listPayload.projects[0].strokeCount, 1);
  assert.equal(listPayload.projects[0].syncRevision, 2);

  const deleteCanvas = await fetch(`${baseUrl}/canvas-projects/ipad-canvas-001`, {
    method: 'DELETE',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 2, clientId: 'ipad-client' }),
  });
  assert.equal(deleteCanvas.status, 200);
  const deleteCanvasPayload = await deleteCanvas.json();
  assert.equal(deleteCanvasPayload.projectId, 'ipad-canvas-001');
  assert.equal(deleteCanvasPayload.recoverable, true);
  const deletedCanvas = await fetch(`${baseUrl}/canvas-projects/ipad-canvas-001`, { headers: proxyHeaders });
  assert.equal(deletedCanvas.status, 404);

  const learningEventsController = new AbortController();
  const learningEvents = await fetch(`${baseUrl}/learning-data/events`, {
    headers: proxyHeaders,
    signal: learningEventsController.signal,
  });
  assert.equal(learningEvents.status, 200);
  assert.match(learningEvents.headers.get('content-type') || '', /^text\/event-stream\b/);
  learningEventsController.abort();

  const learningBefore = await fetch(`${baseUrl}/learning-data`, { headers: proxyHeaders });
  assert.equal(learningBefore.status, 200);
  const learningBeforePayload = await learningBefore.json();
  const createLearningNote = await fetch(`${baseUrl}/learning-data/notes`, {
    method: 'POST',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: learningBeforePayload.revision,
      input: {
        noteUid: 'lan-learning-note',
        title: '局域网错题',
        remark: '检查边界条件',
        subject: '数据结构',
        knowledgePath: ['数据结构', '图'],
        noteType: 'mistake',
        createCard: true,
      },
    }),
  });
  assert.equal(createLearningNote.status, 201);
  let learningSnapshot = await createLearningNote.json();
  assert.equal(learningSnapshot.days[Object.keys(learningSnapshot.days)[0]].autoNotes[0].title, '局域网错题');
  assert.equal(learningSnapshot.cards.length, 1);

  const patchLearningNote = await fetch(`${baseUrl}/learning-data/notes/lan-learning-note`, {
    method: 'PATCH',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: learningSnapshot.revision,
      patch: { title: '局域网错题已修改', remark: '检查入度与出度', tags: ['错题'], noteType: 'mistake' },
    }),
  });
  assert.equal(patchLearningNote.status, 200);
  learningSnapshot = await patchLearningNote.json();
  assert.equal(Object.values(learningSnapshot.days).flatMap((day) => day.autoNotes)[0].title, '局域网错题已修改');

  const createLearningCard = await fetch(`${baseUrl}/learning-data/cards`, {
    method: 'POST',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: learningSnapshot.revision,
      input: { noteUid: 'lan-learning-note', kind: 'memory', front: '什么是入度？', back: '指向该点的边数' },
    }),
  });
  assert.equal(createLearningCard.status, 201);
  learningSnapshot = await createLearningCard.json();
  const extraCard = learningSnapshot.cards.find((card) => card.front === '什么是入度？');
  assert.ok(extraCard);

  const deleteLearningCard = await fetch(`${baseUrl}/learning-data/cards/${encodeURIComponent(extraCard.id)}`, {
    method: 'DELETE',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: learningSnapshot.revision }),
  });
  assert.equal(deleteLearningCard.status, 200);
  learningSnapshot = await deleteLearningCard.json();
  assert.equal(learningSnapshot.cards.some((card) => card.id === extraCard.id), false);

  const deleteLearningNote = await fetch(`${baseUrl}/learning-data/notes/lan-learning-note`, {
    method: 'DELETE',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: learningSnapshot.revision }),
  });
  assert.equal(deleteLearningNote.status, 200);
  learningSnapshot = await deleteLearningNote.json();
  assert.ok(learningSnapshot.deletedNotes['lan-learning-note']);
  assert.equal(Object.values(learningSnapshot.days).flatMap((day) => day.autoNotes).length, 0);

  const restoreLearningNote = await fetch(`${baseUrl}/learning-data/notes/lan-learning-note/restore`, {
    method: 'POST',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: learningSnapshot.revision }),
  });
  assert.equal(restoreLearningNote.status, 200);
  learningSnapshot = await restoreLearningNote.json();
  assert.equal(Object.values(learningSnapshot.days).flatMap((day) => day.autoNotes)[0].title, '局域网错题已修改');
  assert.equal(learningSnapshot.deletedNotes['lan-learning-note'], undefined);

  const patchLearningDay = await fetch(`${baseUrl}/learning-data/day`, {
    method: 'PATCH',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: learningSnapshot.revision,
      date: '2026-07-19',
      manual: { note: 'iPad 当日复盘' },
    }),
  });
  assert.equal(patchLearningDay.status, 200);
  learningSnapshot = await patchLearningDay.json();
  assert.equal(learningSnapshot.days['2026-07-19'].manual.note, 'iPad 当日复盘');

  const putManualRecords = await fetch(`${baseUrl}/learning-data/manual-records`, {
    method: 'PUT',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: learningSnapshot.revision,
      mode: 'merge',
      records: { '2026-07-20': { note: '局域网长期记录' } },
    }),
  });
  assert.equal(putManualRecords.status, 200);
  learningSnapshot = await putManualRecords.json();
  assert.equal(learningSnapshot.days['2026-07-20'].manual.note, '局域网长期记录');

  const staleLearningPatch = await fetch(`${baseUrl}/learning-data/notes/lan-learning-note`, {
    method: 'PATCH',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, patch: { title: '过期覆盖' } }),
  });
  assert.equal(staleLearningPatch.status, 409);
  const staleLearningPayload = await staleLearningPatch.json();
  assert.equal(staleLearningPayload.code, 'REVISION_CONFLICT');

  const publish = await fetch(`${baseUrl}/save-note`, {
    method: 'POST',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      noteUid: 'note_ipad_canvas_001',
      imageDataUrl: tinyPng,
      kind: 'canvas',
      remark: 'iPad 画布发布测试',
    }),
  });
  assert.equal(publish.status, 202);

  const blockedHealth = await fetch(`${baseUrl}/health`, { headers: proxyHeaders });
  assert.equal(blockedHealth.status, 403);
  const blockedAiConfig = await fetch(`${baseUrl}/ai/config`, { headers: proxyHeaders });
  assert.equal(blockedAiConfig.status, 403);
  const blockedAiConfigSave = await fetch(`${baseUrl}/ai/config`, {
    method: 'PUT',
    headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks: {} }),
  });
  assert.equal(blockedAiConfigSave.status, 403);
  const blockedOrganizer = await fetch(`${baseUrl}/organizer/run`, {
    method: 'POST',
    headers: proxyHeaders,
  });
  assert.equal(blockedOrganizer.status, 403);
  const querySmuggling = await fetch(`${baseUrl}/canvas-projects?path=health`, { headers: proxyHeaders });
  assert.equal(querySmuggling.status, 403);
  const learningQuerySmuggling = await fetch(`${baseUrl}/learning-data?path=health`, { headers: proxyHeaders });
  assert.equal(learningQuerySmuggling.status, 403);
  const noteFileQuerySmuggling = await fetch(`${baseUrl}/note-file?path=${encodeURIComponent(noteImagePath)}&extra=1`, { headers: proxyHeaders });
  assert.equal(noteFileQuerySmuggling.status, 403);
  const gatewayPolicy = fs.readFileSync(path.join(projectRoot, 'scripts', 'lan-gateway-policy.cjs'), 'utf8');
  assert.match(gatewayPolicy, /api\/learning-data/);
  assert.match(gatewayPolicy, /api\/note-file/);
  assert.match(gatewayPolicy, /api\/learning-data\/day/);
  assert.match(gatewayPolicy, /api\/learning-data\/manual-records/);
});
