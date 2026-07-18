const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAiRouter } = require('./ai-router.cjs');
const {
  CanvasDocumentStoreError,
  CanvasDocumentValidationError,
  assertCanvasId,
  createCanvasDocumentStore,
} = require('./canvas-document-store.cjs');
const { createLearningDataStore, formatDateInTimeZone, LearningDataConflictError } = require('./learning-data-store.cjs');
const { resolveNoteImage, revealNoteImage } = require('./note-file-access.cjs');
const { parseRemark } = require('./remark-parser.cjs');
const { loadQwenConfig } = require('./qwen-config.cjs');
const { unlinkFileIfExists } = require('./safe-file-ops.cjs');

const PORT = Number(process.env.KAOYAN_NOTE_PORT || 5174);
const NOTES_ROOT = process.env.KAOYAN_NOTES_ROOT || path.join(os.homedir(), 'Desktop', '笔记');
const ASSISTANT_ROOT = process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手');
const LAYOUT_PATH = path.join(ASSISTANT_ROOT, 'desktop-layout.json');
const ORGANIZER_STATE_PATH = path.join(ASSISTANT_ROOT, 'note-organizer-state.json');
const ORGANIZER_LOCK_PATH = path.join(ASSISTANT_ROOT, 'note-organizer.lock');
const AI_PROVIDER_CONFIG_PATH = process.env.KAOYAN_AI_CONFIG_PATH || path.join(ASSISTANT_ROOT, 'ai-providers.json');
const NOTE_SAVE_RECEIPTS_ROOT = path.join(ASSISTANT_ROOT, 'note-save-receipts');
const DEFAULT_SUBJECT = '默认文件夹';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const qwen = loadQwenConfig();
const learningData = createLearningDataStore({ assistantRoot: ASSISTANT_ROOT });
const canvasProjects = createCanvasDocumentStore({
  rootDir: path.join(ASSISTANT_ROOT, 'canvas-projects'),
});
const layoutEventClients = new Set();
const learningEventClients = new Set();
let noteAppReadyAt = null;
let aiRouter = null;
let aiRouterInitError = null;
let aiRouterConfigStamp = null;
let aiNamingQueue = Promise.resolve();
const aiNamingJobs = new Map();

