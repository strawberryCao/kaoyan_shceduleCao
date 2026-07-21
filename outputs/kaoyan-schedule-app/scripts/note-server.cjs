const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  AI_TASK_DEFINITIONS,
  TASK_PARAMETER_DEFINITIONS,
  TASK_PROFILES,
  createAiRouter,
  loadAiProviderConfigs,
  normalizeTaskConfigurations,
} = require('./ai-router.cjs');
const {
  CanvasDocumentStoreError,
  CanvasDocumentValidationError,
  assertCanvasId,
  createCanvasDocumentStore,
} = require('./canvas-document-store.cjs');
const {
  analyzeCanvasOrganization,
  applyCanvasOrganization,
} = require('./canvas-ai-organizer.cjs');
const { createLearningDataStore, formatDateInTimeZone, LearningDataConflictError } = require('./learning-data-store.cjs');
const { resolveNoteImage, revealNoteImage } = require('./note-file-access.cjs');
const {
  ensureKnowledgePoint,
  ensureSubject,
  loadTaxonomy,
  saveTaxonomyAtomic,
} = require('./note-taxonomy.cjs');
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
const LAN_PROXY_HEADER = 'x-kaoyan-lan-proxy';
const LIVE_STROKE_MAX_BODY_BYTES = 512 * 1024;
const ACTIVE_CANVAS_MAX_BODY_BYTES = 16 * 1024;
const CANVAS_AI_MAX_BODY_BYTES = 9 * 1024 * 1024;
const LIVE_STROKE_MAX_POINTS = 4096;
const NOTE_TAXONOMY_PATH = path.join(ASSISTANT_ROOT, 'note-taxonomy.json');
const NOTE_SAVE_RECEIPTS_ROOT = path.join(ASSISTANT_ROOT, 'note-save-receipts');
const DEFAULT_SUBJECT = '默认文件夹';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const qwen = loadQwenConfig();
const learningData = createLearningDataStore({ assistantRoot: ASSISTANT_ROOT });
const canvasProjects = createCanvasDocumentStore({
  rootDir: path.join(ASSISTANT_ROOT, 'canvas-projects'),
});
const canvasEventClients = new Set();
const layoutEventClients = new Set();
const learningEventClients = new Set();
let activeCanvasSelection = null;
let activeCanvasSelectionRevision = 0;
let noteAppReadyAt = null;
let aiRouter = null;
let aiRouterInitError = null;
let aiRouterConfigStamp = null;
let aiNamingQueue = Promise.resolve();
const aiNamingJobs = new Map();
let canvasOrganizationQueue = Promise.resolve();
const canvasOrganizationJobs = new Map();

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