function getFileStamp(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

function getAiRouter() {
  const stamp = `${getFileStamp(AI_PROVIDER_CONFIG_PATH)}|${getFileStamp(qwen.configPath)}`;
  if (aiRouterConfigStamp === stamp && aiRouter) return aiRouter;
  if (aiRouterConfigStamp === stamp && aiRouterInitError) return null;
  aiRouterConfigStamp = stamp;
  try {
    aiRouter = createAiRouter({ configPath: AI_PROVIDER_CONFIG_PATH });
    aiRouterInitError = null;
  } catch (error) {
    aiRouterInitError = error instanceof Error ? error.message : String(error);
  }
  return aiRouter;
}

getAiRouter();

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function allowedCorsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  if (origin === 'http://127.0.0.1:5173' || origin === 'http://localhost:5173') return origin;
  if (origin === 'null' && /\bElectron\//i.test(String(req.headers['user-agent'] || ''))) return origin;
  return false;
}

function sanitizeSegment(input, fallback = DEFAULT_SUBJECT, maxLength = 80) {
  return String(input || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._\s]+|[._\s]+$/g, '')
    .slice(0, maxLength) || fallback;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function canControlNoteApp(req) {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  if (origin === 'null' && /\bElectron\//i.test(String(req.headers['user-agent'] || ''))) {
    return true;
  }
  try {
    const url = new URL(origin);
    return url.protocol === 'http:'
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && url.port === '5173';
  } catch {
    return false;
  }
}

function launchNoteApp(flag = '--note-app') {
  return new Promise((resolve, reject) => {
    if (!['--note-app', '--close-note-app'].includes(flag)) {
      reject(new Error('不支持的笔记 App 操作'));
      return;
    }
    let electronExecutable;
    try {
      electronExecutable = require('electron');
    } catch (error) {
      reject(new Error(`找不到 Electron：${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    if (typeof electronExecutable !== 'string') {
      reject(new Error('无法确定 Electron 可执行文件路径'));
      return;
    }

    const child = spawn(electronExecutable, [PROJECT_ROOT, flag], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

function timestamp(input = new Date()) {
  const now = input instanceof Date && Number.isFinite(input.getTime()) ? input : new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const maxBytes = 80 * 1024 * 1024;
    let body = '';
    let receivedBytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (tooLarge) return;
      if (receivedBytes > maxBytes) {
        // Keep draining the request so the socket stays writable long enough
        // for the handler to return a real 413 response to the client.
        tooLarge = true;
        body = '';
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) reject(new Error('Payload too large'));
      else resolve(body);
    });
    req.on('error', reject);
  });
}

function decodeDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!match) {
    throw new Error('Invalid image data URL');
  }

  const mime = match[1].toLowerCase();
  const ext = mime.includes('jpeg') || mime.includes('jpg')
    ? 'jpg'
    : mime.includes('webp')
      ? 'webp'
      : mime.includes('gif')
        ? 'gif'
        : mime.includes('bmp')
          ? 'bmp'
          : 'png';
  return {
    buffer: Buffer.from(match[2], 'base64'),
    ext,
    mime,
    dataUrl: String(dataUrl),
  };
}

function metadataDir(subjectDir) {
  return path.join(subjectDir, '.metadata');
}

function metadataIndexPath(subjectDir) {
  return path.join(metadataDir(subjectDir), 'metadata.json');
}

function sidecarPathForId(subjectDir, id) {
  return path.join(metadataDir(subjectDir), `${id}.note.json`);
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeNoteUid(input) {
  if (input === undefined || input === null || input === '') {
    return crypto.randomUUID();
  }
  const noteUid = String(input).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(noteUid)) {
    throw new SyntaxError('noteUid 格式无效');
  }
  return noteUid;
}

function saveReceiptPath(noteUid) {
  return path.join(NOTE_SAVE_RECEIPTS_ROOT, `${noteUid}.json`);
}

function writeSaveReceipt(noteUid, metadata, learningSyncError = null) {
  fs.mkdirSync(NOTE_SAVE_RECEIPTS_ROOT, { recursive: true });
  const receipt = {
    schemaVersion: 1,
    noteUid,
    filePath: metadata.filePath,
    fileName: metadata.fileName,
    sidecarPath: sidecarPathForId(path.dirname(metadata.filePath), metadata.id),
    subject: metadata.subject,
    aiStatus: metadata.naming?.status || 'pending',
    learningSyncError,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(saveReceiptPath(noteUid), JSON.stringify(receipt, null, 2), 'utf8');
  return receipt;
}

function readSaveReceipt(noteUid) {
  const receipt = readJson(saveReceiptPath(noteUid), null);
  if (!receipt || receipt.noteUid !== noteUid || typeof receipt.sidecarPath !== 'string') {
    return null;
  }
  const metadata = readJson(receipt.sidecarPath, null);
  const filePath = metadata?.filePath || receipt.filePath;
  if (!metadata || metadata.noteUid !== noteUid || typeof filePath !== 'string' || !fs.existsSync(filePath)) {
    return null;
  }
  return {
    receipt,
    metadata,
    filePath,
    fileName: metadata.fileName || path.basename(filePath),
  };
}

function removeMetadataEntry(subjectDir, noteUid) {
  const indexPath = metadataIndexPath(subjectDir);
  const existing = readJson(indexPath, []);
  if (!Array.isArray(existing)) return;
  const next = existing.filter((item) => item?.noteUid !== noteUid);
  if (next.length === existing.length) return;
  fs.writeFileSync(indexPath, JSON.stringify(next, null, 2), 'utf8');
}

function syncLearningMetadata(metadata) {
  try {
    const currentCards = learningData.getSnapshot().cards.filter((card) => card.noteUid === metadata.noteUid);
    const cards = Array.isArray(metadata.learning?.cards) ? metadata.learning.cards : currentCards;
    const snapshot = learningData.syncNote(metadata, { enrichment: metadata.learning, cards });
    broadcastLearningData(snapshot);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function makeSaveResponse(saved, options = {}) {
  const aiStatus = saved.metadata.naming?.status || saved.receipt?.aiStatus || 'pending';
  return {
    ok: true,
    noteUid: saved.metadata.noteUid,
    filePath: saved.filePath,
    fileName: saved.fileName,
    metadata: saved.metadata,
    learningSyncError: saved.receipt?.learningSyncError ?? options.learningSyncError ?? null,
    notesRoot: NOTES_ROOT,
    aiStatus,
    provisional: aiStatus === 'pending',
    idempotentReplay: options.idempotentReplay === true,
  };
}

function appendMetadata(subjectDir, metadata) {
  const metaDir = metadataDir(subjectDir);
  fs.mkdirSync(metaDir, { recursive: true });
  const indexPath = metadataIndexPath(subjectDir);
  const legacyIndexPath = path.join(subjectDir, 'metadata.json');
  const existing = readJson(indexPath, readJson(legacyIndexPath, []));
  const list = Array.isArray(existing)
    ? existing.filter((item) => (
        item?.id !== metadata.id
        && item?.fileName !== metadata.fileName
        && (!metadata.noteUid || item?.noteUid !== metadata.noteUid)
      ))
    : [];
  list.push(metadata);
  fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), 'utf8');
}

function guessSubjectFromText(text) {
  const content = String(text || '');
  const rules = [
    ['高等数学', ['高等数学', '高数', '极限', '导数', '积分', '微分', '级数', '中值定理', '曲线积分', '多元函数']],
    ['线性代数', ['线性代数', '线代', '矩阵', '行列式', '特征值', '特征向量', '线性方程组', '秩']],
    ['概率论', ['概率论', '概率', '随机变量', '分布', '期望', '方差', '大数定律', '中心极限定理']],
    ['数据结构', ['数据结构', '链表', '栈', '队列', '树', '图', '排序', '查找', '堆', '哈希']],
    ['计算机组成', ['计算机组成', '组成原理', '计组', 'CPU', 'Cache', '存储器', '指令', '流水线', '总线']],
    ['操作系统', ['操作系统', '进程', '线程', '死锁', '分页', '段页', '文件系统', '调度']],
    ['计算机网络', ['计算机网络', '计网', '网络', 'TCP', 'UDP', 'IP', 'HTTP', 'DNS', '路由', '拥塞', '流量控制']],
    ['英语', ['英语', '单词', '阅读', '翻译', '作文', '长难句']],
  ];
  for (const [subject, keywords] of rules) {
    if (keywords.some((keyword) => content.toLowerCase().includes(String(keyword).toLowerCase()))) {
      return subject;
    }
  }
  return DEFAULT_SUBJECT;
}

function makeFallbackName({ kind, remark, subject }) {
  const text = remark && remark.trim() ? remark : kind === 'canvas' ? '画布拼接笔记' : '图片笔记';
  const safeSubject = sanitizeSegment(subject || guessSubjectFromText(text), DEFAULT_SUBJECT, 24);
  const safeTitle = sanitizeSegment(text, kind === 'canvas' ? '画布拼接笔记' : '图片笔记', 42);
  return {
    subject: safeSubject,
    title: safeTitle,
    reason: 'fallback',
  };
}

async function generateNameWithAi({ imageDataUrl, kind, remark }) {
  const prompt = [
    '你是考研学习笔记整理助手。请结合图片内容和用户备注，为这张学习截图生成适合 Windows 文件名的中文标题。',
    '要求：',
    '1. 识别所属科目，只能从：高等数学、线性代数、概率论、数据结构、计算机组成、操作系统、计算机网络、英语、默认文件夹 中选择。',
    '2. title 用 8 到 22 个中文字符概括图片核心内容，不要出现“截图”“图片”“笔记”这类空泛词。',
    '3. 不要输出随机数，不要输出日期，不要输出文件后缀。',
    '4. 不要使用 Windows 非法字符：<>:"/\\|?*。',
    '5. 只输出 JSON：{"subject":"科目","title":"标题","reason":"一句话依据"}',
    `保存类型：${kind === 'canvas' ? '多图画布' : '单图'}`,
    `用户备注：${remark || '无'}`,
  ].join('\n');

  try {
    const router = getAiRouter();
    if (!router) throw new Error(aiRouterInitError || 'AI router is unavailable');
    const response = await router.complete({
      task: 'note_naming',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
      responseSchema: {
        type: 'object',
        required: ['subject', 'title', 'reason'],
        properties: {
          subject: { type: 'string' },
          title: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      temperature: 0.15,
    });

    const parsed = response.json;

    const subject = sanitizeSegment(parsed.subject || guessSubjectFromText(`${parsed.title || ''} ${remark || ''}`), DEFAULT_SUBJECT, 24);
    const allowedSubjects = ['高等数学', '线性代数', '概率论', '数据结构', '计算机组成', '操作系统', '计算机网络', '英语', DEFAULT_SUBJECT];
    const title = sanitizeSegment(parsed.title, kind === 'canvas' ? '画布拼接笔记' : '图片笔记', 42);

    return {
      subject: allowedSubjects.includes(subject) ? subject : guessSubjectFromText(`${subject} ${title} ${remark || ''}`),
      title,
      reason: String(parsed.reason || '').slice(0, 120),
      providerUsed: response.provider,
      modelUsed: response.model,
      error: null,
    };
  } catch (error) {
    return {
      ...makeFallbackName({ kind, remark }),
      providerUsed: null,
      modelUsed: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function generateWidgetWithAi(userPrompt) {
  const router = getAiRouter();
  if (!router) throw new Error(aiRouterInitError || 'AI router is unavailable');
  const prompt = [
    '你是“考研桌面助手”的前端模块生成器。根据用户需求生成一个可独立运行的小组件。',
    '只输出一个 JSON 对象，不要 Markdown，不要解释。',
    'JSON 格式：',
    '{"title":"模块标题","width":360,"height":260,"html":"...","css":"...","js":"..."}',
    '严格要求：',
    '1. 只使用原生 HTML、CSS、JavaScript，不引用外部库、网址、字体或图片。',
    '2. 禁止 fetch、XMLHttpRequest、WebSocket、EventSource、window.open、跳转、表单提交和跨页面通信。',
    '3. 不访问 cookie、localStorage、sessionStorage、indexedDB、父页面或顶层窗口。',
    '4. 所有交互仅操作当前模块 DOM；按钮必须可用，界面适合深色半透明桌面卡片。',
    '5. HTML 不包含 script/style 标签；CSS 和 JS 分别放入对应字段。',
    '6. width 取 240-720，height 取 150-620。内容精简，中文界面。',
    `用户需求：${userPrompt}`,
  ].join('\n');

  const response = await router.complete({
    task: 'widget_generation',
    messages: [
      { role: 'system', content: '你只返回符合指定结构的 JSON。' },
      { role: 'user', content: prompt },
    ],
    responseSchema: {
      type: 'object',
      required: ['title', 'width', 'height', 'html', 'css', 'js'],
      properties: {
        title: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        html: { type: 'string' },
        css: { type: 'string' },
        js: { type: 'string' },
      },
    },
    timeoutMs: 45_000,
    temperature: 0.35,
  });

  const parsed = response.json;

  const html = String(parsed.html || '').slice(0, 40000);
  if (!html.trim()) {
    throw new Error('AI 返回的模块缺少 HTML');
  }

  return {
    provider: response.provider,
    model: response.model,
    widget: {
      title: String(parsed.title || 'AI 代码模块').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 30) || 'AI 代码模块',
      width: clampNumber(parsed.width, 360, 240, 720),
      height: clampNumber(parsed.height, 260, 150, 620),
      html,
      css: String(parsed.css || '').slice(0, 30000),
      js: String(parsed.js || '').slice(0, 30000),
    },
  };
}

function ensureUniquePath(dir, baseName, ext, existingPath = null) {
  let filename = `${baseName}.${ext}`;
  let filePath = path.join(dir, filename);
  let counter = 2;
  const normalizedExistingPath = existingPath ? path.resolve(existingPath) : null;
  while (fs.existsSync(filePath) && path.resolve(filePath) !== normalizedExistingPath) {
    filename = `${baseName}_${counter}.${ext}`;
    filePath = path.join(dir, filename);
    counter += 1;
  }
  return { filename, filePath };
}

function readLayoutFile() {
  if (!fs.existsSync(LAYOUT_PATH)) {
    return null;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf8'));
    if (Array.isArray(payload?.layout)) {
      return payload;
    }
  } catch {
    return null;
  }
  return null;
}

function sendLayoutEvent(res, payload) {
  res.write(`event: layout\ndata: ${JSON.stringify(payload)}\n\n`);
}

function sendLearningEvent(res, payload) {
  res.write(`event: learning-data\ndata: ${JSON.stringify(payload)}\n\n`);
}

function broadcastLearningData(payload) {
  for (const client of learningEventClients) {
    try {
      sendLearningEvent(client, payload);
    } catch {
      learningEventClients.delete(client);
    }
  }
}

function handleLearningEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  sendLearningEvent(res, learningData.getSnapshot());
  learningEventClients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(heartbeat);
      learningEventClients.delete(res);
    }
  }, 20_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    learningEventClients.delete(res);
  });
}

function broadcastLayout(payload) {
  for (const client of layoutEventClients) {
    try {
      sendLayoutEvent(client, payload);
    } catch {
      layoutEventClients.delete(client);
    }
  }
}

function handleLayoutEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  sendLayoutEvent(res, readLayoutFile() ?? { ok: true, updatedAt: null, layout: null });
  layoutEventClients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(heartbeat);
      layoutEventClients.delete(res);
    }
  }, 20_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    layoutEventClients.delete(res);
  });
}

async function handleLayoutSave(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || '{}');
  if (!Array.isArray(payload.layout)) {
    throw new Error('Invalid desktop layout payload');
  }
  fs.mkdirSync(ASSISTANT_ROOT, { recursive: true });
  const nextPayload = {
    ok: true,
    updatedAt: new Date().toISOString(),
    layout: payload.layout,
  };
  fs.writeFileSync(LAYOUT_PATH, JSON.stringify(nextPayload, null, 2), 'utf8');
  broadcastLayout(nextPayload);
  sendJson(res, 200, {
    ...nextPayload,
    layoutPath: LAYOUT_PATH,
  });
}

async function handleGenerateWidget(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || '{}');
  const prompt = String(payload.prompt || '').trim().slice(0, 1200);
  if (prompt.length < 3) {
    sendJson(res, 400, { ok: false, error: '请至少用一句话描述模块需求' });
    return;
  }
  const generated = await generateWidgetWithAi(prompt);
  sendJson(res, 200, {
    ok: true,
    provider: generated.provider,
    model: generated.model,
    widget: generated.widget,
  });
}

function makeLearningPageRefs(parsed) {
  const pageRefs = [];
  for (const item of parsed.pageRefs || []) {
    const pages = (parsed.pages || []).filter((page) => page >= item.start && page <= item.end);
    for (const page of pages) pageRefs.push({ raw: item.raw, page });
  }
  for (const item of parsed.questionRefs || []) {
    pageRefs.push({ raw: item.raw, question: item.number });
  }
  if ((parsed.pages || []).length === 1 && (parsed.questions || []).length === 1) {
    return [{
      raw: `${parsed.pageRefs?.[0]?.raw || `p${parsed.pages[0]}`} ${parsed.questionRefs?.[0]?.raw || `${parsed.questions[0]}题`}`,
      page: parsed.pages[0],
      question: parsed.questions[0],
    }];
  }
  return pageRefs;
}

function makeInitialLearning(kind, parsed, createdAt, details = {}) {
  const tags = [...new Set([...(parsed.explicitTags || []), ...(parsed.inferredTags || [])])];
  const intent = {
    isQuestion: (parsed.questions || []).length > 0,
    isMistake: parsed.flags?.isMistake === true,
    shouldMemorize: parsed.flags?.shouldMemorize === true,
  };
  const noteType = parsed.flags?.isMistake
    ? 'mistake'
    : parsed.flags?.shouldMemorize
      ? 'memory'
      : kind === 'canvas'
        ? 'canvas'
        : (parsed.questions || []).length > 0 ? 'question' : 'note';
  const pageRefs = makeLearningPageRefs(parsed);
  const back = String(details.remark || details.title || '').trim();
  const knowledgePath = details.subject && details.subject !== DEFAULT_SUBJECT ? [details.subject] : [];
  const cards = [];
  if (intent.shouldMemorize && back) {
    cards.push({
      sourceKey: 'remark-memory:0',
      kind: 'memory',
      front: details.title || '回忆这条笔记的核心内容',
      back,
      status: 'draft',
      knowledgePath,
      tags,
      pageRefs,
    });
  }
  if (intent.isMistake && back) {
    cards.push({
      sourceKey: 'remark-mistake:0',
      kind: 'mistake',
      front: details.title ? `重做：${details.title}` : '重新说明这道错题的正确思路',
      back: parsed.wrongReasons?.[0] || back,
      status: 'draft',
      knowledgePath,
      tags,
      pageRefs,
    });
  }
  return {
    capturedDate: formatDateInTimeZone(createdAt, 'Asia/Shanghai'),
    title: details.title || '',
    subject: details.subject || DEFAULT_SUBJECT,
    pageRefs,
    questions: parsed.questions || [],
    tags,
    knowledgePath,
    noteType,
    wrongReason: parsed.wrongReasons?.[0] || '',
    intent,
    cards,
    organizationStatus: 'pending',
    flags: parsed.flags,
    pendingAiOrganization: true,
  };
}

function persistBackgroundMetadata(saved, metadata) {
  fs.writeFileSync(saved.receipt.sidecarPath, JSON.stringify(metadata, null, 2), 'utf8');
  appendMetadata(path.dirname(metadata.filePath), metadata);
  const learningSyncError = syncLearningMetadata(metadata);
  writeSaveReceipt(metadata.noteUid, metadata, learningSyncError);
}

function markAiNamingFailed(noteUid, error, naming = null) {
  const saved = readSaveReceipt(noteUid);
  if (!saved) return;
  const completedAt = new Date().toISOString();
  const metadata = {
    ...saved.metadata,
    updatedAt: completedAt,
    naming: {
      ...(saved.metadata.naming || {}),
      status: 'failed',
      provider: naming?.providerUsed || null,
      model: naming?.modelUsed || null,
      reason: naming?.reason || saved.metadata.naming?.reason || 'background_fallback',
      error: error instanceof Error ? error.message : String(error),
      completedAt,
    },
    classifier: {
      ...(saved.metadata.classifier || {}),
      status: 'fallback_named',
      provider: naming?.providerUsed || null,
    },
  };
  persistBackgroundMetadata(saved, metadata);
}

async function runAiNamingJob(noteUid) {
  const saved = readSaveReceipt(noteUid);
  if (!saved || saved.metadata.naming?.status !== 'pending') return;

  const imageBuffer = fs.readFileSync(saved.filePath);
  const imageDataUrl = `data:${saved.metadata.mime || 'image/png'};base64,${imageBuffer.toString('base64')}`;
  const naming = await generateNameWithAi({
    imageDataUrl,
    kind: saved.metadata.kind,
    remark: saved.metadata.remark,
  });

  if (naming.error) {
    markAiNamingFailed(noteUid, naming.error, naming);
    return;
  }

  // The 72-hour organizer may have enriched this sidecar while the model was
  // running. Re-read it now and merge only naming/path fields so classification
  // and generated cards are never overwritten by the stale pre-AI snapshot.
  const latest = readSaveReceipt(noteUid);
  if (!latest) return;
  const requestedSubject = sanitizeSegment(latest.metadata.requestedSubject || DEFAULT_SUBJECT, DEFAULT_SUBJECT, 24);
  const subject = naming.subject === DEFAULT_SUBJECT && requestedSubject !== DEFAULT_SUBJECT
    ? requestedSubject
    : sanitizeSegment(naming.subject, DEFAULT_SUBJECT, 24);
  const subjectDir = path.join(NOTES_ROOT, subject);
  fs.mkdirSync(subjectDir, { recursive: true });

  const ext = path.extname(latest.filePath).replace(/^\./, '') || 'png';
  const safeTitle = sanitizeSegment(
    naming.title,
    latest.metadata.kind === 'canvas' ? '画布拼接笔记' : '图片笔记',
    42,
  );
  const createdStamp = timestamp(new Date(latest.metadata.createdAt));
  const baseName = sanitizeSegment(
    `${subject}_${safeTitle}_${createdStamp}`,
    `${subject}_图片笔记_${createdStamp}`,
    110,
  );
  const target = ensureUniquePath(subjectDir, baseName, ext, latest.filePath);
  const targetId = path.basename(target.filename, path.extname(target.filename));
  const targetSidecarPath = sidecarPathForId(subjectDir, targetId);
  const completedAt = new Date().toISOString();
  const metadata = {
    ...latest.metadata,
    id: targetId,
    subject,
    title: safeTitle,
    fileName: target.filename,
    filePath: target.filePath,
    updatedAt: completedAt,
    naming: {
      ...(latest.metadata.naming || {}),
      status: 'complete',
      provider: naming.providerUsed,
      model: naming.modelUsed,
      reason: naming.reason,
      error: null,
      completedAt,
    },
    classifier: {
      ...(latest.metadata.classifier || {}),
      status: 'named',
      provider: naming.providerUsed,
    },
  };

  const originalPath = latest.filePath;
  const originalSidecarPath = latest.receipt.sidecarPath;
  const originalSubjectDir = path.dirname(originalPath);
  const moved = path.resolve(target.filePath) !== path.resolve(originalPath);
  let receiptUpdated = false;
  const stagedMetadata = {
    ...metadata,
    naming: {
      ...metadata.naming,
      status: 'pending',
      reason: 'finalizing_background_name',
    },
  };
  const activeSidecarPath = moved ? targetSidecarPath : originalSidecarPath;

  if (!moved) {
    fs.writeFileSync(originalSidecarPath, JSON.stringify(stagedMetadata, null, 2), 'utf8');
    writeSaveReceipt(noteUid, stagedMetadata, latest.receipt.learningSyncError);
    receiptUpdated = true;
    appendMetadata(subjectDir, stagedMetadata);
  } else {
    fs.mkdirSync(metadataDir(subjectDir), { recursive: true });
    fs.renameSync(originalPath, target.filePath);
    try {
      fs.writeFileSync(targetSidecarPath, JSON.stringify(stagedMetadata, null, 2), 'utf8');
      // Make the idempotency receipt point at the new, already-valid pair
      // before deleting the old sidecar or index entry.
      writeSaveReceipt(noteUid, stagedMetadata, latest.receipt.learningSyncError);
      receiptUpdated = true;
      appendMetadata(subjectDir, stagedMetadata);
      if (path.resolve(originalSidecarPath) !== path.resolve(targetSidecarPath)) {
        unlinkFileIfExists(originalSidecarPath);
      }
      try {
        removeMetadataEntry(originalSubjectDir, noteUid);
      } catch {
        // A stale aggregate index is repairable; the image, sidecar and
        // idempotency receipt are already consistent on the new path.
      }
    } catch (error) {
      if (!receiptUpdated) {
        unlinkFileIfExists(targetSidecarPath);
        if (fs.existsSync(target.filePath) && !fs.existsSync(originalPath)) {
          fs.renameSync(target.filePath, originalPath);
        }
      }
      throw error;
    }
  }

  const learningSyncError = syncLearningMetadata(metadata);
  fs.writeFileSync(activeSidecarPath, JSON.stringify(metadata, null, 2), 'utf8');
  appendMetadata(subjectDir, metadata);
  writeSaveReceipt(noteUid, metadata, learningSyncError);
}

function queueAiNamingJob(noteUid) {
  if (aiNamingJobs.has(noteUid)) return;
  const job = aiNamingQueue.then(async () => {
    try {
      await runAiNamingJob(noteUid);
    } catch (error) {
      try {
        markAiNamingFailed(noteUid, error);
      } catch {
        // The local image is already safe. The 72-hour organizer can retry enrichment.
      }
    }
  });
  aiNamingJobs.set(noteUid, job);
  aiNamingQueue = job.catch(() => undefined);
  void job.finally(() => aiNamingJobs.delete(noteUid)).catch(() => undefined);
}

function resumePendingAiNamingJobs() {
  if (!fs.existsSync(NOTE_SAVE_RECEIPTS_ROOT)) return 0;
  let resumed = 0;
  for (const name of fs.readdirSync(NOTE_SAVE_RECEIPTS_ROOT)) {
    if (!name.endsWith('.json')) continue;
    const receipt = readJson(path.join(NOTE_SAVE_RECEIPTS_ROOT, name), null);
    if (!receipt || receipt.aiStatus !== 'pending' || typeof receipt.noteUid !== 'string') continue;
    if (!readSaveReceipt(receipt.noteUid)) continue;
    queueAiNamingJob(receipt.noteUid);
    resumed += 1;
  }
  return resumed;
}

async function handleSave(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || '{}');
  const noteUid = normalizeNoteUid(payload.noteUid);
  const existing = readSaveReceipt(noteUid);
  if (existing) {
    sendJson(res, 200, makeSaveResponse(existing, { idempotentReplay: true }));
    if (existing.metadata.naming?.status === 'pending') queueAiNamingJob(noteUid);
    return;
  }

  const requestedSubject = sanitizeSegment(payload.subject || DEFAULT_SUBJECT, DEFAULT_SUBJECT, 24);
  const kind = payload.kind === 'canvas' ? 'canvas' : 'single';
  const remark = typeof payload.remark === 'string' ? payload.remark : '';
  const canvasProjectId = kind === 'canvas' && typeof payload.canvasProjectId === 'string'
    ? assertCanvasId(payload.canvasProjectId)
    : null;
  const image = decodeDataUrl(payload.imageDataUrl);
  const fallback = makeFallbackName({
    kind,
    remark,
    subject: requestedSubject !== DEFAULT_SUBJECT ? requestedSubject : guessSubjectFromText(remark),
  });
  const subject = sanitizeSegment(fallback.subject, DEFAULT_SUBJECT, 24);
  const subjectDir = path.join(NOTES_ROOT, subject);
  fs.mkdirSync(subjectDir, { recursive: true });

  const createdAt = new Date().toISOString();
  const createdStamp = timestamp(new Date(createdAt));
  const safeTitle = sanitizeSegment(fallback.title, kind === 'canvas' ? '画布拼接笔记' : '图片笔记', 42);
  const baseName = sanitizeSegment(`${subject}_${safeTitle}_${createdStamp}`, `${subject}_图片笔记_${createdStamp}`, 110);
  const { filename, filePath } = ensureUniquePath(subjectDir, baseName, image.ext);
  const id = path.basename(filename, path.extname(filename));
  const sidecarPath = sidecarPathForId(subjectDir, id);
  const extracted = parseRemark(remark);
  const metadata = {
    schemaVersion: 2,
    noteUid,
    id,
    kind,
    ...(canvasProjectId ? { canvasProjectId } : {}),
    subject,
    requestedSubject,
    title: safeTitle,
    remark,
    createdAt,
    captureDate: formatDateInTimeZone(createdAt, 'Asia/Shanghai'),
    fileName: filename,
    filePath,
    mime: image.mime,
    extracted,
    learning: {
      noteUid,
      ...makeInitialLearning(kind, extracted, createdAt, {
        title: safeTitle,
        subject,
        remark,
      }),
    },
    naming: {
      status: 'pending',
      provider: null,
      model: null,
      reason: 'local_first',
      error: null,
      requestedAt: createdAt,
    },
    classifier: {
      status: 'saved_pending_ai',
      provider: null,
      scheduledAt: 'every_72_hours',
    },
  };

  try {
    fs.writeFileSync(filePath, image.buffer);
    fs.mkdirSync(metadataDir(subjectDir), { recursive: true });
    fs.writeFileSync(sidecarPath, JSON.stringify(metadata, null, 2), 'utf8');
    appendMetadata(subjectDir, metadata);
    writeSaveReceipt(noteUid, metadata);
  } catch (error) {
    unlinkFileIfExists(filePath);
    unlinkFileIfExists(sidecarPath);
    removeMetadataEntry(subjectDir, noteUid);
    unlinkFileIfExists(saveReceiptPath(noteUid));
    throw error;
  }

  const learningSyncError = syncLearningMetadata(metadata);
  const receipt = writeSaveReceipt(noteUid, metadata, learningSyncError);
  const saved = {
    receipt,
    metadata,
    filePath,
    fileName: filename,
  };
  sendJson(res, 202, makeSaveResponse(saved, { learningSyncError }));
  queueAiNamingJob(noteUid);
}

async function handleCanvasProjectRoute(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/canvas-projects') {
    const projects = canvasProjects.listDocuments().map((project) => ({
      id: project.id,
      title: project.title,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      imageCount: project.imageCount,
      textCount: project.textCount,
      annotationCount: project.annotationCount,
      anchorCount: project.anchorCount,
      relationCount: project.relationCount,
    }));
    sendJson(res, 200, { ok: true, projects });
    return true;
  }

  const projectMatch = /^\/canvas-projects\/([^/]+)$/.exec(pathname);
  if (!projectMatch) return false;
  const projectId = decodeURIComponent(projectMatch[1]);
  assertCanvasId(projectId);

  if (req.method === 'GET') {
    const document = canvasProjects.readDocument(projectId);
    if (!document) {
      sendJson(res, 404, { ok: false, error: '找不到这个画布工程' });
      return true;
    }
    sendJson(res, 200, { ok: true, document });
    return true;
  }

  if (req.method === 'PUT') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const source = payload.document && typeof payload.document === 'object'
      ? payload.document
      : payload;
    const document = canvasProjects.saveDocument({
      ...source,
      id: projectId,
      updatedAt: new Date().toISOString(),
    }, { canvasId: projectId });
    const summary = canvasProjects.listDocuments().find((item) => item.id === projectId) ?? null;
    sendJson(res, 200, { ok: true, document, summary });
    return true;
  }

  return false;
}

async function handleLearningDataRoute(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/learning-data/events') {
    handleLearningEvents(req, res);
    return true;
  }

  if (req.method === 'GET' && pathname === '/learning-data') {
    sendJson(res, 200, learningData.getSnapshot());
    return true;
  }

  if (req.method === 'PATCH' && pathname === '/learning-data/day') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const snapshot = learningData.upsertDayManual(payload.date, payload.manual, {
      expectedRevision: payload.expectedRevision,
    });
    broadcastLearningData(snapshot);
    sendJson(res, 200, snapshot);
    return true;
  }

  if (req.method === 'PUT' && pathname === '/learning-data/manual-records') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const mutationOptions = { expectedRevision: payload.expectedRevision };
    const snapshot = payload.mode === 'replace'
      ? learningData.replaceManualRecords(payload.records, mutationOptions)
      : learningData.mergeManualRecords(payload.records, mutationOptions);
    broadcastLearningData(snapshot);
    sendJson(res, 200, snapshot);
    return true;
  }

  const cardMatch = /^\/learning-data\/cards\/([^/]+)$/.exec(pathname);
  const noteMatch = /^\/learning-data\/notes\/([^/]+)$/.exec(pathname);
  if (noteMatch && req.method === 'PATCH') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const snapshot = learningData.updateNote(decodeURIComponent(noteMatch[1]), payload.patch, {
      expectedRevision: payload.expectedRevision,
    });
    broadcastLearningData(snapshot);
    sendJson(res, 200, snapshot);
    return true;
  }
  if (cardMatch && req.method === 'PATCH') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const snapshot = learningData.updateCard(decodeURIComponent(cardMatch[1]), payload.patch, {
      expectedRevision: payload.expectedRevision,
    });
    broadcastLearningData(snapshot);
    sendJson(res, 200, snapshot);
    return true;
  }
  if (cardMatch && req.method === 'DELETE') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const snapshot = learningData.deleteCard(decodeURIComponent(cardMatch[1]), {
      expectedRevision: payload.expectedRevision,
    });
    broadcastLearningData(snapshot);
    sendJson(res, 200, snapshot);
    return true;
  }
  return false;
}

function readOrganizerStatus() {
  const state = readJson(ORGANIZER_STATE_PATH, {});
  const parsedLastSuccessfulAt = typeof state?.lastSuccessfulAt === 'string'
    ? new Date(state.lastSuccessfulAt).getTime()
    : Number.NaN;
  const lastSuccessfulAt = Number.isFinite(parsedLastSuccessfulAt) ? state.lastSuccessfulAt : null;
  const nextDueAt = lastSuccessfulAt
    ? new Date(parsedLastSuccessfulAt + 72 * 60 * 60 * 1000).toISOString()
    : null;
  let lockAgeMs = null;
  try {
    lockAgeMs = Date.now() - fs.statSync(ORGANIZER_LOCK_PATH).mtimeMs;
  } catch {
    lockAgeMs = null;
  }
  const running = lockAgeMs !== null && lockAgeMs < 2 * 60 * 60 * 1000;
  return {
    running,
    staleLock: lockAgeMs !== null && !running,
    lastSuccessfulAt,
    nextDueAt,
    report: state?.report || null,
    statePath: ORGANIZER_STATE_PATH,
  };
}

async function handleOrganizerRoute(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/organizer/status') {
    sendJson(res, 200, { ok: true, ...readOrganizerStatus() });
    return true;
  }
  if (req.method === 'POST' && pathname === '/organizer/run') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const organizerStatus = readOrganizerStatus();
    if (organizerStatus.running) {
      sendJson(res, 409, { ok: false, error: '笔记智能整理正在运行', ...readOrganizerStatus() });
      return true;
    }
    if (organizerStatus.staleLock) unlinkFileIfExists(ORGANIZER_LOCK_PATH);
    const args = [path.join(__dirname, 'organize-notes.cjs')];
    if (payload.force === true) args.push('--force');
    if (payload.dryRun === true) args.push('--dry-run');
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.once('error', () => {});
    child.unref();
    sendJson(res, 202, { ok: true, pid: child.pid, force: payload.force === true, dryRun: payload.dryRun === true });
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const corsOrigin = allowedCorsOrigin(req);
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    if (corsOrigin === false) {
      sendJson(res, 403, { ok: false, error: 'Origin is not allowed' });
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (corsOrigin === false) {
    sendJson(res, 403, { ok: false, error: 'Origin is not allowed' });
    return;
  }

  try {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    const { pathname } = requestUrl;

    if (await handleCanvasProjectRoute(req, res, pathname)) return;
    if (await handleLearningDataRoute(req, res, pathname)) return;
    if (await handleOrganizerRoute(req, res, pathname)) return;

    if (req.method === 'GET' && pathname === '/note-file') {
      const image = resolveNoteImage(NOTES_ROOT, requestUrl.searchParams.get('path'));
      const stat = fs.statSync(image.filePath);
      res.writeHead(200, {
        'Content-Type': image.mime,
        'Content-Length': stat.size,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(image.filePath).pipe(res);
      return;
    }

    if (req.method === 'POST' && pathname === '/notes/reveal') {
      if (!canControlNoteApp(req)) {
        sendJson(res, 403, { ok: false, error: 'Only the local Kaoyan desktop page can reveal note files.' });
        return;
      }
      const payload = JSON.parse((await readBody(req)) || '{}');
      const image = revealNoteImage(NOTES_ROOT, payload.path);
      sendJson(res, 200, { ok: true, filePath: image.filePath });
      return;
    }

    if (req.method === 'GET' && pathname === '/health') {
      const currentRouter = getAiRouter();
      sendJson(res, 200, {
        ok: true,
        notesRoot: NOTES_ROOT,
        assistantRoot: ASSISTANT_ROOT,
        layoutPath: LAYOUT_PATH,
        defaultSubject: DEFAULT_SUBJECT,
        metadataPlacement: 'subject/.metadata',
        aiWidgetEndpoint: '/ai/widget',
        noteAppEndpoint: '/open-note-app',
        noteAppCloseEndpoint: '/close-note-app',
        canvasProjectsEndpoint: '/canvas-projects',
        canvasProjectsPath: canvasProjects.rootPath,
        learningDataEndpoint: '/learning-data',
        learningDataPath: learningData.filePath,
        organizerEndpoint: '/organizer/status',
        organizer: readOrganizerStatus(),
        aiRouter: currentRouter ? currentRouter.getStatus() : { providers: [], error: aiRouterInitError },
        qwen: {
          enabled: Boolean(qwen.apiKey),
          model: qwen.model,
          baseUrl: qwen.baseUrl,
          configPath: qwen.configPath,
          source: qwen.source,
        },
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/layout/events') {
      handleLayoutEvents(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/layout') {
      const layoutPayload = readLayoutFile();
      sendJson(res, 200, layoutPayload ?? { ok: true, updatedAt: null, layout: null, layoutPath: LAYOUT_PATH });
      return;
    }

    if (req.method === 'POST' && pathname === '/layout') {
      await handleLayoutSave(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/open-note-app') {
      if (!canControlNoteApp(req)) {
        sendJson(res, 403, { ok: false, error: 'Only the local Kaoyan desktop page can control the note app.' });
        return;
      }
      noteAppReadyAt = null;
      const pid = await launchNoteApp();
      sendJson(res, 202, { ok: true, pid });
      return;
    }

    if (req.method === 'GET' && pathname === '/note-app-status') {
      sendJson(res, 200, { ok: true, readyAt: noteAppReadyAt });
      return;
    }

    if (req.method === 'POST' && pathname === '/note-app-ready') {
      if (!canControlNoteApp(req)) {
        sendJson(res, 403, { ok: false, error: 'Only the local Kaoyan desktop app can report readiness.' });
        return;
      }
      noteAppReadyAt = new Date().toISOString();
      sendJson(res, 200, { ok: true, readyAt: noteAppReadyAt });
      return;
    }

    if (req.method === 'POST' && pathname === '/close-note-app') {
      if (!canControlNoteApp(req)) {
        sendJson(res, 403, { ok: false, error: 'Only the local Kaoyan desktop page can control the note app.' });
        return;
      }
      noteAppReadyAt = null;
      const pid = await launchNoteApp('--close-note-app');
      sendJson(res, 202, { ok: true, pid });
      return;
    }

    if (req.method === 'POST' && req.url === '/save-note') {
      await handleSave(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/ai/widget') {
      await handleGenerateWidget(req, res);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    const status = String(error?.message || '') === 'Payload too large'
      ? 413
      : error instanceof SyntaxError || error instanceof URIError || error instanceof CanvasDocumentValidationError
        ? 400
      : error instanceof CanvasDocumentStoreError && error.code === 'CANVAS_DOCUMENT_READ_FAILED'
        ? 500
        : error instanceof LearningDataConflictError
      ? 409
      : error?.code === 'LEARNING_DATA_BUSY' ? 503
      : error?.code === 'NOTE_PATH_FORBIDDEN' ? 403
      : error?.code === 'NOTE_FILE_NOT_FOUND' ? 404
      : error?.code === 'NOTE_FILE_UNSUPPORTED' ? 415
      : error?.code === 'NOTE_REVEAL_UNSUPPORTED' ? 501
      : error?.code === 'NOTE_NOT_FOUND' ? 404
      : error?.code === 'CARD_NOT_FOUND' ? 404 : 500;
    sendJson(res, status, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(error && typeof error === 'object' && 'code' in error ? { code: error.code } : {}),
      ...(error instanceof CanvasDocumentValidationError ? { issues: error.issues } : {}),
      ...(error instanceof LearningDataConflictError ? {
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision,
      } : {}),
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Kaoyan note server running at http://127.0.0.1:${PORT}`);
  console.log(`Notes root: ${NOTES_ROOT}`);
  console.log(`Assistant root: ${ASSISTANT_ROOT}`);
  console.log(`Layout file: ${LAYOUT_PATH}`);
  console.log(`Canvas projects: ${canvasProjects.rootPath}`);
  console.log(`Metadata placement: subject/.metadata`);
  console.log(`AI widget endpoint: http://127.0.0.1:${PORT}/ai/widget`);
  console.log(`Learning data endpoint: http://127.0.0.1:${PORT}/learning-data`);
  console.log(`Organizer status: http://127.0.0.1:${PORT}/organizer/status`);
  console.log(`Note app endpoint: http://127.0.0.1:${PORT}/open-note-app`);
  console.log(`Note app close endpoint: http://127.0.0.1:${PORT}/close-note-app`);
  console.log(`Qwen: ${qwen.apiKey ? `enabled (${qwen.model})` : `disabled, configPath=${qwen.configPath}`}`);
  const currentRouter = getAiRouter();
  console.log(`AI router providers: ${currentRouter ? currentRouter.getStatus().providers.filter((provider) => provider.enabled).map((provider) => provider.id).join(', ') || 'none' : `unavailable (${aiRouterInitError})`}`);
  const resumedJobs = resumePendingAiNamingJobs();
  if (resumedJobs > 0) console.log(`Resumed ${resumedJobs} pending AI naming job(s).`);
});