function readAiConfigFile() {
  if (!fs.existsSync(AI_PROVIDER_CONFIG_PATH)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(AI_PROVIDER_CONFIG_PATH, 'utf8'));
  } catch (error) {
    const configError = new SyntaxError(`AI 配置文件不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
    configError.code = 'AI_CONFIG_INVALID';
    throw configError;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const configError = new SyntaxError('AI 配置文件的根节点必须是对象');
    configError.code = 'AI_CONFIG_INVALID';
    throw configError;
  }
  return parsed;
}

function getAiConfigurationSnapshot() {
  const loaded = loadAiProviderConfigs({
    configPath: AI_PROVIDER_CONFIG_PATH,
    legacyQwenConfig: qwen,
  });
  const currentRouter = getAiRouter();
  const status = currentRouter ? currentRouter.getStatus() : { providers: [], tasks: loaded.tasks };
  let updatedAt = null;
  try {
    updatedAt = fs.statSync(AI_PROVIDER_CONFIG_PATH).mtime.toISOString();
  } catch {
    // A missing task configuration is a valid default state.
  }
  return {
    ok: true,
    updatedAt,
    taskDefinitions: Object.entries(AI_TASK_DEFINITIONS).map(([id, definition]) => ({
      id,
      ...definition,
      defaults: {
        difficulty: TASK_PROFILES[id]?.difficulty || TASK_PROFILES.custom.difficulty,
        capabilities: [...(TASK_PROFILES[id]?.capabilities || TASK_PROFILES.custom.capabilities)],
      },
      parameters: (TASK_PARAMETER_DEFINITIONS[id] || []).map((parameter) => ({
        ...parameter,
        ...(Array.isArray(parameter.options) ? { options: parameter.options.map((option) => ({ ...option })) } : {}),
      })),
    })),
    tasks: normalizeTaskConfigurations(loaded.tasks),
    providers: status.providers || [],
    routing: loaded.routing,
    error: currentRouter ? null : aiRouterInitError,
  };
}

function validateTaskModelSelections(tasks, providers) {
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  for (const [taskId, task] of Object.entries(tasks)) {
    if (!task.providerId && !task.modelId) continue;
    const matchingProviders = task.providerId
      ? [providerMap.get(task.providerId)].filter(Boolean)
      : providers;
    if (matchingProviders.length === 0) {
      throw new SyntaxError(`${AI_TASK_DEFINITIONS[taskId]?.label || taskId} 选择的 AI 供应商当前不可用`);
    }
    if (task.modelId && !matchingProviders.some((provider) => provider.models.some((model) => model.id === task.modelId))) {
      throw new SyntaxError(`${AI_TASK_DEFINITIONS[taskId]?.label || taskId} 选择的模型当前不可用`);
    }
  }
}

function saveAiTaskConfigurations(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SyntaxError('AI 任务配置必须是对象');
  }
  const tasks = normalizeTaskConfigurations(input);
  const current = readAiConfigFile();
  const next = { ...current, tasks };
  const loaded = loadAiProviderConfigs({
    configPath: AI_PROVIDER_CONFIG_PATH,
    localConfig: next,
    legacyQwenConfig: qwen,
  });
  validateTaskModelSelections(tasks, loaded.providers);
  createAiRouter({ config: loaded });

  fs.mkdirSync(path.dirname(AI_PROVIDER_CONFIG_PATH), { recursive: true });
  const temporaryPath = `${AI_PROVIDER_CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, AI_PROVIDER_CONFIG_PATH);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  aiRouter = null;
  aiRouterInitError = null;
  aiRouterConfigStamp = null;
  getAiRouter();
  return getAiConfigurationSnapshot();
}

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

function isLanProxyRequest(req) {
  return String(req.headers[LAN_PROXY_HEADER] || '') === '1';
}

function isAllowedLanProxyRoute(method, pathname, searchParams = new URLSearchParams()) {
  const queryKeys = [...searchParams.keys()];
  if (method === 'GET' && pathname === '/note-file') {
    return queryKeys.length === 1 && queryKeys[0] === 'path' && Boolean(searchParams.get('path'));
  }
  if (queryKeys.length > 0) return false;
  if (method === 'GET' && pathname === '/canvas-projects') return true;
  if (method === 'GET' && pathname === '/canvas-projects/events') return true;
  if (method === 'POST' && pathname === '/canvas-projects/active') return true;
  if (method === 'POST' && /^\/canvas-projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/live-stroke$/.test(pathname)) return true;
  if ((method === 'GET' || method === 'POST') && /^\/canvas-projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/ai-organize$/.test(pathname)) return true;
  if ((method === 'GET' || method === 'PUT' || method === 'DELETE') && /^\/canvas-projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(pathname)) return true;
  if (method === 'POST' && pathname === '/save-note') return true;
  if (method === 'GET' && (pathname === '/learning-data' || pathname === '/learning-data/events')) return true;
  if (method === 'POST' && (pathname === '/learning-data/notes' || pathname === '/learning-data/cards')) return true;
  if (method === 'PATCH' && pathname === '/learning-data/day') return true;
  if (method === 'PUT' && pathname === '/learning-data/manual-records') return true;
  if (method === 'POST' && /^\/learning-data\/notes\/[^/]+\/restore$/.test(pathname)) return true;
  if ((method === 'PATCH' || method === 'DELETE') && /^\/learning-data\/(?:notes|cards)\/[^/]+$/.test(pathname)) return true;
  return false;
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

function readBody(req, maxBytes = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
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

function isPlainJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireLiveStrokeNumber(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new SyntaxError(`${field} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function requireLiveStrokeString(value, field, maxLength) {
  if (typeof value !== 'string') {
    throw new SyntaxError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new SyntaxError(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizeLiveStrokePayload(payload) {
  if (!isPlainJsonObject(payload)) throw new SyntaxError('live stroke payload must be an object');
  const sourceClientId = requireLiveStrokeString(payload.clientId, 'clientId', 128);
  if (!isPlainJsonObject(payload.stroke)) throw new SyntaxError('stroke must be an object');
  const source = payload.stroke;
  const id = requireLiveStrokeString(source.id, 'stroke.id', 120);
  if (source.kind !== 'ink') throw new SyntaxError('stroke.kind must be ink');
  if (source.tool !== 'pen' && source.tool !== 'highlighter') {
    throw new SyntaxError('stroke.tool must be pen or highlighter');
  }
  if (!Array.isArray(source.points) || source.points.length < 1 || source.points.length > LIVE_STROKE_MAX_POINTS) {
    throw new SyntaxError(`stroke.points must contain between 1 and ${LIVE_STROKE_MAX_POINTS} points`);
  }
  const points = source.points.map((point, index) => {
    if (!isPlainJsonObject(point)) throw new SyntaxError(`stroke.points[${index}] must be an object`);
    return {
      x: requireLiveStrokeNumber(point.x, `stroke.points[${index}].x`, -10_000_000, 10_000_000),
      y: requireLiveStrokeNumber(point.y, `stroke.points[${index}].y`, -10_000_000, 10_000_000),
      pressure: requireLiveStrokeNumber(point.pressure, `stroke.points[${index}].pressure`, 0, 1),
    };
  });
  if (typeof source.color !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(source.color)) {
    throw new SyntaxError('stroke.color must be a hexadecimal CSS color');
  }
  return {
    sourceClientId,
    stroke: {
      id,
      kind: 'ink',
      tool: source.tool,
      points,
      color: source.color.toLowerCase(),
      width: requireLiveStrokeNumber(source.width, 'stroke.width', 0.1, 512),
      opacity: requireLiveStrokeNumber(source.opacity, 'stroke.opacity', 0, 1),
      z: requireLiveStrokeNumber(source.z, 'stroke.z', -10_000_000, 10_000_000),
    },
  };
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

function findSavedNote(noteUid) {
  const saved = readSaveReceipt(noteUid);
  if (saved || !fs.existsSync(NOTES_ROOT)) return saved;
  const directories = [NOTES_ROOT];
  while (directories.length > 0) {
    const directory = directories.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !/\.note\.json$/i.test(entry.name) || path.basename(directory) !== '.metadata') continue;
      const metadata = readJson(fullPath, null);
      const filePath = metadata?.filePath;
      if (metadata?.noteUid !== noteUid || typeof filePath !== 'string' || !fs.existsSync(filePath)) continue;
      return {
        receipt: {
          noteUid,
          sidecarPath: fullPath,
          filePath,
          fileName: metadata.fileName || path.basename(filePath),
          learningSyncError: null,
        },
        metadata,
        filePath,
        fileName: metadata.fileName || path.basename(filePath),
      };
    }
  }
  return null;
}

function persistManualClassification(noteUid, patch) {
  const classificationKeys = ['subject', 'knowledgePath', 'questionType', 'wrongReason'];
  if (!patch || !classificationKeys.some((key) => Object.hasOwn(patch, key))) return null;
  const saved = findSavedNote(noteUid);
  if (!saved) return null;

  const currentLearning = saved.metadata.learning && typeof saved.metadata.learning === 'object'
    ? saved.metadata.learning
    : {};
  const subject = sanitizeSegment(patch.subject || currentLearning.subject || saved.metadata.subject, DEFAULT_SUBJECT, 60);
  const incomingPath = Array.isArray(patch.knowledgePath) ? patch.knowledgePath : currentLearning.knowledgePath;
  const knowledgePath = [subject, ...(Array.isArray(incomingPath) ? incomingPath : [])
    .map((item) => sanitizeSegment(item, '', 60))
    .filter((item) => item && item !== subject && item !== saved.metadata.subject)]
    .slice(0, 3);
  const knowledgePoint = knowledgePath[1] || null;

  const taxonomy = loadTaxonomy(NOTE_TAXONOMY_PATH);
  const subjectNode = ensureSubject(taxonomy, subject, { createdBy: 'user' });
  const pointNode = knowledgePoint
    ? ensureKnowledgePoint(taxonomy, subjectNode, knowledgePoint, { createdBy: 'user' })
    : null;
  saveTaxonomyAtomic(NOTE_TAXONOMY_PATH, taxonomy);

  const destinationDir = path.join(NOTES_ROOT, subject);
  fs.mkdirSync(metadataDir(destinationDir), { recursive: true });
  const sourceImagePath = saved.filePath;
  const sourceSidecarPath = saved.receipt.sidecarPath;
  const sourceSubjectDir = path.dirname(sourceImagePath);
  const sourceExt = path.extname(sourceImagePath).replace(/^\./, '') || 'png';
  const sourceStem = path.basename(sourceImagePath, path.extname(sourceImagePath));
  const target = ensureUniquePath(destinationDir, sourceStem, sourceExt, sourceImagePath);
  const targetId = path.basename(target.filename, path.extname(target.filename));
  const targetSidecarPath = sidecarPathForId(destinationDir, targetId);
  const updatedAt = new Date().toISOString();
  const metadata = {
    ...saved.metadata,
    id: targetId,
    subject,
    fileName: target.filename,
    filePath: target.filePath,
    updatedAt,
    classification: {
      ...(saved.metadata.classification || {}),
      subjectId: subjectNode.id,
      subjectName: subjectNode.name,
      knowledgePointId: pointNode?.id || null,
      knowledgePointName: pointNode?.name || null,
      correctedBy: 'user',
      correctedAt: updatedAt,
    },
    organizer: {
      ...(saved.metadata.organizer || {}),
      status: 'user_corrected',
      proposed: null,
    },
    learning: {
      ...currentLearning,
      subject,
      knowledgePath,
      ...(Object.hasOwn(patch, 'questionType') ? { questionType: String(patch.questionType || '').trim().slice(0, 60) } : {}),
      ...(Object.hasOwn(patch, 'wrongReason') ? { wrongReason: String(patch.wrongReason || '').trim().slice(0, 500) } : {}),
      organizationStatus: 'confirmed',
      classificationSource: 'manual',
      pendingAiOrganization: false,
    },
  };

  const moved = path.resolve(sourceImagePath) !== path.resolve(target.filePath);
  if (!moved) {
    fs.writeFileSync(sourceSidecarPath, JSON.stringify(metadata, null, 2), 'utf8');
    appendMetadata(destinationDir, metadata);
    writeSaveReceipt(noteUid, metadata, saved.receipt.learningSyncError);
    return metadata;
  }

  fs.renameSync(sourceImagePath, target.filePath);
  try {
    fs.writeFileSync(targetSidecarPath, JSON.stringify(metadata, null, 2), 'utf8');
    appendMetadata(destinationDir, metadata);
    writeSaveReceipt(noteUid, metadata, saved.receipt.learningSyncError);
  } catch (error) {
    unlinkFileIfExists(targetSidecarPath);
    if (fs.existsSync(target.filePath) && !fs.existsSync(sourceImagePath)) fs.renameSync(target.filePath, sourceImagePath);
    try {
      writeSaveReceipt(noteUid, saved.metadata, saved.receipt.learningSyncError);
    } catch {
      // The original image and sidecar are still valid; a later launch can rebuild the receipt.
    }
    throw error;
  }
  if (path.resolve(sourceSidecarPath) !== path.resolve(targetSidecarPath)) unlinkFileIfExists(sourceSidecarPath);
  try {
    removeMetadataEntry(sourceSubjectDir, noteUid);
  } catch {
    // A stale aggregate index is repairable from the sidecars.
  }
  return metadata;
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
    ['政治', ['政治', '考研政治', '思想政治', '马克思主义', '马原', '毛中特', '史纲', '思修', '时政']],
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

function applyNamingRuleTemplate(rule, value, subject, aiTitle) {
  const template = String(rule?.titleTemplate || '{value}').slice(0, 240);
  const rendered = template
    .replace(/\{value\}/g, value)
    .replace(/\{subject\}/g, subject)
    .replace(/\{aiTitle\}/g, aiTitle);
  return sanitizeSegment(rendered, value || aiTitle, 80);
}

function namingRulesForPrompt(rules) {
  return rules.filter((rule) => rule.enabled !== false).map((rule) => ({
    id: rule.id,
    name: rule.name,
    when: rule.when,
    extract: rule.extract,
    titleTemplate: rule.titleTemplate,
    validationHint: rule.validationHint || '',
  }));
}

async function generateNameWithAi({ imageDataUrl, kind, remark }) {
  const router = getAiRouter();
  const options = router?.getTaskOptions('note_naming') || {};
  const titleMinLength = Math.max(4, Math.min(40, Number(options.titleMinLength) || 8));
  const titleMaxLength = Math.max(titleMinLength, Math.min(80, Number(options.titleMaxLength) || 22));
  const effectiveRemark = options.useRemark === false ? '' : remark;
  const titleStyleText = {
    knowledge_point: '优先使用知识点或核心概念名称',
    question_type: '优先体现题型与考查动作',
    source_wording: '优先贴近原图中的准确措辞',
  }[options.titleStyle] || '优先使用知识点或核心概念名称';
  const namingRules = namingRulesForPrompt(router?.getStatus()?.tasks?.note_naming?.namingRules || []);
  const prompt = [
    '你是考研学习笔记整理助手。请结合图片内容和用户备注，为这张学习截图生成适合 Windows 文件名的中文标题。',
    '要求：',
    '1. 识别所属科目，只能从：高等数学、线性代数、概率论、数据结构、计算机组成、操作系统、计算机网络、英语、政治、默认文件夹 中选择。',
    options.preferSpecificSubject === false
      ? '1.1 按图片内容选择科目；确实不清晰或跨科时可选择“默认文件夹”。'
      : '1.1 只要图片或备注能看出学科，就必须选择最合理的具体科目；只有图片不可读、没有学习内容或确实无法判断时才选“默认文件夹”。不要因为不完全确定就退回默认。',
    `2. title 目标长度为 ${titleMinLength} 到 ${titleMaxLength} 个字符，${titleStyleText}。`,
    '3. 不要输出随机数，不要输出日期，不要输出文件后缀。',
    '4. 不要使用 Windows 非法字符：<>:"/\\|?*。',
    '5. 先逐条检查“字段命名规则”。只有图片中能直接看到规则要求的标签及对应值时才算匹配，严禁用相似编号、日期或其他字段猜测。',
    '6. 如果匹配规则：ruleId 填规则 id，ruleValue 填原图中提取到的字段值，ruleEvidence 简述标签和值的位置；title 仍给出普通内容标题。程序会根据模板生成最终标题。',
    options.rejectGenericTitle === false
      ? '7. 如果没有规则匹配：ruleId、ruleValue、ruleEvidence 都输出空字符串；title 应尽量给出具体可见主题。'
      : '7. 如果没有规则匹配：ruleId、ruleValue、ruleEvidence 都输出空字符串。禁止输出“待识别”“无法识别”“未知内容”“截图”“图片笔记”作为 title；应给出图片中最具体的可见主题。',
    '8. 只输出 JSON：{"subject":"科目","title":"标题","reason":"一句话依据","ruleId":"匹配规则id或空字符串","ruleValue":"提取值或空字符串","ruleEvidence":"原图证据或空字符串"}',
    `保存类型：${kind === 'canvas' ? '多图画布' : '单图'}`,
    `用户备注：${effectiveRemark || '无'}`,
    `字段命名规则：${namingRules.length ? JSON.stringify(namingRules) : '无'}`,
  ].join('\n');

  try {
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
          ruleId: { type: 'string' },
          ruleValue: { type: 'string' },
          ruleEvidence: { type: 'string' },
        },
      },
      temperature: 0.15,
      maxTokens: Number(options.maxTokens) || 900,
    });

    const parsed = response.json;

    const subject = sanitizeSegment(parsed.subject || guessSubjectFromText(`${parsed.title || ''} ${effectiveRemark || ''}`), DEFAULT_SUBJECT, 24);
    const allowedSubjects = ['高等数学', '线性代数', '概率论', '数据结构', '计算机组成', '操作系统', '计算机网络', '英语', '政治', DEFAULT_SUBJECT];
    const aiTitle = sanitizeSegment(parsed.title, kind === 'canvas' ? '画布拼接笔记' : '图片笔记', titleMaxLength);
    const matchedRule = namingRules.find((rule) => rule.id === String(parsed.ruleId || '').trim()) || null;
    const ruleValue = matchedRule ? sanitizeSegment(parsed.ruleValue, '', 100) : '';
    const title = matchedRule && ruleValue
      ? applyNamingRuleTemplate(matchedRule, ruleValue, subject, aiTitle)
      : aiTitle;
    if (options.rejectGenericTitle !== false && /^(?:待识别|无法识别|未知(?:内容)?|未命名(?:内容)?|图片笔记|截图)$/u.test(title)) {
      const error = new Error('AI 没有返回可用标题或规则字段值');
      error.code = 'AI_NAMING_EMPTY';
      throw error;
    }

    return {
      subject: allowedSubjects.includes(subject) ? subject : guessSubjectFromText(`${subject} ${title} ${effectiveRemark || ''}`),
      title,
      reason: String(parsed.reason || '').slice(0, 120),
      providerUsed: response.provider,
      modelUsed: response.model,
      ruleId: matchedRule && ruleValue ? matchedRule.id : null,
      ruleName: matchedRule && ruleValue ? matchedRule.name : null,
      ruleValue: matchedRule && ruleValue ? ruleValue : null,
      ruleEvidence: matchedRule && ruleValue ? String(parsed.ruleEvidence || '').slice(0, 300) : null,
      error: null,
    };
  } catch (error) {
    return {
      ...makeFallbackName({ kind, remark: effectiveRemark }),
      providerUsed: null,
      modelUsed: null,
      ruleId: null,
      ruleName: null,
      ruleValue: null,
      ruleEvidence: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function generateWidgetWithAi(userPrompt) {
  const router = getAiRouter();
  if (!router) throw new Error(aiRouterInitError || 'AI router is unavailable');
  const options = router.getTaskOptions('widget_generation');
  const defaultWidth = clampNumber(options.defaultWidth, 360, 240, 720);
  const defaultHeight = clampNumber(options.defaultHeight, 260, 150, 620);
  const visualStyle = {
    dark_translucent: '深色半透明桌面卡片',
    light_clean: '明亮、简洁、低阴影界面',
    follow_request: '优先遵循用户需求中描述的视觉风格',
  }[options.visualStyle] || '深色半透明桌面卡片';
  const interactionLevel = {
    static: '静态展示，不生成需要 JavaScript 的交互',
    standard: '只生成必要的常规交互，状态清晰且可恢复',
    advanced: '可以生成较复杂的本地交互，但仍必须遵守安全限制',
  }[options.interactionLevel] || '只生成必要的常规交互';
  const prompt = [
    '你是“考研桌面助手”的前端模块生成器。根据用户需求生成一个可独立运行的小组件。',
    '只输出一个 JSON 对象，不要 Markdown，不要解释。',
    'JSON 格式：',
    '{"title":"模块标题","width":360,"height":260,"html":"...","css":"...","js":"..."}',
    '严格要求：',
    '1. 只使用原生 HTML、CSS、JavaScript，不引用外部库、网址、字体或图片。',
    '2. 禁止 fetch、XMLHttpRequest、WebSocket、EventSource、window.open、跳转、表单提交和跨页面通信。',
    '3. 不访问 cookie、localStorage、sessionStorage、indexedDB、父页面或顶层窗口。',
    `4. 所有交互仅操作当前模块 DOM；交互要求：${interactionLevel}。`,
    `4.1 视觉要求：${visualStyle}。`,
    '5. HTML 不包含 script/style 标签；CSS 和 JS 分别放入对应字段。',
    `6. width 取 240-720，height 取 150-620；用户未指定时优先使用 ${defaultWidth}×${defaultHeight}。内容精简，中文界面。`,
    options.allowJavaScript === false ? '7. 不生成 JavaScript，js 必须是空字符串。' : '7. 可以使用安全的原生 JavaScript 实现所需交互。',
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
    maxTokens: Number(options.maxTokens) || 5000,
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
      width: clampNumber(parsed.width, defaultWidth, 240, 720),
      height: clampNumber(parsed.height, defaultHeight, 150, 620),
      html,
      css: String(parsed.css || '').slice(0, 30000),
      js: options.allowJavaScript === false ? '' : String(parsed.js || '').slice(0, 30000),
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

function sendCanvasEvent(res, payload) {
  res.write(`event: canvas-project\ndata: ${JSON.stringify(payload)}\n\n`);
}

function broadcastCanvasProject(payload) {
  for (const client of canvasEventClients) {
    try {
      sendCanvasEvent(client, payload);
    } catch {
      canvasEventClients.delete(client);
    }
  }
}

function handleCanvasEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.socket?.setKeepAlive(true);
  res.write('retry: 1500\n: connected\n\n');
  canvasEventClients.add(res);
  if (activeCanvasSelection) {
    sendCanvasEvent(res, activeCanvasSelection);
  }
  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(heartbeat);
      canvasEventClients.delete(res);
    }
  }, 20_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    canvasEventClients.delete(res);
  });
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
    isGood: parsed.flags?.isClassic === true,
    shouldMemorize: parsed.flags?.shouldMemorize === true,
  };
  if (intent.isGood && !tags.includes('好题')) tags.push('好题');
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
  const learningCardsAllowed = knowledgePath.length > 0;
  if (learningCardsAllowed && intent.shouldMemorize && back.length >= 6 && details.title !== back) {
    cards.push({
      sourceKey: 'remark-memory:0',
      kind: 'memory',
      front: details.title || '回忆这条笔记的核心内容',
      back,
      status: 'active',
      knowledgePath,
      tags,
      pageRefs,
    });
  }
  if (learningCardsAllowed && intent.isMistake && back.length >= 6) {
    cards.push({
      sourceKey: 'remark-mistake:0',
      kind: 'mistake',
      front: details.title ? `重做：${details.title}` : '重新说明这道错题的正确思路',
      back: parsed.wrongReasons?.[0] || back,
      status: 'active',
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
    organizationStatus: details.subject && details.subject !== DEFAULT_SUBJECT ? 'confirmed' : 'pending',
    classificationSource: details.subject && details.subject !== DEFAULT_SUBJECT ? 'local' : 'ai',
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
    learning: {
      ...(saved.metadata.learning || {}),
      organizationStatus: saved.metadata.subject === DEFAULT_SUBJECT ? 'pending' : 'confirmed',
      classificationSource: saved.metadata.learning?.classificationSource || 'local',
      pendingAiOrganization: false,
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
  const keepsManualClassification = latest.metadata.learning?.classificationSource === 'manual';
  const subject = keepsManualClassification
    ? sanitizeSegment(latest.metadata.subject, DEFAULT_SUBJECT, 60)
    : naming.subject === DEFAULT_SUBJECT && requestedSubject !== DEFAULT_SUBJECT
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
      ruleId: naming.ruleId,
      ruleName: naming.ruleName,
      ruleValue: naming.ruleValue,
      ruleEvidence: naming.ruleEvidence,
      error: null,
      completedAt,
    },
    classifier: {
      ...(latest.metadata.classifier || {}),
      status: 'named',
      provider: naming.providerUsed,
    },
    learning: {
      ...(latest.metadata.learning || {}),
      title: safeTitle,
      subject,
      knowledgePath: keepsManualClassification
        ? latest.metadata.learning.knowledgePath
        : [subject, ...((latest.metadata.learning?.knowledgePath || []).filter((item) => item !== latest.metadata.subject && item !== subject))].slice(0, 3),
      organizationStatus: keepsManualClassification || subject !== DEFAULT_SUBJECT ? 'confirmed' : 'pending',
      classificationSource: keepsManualClassification ? 'manual' : 'ai',
      pendingAiOrganization: false,
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

function publicCanvasOrganizationJob(job) {
  if (!job) return null;
  const { previewDataUrl: _previewDataUrl, ...safe } = job;
  return safe;
}

function updateCanvasOrganizationJob(projectId, changes) {
  const current = canvasOrganizationJobs.get(projectId);
  if (!current) return null;
  const next = { ...current, ...changes, updatedAt: new Date().toISOString() };
  canvasOrganizationJobs.set(projectId, next);
  return next;
}

function queueCanvasOrganization(projectId, previewDataUrl, sourceClientId) {
  const active = canvasOrganizationJobs.get(projectId);
  if (active && ['queued', 'analyzing', 'applying'].includes(active.status)) {
    const error = new Error('这个画布已经在由 AI 整理，请等待当前任务完成');
    error.code = 'CANVAS_AI_ALREADY_RUNNING';
    throw error;
  }
  const existing = canvasProjects.readDocument(projectId);
  if (!existing) {
    const error = new Error('找不到这个画布工程');
    error.code = 'CANVAS_AI_PROJECT_NOT_FOUND';
    throw error;
  }
  const movableCount = (existing.images?.length || 0) + (existing.texts?.length || 0) + (existing.annotations?.length || 0);
  if (movableCount === 0) {
    const error = new Error('画布里还没有可由 AI 整理的图片、文字或批注');
    error.code = 'CANVAS_AI_EMPTY';
    throw error;
  }
  const timestamp = new Date().toISOString();
  const job = {
    id: `canvas-ai-${crypto.randomUUID()}`,
    projectId,
    status: 'queued',
    progress: 12,
    message: '画布已保存，AI 整理任务已进入后台队列。',
    sourceClientId,
    requestedRevision: existing.syncRevision || 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    previewDataUrl,
  };
  canvasOrganizationJobs.set(projectId, job);

  canvasOrganizationQueue = canvasOrganizationQueue.catch(() => undefined).then(async () => {
    const analysisStartedAt = Date.now();
    let activeAttempt = null;
    const progressTimer = setInterval(() => {
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - analysisStartedAt) / 1000));
      const attemptText = activeAttempt
        ? `${activeAttempt.provider}/${activeAttempt.model}`
        : 'AI 模型';
      updateCanvasOrganizationJob(projectId, {
        progress: Math.min(76, 40 + Math.floor(elapsedSeconds / 4)),
        message: `${attemptText} 正在分析画布（已用 ${elapsedSeconds} 秒）；单次最多等待 90 秒，超时会自动切换模型。`,
      });
    }, 4_000);
    updateCanvasOrganizationJob(projectId, {
      status: 'analyzing',
      progress: 38,
      message: 'AI 正在理解图片、文字、批注和内容关系。',
      startedAt: new Date().toISOString(),
    });
    try {
      const router = getAiRouter();
      if (!router) throw new Error(aiRouterInitError || 'AI router is unavailable');
      const baseDocument = canvasProjects.readDocument(projectId);
      if (!baseDocument) throw new Error('画布在整理过程中被删除');
      const plan = await analyzeCanvasOrganization({
        document: baseDocument,
        previewDataUrl,
        router,
        onAttempt(attempt) {
          activeAttempt = attempt;
          const phaseText = attempt.phase === 'json_repair' ? '修复返回格式' : '分析画布';
          updateCanvasOrganizationJob(projectId, {
            progress: Math.max(40, canvasOrganizationJobs.get(projectId)?.progress || 40),
            message: `${attempt.provider}/${attempt.model} 正在${phaseText}；单次最多等待 ${Math.round(attempt.timeoutMs / 1000)} 秒，超时会自动切换模型。`,
            provider: attempt.provider,
            model: attempt.model,
          });
        },
      });
      clearInterval(progressTimer);
      updateCanvasOrganizationJob(projectId, {
        status: 'applying',
        progress: 82,
        message: 'AI 已给出布局，正在安全应用到最新画布版本。',
        provider: plan.provider,
        model: plan.model,
      });
      const latest = canvasProjects.readDocument(projectId);
      if (!latest) throw new Error('画布在整理过程中被删除');
      const applied = applyCanvasOrganization(latest, plan);
      const updatedAt = new Date().toISOString();
      const actualRevision = Number.isInteger(latest.syncRevision) && latest.syncRevision >= 0 ? latest.syncRevision : 0;
      const document = canvasProjects.saveDocument({
        ...applied.document,
        id: projectId,
        syncRevision: actualRevision + 1,
        updatedAt,
        aiOrganization: {
          jobId: job.id,
          provider: plan.provider,
          model: plan.model,
          summary: plan.summary,
          movedCount: applied.movedCount,
          completedAt: updatedAt,
        },
      }, { canvasId: projectId });
      updateCanvasOrganizationJob(projectId, {
        status: 'complete',
        progress: 100,
        message: `AI 整理完成，已重新布局 ${applied.movedCount} 项内容。`,
        summary: plan.summary,
        movedCount: applied.movedCount,
        revision: document.syncRevision,
        completedAt: updatedAt,
        previewDataUrl: undefined,
      });
      broadcastCanvasProject({
        type: 'saved',
        projectId,
        revision: document.syncRevision,
        updatedAt: document.updatedAt,
      });
    } catch (error) {
      updateCanvasOrganizationJob(projectId, {
        status: 'failed',
        progress: 100,
        message: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? error.message : String(error),
        failedAt: new Date().toISOString(),
        previewDataUrl: undefined,
      });
    } finally {
      clearInterval(progressTimer);
    }
  });
  return publicCanvasOrganizationJob(job);
}

async function handleCanvasProjectRoute(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/canvas-projects/events') {
    handleCanvasEvents(req, res);
    return true;
  }

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
      strokeCount: project.strokeCount,
      syncRevision: project.syncRevision,
    }));
    sendJson(res, 200, { ok: true, projects });
    return true;
  }

  if (req.method === 'POST' && pathname === '/canvas-projects/active') {
    const payload = JSON.parse((await readBody(req, ACTIVE_CANVAS_MAX_BODY_BYTES)) || '{}');
    const projectId = typeof payload.projectId === 'string' ? payload.projectId.trim() : '';
    assertCanvasId(projectId);
    if (!canvasProjects.readDocument(projectId, { validate: false })) {
      sendJson(res, 404, { ok: false, error: '找不到这个画布工程' });
      return true;
    }
    const sourceClientId = requireLiveStrokeString(payload.clientId, 'clientId', 128);
    activeCanvasSelectionRevision += 1;
    activeCanvasSelection = {
      type: 'active',
      projectId,
      sourceClientId,
      selectionRevision: activeCanvasSelectionRevision,
      selectedAt: new Date().toISOString(),
    };
    broadcastCanvasProject(activeCanvasSelection);
    sendJson(res, 200, { ok: true, active: activeCanvasSelection });
    return true;
  }

  const liveStrokeMatch = /^\/canvas-projects\/([^/]+)\/live-stroke$/.exec(pathname);
  if (req.method === 'POST' && liveStrokeMatch) {
    const projectId = decodeURIComponent(liveStrokeMatch[1]);
    assertCanvasId(projectId);
    const payload = JSON.parse((await readBody(req, LIVE_STROKE_MAX_BODY_BYTES)) || '{}');
    const { sourceClientId, stroke } = normalizeLiveStrokePayload(payload);
    broadcastCanvasProject({
      type: 'live-stroke',
      projectId,
      sourceClientId,
      stroke,
    });
    sendJson(res, 202, { ok: true });
    return true;
  }

  const aiOrganizeMatch = /^\/canvas-projects\/([^/]+)\/ai-organize$/.exec(pathname);
  if (aiOrganizeMatch) {
    const projectId = decodeURIComponent(aiOrganizeMatch[1]);
    assertCanvasId(projectId);
    if (req.method === 'GET') {
      const job = publicCanvasOrganizationJob(canvasOrganizationJobs.get(projectId));
      sendJson(res, 200, { ok: true, job });
      return true;
    }
    if (req.method === 'POST') {
      const payload = JSON.parse((await readBody(req, CANVAS_AI_MAX_BODY_BYTES)) || '{}');
      const previewDataUrl = typeof payload.previewDataUrl === 'string' ? payload.previewDataUrl : '';
      if (!previewDataUrl.startsWith('data:image/') || previewDataUrl.length > CANVAS_AI_MAX_BODY_BYTES - 64 * 1024) {
        throw new SyntaxError('previewDataUrl must be a supported image data URL within the request limit');
      }
      const sourceClientId = requireLiveStrokeString(payload.clientId, 'clientId', 128);
      const job = queueCanvasOrganization(projectId, previewDataUrl, sourceClientId);
      sendJson(res, 202, { ok: true, job });
      return true;
    }
    return false;
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
    const expectedRevision = payload.document && typeof payload.document === 'object'
      ? payload.expectedRevision
      : undefined;
    if (
      expectedRevision !== undefined
      && (!Number.isInteger(expectedRevision) || expectedRevision < 0)
    ) {
      throw new SyntaxError('expectedRevision must be a non-negative integer');
    }
    let sourceClientId = null;
    if (payload.document && typeof payload.document === 'object' && payload.clientId !== undefined) {
      if (typeof payload.clientId !== 'string' || !payload.clientId.trim() || payload.clientId.trim().length > 128) {
        throw new SyntaxError('clientId must be a non-empty string of at most 128 characters');
      }
      sourceClientId = payload.clientId.trim();
    }
    const existing = canvasProjects.readDocument(projectId, { validate: false });
    const actualRevision = Number.isInteger(existing?.syncRevision) && existing.syncRevision >= 0
      ? existing.syncRevision
      : 0;
    if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
      sendJson(res, 409, {
        ok: false,
        code: 'CANVAS_REVISION_CONFLICT',
        error: `Canvas project revision changed from ${expectedRevision} to ${actualRevision}`,
        expectedRevision,
        actualRevision,
      });
      return true;
    }
    const updatedAt = new Date().toISOString();
    const document = canvasProjects.saveDocument({
      ...source,
      id: projectId,
      syncRevision: actualRevision + 1,
      updatedAt,
    }, { canvasId: projectId });
    const summary = canvasProjects.listDocuments().find((item) => item.id === projectId) ?? null;
    broadcastCanvasProject({
      type: 'saved',
      projectId,
      revision: document.syncRevision,
      updatedAt: document.updatedAt,
      sourceClientId,
    });
    sendJson(res, 200, { ok: true, document, summary });
    return true;
  }

  if (req.method === 'DELETE') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const expectedRevision = payload.expectedRevision;
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
      throw new SyntaxError('expectedRevision must be a non-negative integer');
    }
    let sourceClientId = null;
    if (payload.clientId !== undefined) {
      if (typeof payload.clientId !== 'string' || !payload.clientId.trim() || payload.clientId.trim().length > 128) {
        throw new SyntaxError('clientId must be a non-empty string of at most 128 characters');
      }
      sourceClientId = payload.clientId.trim();
    }
    const existing = canvasProjects.readDocument(projectId, { validate: false });
    if (!existing) {
      sendJson(res, 404, { ok: false, error: '找不到这个画布工程' });
      return true;
    }
    const actualRevision = Number.isInteger(existing.syncRevision) && existing.syncRevision >= 0
      ? existing.syncRevision
      : 0;
    if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
      sendJson(res, 409, {
        ok: false,
        code: 'CANVAS_REVISION_CONFLICT',
        error: `Canvas project revision changed from ${expectedRevision} to ${actualRevision}`,
        expectedRevision,
        actualRevision,
      });
      return true;
    }
    const deleted = canvasProjects.deleteDocument(projectId);
    if (activeCanvasSelection?.projectId === projectId) {
      activeCanvasSelection = null;
    }
    broadcastCanvasProject({
      type: 'deleted',
      projectId,
      revision: actualRevision,
      updatedAt: deleted.deletedAt,
      sourceClientId,
    });
    sendJson(res, 200, {
      ok: true,
      projectId,
      deletedAt: deleted.deletedAt,
      recoverable: true,
    });
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

  if (req.method === 'POST' && pathname === '/learning-data/notes') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const snapshot = learningData.createNote(payload.input ?? payload.note, {
      expectedRevision: payload.expectedRevision,
    });
    broadcastLearningData(snapshot);
    sendJson(res, 201, snapshot);
    return true;
  }

  if (req.method === 'POST' && pathname === '/learning-data/cards') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const snapshot = learningData.createCard(payload.input ?? payload.card, {
      expectedRevision: payload.expectedRevision,
    });
    broadcastLearningData(snapshot);
    sendJson(res, 201, snapshot);
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
  const noteRestoreMatch = /^\/learning-data\/notes\/([^/]+)\/restore$/.exec(pathname);
  if (noteRestoreMatch && req.method === 'POST') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const snapshot = learningData.restoreNote(decodeURIComponent(noteRestoreMatch[1]), {
      expectedRevision: payload.expectedRevision,
    });
    broadcastLearningData(snapshot);
    sendJson(res, 200, snapshot);
    return true;
  }
  if (noteMatch && req.method === 'PATCH') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const noteUid = decodeURIComponent(noteMatch[1]);
    let snapshot = learningData.updateNote(noteUid, payload.patch, {
      expectedRevision: payload.expectedRevision,
    });
    try {
      const metadata = persistManualClassification(noteUid, payload.patch);
      if (metadata) {
        snapshot = learningData.syncNote(metadata, {
          enrichment: metadata.learning,
          cards: snapshot.cards
            .filter((card) => card.noteUid === noteUid)
            .map((card) => ({ ...card, sourceFilePath: metadata.filePath })),
        });
      }
    } catch (error) {
      console.warn(`Manual note classification metadata sync failed for ${noteUid}:`, error);
    }
    broadcastLearningData(snapshot);
    sendJson(res, 200, snapshot);
    return true;
  }
  if (noteMatch && req.method === 'DELETE') {
    const payload = JSON.parse((await readBody(req)) || '{}');
    const snapshot = learningData.deleteNote(decodeURIComponent(noteMatch[1]), {
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
  const lanProxyRequest = isLanProxyRequest(req);
  if (lanProxyRequest) {
    const lanRequestUrl = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    const lanPathname = lanRequestUrl.pathname;
    const lanMethod = req.method || 'GET';
    if (!isAllowedLanProxyRoute(lanMethod, lanPathname, lanRequestUrl.searchParams)) {
      sendJson(res, 403, { ok: false, error: 'This endpoint is not available over LAN app access.' });
      return;
    }
  }

  const corsOrigin = lanProxyRequest ? null : allowedCorsOrigin(req);
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
      const image = await revealNoteImage(NOTES_ROOT, payload.path);
      sendJson(res, 200, { ok: true, filePath: image.filePath });
      return;
    }

    if (req.method === 'GET' && pathname === '/ai/config') {
      if (!canControlNoteApp(req)) {
        sendJson(res, 403, { ok: false, error: 'AI 配置只能在运行服务的 Windows 主机上查看。' });
        return;
      }
      sendJson(res, 200, getAiConfigurationSnapshot());
      return;
    }

    if (req.method === 'PUT' && pathname === '/ai/config') {
      if (!canControlNoteApp(req)) {
        sendJson(res, 403, { ok: false, error: 'AI 配置只能在运行服务的 Windows 主机上修改。' });
        return;
      }
      const payload = JSON.parse((await readBody(req, 128 * 1024)) || '{}');
      const snapshot = saveAiTaskConfigurations(payload.tasks);
      sendJson(res, 200, snapshot);
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
      : ['NOTE_ALREADY_EXISTS', 'CARD_ALREADY_EXISTS', 'NOTE_DELETED'].includes(error?.code) ? 409
      : error?.code === 'CANVAS_AI_ALREADY_RUNNING' ? 409
      : error?.code === 'CANVAS_AI_PROJECT_NOT_FOUND' ? 404
      : error?.code === 'CANVAS_AI_EMPTY' ? 400
      : ['INVALID_LEARNING_NOTE', 'INVALID_LEARNING_CARD'].includes(error?.code) ? 400
      : error?.code === 'LEARNING_DATA_BUSY' ? 503
      : error?.code === 'NOTE_PATH_FORBIDDEN' ? 403
      : error?.code === 'NOTE_FILE_NOT_FOUND' ? 404
      : error?.code === 'NOTE_FILE_UNSUPPORTED' ? 415
      : error?.code === 'NOTE_REVEAL_UNSUPPORTED' ? 501
      : error?.code === 'NOTE_REVEAL_LAUNCH_FAILED' ? 503
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
  console.log('LAN app proxy: enabled without device authentication (canvas and learning-data routes)');
  console.log(`Qwen: ${qwen.apiKey ? `enabled (${qwen.model})` : `disabled, configPath=${qwen.configPath}`}`);
  const currentRouter = getAiRouter();
  console.log(`AI router providers: ${currentRouter ? currentRouter.getStatus().providers.filter((provider) => provider.enabled).map((provider) => provider.id).join(', ') || 'none' : `unavailable (${aiRouterInitError})`}`);
  const resumedJobs = resumePendingAiNamingJobs();
  if (resumedJobs > 0) console.log(`Resumed ${resumedJobs} pending AI naming job(s).`);
});
