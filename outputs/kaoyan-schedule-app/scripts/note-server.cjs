const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
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
const { createNoteAiAnalyzer } = require('./note-ai-analyzer.cjs');
const {
  acquireOrganizerLock,
  moveWithJournal,
  rebuildMetadataIndex,
  recoverMoves,
} = require('./organize-notes.cjs');
const { noteFileContentDisposition, resolveNoteFile, revealNoteImage } = require('./note-file-access.cjs');
const {
  atomicWriteJson,
  ensureKnowledgePoint,
  ensureSubject,
  loadTaxonomy,
  saveTaxonomyAtomic,
} = require('./note-taxonomy.cjs');
const { parseRemark } = require('./remark-parser.cjs');
const { loadQwenConfig } = require('./qwen-config.cjs');
const { unlinkFileIfExists } = require('./safe-file-ops.cjs');
const { createReviewSyncManager, selectWindowsDirectory } = require('./review-github-sync.cjs');
const {
  createPersistentAiRequestGuard,
  localDateKey,
  normalizeAiUsageProtection,
  readDailyAttempts,
} = require('./ai-request-budget.cjs');

const PORT = Number(process.env.KAOYAN_NOTE_PORT || 5174);
const NOTES_ROOT = process.env.KAOYAN_NOTES_ROOT || path.join(os.homedir(), 'Desktop', '笔记');
const ASSISTANT_ROOT = process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手');
const LAYOUT_PATH = path.join(ASSISTANT_ROOT, 'desktop-layout.json');
const ORGANIZER_STATE_PATH = path.join(ASSISTANT_ROOT, 'note-organizer-state.json');
const ORGANIZER_LOCK_PATH = path.join(ASSISTANT_ROOT, 'note-organizer.lock');
const ORGANIZER_MOVE_LOG_PATH = path.join(ASSISTANT_ROOT, 'note-organizer-moves.jsonl');
const AI_PROVIDER_CONFIG_PATH = process.env.KAOYAN_AI_CONFIG_PATH || path.join(ASSISTANT_ROOT, 'ai-providers.json');
const AI_USAGE_PATH = path.join(ASSISTANT_ROOT, 'ai-usage.json');
const AI_REQUEST_ATTEMPTS_PATH = path.join(ASSISTANT_ROOT, 'ai-request-attempts.jsonl');
const AI_HTML_EVENTS_PATH = path.join(ASSISTANT_ROOT, 'ai-html-events.jsonl');
const AI_HTML_EVENTS_MAX_BYTES = 4 * 1024 * 1024;
const AI_HTML_EVENTS_BACKUPS = 2;
const BACKGROUND_JOB_LOG_PATH = path.join(ASSISTANT_ROOT, 'background-jobs.jsonl');
const NOTE_ENRICHMENT_TIMEOUT_MS = 5 * 60 * 1000;
const LAN_PROXY_HEADER = 'x-kaoyan-lan-proxy';
const EXPLICIT_AI_ACTION_HEADER = 'x-kaoyan-ai-action';
const LIVE_STROKE_MAX_BODY_BYTES = 512 * 1024;
const ACTIVE_CANVAS_MAX_BODY_BYTES = 16 * 1024;
const CANVAS_AI_MAX_BODY_BYTES = 9 * 1024 * 1024;
const LIVE_STROKE_MAX_POINTS = 4096;
const NOTE_TAXONOMY_PATH = path.join(ASSISTANT_ROOT, 'note-taxonomy.json');
const NOTE_SAVE_RECEIPTS_ROOT = path.join(ASSISTANT_ROOT, 'note-save-receipts');
const MATERIAL_NOTE_RECEIPTS_ROOT = path.join(ASSISTANT_ROOT, 'material-note-receipts');
const CAPTURE_JOBS_ROOT = path.join(ASSISTANT_ROOT, 'capture-jobs');
const SEARCH_INDEX_PATH = path.join(ASSISTANT_ROOT, 'search-index.json');
const TAXONOMY_CONSOLIDATION_STATE_PATH = path.join(ASSISTANT_ROOT, 'taxonomy-consolidation-state.json');
const MATERIAL_WINDOW_REQUEST_ROOT = path.join(os.tmpdir(), 'kaoyan-material-previews');
const RELAY_TRANSFER_TTL_MS = 2 * 60 * 1000;
const RELAY_TRANSFER_ID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|relay_[A-Za-z0-9_-]{20,64})$/i;
const relayTransfers = new Map();
const HTML_PREVIEW_SESSION_TTL_MS = 20 * 60 * 1000;
const HTML_PREVIEW_SESSION_MAX_BYTES = 8 * 1024 * 1024;
const HTML_PREVIEW_SESSION_MAX_COUNT = 8;
const htmlPreviewSessions = new Map();
const MATERIAL_FILES_ROOT = path.join(NOTES_ROOT, '.materials');
const MAX_MATERIAL_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MATERIAL_TOTAL_BYTES = 16 * 1024 * 1024;
const MATERIAL_NAMING_BATCH_SIZE = 8;
const MATERIAL_MIME_BY_EXT = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.gif', 'image/gif'], ['.bmp', 'image/bmp'], ['.avif', 'image/avif'], ['.heic', 'image/heic'], ['.heif', 'image/heif'],
  ['.pdf', 'application/pdf'], ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.html', 'text/html'], ['.htm', 'text/html'], ['.css', 'text/css'], ['.js', 'text/javascript'], ['.mjs', 'text/javascript'],
  ['.json', 'application/json'], ['.svg', 'image/svg+xml'], ['.txt', 'text/plain'], ['.md', 'text/markdown'],
]);
const MATERIAL_EXT_BY_MIME = new Map([...MATERIAL_MIME_BY_EXT].map(([extension, mime]) => [mime, extension]));
const DEFAULT_SUBJECT = '默认文件夹';
const ALLOWED_STORED_SUBJECTS = new Set([
  DEFAULT_SUBJECT,
  '高等数学',
  '线性代数',
  '概率论',
  '数据结构',
  '计算机组成',
  '操作系统',
  '计算机网络',
  '英语',
  '政治',
]);
const normalizeStoredSubject = (value) => {
  const candidate = String(value || '').normalize('NFKC').trim();
  return ALLOWED_STORED_SUBJECTS.has(candidate) ? candidate : DEFAULT_SUBJECT;
};
const PROJECT_ROOT = path.resolve(__dirname, '..');
const qwen = loadQwenConfig();
const learningData = createLearningDataStore({ assistantRoot: ASSISTANT_ROOT });
const reviewSync = createReviewSyncManager({
  assistantRoot: ASSISTANT_ROOT,
  configPath: AI_PROVIDER_CONFIG_PATH,
  getLearningSnapshot: () => learningData.getSnapshot(),
});
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
const aiNamingQueues = [Promise.resolve(), Promise.resolve()];
let aiNamingLaneCursor = 0;
const aiNamingJobs = new Map();
let noteEnrichmentQueue = Promise.resolve();
const noteEnrichmentJobs = new Map();
const manualAiJobs = new Map();
const semanticQueryCache = new Map();
const materialNamingJobs = new Map();
const materialNamingRerunRequests = new Map();
let noteTitlePolicyPromise = null;
function getNoteTitlePolicy() {
  if (!noteTitlePolicyPromise) noteTitlePolicyPromise = import('../shared/note-title-policy.js');
  return noteTitlePolicyPromise;
}
let canvasOrganizationQueue = Promise.resolve();
const canvasOrganizationJobs = new Map();
const beforeAiRequest = createPersistentAiRequestGuard({
  assistantRoot: ASSISTANT_ROOT,
  logPath: AI_REQUEST_ATTEMPTS_PATH,
  getSettings: () => readAiUsageProtection(),
});

function emptyAiUsage() {
  return { schemaVersion: 1, updatedAt: null, providers: {}, daily: {} };
}

function appendBackgroundJobLog(event) {
  try {
    fs.mkdirSync(ASSISTANT_ROOT, { recursive: true });
    fs.appendFileSync(BACKGROUND_JOB_LOG_PATH, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...event,
    })}\n`, 'utf8');
  } catch {
    // Diagnostics must never make a note operation fail.
  }
}

function appendAiHtmlEvent(event) {
  try {
    fs.mkdirSync(ASSISTANT_ROOT, { recursive: true });
    if (fs.existsSync(AI_HTML_EVENTS_PATH) && fs.statSync(AI_HTML_EVENTS_PATH).size >= AI_HTML_EVENTS_MAX_BYTES) {
      for (let index = AI_HTML_EVENTS_BACKUPS; index >= 1; index -= 1) {
        const source = index === 1 ? AI_HTML_EVENTS_PATH : `${AI_HTML_EVENTS_PATH}.${index - 1}`;
        const target = `${AI_HTML_EVENTS_PATH}.${index}`;
        if (!fs.existsSync(source)) continue;
        fs.rmSync(target, { force: true });
        fs.renameSync(source, target);
      }
    }
    fs.appendFileSync(AI_HTML_EVENTS_PATH, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...event,
    })}\n`, 'utf8');
  } catch {
    // Diagnostics must never make an AI creation request fail.
  }
}

function cleanHtmlPreviewSessions(now = Date.now()) {
  for (const [id, session] of htmlPreviewSessions) {
    if (!session || Number(session.expiresAt) <= now) htmlPreviewSessions.delete(id);
  }
}

const htmlPreviewCleanupTimer = setInterval(
  cleanHtmlPreviewSessions,
  Math.min(HTML_PREVIEW_SESSION_TTL_MS, 60_000),
);
htmlPreviewCleanupTimer.unref?.();

function isVerifiedGeoGebraHtml(html) {
  const officialRuntime = Array.from(String(html || '').matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi)).some((match) => {
    try {
      const runtimeUrl = new URL(String(match[2] || ''));
      return runtimeUrl.protocol === 'https:'
        && runtimeUrl.hostname === 'www.geogebra.org'
        && runtimeUrl.pathname === '/apps/deployggb.js';
    } catch {
      return false;
    }
  });
  return officialRuntime && /\bnew\s+GGBApplet\s*\(/.test(String(html || ''));
}

function createHtmlPreviewSession(html) {
  const source = String(html || '');
  if (!isVerifiedGeoGebraHtml(source)) {
    const error = new Error('只允许为经过识别的 GeoGebra HTML 创建兼容预览');
    error.code = 'HTML_PREVIEW_PROFILE_INVALID';
    throw error;
  }
  if (Buffer.byteLength(source, 'utf8') > HTML_PREVIEW_SESSION_MAX_BYTES) {
    const error = new Error('GeoGebra HTML 超过兼容预览大小上限');
    error.code = 'PAYLOAD_TOO_LARGE';
    throw error;
  }
  cleanHtmlPreviewSessions();
  while (htmlPreviewSessions.size >= HTML_PREVIEW_SESSION_MAX_COUNT) {
    const oldestId = htmlPreviewSessions.keys().next().value;
    if (!oldestId) break;
    htmlPreviewSessions.delete(oldestId);
  }
  const id = crypto.randomBytes(24).toString('base64url');
  htmlPreviewSessions.set(id, {
    html: source,
    expiresAt: Date.now() + HTML_PREVIEW_SESSION_TTL_MS,
  });
  return id;
}

function sendHtmlPreviewSession(res, session) {
  const body = String(session.html || '');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; img-src blob: data: https://geogebra.org https://*.geogebra.org; media-src blob: data: https://geogebra.org https://*.geogebra.org; font-src blob: data: https://geogebra.org https://*.geogebra.org; style-src 'unsafe-inline' blob: https://geogebra.org https://*.geogebra.org; script-src 'unsafe-inline' blob: https://geogebra.org https://*.geogebra.org; worker-src blob: https://geogebra.org https://*.geogebra.org; connect-src https://geogebra.org https://*.geogebra.org; frame-src https://geogebra.org https://*.geogebra.org; form-action 'none'; base-uri 'none'; object-src 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readAiUsage() {
  if (!fs.existsSync(AI_USAGE_PATH)) return emptyAiUsage();
  try {
    const parsed = JSON.parse(fs.readFileSync(AI_USAGE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...emptyAiUsage(), ...parsed, providers: parsed.providers || {}, daily: parsed.daily || {} }
      : emptyAiUsage();
  } catch {
    return emptyAiUsage();
  }
}

function usageCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function addUsage(target, event) {
  const usage = event.usage && typeof event.usage === 'object' ? event.usage : {};
  const promptTokens = usageCount(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = usageCount(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = usageCount(usage.total_tokens) || promptTokens + completionTokens;
  target.calls = usageCount(target.calls) + 1;
  target.promptTokens = usageCount(target.promptTokens) + promptTokens;
  target.completionTokens = usageCount(target.completionTokens) + completionTokens;
  target.totalTokens = usageCount(target.totalTokens) + totalTokens;
  target.lastUsedAt = event.at;
}

function recordAiUsage(event) {
  const providerId = String(event.provider || 'unknown').trim().slice(0, 60) || 'unknown';
  const modelId = String(event.model || 'unknown').trim().slice(0, 160) || 'unknown';
  const date = String(event.at || new Date().toISOString()).slice(0, 10);
  const snapshot = readAiUsage();
  const provider = snapshot.providers[providerId] || { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, models: {} };
  addUsage(provider, event);
  const model = provider.models[modelId] || { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  addUsage(model, event);
  provider.models[modelId] = model;
  snapshot.providers[providerId] = provider;
  const day = snapshot.daily[date] || { providers: {} };
  const dayProvider = day.providers[providerId] || { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  addUsage(dayProvider, event);
  day.providers[providerId] = dayProvider;
  snapshot.daily[date] = day;
  const cutoff = new Date(Date.now() - 35 * 86_400_000).toISOString().slice(0, 10);
  for (const dayKey of Object.keys(snapshot.daily)) {
    if (dayKey < cutoff) delete snapshot.daily[dayKey];
  }
  snapshot.updatedAt = event.at;
  atomicWriteJson(AI_USAGE_PATH, snapshot);
}

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
    aiRouter = createAiRouter({
      configPath: AI_PROVIDER_CONFIG_PATH,
      onUsage: recordAiUsage,
      beforeAttempt: beforeAiRequest,
    });
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

function readAiUsageProtection(config = null) {
  const current = config && typeof config === 'object' ? config : readAiConfigFile();
  return normalizeAiUsageProtection(current.usageProtection);
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
  const usageProtection = readAiUsageProtection();
  return {
    ok: true,
    updatedAt,
    taskDefinitions: Object.entries(AI_TASK_DEFINITIONS).map(([id, definition]) => ({
      id,
      ...definition,
      defaults: {
        difficulty: TASK_PROFILES[id]?.difficulty || TASK_PROFILES.custom.difficulty,
        capabilities: [...(TASK_PROFILES[id]?.capabilities || TASK_PROFILES.custom.capabilities)],
        timeoutMs: Number(definition.defaultTimeoutMs) || loaded.routing.timeoutMs,
      },
      parameters: (TASK_PARAMETER_DEFINITIONS[id] || []).map((parameter) => ({
        ...parameter,
        ...(Array.isArray(parameter.options) ? { options: parameter.options.map((option) => ({ ...option })) } : {}),
      })),
    })),
    tasks: normalizeTaskConfigurations(loaded.tasks),
    providers: status.providers || [],
    routing: loaded.routing,
    usageProtection: {
      ...usageProtection,
      usedToday: readDailyAttempts(AI_REQUEST_ATTEMPTS_PATH, localDateKey()),
    },
    usage: readAiUsage(),
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

function saveAiTaskConfigurations(input, usageProtectionInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SyntaxError('AI 任务配置必须是对象');
  }
  const tasks = normalizeTaskConfigurations(input);
  const current = readAiConfigFile();
  const next = {
    ...current,
    tasks,
    usageProtection: normalizeAiUsageProtection(
      usageProtectionInput === undefined ? current.usageProtection : usageProtectionInput,
    ),
  };
  const loaded = loadAiProviderConfigs({
    configPath: AI_PROVIDER_CONFIG_PATH,
    localConfig: next,
    legacyQwenConfig: qwen,
  });
  validateTaskModelSelections(tasks, loaded.providers);
  createAiRouter({ config: loaded });

  fs.mkdirSync(path.dirname(AI_PROVIDER_CONFIG_PATH), { recursive: true });
  if (fs.existsSync(AI_PROVIDER_CONFIG_PATH)) {
    const backupStamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(AI_PROVIDER_CONFIG_PATH, `${AI_PROVIDER_CONFIG_PATH}.before-task-update-${backupStamp}.bak`);
  }
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

function saveAiProviderCredential(input) {
  const providerId = String(input?.providerId || '').trim().toLowerCase();
  const supported = {
    qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-vl-plus' },
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
    kimi: { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3' },
    deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
  };
  if (!supported[providerId]) throw new SyntaxError('不支持这个 AI 厂家');
  const apiKey = String(input?.apiKey || '').replace(/[\r\n\t ]+/g, '').trim();
  if (apiKey.length < 10 || apiKey.length > 10000) throw new SyntaxError('API Key 格式不正确');
  const model = String(input?.model || supported[providerId].model).trim().slice(0, 160) || supported[providerId].model;
  const current = readAiConfigFile();
  const existingProviders = Array.isArray(current.providers)
    ? Object.fromEntries(current.providers.map((provider) => [provider?.id, provider]).filter(([id]) => id))
    : current.providers && typeof current.providers === 'object' ? current.providers : {};
  const existing = existingProviders[providerId] && typeof existingProviders[providerId] === 'object'
    ? existingProviders[providerId]
    : {};
  const next = {
    ...current,
    providers: {
      ...existingProviders,
      [providerId]: {
        ...existing,
        enabled: true,
        apiKey,
        baseUrl: supported[providerId].baseUrl,
        model,
      },
    },
    ...(providerId === 'deepseek' ? {
      tasks: {
        ...(current.tasks || {}),
        semantic_search: {
          ...(current.tasks?.semantic_search || {}),
          providerId: 'deepseek',
          modelId: 'deepseek-v4-flash',
          fallback: true,
        },
        taxonomy: {
          ...(current.tasks?.taxonomy || {}),
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          fallback: true,
        },
      },
    } : {}),
  };
  loadAiProviderConfigs({ configPath: AI_PROVIDER_CONFIG_PATH, localConfig: next, legacyQwenConfig: qwen });
  fs.mkdirSync(path.dirname(AI_PROVIDER_CONFIG_PATH), { recursive: true });
  atomicWriteJson(AI_PROVIDER_CONFIG_PATH, next);
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
    'Access-Control-Allow-Headers': 'Content-Type, X-Kaoyan-AI-Action',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function requireExplicitAiAction(req) {
  if (String(req.headers[EXPLICIT_AI_ACTION_HEADER] || '').trim().toLowerCase() === 'user') return;
  const error = new Error('AI 请求已被安全拦截：请在当前页面明确点击对应的 AI 按钮。');
  error.code = 'AI_EXPLICIT_ACTION_REQUIRED';
  throw error;
}

function cleanRelayTransfers(now = Date.now()) {
  for (const [transferId, transfer] of relayTransfers) {
    if (!transfer || transfer.expiresAt <= now) relayTransfers.delete(transferId);
  }
}

function normalizeRelayUrl(value) {
  const candidate = String(value || '').trim();
  if (!candidate || candidate.length > 4096) return '';
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function normalizeRelayAsset(input) {
  if (!isPlainJsonObject(input)) throw new Error('Relay asset must be an object');
  const kind = ['image', 'pdf', 'word', 'html', 'file'].includes(input.kind) ? input.kind : 'file';
  const url = normalizeRelayUrl(input.url);
  const fallbackUrl = normalizeRelayUrl(input.fallbackUrl);
  const posterUrl = normalizeRelayUrl(input.posterUrl);
  if (!url && !fallbackUrl) throw new Error('Relay asset URL is required');
  return {
    id: String(input.id || '').slice(0, 180),
    kind,
    name: String(input.name || '未命名资料').replace(/[\r\n\t]+/g, ' ').slice(0, 240),
    mimeType: String(input.mimeType || 'application/octet-stream').slice(0, 160),
    url,
    fallbackUrl,
    posterUrl,
    label: String(input.label || '资料').slice(0, 80),
    sizeLabel: String(input.sizeLabel || '').slice(0, 80),
  };
}

function sendRelayJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function isLanProxyRequest(req) {
  return String(req.headers[LAN_PROXY_HEADER] || '') === '1';
}

function isAllowedLanProxyRoute(method, pathname, searchParams = new URLSearchParams()) {
  const queryKeys = [...searchParams.keys()];
  if (method === 'GET' && pathname === '/note-file') {
    const allowedKeys = new Set(['path', 'preview']);
    return queryKeys.every((key) => allowedKeys.has(key))
      && Boolean(searchParams.get('path'))
      && (searchParams.get('preview') === null || searchParams.get('preview') === '1');
  }
  if (queryKeys.length > 0) return false;
  if (method === 'GET' && pathname === '/canvas-projects') return true;
  if (method === 'GET' && pathname === '/canvas-projects/events') return true;
  if (method === 'POST' && pathname === '/canvas-projects/active') return true;
  if (method === 'POST' && /^\/canvas-projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/live-stroke$/.test(pathname)) return true;
  if ((method === 'GET' || method === 'POST') && /^\/canvas-projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/ai-organize$/.test(pathname)) return true;
  if ((method === 'GET' || method === 'PUT' || method === 'DELETE') && /^\/canvas-projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(pathname)) return true;
  if (method === 'POST' && (pathname === '/save-note' || pathname === '/save-note-batch' || pathname === '/save-material-note' || pathname === '/append-material-note' || pathname === '/capture-batches' || pathname === '/material-window' || pathname === '/html-preview-sessions' || pathname === '/ai/widget' || pathname === '/ai/html-note')) return true;
  if (method === 'GET' && /^\/html-preview-sessions\/[A-Za-z0-9_-]{32}$/.test(pathname)) return true;
  if (method === 'POST' && pathname === '/relay-transfers') return true;
  if (method === 'GET' && /^\/relay-transfers\/[A-Za-z0-9_-]{20,80}$/.test(pathname)) return true;
  if (method === 'GET' && /^\/jobs\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pathname)) return true;
  if (method === 'POST' && /^\/jobs\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/retry$/.test(pathname)) return true;
  if (method === 'GET' && (pathname === '/learning-data' || pathname === '/learning-data/events')) return true;
  if (method === 'GET' && /^\/ai\/jobs\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pathname)) return true;
  if (method === 'POST' && pathname === '/search') return true;
  if (method === 'POST' && (pathname === '/learning-data/notes' || pathname === '/learning-data/cards')) return true;
  if (method === 'POST' && /^\/learning-data\/notes\/[^/]+\/rename$/.test(pathname)) return true;
  if (method === 'POST' && pathname === '/learning-data/note-review-actions') return true;
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
    if (!['--note-app', '--close-note-app'].includes(flag) && !flag.startsWith('--material-preview=')) {
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

function normalizeClassificationPath(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => sanitizeSegment(item, '', 60)).filter(Boolean))].slice(0, 3);
}

const AI_SELECTION_MODES = new Set(['auto-light', 'auto-advanced', 'model', 'off']);
const WRONG_REASON_ROOTS = new Set(['粗心大意', '知识与记忆', '思路与方法', '推理与计算', '时间与策略', '其他']);

function normalizeNoteAiSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const mode = AI_SELECTION_MODES.has(value.mode) ? value.mode : 'auto-light';
  const providerId = String(value.providerId || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  const modelId = String(value.modelId || '').trim().replace(/[\r\n\t]/g, '').slice(0, 120);
  if (mode === 'model' && (!providerId || !modelId)) return { mode: 'auto-light' };
  return mode === 'model' ? { mode, providerId, modelId } : { mode };
}

function noteAiRoute(selection, kind, remark = '') {
  const remarkMissing = !String(remark || '').trim();
  const task = kind === 'canvas'
    ? 'canvas_note_understanding'
    : remarkMissing ? 'note_image_understanding' : 'note_naming';
  if (!selection) return { task };
  if (selection.mode === 'model') {
    return { task, preferredProvider: selection.providerId, preferredModel: selection.modelId, allowFallback: false };
  }
  if (kind === 'canvas') {
    return { task, difficulty: 'high' };
  }
  if (selection.mode === 'auto-advanced') {
    return { task, difficulty: 'high', ignoreTaskModelPreference: true };
  }
  if (remarkMissing) {
    // “自动轻量”是普通有备注笔记的成本偏好。没有备注时图片是唯一
    // 分类依据，必须保留无备注视觉任务的高质量模型偏好，仍然只调用一次 AI。
    return { task, difficulty: 'high' };
  }
  return { task, difficulty: 'low', ignoreTaskModelPreference: true };
}

function normalizeWrongReasonPath(value) {
  const pathValue = normalizeClassificationPath(value);
  return pathValue.length > 0 && WRONG_REASON_ROOTS.has(pathValue[0]) ? pathValue : [];
}

const preparedInternalDirectories = new Set();

function ensureInternalDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
  const resolved = path.resolve(directoryPath);
  if (preparedInternalDirectories.has(resolved)) return resolved;
  preparedInternalDirectories.add(resolved);
  if (process.platform === 'win32') {
    spawnSync('attrib.exe', ['+H', resolved], {
      windowsHide: true,
      stdio: 'ignore',
    });
  }
  return resolved;
}

function subjectDirForMetadata(metadata) {
  return path.join(NOTES_ROOT, normalizeStoredSubject(metadata?.subject));
}

function provisionalAssetDir(subjectDir, captureOriginal = false) {
  const assetRoot = ensureInternalDirectory(path.join(subjectDir, '.assets'));
  const directoryPath = path.join(assetRoot, captureOriginal ? 'capture-originals' : 'pending');
  fs.mkdirSync(directoryPath, { recursive: true });
  return directoryPath;
}

function concealExistingInternalDirectories() {
  if (!fs.existsSync(NOTES_ROOT)) return;
  const rootInternalDirectories = [MATERIAL_FILES_ROOT];
  for (const directoryPath of rootInternalDirectories) {
    if (fs.existsSync(directoryPath)) ensureInternalDirectory(directoryPath);
  }
  for (const entry of fs.readdirSync(NOTES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const subjectDir = path.join(NOTES_ROOT, entry.name);
    for (const name of ['.assets', '.metadata']) {
      const directoryPath = path.join(subjectDir, name);
      if (fs.existsSync(directoryPath)) ensureInternalDirectory(directoryPath);
    }
  }
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

function writeSaveReceipt(noteUid, metadata, learningSyncError = null, persistedSidecarPath = '') {
  fs.mkdirSync(NOTE_SAVE_RECEIPTS_ROOT, { recursive: true });
  const subjectDir = subjectDirForMetadata(metadata);
  const receipt = {
    schemaVersion: 1,
    noteUid,
    filePath: metadata.filePath,
    fileName: metadata.fileName,
    // Legacy notes can keep a descriptive sidecar filename while metadata.id
    // has already migrated to noteUid. Prefer the path that was actually
    // written instead of deriving a receipt path for a file that never existed.
    sidecarPath: persistedSidecarPath || sidecarPathForId(subjectDir, metadata.id),
    subject: metadata.subject,
    aiStatus: metadata.naming?.status || 'pending',
    learningSyncError,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(saveReceiptPath(noteUid), receipt);
  return receipt;
}

function readSaveReceipt(noteUid) {
  const receipt = readJson(saveReceiptPath(noteUid), null);
  if (!receipt || receipt.noteUid !== noteUid || typeof receipt.sidecarPath !== 'string') {
    return null;
  }
  const metadata = readJson(receipt.sidecarPath, null);
  const filePath = metadata?.filePath || receipt.filePath;
  if (!metadata || metadata.noteUid !== noteUid || typeof filePath !== 'string') {
    return null;
  }
  const fileExists = fs.existsSync(filePath);
  const namingInFlight = metadata.naming?.status === 'pending' && receipt.aiStatus === 'pending';
  if (!fileExists && !namingInFlight) {
    return null;
  }
  return {
    receipt,
    metadata,
    filePath,
    fileName: metadata.fileName || path.basename(filePath),
  };
}

function localMetadataFilePath(metadata) {
  const candidates = [
    metadata?.filePath,
    ...(Array.isArray(metadata?.attachments)
      ? metadata.attachments.flatMap((attachment) => [attachment?.filePath, attachment?.localPathKey])
      : []),
    metadata?.localPathKey,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const localCandidate = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(NOTES_ROOT, candidate);
    const relative = path.relative(path.resolve(NOTES_ROOT), localCandidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (fs.existsSync(localCandidate) && fs.statSync(localCandidate).isFile()) return localCandidate;
  }
  return '';
}

function isHashAssetMetadata(metadata, filePath = '') {
  const fileName = String(metadata?.fileName || path.basename(filePath) || '');
  const id = String(metadata?.id || '');
  const fileStem = path.parse(fileName).name;
  const internalAsset = String(filePath || metadata?.filePath || '').split(/[\\/]+/u).includes('.assets');
  return internalAsset
    || /^[a-f0-9]{64}(?:_\d+)?$/i.test(fileStem)
    || (/^[a-f0-9]{64}$/i.test(id) && /^[a-f0-9]{64}(?:_\d+)?$/i.test(fileStem));
}

function savedNotePreference(candidate) {
  const metadata = candidate?.metadata || {};
  const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
  const materialGroup = metadata.sourceType === 'material-note'
    || metadata.sourceType === 'quick-material'
    || (metadata.kind === 'quick' && attachments.length > 0);
  const captureKind = metadata.kind === 'single' || metadata.kind === 'canvas' ? 100 : 0;
  const readableName = isHashAssetMetadata(metadata, candidate?.filePath) ? 0 : 40;
  const visibleFile = String(candidate?.filePath || '').split(/[\\/]+/u).includes('.assets') ? 0 : 20;
  return (materialGroup ? 400 : 0) + Math.min(8, attachments.length) * 20 + captureKind + readableName + visibleFile;
}

function findSavedNote(noteUid) {
  const saved = readSaveReceipt(noteUid);
  if (saved && fs.existsSync(saved.filePath) && !isHashAssetMetadata(saved.metadata, saved.filePath)) return saved;
  if (!fs.existsSync(NOTES_ROOT)) return saved;
  const candidates = saved && fs.existsSync(saved.filePath) ? [saved] : [];
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
      const filePath = localMetadataFilePath(metadata);
      if (metadata?.noteUid !== noteUid || !filePath) continue;
      candidates.push({
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
      });
    }
  }
  return candidates.sort((left, right) => savedNotePreference(right) - savedNotePreference(left))[0] || saved;
}

function repairStrayHashAssets(noteUid, preferredFilePath = '') {
  if (!fs.existsSync(NOTES_ROOT)) return [];
  const repaired = [];
  for (const subjectEntry of fs.readdirSync(NOTES_ROOT, { withFileTypes: true })) {
    if (!subjectEntry.isDirectory() || subjectEntry.name.startsWith('.')) continue;
    const subjectDir = path.join(NOTES_ROOT, subjectEntry.name);
    const sidecarDir = metadataDir(subjectDir);
    if (!fs.existsSync(sidecarDir)) continue;
    for (const entry of fs.readdirSync(sidecarDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.note\.json$/i.test(entry.name)) continue;
      const sidecarPath = path.join(sidecarDir, entry.name);
      const metadata = readJson(sidecarPath, null);
      const sourcePath = localMetadataFilePath(metadata);
      if (
        metadata?.noteUid !== noteUid
        || !sourcePath
        || path.resolve(sourcePath) === path.resolve(preferredFilePath || sourcePath)
        || !isHashAssetMetadata(metadata, sourcePath)
        || path.resolve(path.dirname(sourcePath)) !== path.resolve(subjectDir)
      ) continue;
      const assetDir = ensureInternalDirectory(path.join(subjectDir, '.assets'));
      const targetPath = path.join(assetDir, path.basename(sourcePath));
      if (fs.existsSync(targetPath)) continue;
      fs.renameSync(sourcePath, targetPath);
      const replacePath = (value) => typeof value === 'string' && path.resolve(value) === path.resolve(sourcePath)
        ? targetPath
        : value;
      const updated = {
        ...metadata,
        filePath: targetPath,
        attachments: Array.isArray(metadata.attachments)
          ? metadata.attachments.map((attachment) => ({
              ...attachment,
              filePath: replacePath(attachment?.filePath),
              localPathKey: replacePath(attachment?.localPathKey),
              previewPath: replacePath(attachment?.previewPath),
              posterPath: replacePath(attachment?.posterPath),
            }))
          : metadata.attachments,
        learning: metadata.learning && typeof metadata.learning === 'object'
          ? {
              ...metadata.learning,
              cards: Array.isArray(metadata.learning.cards)
                ? metadata.learning.cards.map((card) => ({ ...card, sourceFilePath: replacePath(card?.sourceFilePath) }))
                : metadata.learning.cards,
            }
          : metadata.learning,
      };
      atomicWriteJson(sidecarPath, updated);
      repaired.push({ sourcePath, targetPath, sidecarPath });
    }
  }
  return repaired;
}

function findLearningNote(snapshot, noteUid) {
  for (const day of Object.values(snapshot?.days || {})) {
    const note = Array.isArray(day?.autoNotes)
      ? day.autoNotes.find((item) => item?.noteUid === noteUid)
      : null;
    if (note) return note;
  }
  return null;
}

function canPersistWithoutLocalMetadata(note) {
  const filePath = typeof note?.filePath === 'string' ? note.filePath.trim() : '';
  return !filePath || /^(?:github|https?):\/\//i.test(filePath);
}

function resolveLearningNoteImage(note) {
  const candidates = [
    note?.filePath,
    ...(Array.isArray(note?.attachments)
      ? note.attachments.flatMap((attachment) => [
          attachment?.filePath,
          attachment?.cloudPath,
          attachment?.localPathKey,
        ])
      : []),
  ];
  let lastError = null;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      const resolved = resolveNoteFile(NOTES_ROOT, candidate);
      if (String(resolved.mime || '').startsWith('image/')) return resolved;
    } catch (error) {
      lastError = error;
    }
  }
  throw makeReviewError(
    '这条记录的原图尚未同步到本机，无法启动 AI 命名',
    lastError?.code === 'NOTE_FILE_NOT_FOUND' ? 'NOTE_IMAGE_NOT_SYNCED' : 'NOTE_IMAGE_UNAVAILABLE',
  );
}

function makeReviewError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizedReviewStatus(learning = {}) {
  if (['pending', 'auto_applied', 'accepted', 'corrected', 'ignored'].includes(learning.reviewStatus)) {
    return learning.reviewStatus;
  }
  if (learning.organizationStatus === 'ignored') return 'ignored';
  if (learning.classificationSource === 'manual') return 'corrected';
  return learning.organizationStatus === 'confirmed' ? 'auto_applied' : 'pending';
}

function proposalIdFor(noteUid, subject, knowledgePath, seed = '') {
  const digest = crypto.createHash('sha256')
    .update(`${noteUid}|${subject}|${(knowledgePath || []).join('/')}|${seed}`)
    .digest('hex')
    .slice(0, 20);
  return `proposal-${digest}`;
}

function persistNoteReviewAction(action, snapshot) {
  const noteUid = typeof action?.noteUid === 'string' ? action.noteUid.trim() : '';
  const operationId = typeof action?.operationId === 'string' ? action.operationId.trim().slice(0, 160) : '';
  const actionType = action?.action;
  if (!noteUid || !operationId || !['accept', 'correct', 'ignore'].includes(actionType)) {
    throw makeReviewError('Invalid note review action', 'INVALID_NOTE_REVIEW_ACTION');
  }
  const currentNote = findLearningNote(snapshot, noteUid);
  if (!currentNote) throw makeReviewError(`Learning note not found: ${noteUid}`, 'NOTE_NOT_FOUND');
  const saved = findSavedNote(noteUid);
  if (!saved) {
    // Text-only notes and cloud/GitHub-backed notes have no local sidecar by
    // design. Their atomic learning-data snapshot is the durable source of
    // truth, so human edits must not be rejected as missing local metadata.
    if (canPersistWithoutLocalMetadata(currentNote)) return { metadata: null, durable: true, replayed: false };
    throw makeReviewError(`Durable note metadata not found: ${noteUid}`, 'NOTE_FILE_METADATA_NOT_FOUND');
  }
  const currentLearning = saved.metadata.learning && typeof saved.metadata.learning === 'object'
    ? saved.metadata.learning
    : {};
  const sidecarRevision = Number.isInteger(Number(currentLearning.decisionRevision))
    ? Math.max(0, Number(currentLearning.decisionRevision))
    : ['accepted', 'corrected', 'ignored'].includes(normalizedReviewStatus(currentLearning)) ? 1 : 0;
  const storeRevision = Number.isInteger(Number(currentNote.decisionRevision))
    ? Math.max(0, Number(currentNote.decisionRevision))
    : 0;
  const currentDecisionRevision = Math.max(sidecarRevision, storeRevision);
  const lastOperationId = sidecarRevision >= storeRevision
    ? currentLearning.lastReviewOperationId
    : currentNote.lastReviewOperationId;
  const lastAction = sidecarRevision >= storeRevision
    ? currentLearning.lastReviewAction
    : currentNote.lastReviewAction;
  if (lastOperationId === operationId) {
    if (lastAction && lastAction !== actionType) {
      throw makeReviewError(`Review operation id already used: ${operationId}`, 'REVIEW_OPERATION_REUSED');
    }
    return { metadata: saved.metadata, durable: true, replayed: true };
  }
  if (action.expectedDecisionRevision !== undefined && action.expectedDecisionRevision !== null) {
    const expected = Number(action.expectedDecisionRevision);
    if (!Number.isInteger(expected) || expected !== currentDecisionRevision) {
      throw makeReviewError(
        `Note review decision conflict: expected ${action.expectedDecisionRevision}, actual ${currentDecisionRevision}`,
        'NOTE_REVIEW_CONFLICT',
        { expectedDecisionRevision: action.expectedDecisionRevision, actualDecisionRevision: currentDecisionRevision },
      );
    }
  }
  const currentProposalId = String(currentLearning.proposalId || currentNote.proposalId || '');
  const proposalId = typeof action.proposalId === 'string' ? action.proposalId.trim().slice(0, 160) : '';
  if (proposalId && currentProposalId && proposalId !== currentProposalId) {
    throw makeReviewError('The AI proposal changed before it was reviewed', 'NOTE_REVIEW_PROPOSAL_CONFLICT', {
      expectedProposalId: proposalId,
      actualProposalId: currentProposalId,
    });
  }

  const patch = action.patch && typeof action.patch === 'object' && !Array.isArray(action.patch) ? action.patch : {};
  const proposed = actionType === 'accept' && saved.metadata.organizer?.proposed
    ? saved.metadata.organizer.proposed
    : {};
  const subject = normalizeStoredSubject(
    patch.subject || proposed.subject || currentLearning.subject || saved.metadata.subject,
  );
  const incomingPath = Array.isArray(patch.knowledgePath)
    ? patch.knowledgePath
    : proposed.knowledgePoint
      ? [subject, proposed.knowledgePoint]
      : currentLearning.knowledgePath;
  const knowledgePath = [subject, ...(Array.isArray(incomingPath) ? incomingPath : [])
    .map((item) => sanitizeSegment(item, '', 60))
    .filter((item) => item && item !== subject && item !== saved.metadata.subject)]
    .slice(0, 3);
  const knowledgePoint = knowledgePath[1] || null;
  const reviewStatus = actionType === 'accept' ? 'accepted' : actionType === 'correct' ? 'corrected' : 'ignored';
  const updatedAt = new Date().toISOString();
  const nextProposalId = proposalId || currentProposalId || proposalIdFor(noteUid, subject, knowledgePath);

  let subjectNode = null;
  let pointNode = null;
  if (actionType !== 'ignore') {
    const taxonomy = loadTaxonomy(NOTE_TAXONOMY_PATH);
    subjectNode = ensureSubject(taxonomy, subject, { createdBy: actionType === 'correct' ? 'user' : 'ai' });
    pointNode = knowledgePoint
      ? ensureKnowledgePoint(taxonomy, subjectNode, knowledgePoint, { createdBy: actionType === 'correct' ? 'user' : 'ai' })
      : null;
    saveTaxonomyAtomic(NOTE_TAXONOMY_PATH, taxonomy);
  }

  const metadata = {
    ...saved.metadata,
    subject,
    updatedAt,
    ...(Object.hasOwn(patch, 'title') ? { title: String(patch.title || '').trim().slice(0, 120) } : {}),
    ...(Object.hasOwn(patch, 'remark') ? { remark: String(patch.remark || '').trim().slice(0, 8_000) } : {}),
    ...(Object.hasOwn(patch, 'goodQuestion') ? { goodQuestion: patch.goodQuestion === true } : {}),
    ...(Object.hasOwn(patch, 'goodQuestionType') ? { goodQuestionType: String(patch.goodQuestionType || '').trim().slice(0, 40) } : {}),
    ...(actionType === 'ignore' ? {} : {
      classification: {
        ...(saved.metadata.classification || {}),
        subjectId: subjectNode?.id || null,
        subjectName: subjectNode?.name || subject,
        knowledgePointId: pointNode?.id || null,
        knowledgePointName: pointNode?.name || knowledgePoint,
        reviewedBy: 'user',
        reviewedAt: updatedAt,
      },
    }),
    organizer: {
      ...(saved.metadata.organizer || {}),
      status: `user_${reviewStatus}`,
      proposed: null,
    },
    learning: {
      ...currentLearning,
      subject,
      knowledgePath,
      ...(Object.hasOwn(patch, 'title') ? { title: String(patch.title || '').trim().slice(0, 120) } : {}),
      ...(Object.hasOwn(patch, 'remark') ? { remark: String(patch.remark || '').trim().slice(0, 8_000) } : {}),
      ...(Object.hasOwn(patch, 'tags') ? { tags: [...new Set((Array.isArray(patch.tags) ? patch.tags : []).map((item) => String(item || '').trim().slice(0, 80)).filter(Boolean))].slice(0, 30) } : {}),
      ...(Object.hasOwn(patch, 'noteType') ? { noteType: String(patch.noteType || '').trim().slice(0, 40) } : {}),
      ...(Object.hasOwn(patch, 'questionType') ? { questionType: String(patch.questionType || '').trim().slice(0, 60) } : {}),
      ...(Object.hasOwn(patch, 'questionTypePath') ? { questionTypePath: normalizeClassificationPath(patch.questionTypePath) } : {}),
      ...(Object.hasOwn(patch, 'wrongReason') ? { wrongReason: String(patch.wrongReason || '').trim().slice(0, 500) } : {}),
      ...(Object.hasOwn(patch, 'wrongReasonPath') ? { wrongReasonPath: normalizeClassificationPath(patch.wrongReasonPath) } : {}),
      ...(Object.hasOwn(patch, 'learningTypePath') ? { learningTypePath: normalizeClassificationPath(patch.learningTypePath) } : {}),
      ...(Object.hasOwn(patch, 'goodQuestion') ? { goodQuestion: patch.goodQuestion === true } : {}),
      ...(Object.hasOwn(patch, 'goodQuestionType') ? { goodQuestionType: String(patch.goodQuestionType || '').trim().slice(0, 40) } : {}),
      organizationStatus: reviewStatus === 'ignored' ? 'ignored' : 'confirmed',
      classificationSource: reviewStatus === 'corrected' ? 'manual' : currentLearning.classificationSource || currentNote.classificationSource || 'ai',
      reviewStatus,
      decisionRevision: currentDecisionRevision + 1,
      lastReviewOperationId: operationId,
      lastReviewAction: actionType,
      proposalId: nextProposalId,
      reviewedAt: updatedAt,
      pendingAiOrganization: false,
      userEditedFields: [...new Set([
        ...(Array.isArray(currentLearning.userEditedFields) ? currentLearning.userEditedFields : []),
        ...Object.keys(patch),
      ])].slice(0, 40),
      ...(reviewStatus === 'ignored' ? { cards: [] } : {}),
    },
  };

  let finalMetadata = metadata;
  let finalSidecarPath = saved.receipt.sidecarPath;
  const destinationDir = path.join(NOTES_ROOT, subject);
  const shouldMove = actionType !== 'ignore' && path.resolve(path.dirname(saved.filePath)) !== path.resolve(destinationDir);
  if (shouldMove) {
    const movement = moveWithJournal({
      notesRoot: NOTES_ROOT,
      logPath: ORGANIZER_MOVE_LOG_PATH,
      imagePath: saved.filePath,
      sidecarPath: saved.receipt.sidecarPath,
      destinationDir,
      metadata,
    });
    finalMetadata = movement.metadata || metadata;
    finalSidecarPath = movement.sidecarPath;
  } else {
    atomicWriteJson(finalSidecarPath, metadata);
    rebuildMetadataIndex(subjectDirForMetadata(saved.metadata));
  }
  appendMetadata(subjectDirForMetadata(finalMetadata), finalMetadata);
  writeSaveReceipt(noteUid, finalMetadata, saved.receipt.learningSyncError, finalSidecarPath);
  repairStrayHashAssets(noteUid, finalMetadata.filePath);
  return { metadata: finalMetadata, sidecarPath: finalSidecarPath, durable: true, replayed: false };
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
  ensureInternalDirectory(metaDir);
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

function isIntentOnlyRemark(value) {
  const remainder = String(value || '')
    .normalize('NFKC')
    .replace(/\b\d+(?:\.\d+)*\b/g, ' ')
    .replace(/错题|好题|背诵|背|记住|记忆|速记/g, ' ')
    .replace(/[#，,。；;：:、_\-\s]+/g, '');
  return remainder.length === 0;
}

function makeFallbackName({ kind, remark, subject }) {
  const text = remark && remark.trim() ? remark : kind === 'canvas' ? '待确认画布笔记' : '待确认题目';
  const safeSubject = sanitizeSegment(subject || guessSubjectFromText(text), DEFAULT_SUBJECT, 24);
  const pendingTitle = kind !== 'canvas' && isIntentOnlyRemark(remark)
    ? '正在识别题目内容'
    : text;
  const safeTitle = sanitizeSegment(pendingTitle, kind === 'canvas' ? '画布拼接笔记' : '图片笔记', 42);
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

async function generateNameWithAi({ imageDataUrl, kind, remark, aiSelection }) {
  const { ALLOWED_NOTE_SUBJECTS, normalizeNoteSubject, sanitizeNoteTitle, validateNoteTitle } = await getNoteTitlePolicy();
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
  const route = noteAiRoute(aiSelection, kind, effectiveRemark);
  const routeOptions = router?.getTaskOptions(route.task) || {};
  const prompt = [
    '你是考研学习笔记整理助手。请结合图片内容和用户备注，为这张学习截图生成适合 Windows 文件名的中文标题。',
    '要求：',
    `1. 识别所属科目，只能从：${ALLOWED_NOTE_SUBJECTS.join('、')} 中选择。`,
    options.preferSpecificSubject === false
      ? '1.1 按图片内容选择科目；确实不清晰或跨科时可选择“默认文件夹”。'
      : '1.1 只要图片或备注能看出学科，就必须选择最合理的具体科目；只有图片不可读、没有学习内容或确实无法判断时才选“默认文件夹”。不要因为不完全确定就退回默认。',
    `2. title 目标长度为 ${titleMinLength} 到 ${titleMaxLength} 个字符，${titleStyleText}。`,
    '3. 不要输出随机数，不要输出日期，不要输出文件后缀。',
    '4. 不要使用 Windows 非法字符：<>:"/\\|?*。',
    '4.1 用户备注里的“错题”“好题”“背”“背诵”“记住”只表示收录分类，不是标题。即使备注只有这些词，也必须阅读图片内容并生成具体标题与科目。',
    '5. 先逐条检查“字段命名规则”。只有图片中能直接看到规则要求的标签及对应值时才算匹配，严禁用相似编号、日期或其他字段猜测。',
    '6. 如果匹配规则：ruleId 填规则 id，ruleValue 填原图中提取到的字段值，ruleEvidence 简述标签和值的位置；title 仍给出普通内容标题。程序会根据模板生成最终标题。',
    options.rejectGenericTitle === false
      ? '7. 如果没有规则匹配：ruleId、ruleValue、ruleEvidence 都输出空字符串；title 应尽量给出具体可见主题。'
      : '7. 如果没有规则匹配：ruleId、ruleValue、ruleEvidence 都输出空字符串。禁止输出“待识别”“无法识别”“未知内容”“截图”“图片笔记”作为 title；应给出图片中最具体的可见主题。',
    '8. 必须检查图片中的手写批注、圈画、划改、订正文字、老师评语和边栏笔记；这些信息与题目正文同等重要。',
    '8.1 knowledgePoint 输出稳定、可复用的知识点短语，不要把整道题描述当知识点。',
    '8.2 只有图片或用户备注直接写出具体错误原因，或可见划改明确证明了错误动作时，才输出 wrongReason。图片直接证据标记 explicit_image，备注直接证据标记 explicit_remark；无法确认时必须为 null/none，禁止猜测。',
    '8.3 wrongReasonEvidence 简短抄录或描述可见证据及其位置；wrongReasonPath 最多三级，一级只能是：粗心大意、知识与记忆、思路与方法、推理与计算、时间与策略、其他。',
    '9. 只输出 JSON：{"subject":"科目","title":"标题","knowledgePoint":"知识点或null","wrongReason":null,"wrongReasonPath":[],"wrongReasonSource":"none","wrongReasonEvidence":"","reason":"一句话依据","ruleId":"匹配规则id或空字符串","ruleValue":"提取值或空字符串","ruleEvidence":"原图证据或空字符串"}',
    `保存类型：${kind === 'canvas' ? '多图画布' : '单图'}`,
    `用户备注：${effectiveRemark || '无'}`,
    `字段命名规则：${namingRules.length ? JSON.stringify(namingRules) : '无'}`,
  ].join('\n');

  try {
    if (!router) throw new Error(aiRouterInitError || 'AI router is unavailable');
    const response = await router.complete({
      ...route,
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
          knowledgePoint: { type: ['string', 'null'] },
          wrongReason: { type: ['string', 'null'] },
          wrongReasonPath: { type: 'array', maxItems: 3, items: { type: 'string' } },
          wrongReasonSource: { type: 'string' },
          wrongReasonEvidence: { type: 'string' },
        },
      },
      temperature: 0.15,
      maxTokens: Number(routeOptions.maxTokens) || Number(options.maxTokens) || (kind === 'canvas' ? 1600 : 900),
    });

    const parsed = response.json;

    const subject = normalizeNoteSubject(parsed.subject || guessSubjectFromText(`${parsed.title || ''} ${effectiveRemark || ''}`));
    const aiTitle = sanitizeNoteTitle(parsed.title, titleMaxLength);
    const matchedRule = namingRules.find((rule) => rule.id === String(parsed.ruleId || '').trim()) || null;
    const ruleValue = matchedRule ? sanitizeSegment(parsed.ruleValue, '', 100) : '';
    const title = matchedRule && ruleValue
      ? applyNamingRuleTemplate(matchedRule, ruleValue, subject, aiTitle)
      : aiTitle;
    const titleValidation = validateNoteTitle(title, { ...options, titleMinLength, titleMaxLength, allowRuleIdentifier: Boolean(matchedRule && ruleValue), ruleValue });
    if (!titleValidation.ok) {
      const error = new Error('AI 标题未通过统一校验：' + titleValidation.problem);
      error.code = 'AI_NAMING_INVALID';
      throw error;
    }

    return {
      subject: normalizeNoteSubject(subject, guessSubjectFromText(`${subject} ${title} ${effectiveRemark || ''}`)),
      title,
      reason: String(parsed.reason || '').slice(0, 120),
      providerUsed: response.provider,
      modelUsed: response.model,
      ruleId: matchedRule && ruleValue ? matchedRule.id : null,
      ruleName: matchedRule && ruleValue ? matchedRule.name : null,
      ruleValue: matchedRule && ruleValue ? ruleValue : null,
      ruleEvidence: matchedRule && ruleValue ? String(parsed.ruleEvidence || '').slice(0, 300) : null,
      knowledgePoint: sanitizeSegment(parsed.knowledgePoint, '', 60) || null,
      wrongReason: String(parsed.wrongReason || '').normalize('NFKC').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300) || null,
      wrongReasonPath: normalizeWrongReasonPath(parsed.wrongReasonPath),
      wrongReasonSource: ['explicit_remark', 'explicit_image', 'ai_inferred'].includes(parsed.wrongReasonSource)
        ? parsed.wrongReasonSource : 'none',
      wrongReasonEvidence: String(parsed.wrongReasonEvidence || '').normalize('NFKC').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500),
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
      knowledgePoint: null,
      wrongReason: null,
      wrongReasonPath: [],
      wrongReasonSource: 'none',
      wrongReasonEvidence: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateGeneratedHtmlArtifact({ html, css, js }) {
  const failures = [];
  if (/<\/?(?:script|style|iframe|object|embed|link|meta|base|form)\b/i.test(html)) {
    failures.push('HTML 含有不允许的标签');
  }
  if (/\son[a-z]+\s*=/i.test(html)) failures.push('HTML 含有内联事件处理器');
  if (/\s(?:href|src|srcset|xlink:href|action|formaction|poster|ping)\s*=/i.test(html)) {
    failures.push('HTML 含有导航或资源 URL 属性');
  }
  if (/@import\b|url\(\s*(["']?)\s*(?:https?:|\/\/|javascript:)/i.test(css)) {
    failures.push('CSS 含有外部资源');
  }
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|postMessage|window|globalThis|self|location|open|parent|top|opener|frames|defaultView|eval|constructor)\b|\b(?:href|src|srcset|xlinkHref|action|formAction|poster|ping)\b|\bdocument\s*\.\s*(?:cookie|URL|documentURI)\b/i.test(js) || /\bFunction\s*\(/.test(js)) {
    failures.push('JavaScript 含有网络、存储或跨页面 API');
  }
  if (String(js || '').trim()) {
    try {
      // Compile only. This catches syntax errors before the artifact is saved;
      // it never executes model-generated code in the note service.
      new vm.Script(String(js), { filename: 'ai-html-note.js' });
    } catch {
      failures.push('JavaScript 存在语法错误');
    }
  }
  if (failures.length > 0) {
    const error = new Error(`AI 生成内容未通过离线安全检查：${failures.join('；')}`);
    error.code = 'AI_HTML_VALIDATION_FAILED';
    throw error;
  }
}

async function generateWidgetWithAi(userPrompt, taskId = 'widget_generation') {
  const router = getAiRouter();
  if (!router) throw new Error(aiRouterInitError || 'AI router is unavailable');
  const isInteractiveNote = taskId === 'interactive_note_generation';
  const options = router.getTaskOptions(taskId);
  const defaultWidth = clampNumber(options.defaultWidth, isInteractiveNote ? 520 : 360, 240, 720);
  const defaultHeight = clampNumber(options.defaultHeight, isInteractiveNote ? 360 : 260, 150, 620);
  const visualStyle = {
    dark_translucent: '深色半透明桌面卡片',
    light_clean: isInteractiveNote ? '学习中心一致的暖白底、棕色强调、克制阴影' : '明亮、简洁、低阴影界面',
    follow_request: '优先遵循用户需求中描述的视觉风格',
  }[options.visualStyle] || '深色半透明桌面卡片';
  const interactionLevel = {
    static: '静态展示，不生成需要 JavaScript 的交互',
    standard: '只生成必要的常规交互，状态清晰且可恢复',
    advanced: '可以生成较复杂的本地交互，但仍必须遵守安全限制',
  }[options.interactionLevel] || '只生成必要的常规交互';
  const contentDensity = {
    concise: '大道至简：少文字、突出公式或操作，不重复速记正文',
    balanced: '均衡：保留必要说明、操作提示与结论',
    detailed: '详细：提供更完整的步骤提示与解释，但避免冗长段落',
  }[options.contentDensity] || '均衡：保留必要说明、操作提示与结论';
  const responsiveMode = {
    adaptive: '同时适配手机与桌面，控件可换行且不得横向溢出',
    mobile_first: '优先适配窄屏触控，桌面端自然放大',
    desktop_first: '优先桌面空间，但在窄屏仍必须可滚动和操作',
  }[options.responsiveMode] || '同时适配手机与桌面';
  const prompt = [
    isInteractiveNote
      ? '你是“考研桌面助手”学习中心的 HTML 交互笔记创作器。综合当前速记内容，生成一个可独立运行的学习资料。'
      : '你是“考研桌面助手”的前端模块生成器。根据用户需求生成一个可独立运行的小组件。',
    '只输出一个 JSON 对象，不要 Markdown，不要解释。',
    'JSON 格式：',
    '{"title":"模块标题","width":360,"height":260,"html":"...","css":"...","js":"..."}',
    '严格要求：',
    '1. 只使用原生 HTML、CSS、JavaScript，不引用外部库、网址、字体或图片。',
    '2. 禁止 fetch、XMLHttpRequest、WebSocket、EventSource、window.open、跳转、表单提交和跨页面通信。',
    '3. 不访问 cookie、localStorage、sessionStorage、indexedDB、父页面或顶层窗口。',
    `4. 所有交互仅操作当前模块 DOM；交互要求：${interactionLevel}。`,
    `4.1 视觉要求：${visualStyle}。`,
    isInteractiveNote ? `4.2 内容密度：${contentDensity}。` : '',
    isInteractiveNote ? `4.3 布局要求：${responsiveMode}。` : '',
    '5. HTML 不包含 script/style 标签；CSS 和 JS 分别放入对应字段。',
    `6. width 取 240-720，height 取 150-620；用户未指定时优先使用 ${defaultWidth}×${defaultHeight}。内容精简，中文界面。`,
    options.allowJavaScript === false ? '7. 不生成 JavaScript，js 必须是空字符串。' : '7. 可以使用安全的原生 JavaScript 实现所需交互。',
    isInteractiveNote && options.requireResetControl !== false ? '8. 只要存在可变状态，就必须提供清晰的重置或恢复初始状态操作。' : '',
    `用户需求：${userPrompt}`,
  ].filter(Boolean).join('\n');

  const response = await router.complete({
    task: taskId,
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
    validate(candidate) {
      const candidateHtml = String(candidate?.html || '').slice(0, 40_000);
      if (!candidateHtml.trim()) return 'HTML 字段不能为空';
      try {
        validateGeneratedHtmlArtifact({
          html: candidateHtml,
          css: String(candidate?.css || '').slice(0, 30_000),
          js: options.allowJavaScript === false ? '' : String(candidate?.js || '').slice(0, 30_000),
        });
        return true;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    responseFormatMode: options.structuredOutputMode || 'auto',
    timeoutMs: Number(AI_TASK_DEFINITIONS[taskId]?.defaultTimeoutMs) || 45_000,
    temperature: isInteractiveNote ? 0.25 : 0.35,
    networkRetries: Number.isFinite(Number(options.networkRetries)) ? Number(options.networkRetries) : undefined,
    jsonRepairRetries: Number.isFinite(Number(options.jsonRepairRetries)) ? Number(options.jsonRepairRetries) : undefined,
    maxCandidateCount: isInteractiveNote ? 2 : undefined,
    overallTimeoutMs: isInteractiveNote ? 570_000 : undefined,
    maxTokens: Number(options.maxTokens) || 5000,
  });

  const parsed = response.json;

  const html = String(parsed.html || '').slice(0, 40000);
  if (!html.trim()) {
    throw new Error('AI 返回的模块缺少 HTML');
  }

  const css = String(parsed.css || '').slice(0, 30000);
  const js = options.allowJavaScript === false ? '' : String(parsed.js || '').slice(0, 30000);
  validateGeneratedHtmlArtifact({ html, css, js });
  const artifactHash = crypto.createHash('sha256')
    .update(JSON.stringify({ html, css, js }))
    .digest('hex');

  return {
    provider: response.provider,
    model: response.model,
    attempts: Array.isArray(response.attempts) ? response.attempts : [],
    artifactHash,
    widget: {
      title: String(parsed.title || 'AI 代码模块').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 30) || 'AI 代码模块',
      width: clampNumber(parsed.width, defaultWidth, 240, 720),
      height: clampNumber(parsed.height, defaultHeight, 150, 620),
      html,
      css,
      js,
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

async function handleGenerateWidget(req, res, taskId = 'widget_generation') {
  const requestId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  const startedAt = Date.now();
  const raw = await readBody(req, 64 * 1024);
  const payload = JSON.parse(raw || '{}');
  const promptLimit = taskId === 'interactive_note_generation' ? 15_000 : 1_200;
  const prompt = String(payload.prompt || '').trim().slice(0, promptLimit);
  if (prompt.length < 3) {
    sendJson(res, 400, { ok: false, error: '请至少用一句话描述模块需求' });
    return;
  }
  appendAiHtmlEvent({ event: 'started', requestId, taskId, promptChars: prompt.length });
  try {
    const generated = await generateWidgetWithAi(prompt, taskId);
    const durationMs = Date.now() - startedAt;
    appendAiHtmlEvent({
      event: 'completed', requestId, taskId,
      provider: generated.provider, model: generated.model,
      durationMs, artifactHash: generated.artifactHash,
      attemptCount: generated.attempts.length,
    });
    sendJson(res, 200, {
      ok: true,
      requestId,
      durationMs,
      provider: generated.provider,
      model: generated.model,
      attempts: generated.attempts,
      artifactHash: generated.artifactHash,
      validationProfile: 'offline-html-v1',
      widget: generated.widget,
    });
  } catch (error) {
    const failedAttempts = Array.isArray(error?.attempts) ? error.attempts : [];
    const lastAttempt = failedAttempts.at(-1) || null;
    appendAiHtmlEvent({
      event: 'failed', requestId, taskId,
      durationMs: Date.now() - startedAt,
      attemptCount: failedAttempts.length,
      provider: lastAttempt?.provider || null,
      model: lastAttempt?.model || null,
      errorCode: String(error?.code || 'AI_HTML_GENERATION_FAILED'),
      error: String(error?.message || error).slice(0, 500),
    });
    if (error && typeof error === 'object') error.requestId = requestId;
    throw error;
  }
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
  const hasExplicitUserCategory = intent.isMistake || intent.isGood || intent.shouldMemorize;
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
    wrongReasonSource: parsed.wrongReasons?.[0] ? 'explicit_remark' : 'none',
      wrongReasonConfidence: parsed.wrongReasons?.[0] ? 1 : null,
      userEditedFields: [],
      intent,
    cards,
    organizationStatus: hasExplicitUserCategory || (details.subject && details.subject !== DEFAULT_SUBJECT) ? 'confirmed' : 'pending',
    classificationSource: details.subject && details.subject !== DEFAULT_SUBJECT ? 'local' : 'ai',
    reviewStatus: hasExplicitUserCategory || (details.subject && details.subject !== DEFAULT_SUBJECT) ? 'auto_applied' : 'pending',
    decisionRevision: 0,
    proposalId: proposalIdFor(details.noteUid || 'new-note', details.subject || DEFAULT_SUBJECT, knowledgePath, createdAt),
    flags: parsed.flags,
    pendingAiOrganization: true,
  };
}

function persistBackgroundMetadata(saved, metadata) {
  atomicWriteJson(saved.receipt.sidecarPath, metadata);
  appendMetadata(subjectDirForMetadata(metadata), metadata);
  const learningSyncError = syncLearningMetadata(metadata);
  writeSaveReceipt(metadata.noteUid, metadata, learningSyncError, saved.receipt.sidecarPath);
}

function markAiNamingFailed(noteUid, error, naming = null) {
  const releaseOrganizerLock = acquireOrganizerLock(ORGANIZER_LOCK_PATH);
  try {
  const saved = readSaveReceipt(noteUid);
  if (!saved) return;
  const completedAt = new Date().toISOString();
  const currentReviewStatus = normalizedReviewStatus(saved.metadata.learning || {});
  const keepsHumanDecision = ['accepted', 'corrected', 'ignored'].includes(currentReviewStatus);
  const explicitIntent = saved.metadata.learning?.intent || {};
  const hasExplicitUserCategory = explicitIntent.isMistake === true
    || explicitIntent.isGood === true
    || explicitIntent.shouldMemorize === true;
  const storedDecisionRevision = Number(saved.metadata.learning?.decisionRevision);
  const decisionRevision = Number.isInteger(storedDecisionRevision) && storedDecisionRevision >= 0
    ? storedDecisionRevision
    : keepsHumanDecision ? 1 : 0;
  const reviewStatus = keepsHumanDecision
    ? currentReviewStatus
    : hasExplicitUserCategory || saved.metadata.subject !== DEFAULT_SUBJECT ? 'auto_applied' : 'pending';
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
      organizationStatus: reviewStatus === 'ignored' ? 'ignored' : reviewStatus === 'pending' ? 'pending' : 'confirmed',
      classificationSource: saved.metadata.learning?.classificationSource || 'local',
      reviewStatus,
      decisionRevision,
      proposalId: saved.metadata.learning?.proposalId
        || proposalIdFor(noteUid, saved.metadata.subject, saved.metadata.learning?.knowledgePath || [], saved.metadata.createdAt),
      pendingAiOrganization: false,
      ...(reviewStatus === 'ignored' ? { cards: [] } : {}),
    },
  };
  persistBackgroundMetadata(saved, metadata);
  } finally {
    releaseOrganizerLock();
  }
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
    aiSelection: saved.metadata.aiSelection,
  });

  if (naming.error) {
    markAiNamingFailed(noteUid, naming.error, naming);
    return;
  }

  // The 72-hour organizer may have enriched this sidecar while the model was
  // running. Re-read it now and merge only naming/path fields so classification
  // and generated cards are never overwritten by the stale pre-AI snapshot.
  const releaseOrganizerLock = acquireOrganizerLock(ORGANIZER_LOCK_PATH);
  try {
  const latest = readSaveReceipt(noteUid);
  if (!latest) return;
  const requestedSubject = normalizeStoredSubject(latest.metadata.requestedSubject);
  const currentReviewStatus = normalizedReviewStatus(latest.metadata.learning || {});
  const keepsHumanDecision = ['accepted', 'corrected', 'ignored'].includes(currentReviewStatus);
  const explicitIntent = latest.metadata.learning?.intent || {};
  const hasExplicitUserCategory = explicitIntent.isMistake === true
    || explicitIntent.isGood === true
    || explicitIntent.shouldMemorize === true;
  const storedDecisionRevision = Number(latest.metadata.learning?.decisionRevision);
  const decisionRevision = Number.isInteger(storedDecisionRevision) && storedDecisionRevision >= 0
    ? storedDecisionRevision
    : keepsHumanDecision ? 1 : 0;
  const subject = keepsHumanDecision
    ? normalizeStoredSubject(latest.metadata.subject)
    : latest.metadata.subjectLocked === true && requestedSubject !== DEFAULT_SUBJECT
      ? requestedSubject
      : normalizeStoredSubject(naming.subject, DEFAULT_SUBJECT);
  const visualWrongReason = latest.metadata.learning?.wrongReason || naming.wrongReason || '';
  const visualWrongReasonPath = latest.metadata.learning?.wrongReasonPath?.length
    ? latest.metadata.learning.wrongReasonPath
    : naming.wrongReasonPath;
  const visualWrongReasonSource = latest.metadata.learning?.wrongReason
    ? latest.metadata.learning?.wrongReasonSource || 'explicit_remark'
    : naming.wrongReason ? naming.wrongReasonSource : 'none';
  const knowledgePath = keepsHumanDecision
    ? latest.metadata.learning.knowledgePath
    : [
        subject,
        ...(naming.knowledgePoint ? [naming.knowledgePoint] : []),
        ...((latest.metadata.learning?.knowledgePath || []).filter((item) => item !== latest.metadata.subject && item !== subject)),
      ].filter((item, index, values) => item && values.indexOf(item) === index).slice(0, 3);
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
  const originalPath = latest.filePath;
  const currentAttachments = Array.isArray(latest.metadata.attachments) && latest.metadata.attachments.length > 0
    ? latest.metadata.attachments
    : [{
        id: 'primary-image', kind: 'image', name: latest.metadata.fileName || path.basename(originalPath),
        mimeType: latest.metadata.mime || `image/${ext}`, size: fs.statSync(originalPath).size,
        filePath: originalPath, cloudPath: '', localPathKey: '', previewPath: '', posterPath: '',
        createdAt: latest.metadata.createdAt,
      }];
  const rebasedAttachments = currentAttachments.map((attachment, index) => {
    const attachmentPath = String(attachment?.filePath || '');
    const isPrimary = index === 0 || (attachmentPath && path.resolve(attachmentPath) === path.resolve(originalPath));
    return isPrimary ? {
      ...attachment,
      id: attachment.id || 'primary-image',
      kind: 'image',
      name: target.filename,
      mimeType: latest.metadata.mime || attachment.mimeType || `image/${ext}`,
      size: Number(attachment.size) > 0 ? Number(attachment.size) : fs.statSync(originalPath).size,
      filePath: target.filePath,
    } : attachment;
  });
  const metadata = {
    ...latest.metadata,
    id: targetId,
    subject,
    title: safeTitle,
    fileName: target.filename,
    filePath: target.filePath,
    attachments: rebasedAttachments,
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
      model: naming.modelUsed,
      visualEvidence: {
        knowledgePoint: naming.knowledgePoint,
        wrongReason: naming.wrongReason,
        wrongReasonPath: naming.wrongReasonPath,
        wrongReasonSource: naming.wrongReasonSource,
        wrongReasonEvidence: naming.wrongReasonEvidence,
      },
    },
    learning: {
      ...(latest.metadata.learning || {}),
      title: safeTitle,
      subject,
      fileName: target.filename,
      filePath: target.filePath,
      attachments: rebasedAttachments,
      knowledgePath,
      wrongReason: keepsHumanDecision ? latest.metadata.learning?.wrongReason || '' : visualWrongReason,
      wrongReasonPath: keepsHumanDecision ? latest.metadata.learning?.wrongReasonPath || [] : visualWrongReasonPath || [],
      wrongReasonSource: keepsHumanDecision ? latest.metadata.learning?.wrongReasonSource || 'none' : visualWrongReasonSource,
      wrongReasonConfidence: keepsHumanDecision
        ? latest.metadata.learning?.wrongReasonConfidence ?? null
        : visualWrongReason ? (['explicit_image', 'explicit_remark'].includes(visualWrongReasonSource) ? 1 : 0.65) : null,
      visualEvidence: {
        wrongReasonEvidence: naming.wrongReasonEvidence || '',
        source: naming.wrongReasonSource || 'none',
      },
      organizationStatus: currentReviewStatus === 'ignored'
        ? 'ignored'
        : keepsHumanDecision || hasExplicitUserCategory || subject !== DEFAULT_SUBJECT ? 'confirmed' : 'pending',
      classificationSource: currentReviewStatus === 'corrected' ? 'manual' : keepsHumanDecision
        ? latest.metadata.learning?.classificationSource || 'ai'
        : 'ai',
      reviewStatus: keepsHumanDecision
        ? currentReviewStatus
        : hasExplicitUserCategory || subject !== DEFAULT_SUBJECT ? 'auto_applied' : 'pending',
      decisionRevision,
      proposalId: keepsHumanDecision
        ? latest.metadata.learning?.proposalId
          || proposalIdFor(noteUid, subject, latest.metadata.learning?.knowledgePath || [subject], latest.metadata.createdAt)
        : proposalIdFor(noteUid, subject, [subject], completedAt),
      pendingAiOrganization: false,
      ...(currentReviewStatus === 'ignored' ? { cards: [] } : {}),
    },
  };

  const originalSidecarPath = latest.receipt.sidecarPath;
  const originalSubjectDir = subjectDirForMetadata(latest.metadata);
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
    atomicWriteJson(originalSidecarPath, stagedMetadata);
    writeSaveReceipt(noteUid, stagedMetadata, latest.receipt.learningSyncError, originalSidecarPath);
    receiptUpdated = true;
    appendMetadata(subjectDir, stagedMetadata);
  } else {
    ensureInternalDirectory(metadataDir(subjectDir));
    fs.renameSync(originalPath, target.filePath);
    try {
      atomicWriteJson(targetSidecarPath, stagedMetadata);
      // Make the idempotency receipt point at the new, already-valid pair
      // before deleting the old sidecar or index entry.
      writeSaveReceipt(noteUid, stagedMetadata, latest.receipt.learningSyncError, targetSidecarPath);
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
  atomicWriteJson(activeSidecarPath, metadata);
  appendMetadata(subjectDir, metadata);
  writeSaveReceipt(noteUid, metadata, learningSyncError, activeSidecarPath);
  } finally {
    releaseOrganizerLock();
  }
}

function queueNoteEnrichment(noteUid) {
  if (!noteUid || noteEnrichmentJobs.has(noteUid)) return false;
  const job = noteEnrichmentQueue.then(() => new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, 'organize-notes.cjs'), '--allow-ai', '--force', `--note-uid=${noteUid}`], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const collect = (target) => (chunk) => {
      const value = String(chunk || '');
      if (target === 'stdout') stdout = `${stdout}${value}`.slice(-12_000);
      else stderr = `${stderr}${value}`.slice(-12_000);
    };
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));
    let finished = false;
    const finish = (outcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (outcome.status !== 'completed') {
        appendBackgroundJobLog({
          type: 'note-enrichment',
          noteUid,
          durationMs: Date.now() - startedAt,
          stdout,
          stderr,
          ...outcome,
        });
      }
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ status: 'timed_out', error: `Organizer exceeded ${NOTE_ENRICHMENT_TIMEOUT_MS}ms` });
    }, NOTE_ENRICHMENT_TIMEOUT_MS);
    timer.unref?.();
    child.once('error', (error) => finish({ status: 'failed_to_start', error: error.message }));
    child.once('close', (code, signal) => finish({
      status: code === 0 ? 'completed' : 'failed',
      exitCode: code,
      signal: signal || '',
      ...(code === 0 ? {} : { error: `Organizer exited with code ${code}` }),
    }));
  }));
  noteEnrichmentJobs.set(noteUid, job);
  noteEnrichmentQueue = job.catch(() => undefined);
  void job.finally(() => noteEnrichmentJobs.delete(noteUid)).catch(() => undefined);
  return true;
}

async function acquireOrganizerLockForHumanAction(timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      return acquireOrganizerLock(ORGANIZER_LOCK_PATH);
    } catch (error) {
      if (error?.code !== 'ORGANIZER_LOCKED') throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError || Object.assign(new Error('Note organizer is still running'), { code: 'ORGANIZER_LOCKED' });
}

function queueAiNamingJob(noteUid) {
  if (aiNamingJobs.has(noteUid)) return false;
  const lane = aiNamingLaneCursor % aiNamingQueues.length;
  aiNamingLaneCursor += 1;
  const job = aiNamingQueues[lane].then(async () => {
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
  aiNamingQueues[lane] = job.catch(() => undefined);
  void job.finally(() => aiNamingJobs.delete(noteUid)).catch(() => undefined);
  return true;
}

function pruneManualAiJobs() {
  if (manualAiJobs.size <= 160) return;
  const removable = [...manualAiJobs.values()]
    .filter((job) => !['queued', 'processing'].includes(job.status))
    .sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)));
  while (manualAiJobs.size > 140 && removable.length > 0) {
    manualAiJobs.delete(removable.shift().id);
  }
}

function updateManualAiJob(jobId, patch) {
  const current = manualAiJobs.get(jobId);
  if (!current) return null;
  const job = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  manualAiJobs.set(jobId, job);
  return job;
}

function promoteLearningOnlyImage(note, image, analysis, subject) {
  const sourcePath = path.resolve(image.filePath);
  const notesRelativePath = path.relative(path.resolve(NOTES_ROOT), sourcePath);
  if (notesRelativePath.startsWith('..') || path.isAbsolute(notesRelativePath)) {
    return {
      filePath: note.filePath,
      fileName: note.fileName,
      attachments: Array.isArray(note.attachments) ? note.attachments : [],
      rollback: () => undefined,
    };
  }
  const extension = path.extname(sourcePath).replace(/^\./, '').toLowerCase() || 'png';
  const safeTitle = sanitizeSegment(analysis.title || note.title, '图片笔记', 42);
  const createdAt = new Date(note.createdAt || Date.now());
  const createdStamp = timestamp(Number.isNaN(createdAt.getTime()) ? new Date() : createdAt);
  const destinationDir = path.join(NOTES_ROOT, normalizeStoredSubject(subject));
  fs.mkdirSync(destinationDir, { recursive: true });
  const baseName = sanitizeSegment(
    `${normalizeStoredSubject(subject)}_${safeTitle}_${createdStamp}`,
    `${normalizeStoredSubject(subject)}_图片笔记_${createdStamp}`,
    110,
  );
  const target = ensureUniquePath(destinationDir, baseName, extension, sourcePath);
  let createdCopy = false;
  if (path.resolve(target.filePath) !== sourcePath) {
    fs.copyFileSync(sourcePath, target.filePath, fs.constants.COPYFILE_EXCL);
    createdCopy = true;
  }
  const currentAttachments = Array.isArray(note.attachments) && note.attachments.length > 0
    ? note.attachments
    : [{
        id: 'primary-image',
        kind: 'image',
        name: path.basename(sourcePath),
        mimeType: image.mime || 'image/png',
        size: fs.statSync(sourcePath).size,
        filePath: sourcePath,
        cloudPath: '',
        localPathKey: '',
        previewPath: '',
        posterPath: '',
        createdAt: note.createdAt,
      }];
  const attachments = currentAttachments.map((attachment, index) => {
    const attachmentPaths = [attachment?.filePath, attachment?.localPathKey]
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => {
        try { return path.resolve(value); } catch { return ''; }
      });
    const primary = index === 0 || attachmentPaths.includes(sourcePath);
    return primary ? {
      ...attachment,
      name: target.filename,
      kind: 'image',
      mimeType: image.mime || attachment.mimeType || `image/${extension}`,
      size: Number(attachment.size) > 0 ? Number(attachment.size) : fs.statSync(sourcePath).size,
      filePath: target.filePath,
      localPathKey: path.relative(NOTES_ROOT, target.filePath).replaceAll('\\', '/'),
    } : attachment;
  });
  return {
    filePath: target.filePath,
    fileName: target.filename,
    attachments,
    rollback: () => {
      if (createdCopy && fs.existsSync(target.filePath)) fs.unlinkSync(target.filePath);
    },
  };
}

async function runLearningOnlyAiRename(noteUid, jobId) {
  const before = findLearningNote(learningData.getSnapshot(), noteUid);
  if (!before) throw makeReviewError(`Learning note not found: ${noteUid}`, 'NOTE_NOT_FOUND');
  const image = resolveLearningNoteImage(before);
  const router = getAiRouter();
  if (!router) throw makeReviewError(aiRouterInitError || 'AI router is unavailable', 'AI_ROUTER_UNAVAILABLE');

  updateManualAiJob(jobId, {
    status: 'processing',
    progress: 15,
    message: 'AI 正在读取原图并重新命名、分类',
    error: '',
  });
  const taxonomy = loadTaxonomy(NOTE_TAXONOMY_PATH);
  const analyzer = createNoteAiAnalyzer({ router });
  const analysis = await analyzer({
    imagePath: image.filePath,
    metadata: {
      kind: 'single',
      sourceType: before.sourceType,
      title: before.title,
      remark: before.remark,
      fileName: path.basename(image.filePath),
      filePath: before.filePath,
      attachments: before.attachments,
      learning: before,
    },
    currentCategory: {
      subject: before.subject || DEFAULT_SUBJECT,
      knowledgePoint: Array.isArray(before.knowledgePath) ? before.knowledgePath[1] || null : null,
    },
    taxonomy,
    notesRoot: NOTES_ROOT,
  });
  // Re-read after the model returns. The learning-data store keeps every field
  // listed in userEditedFields and every accepted/corrected human decision, so
  // a concurrent edit always wins over this AI proposal.
  const latest = findLearningNote(learningData.getSnapshot(), noteUid);
  if (!latest) throw makeReviewError(`Learning note not found: ${noteUid}`, 'NOTE_NOT_FOUND');
  const subject = normalizeStoredSubject(analysis.subject);
  const subjectNode = ensureSubject(taxonomy, subject, { createdBy: subject === DEFAULT_SUBJECT ? 'user' : 'ai' });
  const knowledgePoint = subject !== DEFAULT_SUBJECT && analysis.knowledgePoint
    ? ensureKnowledgePoint(taxonomy, subjectNode, analysis.knowledgePoint, {
        aliases: analysis.knowledgePointAliases,
        createdBy: 'ai',
      })
    : null;
  saveTaxonomyAtomic(NOTE_TAXONOMY_PATH, taxonomy);

  const keepsHumanDecision = ['accepted', 'corrected', 'ignored'].includes(latest.reviewStatus);
  const confident = subject !== DEFAULT_SUBJECT && Number(analysis.confidence) >= 0.72;
  const reviewStatus = keepsHumanDecision
    ? latest.reviewStatus
    : confident ? 'auto_applied' : 'pending';
  const intent = analysis.intent || {};
  const tags = [...new Set([
    ...(Array.isArray(latest.tags) ? latest.tags : []),
    ...(Array.isArray(analysis.tags) ? analysis.tags : []),
    ...(intent.isMistake ? ['错题'] : []),
    ...(intent.shouldMemorize ? ['背诵'] : []),
  ])];
  const enrichment = {
    ...latest,
    title: analysis.title || latest.title,
    subject,
    knowledgePath: [subject, ...(knowledgePoint ? [knowledgePoint.name] : [])],
    tags,
    noteType: intent.isMistake ? 'mistake'
      : intent.shouldMemorize ? 'memory'
        : intent.isQuestion ? 'question' : latest.noteType || 'note',
    questionType: analysis.questionType || '',
    questionTypePath: analysis.questionTypePath || [],
    wrongReason: analysis.wrongReason || '',
    wrongReasonPath: analysis.wrongReasonPath || [],
    learningTypePath: analysis.learningTypePath || [],
    goodQuestion: latest.goodQuestion === true || intent.isGood === true,
    goodQuestionType: analysis.goodQuestionType || latest.goodQuestionType || '',
    organizationStatus: reviewStatus === 'ignored' ? 'ignored' : reviewStatus === 'pending' ? 'pending' : 'confirmed',
    classificationSource: reviewStatus === 'corrected' ? 'manual' : 'ai',
    reviewStatus,
    decisionRevision: latest.decisionRevision || 0,
    pendingAiOrganization: false,
    intent,
    items: analysis.items || [],
    confidence: analysis.confidence,
    cards: reviewStatus === 'ignored' ? [] : analysis.cards || [],
    wrongReasonSource: analysis.wrongReasonSource || latest.wrongReasonSource || '',
    wrongReasonConfidence: analysis.wrongReasonConfidence,
  };
  const promoted = promoteLearningOnlyImage(latest, image, analysis, subject);
  enrichment.filePath = promoted.filePath;
  enrichment.fileName = promoted.fileName;
  enrichment.attachments = promoted.attachments;
  let snapshot;
  try {
    snapshot = learningData.syncNote({
      noteUid,
      title: enrichment.title,
      subject,
      remark: latest.remark,
      createdAt: latest.createdAt,
      fileName: promoted.fileName,
      filePath: promoted.filePath,
      sourceType: latest.sourceType,
      sourceBatchId: latest.sourceBatchId,
      sourceSplitIndex: latest.sourceSplitIndex,
      attachments: promoted.attachments,
      facets: latest.facets,
      learning: enrichment,
    }, { enrichment, cards: enrichment.cards });
  } catch (error) {
    promoted.rollback();
    throw error;
  }
  broadcastLearningData(snapshot);
  const stored = findLearningNote(snapshot, noteUid);
  const completedAt = new Date().toISOString();
  return updateManualAiJob(jobId, {
    status: 'completed',
    progress: 100,
    message: reviewStatus === 'pending'
      ? 'AI 命名已完成，分类置信度较低，已放入待确认'
      : 'AI 命名与分类已完成',
    error: '',
    completedAt,
    result: {
      applied: true,
      title: String(stored?.title || enrichment.title || ''),
      subject: String(stored?.subject || subject),
      provider: analysis.provider || '',
      model: analysis.model || '',
      revision: Number(snapshot.revision) || 0,
    },
  });
}

function enqueueLearningOnlyAiRename(noteUid, note, operationId) {
  // Resolve synchronously so the button gets a precise error instead of a job
  // that can only fail later. This also proves the GitHub clone is ready.
  resolveLearningNoteImage(note);
  const stagedAt = new Date().toISOString();
  const job = {
    id: `job-${crypto.randomUUID()}`,
    type: 'note-rename',
    noteUid,
    status: 'queued',
    progress: 0,
    message: '已加入 AI 命名与分类队列',
    error: '',
    createdAt: stagedAt,
    updatedAt: stagedAt,
    completedAt: '',
    request: { operationId },
    result: null,
  };
  manualAiJobs.set(job.id, job);
  pruneManualAiJobs();
  void runLearningOnlyAiRename(noteUid, job.id).catch((error) => {
    updateManualAiJob(job.id, {
      status: 'failed',
      progress: 100,
      message: 'AI 命名失败，可以安全重试',
      error: error instanceof Error ? error.message : String(error),
      errorCode: String(error?.code || ''),
      completedAt: new Date().toISOString(),
    });
  });
  return { job: manualAiJobs.get(job.id), replayed: false };
}

function enqueueManualAiRename(noteUid, requestedOperationId = '') {
  const operationId = /^[A-Za-z0-9_-]{12,100}$/.test(String(requestedOperationId || '').trim())
    ? String(requestedOperationId).trim()
    : `rename-${crypto.randomUUID()}`;
  const operationReplay = [...manualAiJobs.values()].find((job) => (
    job.noteUid === noteUid
    && job.type === 'note-rename'
    && job.request?.operationId === operationId
  ));
  if (operationReplay) return { job: operationReplay, replayed: true };
  const existing = [...manualAiJobs.values()].find((job) => (
    job.noteUid === noteUid
    && job.type === 'note-rename'
    && ['queued', 'processing'].includes(job.status)
  ));
  if (existing) return { job: existing, replayed: true };

  // A material note can have legacy single-image sidecars with the same UID.
  // The receipt is the authoritative whole-group record, so it must win before
  // findSavedNote() can accidentally route a retry through one attachment.
  const materialReceipt = readMaterialReceipt(noteUid);
  const materialNote = findMaterialLearningNote(learningData.getSnapshot(), noteUid);
  if (materialReceipt && materialNote) {
    const stagedAt = new Date().toISOString();
    const job = {
      id: `job-${crypto.randomUUID()}`,
      type: 'note-rename',
      noteUid,
      status: 'queued',
      progress: 0,
      message: '已加入整组资料 AI 命名与分类队列',
      error: '',
      createdAt: stagedAt,
      updatedAt: stagedAt,
      completedAt: '',
      request: { operationId },
      result: null,
    };
    manualAiJobs.set(job.id, job);
    pruneManualAiJobs();
    queueMaterialNamingJob(noteUid, { explicit: true, forceTitle: true, manualJobId: job.id });
    return { job, replayed: false };
  }
  const saved = findSavedNote(noteUid);
  if (!saved) {
    const learningNote = findLearningNote(learningData.getSnapshot(), noteUid);
    if (!learningNote) throw makeReviewError(`Learning note not found: ${noteUid}`, 'NOTE_NOT_FOUND');
    if (canPersistWithoutLocalMetadata(learningNote)) return enqueueLearningOnlyAiRename(noteUid, learningNote, operationId);
    throw makeReviewError(`Durable note metadata not found: ${noteUid}`, 'NOTE_FILE_METADATA_NOT_FOUND');
  }
  const extension = path.extname(saved.filePath).toLowerCase();
  const mime = saved.metadata.mime || MATERIAL_MIME_BY_EXT.get(extension) || 'image/png';
  if (!String(mime).startsWith('image/')) {
    throw makeReviewError('AI 重命名目前只处理有原图的学习记录', 'AI_RENAME_NOT_ALLOWED');
  }

  const stagedAt = new Date().toISOString();
  const metadata = {
    ...saved.metadata,
    filePath: saved.filePath,
    fileName: path.basename(saved.filePath),
    mime,
    updatedAt: stagedAt,
    naming: {
      ...(saved.metadata.naming || {}),
      status: 'pending',
      reason: 'manual_retry',
      error: null,
      completedAt: null,
    },
    learning: {
      ...(saved.metadata.learning || {}),
      pendingAiOrganization: true,
    },
  };
  atomicWriteJson(saved.receipt.sidecarPath, metadata);
  appendMetadata(subjectDirForMetadata(metadata), metadata);
  const learningSyncError = syncLearningMetadata(metadata);
  writeSaveReceipt(noteUid, metadata, learningSyncError, saved.receipt.sidecarPath);

  const job = {
    id: `job-${crypto.randomUUID()}`,
    type: 'note-rename',
    noteUid,
    status: 'queued',
    progress: 0,
    message: '已加入本机 AI 命名队列',
    error: '',
    createdAt: stagedAt,
    updatedAt: stagedAt,
    completedAt: '',
    request: { operationId },
    result: null,
  };
  manualAiJobs.set(job.id, job);
  pruneManualAiJobs();
  queueAiNamingJob(noteUid);
  updateManualAiJob(job.id, {
    status: 'processing',
    progress: 15,
    message: 'AI 正在读取原图并按本地规则命名、分类',
  });
  const running = aiNamingJobs.get(noteUid);
  void Promise.resolve(running).then(() => {
    const latest = findSavedNote(noteUid);
    const naming = latest?.metadata?.naming || {};
    const completed = naming.status === 'complete';
    const completedAt = new Date().toISOString();
    updateManualAiJob(job.id, {
      status: completed ? 'completed' : 'failed',
      progress: completed ? 100 : 0,
      message: completed ? 'AI 命名与分类已完成' : 'AI 命名失败，可稍后重试',
      error: completed ? '' : String(naming.error || 'AI 命名未能完成'),
      completedAt,
      result: completed ? {
        applied: true,
        title: String(latest?.metadata?.title || ''),
        revision: Number(learningData.getSnapshot().revision) || 0,
      } : null,
    });
  }).catch((error) => {
    updateManualAiJob(job.id, {
      status: 'failed',
      progress: 0,
      message: 'AI 命名失败，可稍后重试',
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
    });
  });
  return { job: manualAiJobs.get(job.id), replayed: false };
}

function searchTokens(value) {
  const normalized = String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const tokens = new Set(normalized.match(/[\p{L}\p{N}]{2,}/gu) || []);
  const chinese = normalized.replace(/[^\p{Script=Han}]/gu, '');
  for (let index = 0; index < chinese.length - 1; index += 1) tokens.add(chinese.slice(index, index + 2));
  return [...tokens].slice(0, 80);
}

function fallbackSearchDocuments() {
  const documents = [];
  for (const [date, day] of Object.entries(learningData.getSnapshot()?.days || {})) {
    for (const note of Array.isArray(day?.autoNotes) ? day.autoNotes : []) {
      documents.push({
        noteUid: note.noteUid,
        capturedDate: note.capturedDate || date,
        updatedAt: note.updatedAt || '',
        title: note.title || '',
        subject: note.subject || '',
        facets: note.facets || [],
        tags: note.tags || [],
        attachmentNames: (note.attachments || []).map((attachment) => attachment?.name || ''),
        content: [
          note.title,
          note.remark,
          note.subject,
          ...(note.tags || []),
          ...(note.facets || []),
          ...(note.knowledgePath || []),
          ...(note.questions || []),
          ...(note.items || []).flatMap((item) => [item?.title, item?.question, item?.answer, item?.remark]),
        ].filter(Boolean).join('\n'),
      });
    }
  }
  return documents;
}

async function expandSemanticSearchQuery(query) {
  const cacheKey = query.normalize('NFKC').trim().toLowerCase();
  if (semanticQueryCache.has(cacheKey)) return semanticQueryCache.get(cacheKey);
  const router = getAiRouter();
  if (!router) throw new Error(aiRouterInitError || 'AI router is unavailable');
  const response = await router.complete({
    task: 'semantic_search',
    messages: [{
      role: 'user',
      content: [
        '你只负责扩展学习资料搜索词，不回答问题，不总结资料。',
        '根据用户表达的含义，给出可能出现在考研笔记里的同义词、相关概念、公式名称、常见中文说法。',
        '只输出 JSON，terms 为 3 到 12 个简短检索词，不能编造结论。',
        `查询：${query}`,
      ].join('\n'),
    }],
    responseSchema: {
      type: 'object',
      required: ['terms'],
      properties: {
        terms: { type: 'array', items: { type: 'string' }, maxItems: 12 },
      },
    },
    temperature: 0.1,
    maxTokens: Number(router.getTaskOptions?.('semantic_search')?.maxTokens) || 360,
  });
  const terms = [...new Set((response.json?.terms || [])
    .map((item) => String(item || '').normalize('NFKC').trim().slice(0, 80))
    .filter(Boolean))]
    .slice(0, 12);
  semanticQueryCache.set(cacheKey, terms);
  if (semanticQueryCache.size > 120) semanticQueryCache.delete(semanticQueryCache.keys().next().value);
  return terms;
}

async function searchLearningDocuments(payload) {
  const query = String(payload?.query || '').normalize('NFKC').trim().slice(0, 500);
  const mode = payload?.mode === 'ai' ? 'ai' : 'normal';
  const limit = Math.max(1, Math.min(200, Number(payload?.limit) || 80));
  if (!query) return { ok: true, mode, query, terms: [], results: [] };
  const index = readJson(SEARCH_INDEX_PATH, null);
  const documents = Array.isArray(index?.documents) ? index.documents : fallbackSearchDocuments();
  let expandedTerms = [];
  let degraded = false;
  if (mode === 'ai') {
    try {
      expandedTerms = await expandSemanticSearchQuery(query);
    } catch {
      degraded = true;
    }
  }
  const directTerms = searchTokens(query);
  const semanticTerms = searchTokens(expandedTerms.join(' '));
  const results = documents.map((document, originalIndex) => {
    const title = String(document.title || '').normalize('NFKC').toLowerCase();
    const haystack = [
      document.title,
      document.subject,
      ...(document.tags || []),
      ...(document.facets || []),
      ...(document.attachmentNames || []),
      document.content,
    ].join(' ').normalize('NFKC').toLowerCase();
    let score = haystack.includes(query.toLowerCase()) ? 80 : 0;
    const matchedTerms = [];
    for (const term of directTerms) {
      if (!haystack.includes(term)) continue;
      score += title.includes(term) ? 18 : 7;
      matchedTerms.push(term);
    }
    for (const term of semanticTerms) {
      if (!haystack.includes(term)) continue;
      score += title.includes(term) ? 12 : 5;
      matchedTerms.push(term);
    }
    return { document, originalIndex, score, matchedTerms: [...new Set(matchedTerms)].slice(0, 8) };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex)
    .slice(0, limit)
    .map(({ document, score, matchedTerms }) => ({
      noteUid: document.noteUid,
      title: document.title || '',
      subject: document.subject || '',
      capturedDate: document.capturedDate || '',
      score,
      matchedTerms,
      reason: matchedTerms.length ? `匹配：${matchedTerms.join('、')}` : '匹配原始记录内容',
    }));
  return {
    ok: true,
    mode,
    query,
    terms: expandedTerms,
    results,
    degraded,
    sourceRevision: Number(index?.sourceRevision) || Number(learningData.getSnapshot().revision) || 0,
  };
}

function taxonomyLabel(value, maxLength = 80) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function collectTaxonomyCandidates(snapshot) {
  const knowledge = new Map();
  const wrongReasons = new Map();
  for (const day of Object.values(snapshot?.days || {})) {
    for (const note of Array.isArray(day?.autoNotes) ? day.autoNotes : []) {
      const subject = normalizeStoredSubject(note.subject);
      const manualKnowledge = note.classificationSource === 'manual'
        || (Array.isArray(note.userEditedFields) && note.userEditedFields.includes('knowledgePath'));
      if (!manualKnowledge) {
        const values = [
          ...(Array.isArray(note.knowledgePath) ? note.knowledgePath : []).filter((item) => item !== subject),
          ...(Array.isArray(note.items) ? note.items.map((item) => item?.knowledgePoint) : []),
        ];
        for (const value of values) {
          const label = taxonomyLabel(value);
          if (!label) continue;
          const key = `${subject}\u0000${label}`;
          const previous = knowledge.get(key);
          knowledge.set(key, {
            subject,
            label,
            count: (previous?.count || 0) + 1,
          });
        }
      }
      const reasons = [
        note.wrongReason,
        ...(Array.isArray(note.items) ? note.items.map((item) => item?.wrongReason) : []),
        ...(Array.isArray(note.tags) ? note.tags
          .filter((tag) => /^错因[:：]/u.test(tag))
          .map((tag) => tag.replace(/^错因[:：]\s*/u, '')) : []),
      ];
      for (const value of reasons) {
        const label = taxonomyLabel(value, 300);
        if (!label) continue;
        wrongReasons.set(label, (wrongReasons.get(label) || 0) + 1);
      }
    }
  }
  return {
    knowledge: [...knowledge.values()].sort((left, right) => (
      left.subject.localeCompare(right.subject, 'zh-CN')
      || right.count - left.count
      || left.label.localeCompare(right.label, 'zh-CN')
    )),
    wrongReasons: [...wrongReasons].map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'zh-CN')),
  };
}

function taxonomyCandidateFingerprint(candidates) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(candidates || { knowledge: [], wrongReasons: [] }))
    .digest('hex');
}

function taxonomyNeedsConsolidation(snapshot) {
  const candidates = collectTaxonomyCandidates(snapshot);
  const bySubject = new Map();
  for (const candidate of candidates.knowledge) {
    bySubject.set(candidate.subject, (bySubject.get(candidate.subject) || 0) + 1);
  }
  return candidates.wrongReasons.length > 12
    || candidates.knowledge.filter((candidate) => (
      candidate.label.length > 32 || /[。！？；\n]/u.test(candidate.label)
    )).length > 3
    || [...bySubject.values()].some((count) => count > 20);
}

function validateTaxonomyGroups(result, candidates, options) {
  const knowledgeInputs = new Map(candidates.knowledge.map((item) => [`${item.subject}\u0000${item.label}`, item]));
  const wrongInputs = new Set(candidates.wrongReasons.map((item) => item.label));
  const knowledgeMap = new Map();
  const wrongMap = new Map();
  const groupsBySubject = new Map();

  for (const group of Array.isArray(result?.knowledgeGroups) ? result.knowledgeGroups : []) {
    const subject = normalizeStoredSubject(group?.subject);
    if (subject !== taxonomyLabel(group?.subject)) continue;
    const canonical = taxonomyLabel(group?.canonical, 32);
    if (!canonical || /[。！？；\n]/u.test(canonical)) continue;
    for (const rawAlias of Array.isArray(group?.aliases) ? group.aliases : []) {
      const alias = taxonomyLabel(rawAlias);
      const key = `${subject}\u0000${alias}`;
      if (!knowledgeInputs.has(key) || knowledgeMap.has(key)) continue;
      knowledgeMap.set(key, canonical);
    }
    if ([...knowledgeMap].some(([key, value]) => key.startsWith(`${subject}\u0000`) && value === canonical)) {
      const subjectGroups = groupsBySubject.get(subject) || new Set();
      subjectGroups.add(canonical);
      groupsBySubject.set(subject, subjectGroups);
    }
  }

  for (const group of Array.isArray(result?.wrongReasonGroups) ? result.wrongReasonGroups : []) {
    const category = taxonomyLabel(group?.category, 20);
    if (!category || /[。！？；\n]/u.test(category)) continue;
    for (const rawAlias of Array.isArray(group?.aliases) ? group.aliases : []) {
      const alias = taxonomyLabel(rawAlias, 300);
      if (!wrongInputs.has(alias) || wrongMap.has(alias)) continue;
      wrongMap.set(alias, category);
    }
  }

  const totalInputs = knowledgeInputs.size + wrongInputs.size;
  const coveredInputs = knowledgeMap.size + wrongMap.size;
  const coverage = totalInputs === 0 ? 1 : coveredInputs / totalInputs;
  const minimumCoverage = Math.max(0.6, Math.min(1, Number(options.minimumCoverage) || 0.8));
  if (coverage < minimumCoverage) {
    throw new Error(`分类整理覆盖率 ${(coverage * 100).toFixed(1)}% 低于安全阈值 ${(minimumCoverage * 100).toFixed(0)}%，本次未写入`);
  }

  const minGroups = Math.max(2, Math.min(12, Number(options.minKnowledgeGroupsPerSubject) || 5));
  const maxGroups = Math.max(8, Math.min(40, Number(options.maxKnowledgeGroupsPerSubject) || 18));
  for (const [subject, inputs] of [...knowledgeInputs.values()].reduce((map, item) => {
    const list = map.get(item.subject) || [];
    list.push(item);
    map.set(item.subject, list);
    return map;
  }, new Map())) {
    const coveredForSubject = inputs.filter((item) => knowledgeMap.has(`${subject}\u0000${item.label}`)).length;
    if (coveredForSubject === 0) continue;
    const count = groupsBySubject.get(subject)?.size || 0;
    const effectiveMinimum = Math.min(minGroups, coveredForSubject);
    const effectiveMaximum = Math.min(maxGroups, coveredForSubject);
    if (count < effectiveMinimum || count > effectiveMaximum) {
      throw new Error(`${subject} 归并为 ${count} 组，不在安全范围 ${effectiveMinimum}-${effectiveMaximum} 内，本次未写入`);
    }
  }
  return { knowledgeMap, wrongMap, groupsBySubject, coverage };
}

function applyTaxonomyConsolidation(snapshot, mappings) {
  const next = JSON.parse(JSON.stringify(snapshot));
  let changedNotes = 0;
  for (const day of Object.values(next.days || {})) {
    day.autoNotes = (day.autoNotes || []).map((note) => {
      const subject = normalizeStoredSubject(note.subject);
      const locksKnowledge = note.classificationSource === 'manual'
        || (Array.isArray(note.userEditedFields) && note.userEditedFields.includes('knowledgePath'));
      let changed = false;
      let knowledgePath = Array.isArray(note.knowledgePath) ? [...note.knowledgePath] : [];
      let items = Array.isArray(note.items) ? note.items.map((item) => ({ ...item })) : [];
      if (!locksKnowledge) {
        knowledgePath = knowledgePath.map((item) => {
          if (item === note.subject || item === subject) return subject;
          const mapped = mappings.knowledgeMap.get(`${subject}\u0000${taxonomyLabel(item)}`);
          if (mapped && mapped !== item) changed = true;
          return mapped || item;
        });
        knowledgePath = [...new Set([subject, ...knowledgePath.filter((item) => item !== subject && item !== note.subject)])].slice(0, 3);
        items = items.map((item) => {
          const mapped = mappings.knowledgeMap.get(`${subject}\u0000${taxonomyLabel(item.knowledgePoint)}`);
          if (!mapped || mapped === item.knowledgePoint) return item;
          changed = true;
          return { ...item, knowledgePoint: mapped };
        });
      }
      const reasons = [
        note.wrongReason,
        ...items.map((item) => item?.wrongReason),
      ].map((value) => taxonomyLabel(value, 300)).filter(Boolean);
      const categories = [...new Set(reasons.map((reason) => mappings.wrongMap.get(reason)).filter(Boolean))];
      const previousTags = Array.isArray(note.tags) ? note.tags : [];
      const tags = [
        ...previousTags.filter((tag) => !/^错因(?:分类|类别)[:：]/u.test(tag)),
        ...categories.map((category) => `错因分类:${category}`),
      ];
      if (JSON.stringify(tags) !== JSON.stringify(previousTags)) changed = true;
      if (!changed) return note;
      changedNotes += 1;
      return {
        ...note,
        knowledgePath,
        items,
        tags,
        updatedAt: new Date().toISOString(),
      };
    });
  }
  return { snapshot: next, changedNotes };
}

function persistConsolidatedNoteMetadata(note) {
  const saved = findSavedNote(note.noteUid);
  if (!saved) return false;
  const metadata = {
    ...saved.metadata,
    updatedAt: note.updatedAt || new Date().toISOString(),
    learning: {
      ...(saved.metadata.learning || {}),
      knowledgePath: note.knowledgePath,
      items: note.items,
      tags: note.tags,
    },
  };
  atomicWriteJson(saved.receipt.sidecarPath, metadata);
  appendMetadata(subjectDirForMetadata(metadata), metadata);
  writeSaveReceipt(note.noteUid, metadata, saved.receipt.learningSyncError, saved.receipt.sidecarPath);
  return true;
}

async function runTaxonomyConsolidation(jobId) {
  const sourceSnapshot = learningData.getSnapshot();
  const candidates = collectTaxonomyCandidates(sourceSnapshot);
  if (candidates.knowledge.length === 0 && candidates.wrongReasons.length === 0) {
    updateManualAiJob(jobId, {
      status: 'completed',
      progress: 100,
      message: '当前没有需要整理的分类',
      completedAt: new Date().toISOString(),
      result: { changedNotes: 0, coverage: 1 },
    });
    return;
  }
  const router = getAiRouter();
  if (!router) throw new Error(aiRouterInitError || 'AI router is unavailable');
  const options = router.getTaskOptions?.('taxonomy') || {};
  updateManualAiJob(jobId, {
    status: 'processing',
    progress: 20,
    message: 'AI 正在全库比较知识点与错因，原始详情不会删除',
  });
  const response = await router.complete({
    task: 'taxonomy',
    messages: [{
      role: 'user',
      content: [
        '请全局整理以下考研笔记分类候选。只输出 JSON。',
        `归并策略：${options.mergeStrategy || 'balanced'}`,
        `每个资料充分的科目保持 ${Number(options.minKnowledgeGroupsPerSubject) || 5} 到 ${Number(options.maxKnowledgeGroupsPerSubject) || 18} 个知识组。`,
        `错因一级类别目标约 ${Number(options.wrongReasonGroupCount) || 6} 个；必须保留“粗心大意”，其下再按真实数据动态细分。`,
        'aliases 必须逐字复制输入 label，每个输入只出现一次；禁止跨 subject 合并。',
        `知识点候选：${JSON.stringify(candidates.knowledge)}`,
        `错因候选：${JSON.stringify(candidates.wrongReasons)}`,
      ].join('\n'),
    }],
    responseSchema: {
      type: 'object',
      required: ['knowledgeGroups', 'wrongReasonGroups'],
      properties: {
        knowledgeGroups: {
          type: 'array',
          items: {
            type: 'object',
            required: ['subject', 'canonical', 'aliases'],
            properties: {
              subject: { type: 'string' },
              canonical: { type: 'string' },
              aliases: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        wrongReasonGroups: {
          type: 'array',
          items: {
            type: 'object',
            required: ['category', 'aliases'],
            properties: {
              category: { type: 'string' },
              aliases: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    temperature: 0.05,
    maxTokens: Number(options.maxTokens) || 6000,
  });
  const mappings = validateTaxonomyGroups(response.json, candidates, options);
  updateManualAiJob(jobId, {
    progress: 72,
    message: '归并结果已通过覆盖率与科目边界校验，正在原子写入',
  });
  const sourceCandidateFingerprint = taxonomyCandidateFingerprint(candidates);
  let applied = null;
  let appliedSourceSnapshot = null;
  let nextSnapshot = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const currentSnapshot = learningData.getSnapshot();
    const currentFingerprint = taxonomyCandidateFingerprint(collectTaxonomyCandidates(currentSnapshot));
    if (currentFingerprint !== sourceCandidateFingerprint) {
      throw new Error('整理期间分类候选发生变化，本轮未写入；稍后将基于最新资料重新整理');
    }
    const currentApplied = applyTaxonomyConsolidation(currentSnapshot, mappings);
    try {
      nextSnapshot = learningData.restoreSnapshot(currentApplied.snapshot, {
        expectedRevision: currentSnapshot.revision,
      });
      applied = currentApplied;
      appliedSourceSnapshot = currentSnapshot;
      break;
    } catch (error) {
      if (!/revision conflict/i.test(error instanceof Error ? error.message : String(error)) || attempt >= 3) {
        throw error;
      }
    }
  }
  if (!nextSnapshot || !applied || !appliedSourceSnapshot) {
    throw new Error('学习数据持续更新，本轮未写入；稍后将自动重试');
  }

  const taxonomy = loadTaxonomy(NOTE_TAXONOMY_PATH);
  for (const [subject, groups] of mappings.groupsBySubject) {
    const subjectNode = ensureSubject(taxonomy, subject, { createdBy: 'ai' });
    for (const canonical of groups) {
      const aliases = [...mappings.knowledgeMap]
        .filter(([key, value]) => key.startsWith(`${subject}\u0000`) && value === canonical)
        .map(([key]) => key.slice(subject.length + 1));
      ensureKnowledgePoint(taxonomy, subjectNode, canonical, { aliases, createdBy: 'ai' });
    }
  }
  saveTaxonomyAtomic(NOTE_TAXONOMY_PATH, taxonomy);
  let durableNotes = 0;
  for (const day of Object.values(nextSnapshot.days || {})) {
    for (const note of day.autoNotes || []) {
      if (persistConsolidatedNoteMetadata(note)) durableNotes += 1;
    }
  }
  broadcastLearningData(nextSnapshot);
  atomicWriteJson(TAXONOMY_CONSOLIDATION_STATE_PATH, {
    completedAt: new Date().toISOString(),
    sourceRevision: appliedSourceSnapshot.revision,
    resultRevision: nextSnapshot.revision,
    coverage: mappings.coverage,
    changedNotes: applied.changedNotes,
    provider: response.provider || '',
    model: response.model || '',
  });
  updateManualAiJob(jobId, {
    status: 'completed',
    progress: 100,
    message: `分类整理完成：更新 ${applied.changedNotes} 条记录`,
    completedAt: new Date().toISOString(),
    result: {
      changedNotes: applied.changedNotes,
      durableNotes,
      coverage: mappings.coverage,
      revision: nextSnapshot.revision,
    },
  });
}

function enqueueTaxonomyConsolidation(options = {}) {
  const existing = [...manualAiJobs.values()].find((job) => (
    job.type === 'taxonomy-consolidation' && ['queued', 'processing'].includes(job.status)
  ));
  if (existing) return { job: existing, replayed: true };
  const stagedAt = new Date().toISOString();
  const job = {
    id: `job-${crypto.randomUUID()}`,
    type: 'taxonomy-consolidation',
    status: 'queued',
    progress: 0,
    message: options.automatic ? '检测到分类过细，已加入后台整理队列' : '已加入全局分类整理队列',
    error: '',
    createdAt: stagedAt,
    updatedAt: stagedAt,
    completedAt: '',
    result: null,
  };
  manualAiJobs.set(job.id, job);
  pruneManualAiJobs();
  void runTaxonomyConsolidation(job.id).catch((error) => {
    updateManualAiJob(job.id, {
      status: 'failed',
      progress: 0,
      message: '分类整理未通过安全校验，原数据未被覆盖',
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
    });
  });
  return { job, replayed: false };
}

function saveNotePayload(payload) {
  const noteUid = normalizeNoteUid(payload.noteUid);
  const existing = readSaveReceipt(noteUid);
  if (existing) {
    const response = makeSaveResponse(existing, { idempotentReplay: true });
    if (response.aiStatus === 'complete' && aiNamingJobs.has(noteUid)) {
      response.aiStatus = 'pending';
    }
    return { status: 200, body: response };
  }

  const requestedSubject = normalizeStoredSubject(payload.subject);
  const subjectLocked = payload.subjectLocked === true && requestedSubject !== DEFAULT_SUBJECT;
  const kind = payload.kind === 'canvas' ? 'canvas' : 'single';
  const aiSelection = normalizeNoteAiSelection(payload.aiSelection);
  const remark = typeof payload.remark === 'string' ? payload.remark : '';
  const isCaptureOriginal = payload.sourceType === 'multi-capture-original';
  const canvasProjectId = kind === 'canvas' && typeof payload.canvasProjectId === 'string'
    ? assertCanvasId(payload.canvasProjectId)
    : null;
  const image = decodeDataUrl(payload.imageDataUrl);
  const fallback = makeFallbackName({
    kind,
    remark,
    subject: isCaptureOriginal || requestedSubject !== DEFAULT_SUBJECT ? requestedSubject : guessSubjectFromText(remark),
  });
  const subject = normalizeStoredSubject(fallback.subject);
  const subjectDir = path.join(NOTES_ROOT, subject);
  fs.mkdirSync(subjectDir, { recursive: true });

  const createdAt = new Date().toISOString();
  const createdStamp = timestamp(new Date(createdAt));
  const safeTitle = sanitizeSegment(fallback.title, kind === 'canvas' ? '画布拼接笔记' : '图片笔记', 42);
  const baseName = sanitizeSegment(`${subject}_${safeTitle}_${createdStamp}`, `${subject}_图片笔记_${createdStamp}`, 110);
  const storageDir = provisionalAssetDir(subjectDir, isCaptureOriginal);
  const { filename, filePath } = ensureUniquePath(storageDir, baseName, image.ext);
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
    subjectLocked,
    title: safeTitle,
    remark,
    createdAt,
    captureDate: formatDateInTimeZone(createdAt, 'Asia/Shanghai'),
    fileName: filename,
    filePath,
    mime: image.mime,
    attachments: [{
      id: 'primary-image',
      kind: 'image',
      name: filename,
      mimeType: image.mime,
      size: image.buffer.length,
      filePath,
      cloudPath: '',
      localPathKey: '',
      previewPath: '',
      posterPath: '',
      createdAt,
    }],
    sourceType: typeof payload.sourceType === 'string' ? payload.sourceType.slice(0, 80) : '',
    sourceBatchId: typeof payload.sourceBatchId === 'string' ? payload.sourceBatchId.slice(0, 128) : '',
    sourceSplitIndex: Number.isInteger(payload.sourceSplitIndex) ? payload.sourceSplitIndex : null,
    tags: Array.isArray(payload.tags)
      ? [...new Set(payload.tags.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].slice(0, 24)
      : [],
    aiSelection: aiSelection || { mode: kind === 'canvas' ? 'auto-advanced' : 'auto-light' },
    extracted,
    learning: {
      noteUid,
      ...makeInitialLearning(kind, extracted, createdAt, {
        noteUid,
        title: safeTitle,
        subject,
        remark,
      }),
    },
    naming: {
      status: isCaptureOriginal || aiSelection?.mode === 'off' ? 'complete' : 'pending',
      provider: null,
      model: null,
      reason: isCaptureOriginal ? 'capture_batch_original' : aiSelection?.mode === 'off' ? 'user_disabled_ai' : 'local_first',
      error: null,
      requestedAt: createdAt,
    },
    classifier: {
      status: isCaptureOriginal ? 'pending_capture_processing' : aiSelection?.mode === 'off' ? 'saved_without_ai' : 'saved_pending_ai',
      provider: null,
      scheduledAt: isCaptureOriginal ? 'capture_workflow' : 'on_new_save_once',
    },
  };

  try {
    fs.writeFileSync(filePath, image.buffer);
    ensureInternalDirectory(metadataDir(subjectDir));
    fs.writeFileSync(sidecarPath, JSON.stringify(metadata, null, 2), 'utf8');
    appendMetadata(subjectDir, metadata);
    writeSaveReceipt(noteUid, metadata, null, sidecarPath);
  } catch (error) {
    unlinkFileIfExists(filePath);
    unlinkFileIfExists(sidecarPath);
    removeMetadataEntry(subjectDir, noteUid);
    unlinkFileIfExists(saveReceiptPath(noteUid));
    throw error;
  }

  const learningSyncError = syncLearningMetadata(metadata);
  const receipt = writeSaveReceipt(noteUid, metadata, learningSyncError, sidecarPath);
  const saved = {
    receipt,
    metadata,
    filePath,
    fileName: filename,
  };
  // A newly created note gets exactly one background naming request. The same
  // response supplies both the title and the protected top-level subject. This
  // is deliberately placed after the durable receipt is written: a failed AI
  // call can never lose the original image, while an idempotent replay returns
  // from the branch above and therefore cannot enqueue the request again.
  if (!isCaptureOriginal && aiSelection?.mode !== 'off') queueAiNamingJob(noteUid);
  return { status: 202, body: makeSaveResponse(saved, { learningSyncError }) };
}

async function handleSave(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || '{}');
  const result = saveNotePayload(payload);
  sendJson(res, result.status, result.body);
}

async function handleSaveBatch(req, res) {
  const raw = await readBody(req, 32 * 1024 * 1024);
  const payload = JSON.parse(raw || '{}');
  if (!Array.isArray(payload.notes) || payload.notes.length < 1 || payload.notes.length > 40) {
    throw new SyntaxError('notes 必须包含 1 到 40 条图片记录');
  }
  const results = payload.notes.map((note) => saveNotePayload(note));
  sendJson(res, 202, {
    ok: true,
    notes: results.map((result) => result.body),
    learningData: learningData.getSnapshot(),
    idempotentReplay: results.every((result) => result.body.idempotentReplay === true),
  });
}

function cleanMaterialPreviewItem(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const kind = ['image', 'pdf', 'word', 'html', 'file'].includes(input.kind) ? input.kind : 'file';
  const clean = (field, limit = 2_000) => String(input[field] || '').trim().slice(0, limit);
  return {
    id: clean('id', 200),
    kind,
    name: clean('name', 240) || '学习资料',
    mimeType: clean('mimeType', 180),
    filePath: clean('filePath'),
    fallbackPath: clean('fallbackPath'),
    url: clean('url', 4_000),
    fallbackUrl: clean('fallbackUrl', 4_000),
    posterUrl: clean('posterUrl', 4_000),
    label: clean('label', 80),
    sizeLabel: clean('sizeLabel', 80),
  };
}

async function openMaterialPreviewWindow(payload) {
  const input = payload?.descriptor && typeof payload.descriptor === 'object' ? payload.descriptor : {};
  const item = cleanMaterialPreviewItem(input.item);
  if (!item.id || !item.url) {
    const error = new Error('资料预览描述无效');
    error.code = 'INVALID_MATERIAL_PREVIEW';
    throw error;
  }
  const assets = (Array.isArray(input.assets) ? input.assets : [])
    .map(cleanMaterialPreviewItem);
  const descriptor = {
    schemaVersion: 1,
    item,
    assets: assets.some((asset) => asset.id === item.id) ? assets : [item, ...assets],
    screenPoint: {
      x: Number(input.screenPoint?.x) || 0,
      y: Number(input.screenPoint?.y) || 0,
    },
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(MATERIAL_WINDOW_REQUEST_ROOT, { recursive: true });
  const requestPath = path.join(MATERIAL_WINDOW_REQUEST_ROOT, `${crypto.randomUUID()}.json`);
  fs.writeFileSync(requestPath, JSON.stringify(descriptor), { encoding: 'utf8', flag: 'wx' });
  try {
    const pid = await launchNoteApp(`--material-preview=${requestPath}`);
    return { ok: true, pid };
  } catch (error) {
    unlinkFileIfExists(requestPath);
    throw error;
  }
}

function captureJobPath(jobId) {
  return path.join(CAPTURE_JOBS_ROOT, `${jobId}.json`);
}

function readCaptureJob(jobId) {
  const job = readJson(captureJobPath(jobId), null);
  return job?.jobId === jobId ? job : null;
}

function writeCaptureJob(job) {
  fs.mkdirSync(CAPTURE_JOBS_ROOT, { recursive: true });
  atomicWriteJson(captureJobPath(job.jobId), job);
  return job;
}

function captureRuntimeHashes() {
  const configuration = fs.existsSync(AI_PROVIDER_CONFIG_PATH)
    ? fs.readFileSync(AI_PROVIDER_CONFIG_PATH)
    : Buffer.from('{}');
  const workflowPath = path.join(__dirname, 'agent-workflow-contracts.cjs');
  const workflow = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath) : Buffer.from('');
  return {
    configurationHash: crypto.createHash('sha256').update(configuration).digest('hex'),
    workflowHash: crypto.createHash('sha256').update(workflow).digest('hex'),
  };
}

async function handleLocalCaptureBatch(req, res) {
  const raw = await readBody(req, 16 * 1024 * 1024);
  const payload = JSON.parse(raw || '{}');
  const batchId = String(payload.batchId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(batchId)) {
    throw new SyntaxError('batchId 格式无效');
  }
  const image = decodeDataUrl(payload.imageDataUrl);
  const imageHash = crypto.createHash('sha256').update(image.buffer).digest('hex');
  const jobId = `local-${crypto.createHash('sha256').update(`${batchId}\0${imageHash}`).digest('hex').slice(0, 40)}`;
  const existing = readCaptureJob(jobId);
  if (existing) {
    sendJson(res, 200, {
      ok: true,
      accepted: false,
      jobId,
      entryId: existing.entryId,
      job: existing,
    });
    return;
  }

  const entryId = `capture-${imageHash.slice(0, 32)}`;
  const saved = saveNotePayload({
    imageDataUrl: payload.imageDataUrl,
    noteUid: entryId,
    kind: 'single',
    subject: normalizeStoredSubject(payload.subject),
    remark: typeof payload.remark === 'string' ? payload.remark : '',
    sourceType: 'multi-capture-original',
    sourceBatchId: batchId,
    tags: ['AI多题原图', '待处理'],
  });
  const now = new Date().toISOString();
  const hashes = captureRuntimeHashes();
  const job = writeCaptureJob({
    jobId,
    batchId,
    entryId,
    assetHash: imageHash,
    status: 'needs_review',
    progress: 10,
    message: '整页原图已可靠写入本地；局域网模式保留为待处理，可在桌面端手工框选或同步后由公网后台处理',
    error: '',
    resultEntryIds: [],
    configurationHash: hashes.configurationHash,
    workflowHash: hashes.workflowHash,
    createdAt: now,
    updatedAt: now,
    saveStatus: saved.status,
  });
  sendJson(res, 202, { ok: true, accepted: true, jobId, entryId, job });
}

function handleLocalCaptureJob(req, res, pathname) {
  const retryMatch = /^\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/retry$/.exec(pathname);
  const readMatch = /^\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(pathname);
  const match = retryMatch || readMatch;
  if (!match) return false;
  const job = readCaptureJob(match[1]);
  if (!job) {
    sendJson(res, 404, { ok: false, error: '多题任务不存在' });
    return true;
  }
  if (retryMatch && req.method === 'POST') {
    const hashes = captureRuntimeHashes();
    const next = writeCaptureJob({
      ...job,
      status: 'needs_review',
      message: '原图仍安全保留；局域网自动裁剪不可用，请手工框选或等待同步到公网后台',
      error: '',
      configurationHash: hashes.configurationHash,
      workflowHash: hashes.workflowHash,
      updatedAt: new Date().toISOString(),
    });
    sendJson(res, 202, { ok: true, accepted: true, job: next });
    return true;
  }
  if (readMatch && req.method === 'GET') {
    sendJson(res, 200, { ok: true, job });
    return true;
  }
  return false;
}

function materialReceiptPath(noteUid) {
  return path.join(MATERIAL_NOTE_RECEIPTS_ROOT, `${noteUid}.json`);
}

function materialKind(mime, extension) {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (extension === '.doc' || extension === '.docx') return 'word';
  if (extension === '.html' || extension === '.htm') return 'html';
  return 'file';
}

function safeMaterialFileName(input, index, mimeType) {
  const raw = String(input || '').normalize('NFKC').trim();
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120);
  let extension = path.extname(cleaned).toLowerCase();
  if (!MATERIAL_MIME_BY_EXT.has(extension)) extension = MATERIAL_EXT_BY_MIME.get(String(mimeType || '').toLowerCase()) || '';
  if (!extension || !MATERIAL_MIME_BY_EXT.has(extension)) {
    const error = new Error('不支持的资料文件类型');
    error.code = 'NOTE_FILE_UNSUPPORTED';
    throw error;
  }
  const stem = (path.basename(cleaned, path.extname(cleaned)).trim() || `资料-${index + 1}`).slice(0, 96);
  return `${stem}${extension}`;
}

function decodeMaterialFile(input, index) {
  if (!input || typeof input !== 'object') {
    const error = new Error('资料文件无效');
    error.code = 'INVALID_MATERIAL_NOTE';
    throw error;
  }
  const match = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(input.dataUrl || ''));
  if (!match) {
    const error = new Error('资料文件必须使用 base64 data URL');
    error.code = 'INVALID_MATERIAL_NOTE';
    throw error;
  }
  const suppliedMime = match[1].toLowerCase();
  const fileName = safeMaterialFileName(input.name, index, suppliedMime);
  const extension = path.extname(fileName).toLowerCase();
  const mime = MATERIAL_MIME_BY_EXT.get(extension);
  const buffer = Buffer.from(match[2].replace(/[\r\n]/g, ''), 'base64');
  if (buffer.length > MAX_MATERIAL_FILE_BYTES) {
    const error = new Error(`${fileName} 超过 8 MB`);
    error.code = 'PAYLOAD_TOO_LARGE';
    throw error;
  }
  return { fileName, extension, mime, buffer, kind: materialKind(mime, extension) };
}

function findMaterialLearningNote(snapshot, noteUid) {
  for (const day of Object.values(snapshot?.days || {})) {
    const found = Array.isArray(day?.autoNotes) ? day.autoNotes.find((note) => note?.noteUid === noteUid) : null;
    if (found) return found;
  }
  return null;
}

function readMaterialReceipt(noteUid) {
  const receipt = readJson(materialReceiptPath(noteUid), null);
  if (!receipt || receipt.noteUid !== noteUid || typeof receipt.requestHash !== 'string') return null;
  // A failed legacy naming run may already have moved one physical file before
  // its final consistency check. Keep the receipt readable so the retry path can
  // reconcile it from checksums and the current learning snapshot instead of
  // making the whole material group permanently unreachable.
  if (!Array.isArray(receipt.attachments)) return null;
  return receipt;
}

function writeMaterialReceipt(receipt) {
  fs.mkdirSync(MATERIAL_NOTE_RECEIPTS_ROOT, { recursive: true });
  atomicWriteJson(materialReceiptPath(receipt.noteUid), receipt);
}

async function extractMaterialNamingText(attachment) {
  const filePath = String(attachment?.filePath || '');
  const extension = path.extname(filePath).toLowerCase();
  try {
    const buffer = fs.readFileSync(filePath);
    if (['.txt', '.md', '.css', '.js', '.mjs', '.json', '.svg'].includes(extension)) {
      return buffer.toString('utf8').slice(0, 6_000);
    }
    if (extension === '.html' || extension === '.htm') {
      const html = buffer.toString('utf8');
      const visibleText = html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(?:nbsp|amp|lt|gt|quot);/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const geoGebraContext = /(?:geogebra\.org\/apps\/deployggb\.js|\bGGBApplet\s*\()/i.test(html)
        ? [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
          .map((match) => match[1])
          .filter((script) => /GGBApplet|ggbOnInit|evalCommand|setValue|setVisible/i.test(script))
          .join(' ')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/\/\/[^\r\n]*/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 3_000)
        : '';
      return [visibleText, geoGebraContext ? `GeoGebra 交互定义：${geoGebraContext}` : '']
        .filter(Boolean)
        .join('\n')
        .slice(0, 8_000);
    }
    if (extension === '.docx') {
      const imported = await import('mammoth');
      const mammoth = imported.default || imported;
      const result = await mammoth.extractRawText({ buffer });
      return String(result.value || '').replace(/\s+/g, ' ').trim().slice(0, 8_000);
    }
    if (extension === '.pdf') {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const document = await getDocument({ data: new Uint8Array(buffer) }).promise;
      const pages = [];
      for (let pageNumber = 1; pageNumber <= Math.min(3, document.numPages); pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => typeof item?.str === 'string' ? item.str : '').join(' '));
      }
      await document.destroy();
      return pages.join(' ').replace(/\s+/g, ' ').trim().slice(0, 8_000);
    }
  } catch {
    return '';
  }
  return '';
}

function safeAiMaterialStem(value, fallback, maxLength) {
  return String(value || fallback)
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, maxLength) || fallback;
}

const GENERIC_AI_MATERIAL_NAME_RE = /^(?:资料|图片|截图|文档|文件|原图|附件|素材|未命名|image|img|file|document|screenshot|attachment|material|asset)(?:[-_ ]?(?:\d+|[一二三四五六七八九十]+))?$/iu;

function createMaterialNamingError(message, details = {}) {
  const error = new Error(message);
  error.code = 'AI_MATERIAL_NAMES_INCOMPLETE';
  error.details = details;
  return error;
}

function originalMaterialStem(attachment) {
  const source = String(attachment?.name || path.basename(String(attachment?.filePath || '')));
  return safeAiMaterialStem(path.basename(source, path.extname(source)), '', 120);
}

function weakMaterialStem(value) {
  const normalized = safeAiMaterialStem(value, '', 120);
  const compact = normalized.replace(/[\s_-]+/g, '');
  return !normalized
    || GENERIC_AI_MATERIAL_NAME_RE.test(normalized)
    || /^[a-f0-9]{16,}$/i.test(compact);
}

function materialAttachmentId(attachment) {
  return String(attachment?.assetId || attachment?.id || '').trim();
}

function materialAttachmentDigest(attachment) {
  const id = materialAttachmentId(attachment).toLowerCase();
  if (/^[a-f0-9]{64}$/.test(id)) return id;
  // V2 asset ids are computed from the actual bytes and are authoritative.
  // Some legacy learning snapshots copied the previous attachment checksum
  // while replacing ids, so trusting checksum first can pair two files wrong.
  const declared = String(attachment?.checksum || '').replace(/^sha256:/i, '').toLowerCase();
  if (/^[a-f0-9]{64}$/.test(declared)) return declared;
  const filePath = String(attachment?.filePath || '');
  const pathStem = path.basename(filePath, path.extname(filePath)).toLowerCase();
  if (/^[a-f0-9]{64}$/.test(pathStem)) return pathStem;
  if (!filePath || !fs.existsSync(filePath)) return '';
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return '';
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return '';
  }
}

function sameMaterialAttachmentShape(left, right) {
  const leftSize = Number(left?.size);
  const rightSize = Number(right?.size);
  const sizeMatches = Number.isFinite(leftSize) && Number.isFinite(rightSize) && leftSize === rightSize;
  const leftMime = String(left?.mimeType || left?.mime || '').toLowerCase();
  const rightMime = String(right?.mimeType || right?.mime || '').toLowerCase();
  const mimeMatches = Boolean(leftMime && rightMime && leftMime === rightMime);
  const leftExtension = path.extname(String(left?.name || left?.filePath || '')).toLowerCase();
  const rightExtension = path.extname(String(right?.name || right?.filePath || '')).toLowerCase();
  const extensionMatches = Boolean(leftExtension && rightExtension && leftExtension === rightExtension);
  return (sizeMatches && mimeMatches) || (sizeMatches && extensionMatches) || (mimeMatches && extensionMatches);
}

function findExistingMaterialAttachmentPath(sourceAttachment, currentAttachment) {
  const pathCandidates = [
    sourceAttachment?.filePath,
    currentAttachment?.filePath,
    sourceAttachment?.localPathKey,
    currentAttachment?.localPathKey,
  ].filter((value) => typeof value === 'string' && value.trim());
  for (const candidate of pathCandidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {}
  }

  const expectedDigest = materialAttachmentDigest(sourceAttachment)
    || materialAttachmentDigest(currentAttachment);
  if (!expectedDigest) return '';
  const expectedSize = Number(sourceAttachment?.size ?? currentAttachment?.size);
  const expectedExtension = path.extname(String(
    sourceAttachment?.name
    || sourceAttachment?.filePath
    || currentAttachment?.name
    || currentAttachment?.filePath
    || '',
  )).toLowerCase();
  const directories = [...new Set(pathCandidates.map((candidate) => path.dirname(path.resolve(candidate))))];
  const matches = [];
  for (const directory of directories) {
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const candidate = path.join(directory, entry.name);
      if (expectedExtension && path.extname(entry.name).toLowerCase() !== expectedExtension) continue;
      try {
        const stat = fs.statSync(candidate);
        if (Number.isFinite(expectedSize) && expectedSize >= 0 && stat.size !== expectedSize) continue;
        const digest = crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
        if (digest === expectedDigest) matches.push(path.resolve(candidate));
      } catch {}
    }
  }
  return matches.length === 1 ? matches[0] : '';
}

function reconcileMaterialReceiptAttachments(receiptAttachments, currentAttachments) {
  const source = Array.isArray(receiptAttachments) ? receiptAttachments : [];
  const current = Array.isArray(currentAttachments) ? currentAttachments : [];
  const identityPlan = buildMaterialAttachmentIdentityPlan(source, current);
  const currentById = new Map(current.map((attachment) => [materialAttachmentId(attachment), attachment]));
  return source.map((attachment, index) => {
    const currentAttachment = currentById.get(identityPlan.sourceIdentityIds[index]);
    const filePath = findExistingMaterialAttachmentPath(attachment, currentAttachment);
    if (!filePath) {
      const error = createMaterialNamingError(`资料 ${index + 1} 的本机文件不存在，无法安全重命名。`, {
        index,
        sourcePath: attachment?.filePath || '',
        currentPath: currentAttachment?.filePath || '',
        checksum: materialAttachmentDigest(attachment) || materialAttachmentDigest(currentAttachment),
      });
      error.code = 'AI_MATERIAL_FILE_MISSING';
      throw error;
    }
    const digest = materialAttachmentDigest({ ...attachment, filePath })
      || materialAttachmentDigest({ ...currentAttachment, filePath });
    const pathName = path.basename(filePath).replace(/^\d{2}-/, '');
    return {
      ...attachment,
      ...currentAttachment,
      id: currentAttachment?.id || attachment?.id,
      assetId: currentAttachment?.assetId || attachment?.assetId,
      name: path.resolve(filePath) === path.resolve(String(attachment?.filePath || ''))
        ? attachment?.name || currentAttachment?.name || pathName
        : pathName || currentAttachment?.name || attachment?.name,
      filePath,
      ...(digest ? { checksum: `sha256:${digest}` } : {}),
    };
  });
}

function isCanonicalHashAssetPath(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  const stem = path.basename(resolved, path.extname(resolved));
  return path.basename(path.dirname(resolved)).toLowerCase() === '.assets'
    && /^[a-f0-9]{64}(?:_\d+)?$/i.test(stem);
}

function createMaterialFileRenamePlan(attachments, names, subject) {
  const reserved = new Set((Array.isArray(attachments) ? attachments : [])
    .map((attachment) => path.resolve(String(attachment?.filePath || ''))));
  return (Array.isArray(attachments) ? attachments : []).map((attachment, index) => {
    const sourcePath = path.resolve(String(attachment.filePath || ''));
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      const error = createMaterialNamingError(`资料 ${index + 1} 的本机文件不存在，无法安全重命名。`, {
        index,
        sourcePath,
      });
      error.code = 'AI_MATERIAL_FILE_MISSING';
      throw error;
    }
    const extension = (path.extname(sourcePath) || path.extname(String(attachment.name || ''))).toLowerCase();
    const stem = names.get(index);
    const storedPrefix = `${String(index + 1).padStart(2, '0')}-`;
    const copiesCanonicalAsset = isCanonicalHashAssetPath(sourcePath);
    const destinationDir = copiesCanonicalAsset
      ? path.join(NOTES_ROOT, normalizeStoredSubject(subject))
      : path.dirname(sourcePath);
    fs.mkdirSync(destinationDir, { recursive: true });
    const baseTarget = path.join(destinationDir, `${storedPrefix}${stem}${extension}`);
    let targetPath = baseTarget;
    let suffix = 2;
    while (path.resolve(targetPath) !== sourcePath
      && (reserved.has(path.resolve(targetPath)) || fs.existsSync(targetPath))) {
      targetPath = path.join(destinationDir, `${storedPrefix}${stem}-${suffix}${extension}`);
      suffix += 1;
    }
    reserved.add(path.resolve(targetPath));
    const checksum = materialAttachmentDigest({ ...attachment, filePath: sourcePath });
    return {
      attachment,
      sourcePath,
      targetPath: path.resolve(targetPath),
      mode: copiesCanonicalAsset ? 'copy' : 'rename',
      checksum,
      displayName: `${path.basename(targetPath, path.extname(targetPath)).replace(/^\d{2}-/, '')}${path.extname(targetPath)}`,
    };
  });
}

function executeMaterialFileRenamePlan(plan) {
  const operations = (Array.isArray(plan) ? plan : [])
    .filter((item) => item.sourcePath !== item.targetPath)
    .map((item) => ({
      ...item,
      temporaryPath: path.join(
        path.dirname(item.targetPath),
        `.kaoyan-rename-${crypto.randomUUID()}${path.extname(item.targetPath)}.tmp`,
      ),
      staged: false,
      finalized: false,
    }));
  let active = true;
  const rollback = () => {
    if (!active) return;
    for (const operation of [...operations].reverse()) {
      try {
        if (operation.finalized && fs.existsSync(operation.targetPath)) {
          if (operation.mode === 'copy') fs.unlinkSync(operation.targetPath);
          else if (!fs.existsSync(operation.sourcePath)) fs.renameSync(operation.targetPath, operation.sourcePath);
        } else if (operation.staged && fs.existsSync(operation.temporaryPath)) {
          if (operation.mode === 'copy') fs.unlinkSync(operation.temporaryPath);
          else if (!fs.existsSync(operation.sourcePath)) fs.renameSync(operation.temporaryPath, operation.sourcePath);
        }
      } catch {}
    }
    active = false;
  };
  try {
    for (const operation of operations) {
      if (operation.mode === 'copy') fs.copyFileSync(operation.sourcePath, operation.temporaryPath, fs.constants.COPYFILE_EXCL);
      else fs.renameSync(operation.sourcePath, operation.temporaryPath);
      operation.staged = true;
    }
    for (const operation of operations) {
      fs.renameSync(operation.temporaryPath, operation.targetPath);
      operation.finalized = true;
    }
  } catch (error) {
    rollback();
    throw error;
  }
  return {
    commit() {
      active = false;
    },
    rollback,
  };
}

function materialAttachmentMappingError(sourceAttachments, baselineAttachments, reason) {
  const error = createMaterialNamingError('无法安全对应 AI 命名前后的资料，请刷新后重试以保护资料顺序。', {
    reason,
    sourceIds: sourceAttachments.map(materialAttachmentId),
    baselineIds: baselineAttachments.map(materialAttachmentId),
  });
  error.code = 'AI_MATERIAL_ATTACHMENTS_CHANGED';
  return error;
}

function buildMaterialAttachmentIdentityPlan(sourceAttachments, baselineAttachments) {
  const source = Array.isArray(sourceAttachments) ? sourceAttachments : [];
  const baseline = Array.isArray(baselineAttachments) ? baselineAttachments : [];
  const baselineIds = baseline.map(materialAttachmentId);
  if (source.length !== baseline.length
    || baselineIds.some((id) => !id)
    || new Set(baselineIds).size !== baselineIds.length) {
    throw materialAttachmentMappingError(source, baseline, 'attachment-count-or-id-changed');
  }

  const remaining = new Set(baseline.map((_, index) => index));
  const sourceIdentityIds = new Array(source.length);
  const take = (sourceIndex, candidateIndex) => {
    sourceIdentityIds[sourceIndex] = baselineIds[candidateIndex];
    remaining.delete(candidateIndex);
  };

  // Prefer exact durable identifiers when both records already share them.
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    const id = materialAttachmentId(source[sourceIndex]);
    const candidateIndex = baselineIds.indexOf(id);
    if (id && candidateIndex >= 0 && remaining.has(candidateIndex)) take(sourceIndex, candidateIndex);
  }

  // Consolidation replaces material-* ids with SHA-256 ids. Match those by
  // actual bytes/checksum before considering any weaker metadata evidence.
  const baselineDigests = baseline.map(materialAttachmentDigest);
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    if (sourceIdentityIds[sourceIndex]) continue;
    const digest = materialAttachmentDigest(source[sourceIndex]);
    if (!digest) continue;
    const candidates = [...remaining].filter((index) => baselineDigests[index] === digest);
    if (candidates.length === 1) take(sourceIndex, candidates[0]);
    else if (candidates.length === 0) throw materialAttachmentMappingError(source, baseline, `digest-mismatch-${sourceIndex}`);
  }

  // If bytes are not locally available (for example a just-migrated legacy
  // receipt), the pre-call array position is acceptable only together with
  // matching size/mime/extension evidence. Never use position on its own.
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    if (sourceIdentityIds[sourceIndex]) continue;
    if (remaining.has(sourceIndex)
      && !materialAttachmentDigest(source[sourceIndex])
      && !baselineDigests[sourceIndex]
      && sameMaterialAttachmentShape(source[sourceIndex], baseline[sourceIndex])) {
      take(sourceIndex, sourceIndex);
    }
  }

  // Finally accept a unique metadata match. Ambiguous duplicates are rejected
  // rather than guessing which attachment the user placed first.
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    if (sourceIdentityIds[sourceIndex]) continue;
    const candidates = [...remaining].filter((index) => (
      !materialAttachmentDigest(source[sourceIndex])
      && !baselineDigests[index]
      && sameMaterialAttachmentShape(source[sourceIndex], baseline[index])
    ));
    if (candidates.length !== 1) {
      throw materialAttachmentMappingError(source, baseline, `ambiguous-metadata-${sourceIndex}`);
    }
    take(sourceIndex, candidates[0]);
  }

  return { baselineIds, sourceIdentityIds };
}

function validateCompleteMaterialNames(attachments, files, maxLength) {
  const sourceAttachments = Array.isArray(attachments) ? attachments : [];
  const returnedFiles = Array.isArray(files) ? files : [];
  const names = new Map();
  const failures = [];
  const seenNames = new Map();

  for (const item of returnedFiles) {
    const index = Number(item?.index);
    if (!Number.isInteger(index) || index < 0 || index >= sourceAttachments.length) {
      failures.push(`无效附件索引 ${String(item?.index ?? '')}`);
      continue;
    }
    if (names.has(index)) {
      failures.push(`附件 ${index + 1} 重复返回`);
      continue;
    }
    const name = safeAiMaterialStem(item?.name, '', maxLength);
    const compact = name.replace(/[\s_-]+/g, '');
    const original = originalMaterialStem(sourceAttachments[index]);
    let reason = '';
    if (!name) reason = '名称为空';
    else if (GENERIC_AI_MATERIAL_NAME_RE.test(name)) reason = '名称过于泛化';
    else if (/^[a-f0-9]{16,}$/i.test(compact)) reason = '名称疑似哈希值';
    // A previous successful group rename can already have produced the best
    // semantic name while an older learning snapshot still shows image.png or
    // a hash. Accept the same meaningful name so this run can reconcile every
    // attachment instead of failing before the atomic update. Echoing a weak
    // original name remains invalid.
    else if (name.localeCompare(original, undefined, { sensitivity: 'accent' }) === 0
      && weakMaterialStem(original)) reason = '名称没有变化';
    const normalizedName = name.toLocaleLowerCase('zh-CN');
    if (!reason && seenNames.has(normalizedName)) {
      reason = `与附件 ${seenNames.get(normalizedName) + 1} 重名`;
    }
    if (reason) {
      failures.push(`附件 ${index + 1}：${reason}`);
      continue;
    }
    names.set(index, name);
    seenNames.set(normalizedName, index);
  }

  for (let index = 0; index < sourceAttachments.length; index += 1) {
    if (!names.has(index)) failures.push(`附件 ${index + 1} 缺少有效新名称`);
  }
  if (failures.length > 0) {
    throw createMaterialNamingError(`AI 未返回完整、有效的资料名称：${failures.join('；')}`, {
      failures,
      expectedAttachmentCount: sourceAttachments.length,
      returnedFileCount: returnedFiles.length,
      returnedIndexes: returnedFiles.map((item) => item?.index),
    });
  }
  return names;
}

function validateMaterialNameBatch(attachments, files, startIndex, maxLength) {
  const batch = attachments.slice(startIndex, startIndex + MATERIAL_NAMING_BATCH_SIZE);
  const normalized = (Array.isArray(files) ? files : []).map((item) => ({
    ...item,
    index: Number(item?.index) - startIndex,
  }));
  const localNames = validateCompleteMaterialNames(batch, normalized, maxLength);
  return new Map([...localNames.entries()].map(([index, name]) => [startIndex + index, name]));
}

function mergeLatestMaterialAttachmentOrder(latestAttachments, renamedAttachments, identityPlan) {
  const latest = Array.isArray(latestAttachments) ? latestAttachments : [];
  const latestIds = latest.map(materialAttachmentId);
  const baselineIds = Array.isArray(identityPlan?.baselineIds) ? identityPlan.baselineIds : [];
  const sourceIdentityIds = Array.isArray(identityPlan?.sourceIdentityIds) ? identityPlan.sourceIdentityIds : [];
  if (latestIds.some((id) => !id)
    || latestIds.length !== baselineIds.length
    || new Set(latestIds).size !== latestIds.length
    || baselineIds.some((id) => !latestIds.includes(id))) {
    const error = createMaterialNamingError('资料列表在 AI 命名期间发生了增删，请重试以保护最新资料。', {
      latestIds,
      baselineIds,
    });
    error.code = 'AI_MATERIAL_ATTACHMENTS_CHANGED';
    throw error;
  }
  const renamedById = new Map((Array.isArray(renamedAttachments) ? renamedAttachments : [])
    .map((attachment, index) => [sourceIdentityIds[index], attachment]));
  if (renamedById.size !== latest.length || sourceIdentityIds.some((id) => !id)) {
    throw materialAttachmentMappingError(renamedAttachments, latest, 'incomplete-renamed-map');
  }
  return latest.map((attachment) => {
    const renamed = renamedById.get(materialAttachmentId(attachment));
    return renamed ? {
      ...attachment,
      name: renamed.name,
      filePath: renamed.filePath,
      ...(renamed.checksum ? { checksum: renamed.checksum } : {}),
    } : attachment;
  });
}

function materialImagePaths(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter((attachment) => (
      String(attachment?.mimeType || '').startsWith('image/')
      && typeof attachment?.filePath === 'string'
      && fs.existsSync(attachment.filePath)
    ))
    .map((attachment) => path.resolve(attachment.filePath))
    .slice(0, 8);
}

function writeCanonicalMaterialSidecar(note, receipt, analysis = null) {
  if (!note || !receipt) return '';
  const subject = normalizeStoredSubject(note.subject);
  const subjectDir = path.join(NOTES_ROOT, subject);
  const sidecarPath = path.join(metadataDir(subjectDir), `${note.noteUid}.note.json`);
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  const existing = readJson(sidecarPath, {});
  const primary = receipt.attachments[0] || null;
  const metadata = {
    ...existing,
    schemaVersion: 2,
    entryId: note.noteUid,
    id: note.noteUid,
    noteUid: note.noteUid,
    kind: 'quick',
    sourceType: 'material-note',
    subject,
    requestedSubject: subject,
    title: note.title,
    remark: note.remark,
    facets: note.facets,
    tags: note.tags,
    fileName: primary?.name || '',
    filePath: primary?.filePath || '',
    mime: primary?.mimeType || '',
    attachments: receipt.attachments,
    state: 'active',
    createdAt: note.createdAt || receipt.createdAt,
    updatedAt: note.updatedAt || receipt.updatedAt || new Date().toISOString(),
    learning: { ...(existing.learning || {}), ...note, attachments: receipt.attachments },
    organizer: analysis ? {
      ...(existing.organizer || {}),
      status: note.reviewStatus === 'pending' ? 'needs_review' : 'organized',
      processedAt: new Date().toISOString(),
      provider: analysis.provider || '',
      model: analysis.model || '',
      reason: analysis.reason || '',
      summary: analysis.summary || '',
      confidence: analysis.confidence,
      materialGroup: true,
    } : existing.organizer,
  };
  atomicWriteJson(sidecarPath, metadata);
  rebuildMetadataIndex(subjectDir);
  for (const candidateSubject of ALLOWED_STORED_SUBJECTS) {
    if (candidateSubject === subject) continue;
    const stalePath = path.join(metadataDir(path.join(NOTES_ROOT, candidateSubject)), `${note.noteUid}.note.json`);
    if (!fs.existsSync(stalePath)) continue;
    unlinkFileIfExists(stalePath);
    rebuildMetadataIndex(path.join(NOTES_ROOT, candidateSubject));
  }
  return sidecarPath;
}

async function runMaterialEnrichment(noteUid, attachments, router) {
  const note = findMaterialLearningNote(learningData.getSnapshot(), noteUid);
  const imagePaths = materialImagePaths(attachments);
  if (!note || imagePaths.length === 0) return null;
  const taxonomy = loadTaxonomy(NOTE_TAXONOMY_PATH);
  const analyzer = createNoteAiAnalyzer({ router });
  const analysis = await analyzer({
    imagePath: imagePaths[0],
    imagePaths,
    metadata: {
      kind: 'quick',
      sourceType: 'material-note',
      title: note.title,
      remark: note.remark,
      attachments,
      learning: note,
    },
    currentCategory: {
      subject: note.subject || DEFAULT_SUBJECT,
      knowledgePoint: Array.isArray(note.knowledgePath) ? note.knowledgePath[1] || null : null,
    },
    taxonomy,
    notesRoot: NOTES_ROOT,
  });
  const subject = normalizeStoredSubject(analysis.subject);
  const subjectNode = ensureSubject(taxonomy, subject, { createdBy: subject === DEFAULT_SUBJECT ? 'user' : 'ai' });
  const knowledgePoint = subject !== DEFAULT_SUBJECT && analysis.knowledgePoint
    ? ensureKnowledgePoint(taxonomy, subjectNode, analysis.knowledgePoint, {
        aliases: analysis.knowledgePointAliases,
        createdBy: 'ai',
      })
    : null;
  saveTaxonomyAtomic(NOTE_TAXONOMY_PATH, taxonomy);
  const intent = analysis.intent || {};
  const tags = [...new Set([
    ...(Array.isArray(latestNote.tags) ? latestNote.tags : []),
    ...(Array.isArray(analysis.tags) ? analysis.tags : []),
    ...(intent.isMistake ? ['错题'] : []),
    ...(intent.shouldMemorize ? ['背诵'] : []),
  ])];
  const keepsHumanDecision = ['accepted', 'corrected', 'ignored'].includes(latestNote.reviewStatus);
  const reviewStatus = keepsHumanDecision
    ? latestNote.reviewStatus
    : subject === DEFAULT_SUBJECT ? 'pending' : 'auto_applied';
  const enrichment = {
    ...latestNote,
    title: analysis.title || latestNote.title,
    subject,
    knowledgePath: [subject, ...(knowledgePoint ? [knowledgePoint.name] : [])],
    tags,
    noteType: intent.isMistake ? 'mistake'
      : intent.shouldMemorize ? 'memory'
        : intent.isQuestion ? 'question' : latestNote.noteType || 'quick',
    questionType: analysis.questionType || '',
    questionTypePath: analysis.questionTypePath || [],
    wrongReason: analysis.wrongReason || '',
    wrongReasonPath: analysis.wrongReasonPath || [],
    learningTypePath: analysis.learningTypePath || [],
    goodQuestion: latestNote.goodQuestion === true || intent.isGood === true,
    goodQuestionType: analysis.goodQuestionType || latestNote.goodQuestionType || '',
    organizationStatus: reviewStatus === 'ignored' ? 'ignored' : reviewStatus === 'pending' ? 'pending' : 'confirmed',
    classificationSource: reviewStatus === 'corrected' ? 'manual' : latestNote.classificationSource || 'ai',
    reviewStatus,
    decisionRevision: latestNote.decisionRevision || 0,
    pendingAiOrganization: false,
    intent,
    items: analysis.items || [],
    confidence: analysis.confidence,
    cards: reviewStatus === 'ignored' ? [] : analysis.cards || [],
    sourceType: 'material-note',
    attachments: latestAttachments,
    facets: latestNote.facets,
    enrichedAt: new Date().toISOString(),
  };
  const metadata = {
    noteUid,
    title: enrichment.title,
    subject,
    remark: latestNote.remark,
    sourceType: 'material-note',
    attachments: latestAttachments,
    facets: latestNote.facets,
    learning: enrichment,
  };
  const snapshot = learningData.syncNote(metadata, { enrichment, cards: enrichment.cards });
  return { analysis, snapshot, note: findMaterialLearningNote(snapshot, noteUid) };
}

async function runMaterialNamingJob(noteUid, options = {}) {
  const receipt = readMaterialReceipt(noteUid);
  const note = findMaterialLearningNote(learningData.getSnapshot(), noteUid);
  if (!receipt || !note) return null;
  const sourceAttachments = reconcileMaterialReceiptAttachments(receipt.attachments, note.attachments);
  if (sourceAttachments.some((attachment, index) => (
    path.resolve(String(attachment.filePath || '')) !== path.resolve(String(receipt.attachments[index]?.filePath || ''))
    || materialAttachmentId(attachment) !== materialAttachmentId(receipt.attachments[index])
  ))) {
    writeMaterialReceipt({
      ...receipt,
      attachments: sourceAttachments,
      repairedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  const router = getAiRouter();
  if (!router) throw new Error(aiRouterInitError || 'AI router is unavailable');
  const taskOptions = router.getTaskOptions?.('material_naming') || {};
  const renameAttachments = taskOptions.renameAttachments !== false && sourceAttachments.length > 0;
  const maxLength = Math.max(8, Math.min(60, Number(taskOptions.titleMaxLength) || 26));
  const noteTitleMaxLength = Math.max(8, Math.min(32, Number(taskOptions.noteTitleMaxLength) || 18));
  const fileContexts = [];
  const contextCharsPerFile = Math.max(240, Math.floor(18_000 / Math.max(1, sourceAttachments.length)));
  for (let index = 0; index < sourceAttachments.length; index += 1) {
    const attachment = sourceAttachments[index];
    const extractedText = await extractMaterialNamingText(attachment);
    fileContexts.push({
      index,
      originalName: attachment.name,
      mimeType: attachment.mimeType,
      extractedText: extractedText.slice(0, contextCharsPerFile),
    });
  }
  const sharedPrompt = [
    '你只负责为一条考研速记及其附件命名，不回答问题，不总结资料。',
    '命名前必须先完整理解正文与全部附件的共同主题、顺序和互补关系；禁止逐个孤立判断。',
    '速记标题只写共同主题，不得机械拼接附件名，且必须控制在很短的长度内。',
    '标题必须使用完整、通行的学科表述，至少同时包含核心对象与任务/方法；禁止自造缩写、截断词语或输出“高阶差配凑”这类无法独立理解的残缺短语。',
    '数学题优先写成“核心条件/对象 + 所求量或方法”，例如“函数差分关系与定积分平均值”。',
    '每个附件名要体现它在本条速记中的作用，例如概念原文、例题解析、我的批注、动态演示、总结图或补充证明。',
    '同组附件名称要彼此区分并保持统一主题，不能使用资料一、资料二。',
    '每份资料都必须返回原始的全局 index；名称不含扩展名、日期、随机数和路径。',
    '禁止使用“资料、图片、截图、文档、未命名”等空泛名称。',
    `速记正文：${String(note.remark || '').slice(0, 4_000) || '无'}`,
    `全部附件摘要：${JSON.stringify(fileContexts)}`,
  ].join('\n');
  const batchStarts = renameAttachments
    ? Array.from({ length: Math.ceil(sourceAttachments.length / MATERIAL_NAMING_BATCH_SIZE) }, (_, index) => index * MATERIAL_NAMING_BATCH_SIZE)
    : [0];
  const names = new Map();
  const responses = [];
  for (const batchStart of batchStarts) {
    const batchEnd = renameAttachments
      ? Math.min(sourceAttachments.length, batchStart + MATERIAL_NAMING_BATCH_SIZE)
      : 0;
    const batchSize = batchEnd - batchStart;
    const content = [{
      type: 'text',
      text: [
        sharedPrompt,
        renameAttachments
          ? `本次只命名全局 index ${batchStart} 到 ${batchEnd - 1}；files 必须且只能返回这 ${batchSize} 项，index 保持全局值。`
          : '本条速记没有附件，只返回 noteTitle。',
        responses.length === 0 ? '本次还必须返回 noteTitle。' : 'noteTitle 已在首批生成，本次不要改写标题。',
      ].join('\n'),
    }];
    for (let index = batchStart; index < batchEnd; index += 1) {
      const attachment = sourceAttachments[index];
      if (!String(attachment.mimeType || '').startsWith('image/')) continue;
      try {
        const buffer = fs.readFileSync(attachment.filePath);
        if (buffer.length > MAX_MATERIAL_FILE_BYTES) continue;
        content.push({ type: 'text', text: `下面是全局 index=${index} 的图片内容：` });
        content.push({
          type: 'image_url',
          image_url: { url: `data:${attachment.mimeType};base64,${buffer.toString('base64')}` },
        });
      } catch {}
    }
    const firstBatch = responses.length === 0;
    const response = await router.complete({
      task: 'material_naming',
      messages: [{ role: 'user', content }],
      responseSchema: {
        type: 'object',
        required: [
          ...(firstBatch ? ['noteTitle'] : []),
          ...(renameAttachments ? ['files'] : []),
        ],
        properties: {
          ...(firstBatch ? { noteTitle: { type: 'string' } } : {}),
          ...(renameAttachments ? {
            files: {
              type: 'array',
              minItems: batchSize,
              maxItems: batchSize,
              items: {
                type: 'object',
                required: ['index', 'name'],
                properties: {
                  index: { type: 'number' },
                  name: { type: 'string' },
                },
              },
            },
          } : {}),
        },
      },
      temperature: 0.1,
      maxTokens: Number(taskOptions.maxTokens) || 1200,
    });
    responses.push(response);
    if (renameAttachments) {
      for (const [index, name] of validateMaterialNameBatch(sourceAttachments, response.json?.files, batchStart, maxLength)) {
        names.set(index, name);
      }
    }
  }
  const response = responses[0];
  const latestNote = findMaterialLearningNote(learningData.getSnapshot(), noteUid);
  if (!latestNote) throw createMaterialNamingError('AI 命名完成前速记已不存在，请刷新后重试。');
  // Rebuild identity mapping after the model returns. V2 consolidation may
  // legitimately replace material-* identifiers with SHA-256 ids while AI is
  // running; comparing against the stale pre-call ids would reject that safe
  // migration and previously left already-moved files behind.
  const latestIdentityPlan = buildMaterialAttachmentIdentityPlan(sourceAttachments, latestNote.attachments);
  mergeLatestMaterialAttachmentOrder(latestNote.attachments, sourceAttachments, latestIdentityPlan);
  const fileRenamePlan = renameAttachments
    ? createMaterialFileRenamePlan(sourceAttachments, names, latestNote.subject)
    : [];
  const renamedFromReceipt = renameAttachments ? fileRenamePlan.map((item) => ({
    ...item.attachment,
    name: item.displayName,
    filePath: item.targetPath,
    ...(item.checksum ? { checksum: `sha256:${item.checksum}` } : {}),
  })) : sourceAttachments;
  const renamed = mergeLatestMaterialAttachmentOrder(
    latestNote.attachments,
    renamedFromReceipt,
    latestIdentityPlan,
  );
  const titleChangedWhileRunning = latestNote.title !== note.title
    && Array.isArray(latestNote.userEditedFields)
    && latestNote.userEditedFields.includes('title');
  const shouldRenameTitle = options.forceTitle === true
    || (taskOptions.renameNoteTitle !== false && !options.userTitle);
  const { validateNoteTitle } = await getNoteTitlePolicy();
  const proposedTitle = safeAiMaterialStem(
    response.json?.noteTitle,
    latestNote.title || renamed[0]?.name || '快速记录',
    noteTitleMaxLength,
  );
  const titleValidation = validateNoteTitle(proposedTitle, {
    titleMinLength: 6,
    titleMaxLength: noteTitleMaxLength,
    rejectGenericTitle: true,
  });
  const nextTitle = shouldRenameTitle && !titleChangedWhileRunning
    ? titleValidation.ok && titleValidation.title.length >= 6
      ? titleValidation.title
      : latestNote.title || renamed[0]?.name || '待确认题目'
    : latestNote.title;
  const namingCompletedAt = new Date().toISOString();
  const namingReceipt = {
    ...receipt,
    attachments: renamed,
    aiNaming: {
      status: 'complete',
      explicit: options.explicit === true,
      trigger: options.explicit === true ? 'user' : 'auto',
      provider: response.provider || '',
      model: response.model || '',
      completedAt: namingCompletedAt,
    },
    aiClassification: {
      status: 'pending',
      startedAt: namingCompletedAt,
    },
    updatedAt: namingCompletedAt,
  };
  let snapshot;
  let noteUpdated = false;
  const fileTransaction = executeMaterialFileRenamePlan(fileRenamePlan);
  try {
    snapshot = learningData.updateNote(noteUid, {
      title: nextTitle,
      attachments: renamed,
    }, { trackUserEdits: false });
    noteUpdated = true;
    writeMaterialReceipt(namingReceipt);
    fileTransaction.commit();
  } catch (error) {
    fileTransaction.rollback();
    if (noteUpdated) {
      try {
        snapshot = learningData.updateNote(noteUid, {
          title: latestNote.title,
          attachments: latestNote.attachments,
        }, { trackUserEdits: false });
      } catch {}
    }
    throw error;
  }
  let enrichment = null;
  let enrichmentError = '';
  try {
    enrichment = await runMaterialEnrichment(noteUid, renamed, router);
    if (enrichment?.snapshot) snapshot = enrichment.snapshot;
  } catch (error) {
    enrichmentError = error instanceof Error ? error.message : String(error);
    if (error?.code === 'AI_MATERIAL_ATTACHMENTS_CHANGED') {
      queueMaterialNamingJob(noteUid, { userTitle: false });
    }
  }
  const latestReceipt = readMaterialReceipt(noteUid) || namingReceipt;
  let receiptStillMatches = true;
  try {
    buildMaterialAttachmentIdentityPlan(renamed, latestReceipt.attachments);
  } catch {
    receiptStillMatches = false;
  }
  if (!receiptStillMatches) {
    queueMaterialNamingJob(noteUid, { userTitle: false });
    const currentSnapshot = learningData.getSnapshot();
    const currentNote = findMaterialLearningNote(currentSnapshot, noteUid);
    return {
      title: currentNote?.title || nextTitle,
      attachments: currentNote?.attachments || latestReceipt.attachments,
      snapshot: currentSnapshot,
      enrichmentError: enrichmentError || '资料在 AI 分类期间有更新，已按最新版排队重跑',
    };
  }
  const completedReceipt = {
    ...latestReceipt,
    attachments: renamed,
    aiNaming: namingReceipt.aiNaming,
    aiClassification: enrichment ? {
      status: 'complete',
      provider: enrichment.analysis.provider || '',
      model: enrichment.analysis.model || '',
      subject: enrichment.note?.subject || '',
      completedAt: new Date().toISOString(),
    } : {
      status: 'failed',
      error: enrichmentError || 'NO_IMAGE_ENRICHMENT',
      completedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  writeMaterialReceipt(completedReceipt);
  const finalNote = findMaterialLearningNote(snapshot, noteUid);
  if (finalNote) writeCanonicalMaterialSidecar(finalNote, completedReceipt, enrichment?.analysis || null);
  broadcastLearningData(snapshot);
  return { title: finalNote?.title || nextTitle, attachments: renamed, snapshot, enrichmentError };
}

function queueMaterialNamingJob(noteUid, options = {}) {
  if (materialNamingJobs.has(noteUid)) {
    const pending = materialNamingRerunRequests.get(noteUid) || {};
    materialNamingRerunRequests.set(noteUid, {
      ...pending,
      ...options,
      explicit: pending.explicit === true || options.explicit === true,
      forceTitle: pending.forceTitle === true || options.forceTitle === true,
      manualJobId: options.manualJobId || pending.manualJobId,
    });
    if (options.manualJobId) {
      updateManualAiJob(options.manualJobId, {
        status: 'queued',
        progress: 5,
        message: '资料刚刚有更新，将在当前命名完成后按最新版重跑',
      });
    }
    return false;
  }
  if (options.manualJobId) {
    const currentReceipt = readMaterialReceipt(noteUid);
    if (currentReceipt) {
      writeMaterialReceipt({
        ...currentReceipt,
        aiNaming: {
          status: 'processing',
          explicit: options.explicit === true,
          trigger: options.explicit === true ? 'user' : 'auto',
          startedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      });
    }
    updateManualAiJob(options.manualJobId, {
      status: 'processing',
      progress: 15,
      message: 'AI 正在读取速记文字和各份资料',
    });
  }
  const job = Promise.resolve().then(() => runMaterialNamingJob(noteUid, options));
  materialNamingJobs.set(noteUid, job);
  void job.then((result) => {
    if (options.manualJobId) {
      updateManualAiJob(options.manualJobId, {
        status: result ? 'completed' : 'failed',
        progress: result ? 100 : 0,
        message: result ? '速记标题与资料命名完成' : '没有找到可命名的速记资料',
        error: result ? '' : 'MATERIAL_NOTE_NOT_FOUND',
        completedAt: new Date().toISOString(),
        result: result ? { applied: true, title: result.title, revision: result.snapshot.revision } : null,
      });
    }
  }).catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = typeof error?.code === 'string' ? error.code : 'MATERIAL_NAMING_FAILED';
    appendBackgroundJobLog({
      type: 'material-naming',
      noteUid,
      status: 'failed',
      error: errorMessage,
      details: error && typeof error === 'object' ? error.details || null : null,
      stack: error instanceof Error ? String(error.stack || '').slice(0, 12_000) : '',
    });
    const currentReceipt = readMaterialReceipt(noteUid);
    if (currentReceipt) {
      writeMaterialReceipt({
        ...currentReceipt,
        aiNaming: {
          status: 'failed',
          explicit: options.explicit === true,
          trigger: options.explicit === true ? 'user' : 'auto',
          error: errorMessage,
          errorCode,
          completedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      });
    }
    if (options.manualJobId) {
      updateManualAiJob(options.manualJobId, {
        status: 'failed',
        progress: 0,
        message: 'AI 未能返回完整有效的资料名称，可安全重试',
        error: errorMessage,
        errorCode,
        completedAt: new Date().toISOString(),
      });
    }
  }).finally(() => {
    materialNamingJobs.delete(noteUid);
    const rerunOptions = materialNamingRerunRequests.get(noteUid);
    materialNamingRerunRequests.delete(noteUid);
    if (rerunOptions) queueMicrotask(() => queueMaterialNamingJob(noteUid, rerunOptions));
  });
  return true;
}

async function handleSaveMaterial(req, res) {
  const raw = await readBody(req, 24 * 1024 * 1024);
  const payload = JSON.parse(raw || '{}');
  const noteUid = normalizeNoteUid(payload.noteUid);
  const rawFiles = Array.isArray(payload.files) ? payload.files : [];
  const files = rawFiles.map(decodeMaterialFile);
  const totalBytes = files.reduce((sum, file) => sum + file.buffer.length, 0);
  if (totalBytes > MAX_MATERIAL_TOTAL_BYTES) {
    const error = new Error('资料文件合计超过 16 MB');
    error.code = 'PAYLOAD_TOO_LARGE';
    throw error;
  }
  const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 240) : '';
  const remark = typeof payload.remark === 'string' ? payload.remark.trim().slice(0, 8000) : '';
  if (!title && !remark && files.length === 0) {
    const error = new Error('至少写一点文字，或加入一个资料文件');
    error.code = 'INVALID_MATERIAL_NOTE';
    throw error;
  }
  const subject = normalizeStoredSubject(payload.subject);
  const facets = Array.isArray(payload.facets)
    ? [...new Set(payload.facets.filter((item) => ['quick', 'mistake', 'good', 'memory', 'knowledge', 'method'].includes(item)))]
    : ['quick'];
  const tags = Array.isArray(payload.tags)
    ? [...new Set(payload.tags.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
  const fileHashes = files.map((file) => crypto.createHash('sha256').update(file.buffer).digest('hex'));
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({
    noteUid,
    title,
    remark,
    subject,
    facets,
    tags,
    files: files.map((file, index) => ({ name: file.fileName, mime: file.mime, hash: fileHashes[index] })),
  })).digest('hex');
  const existing = readMaterialReceipt(noteUid);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      const error = new Error('这个 noteUid 已用于另一条资料记录');
      error.code = 'SAVE_OPERATION_REUSED';
      throw error;
    }
    sendJson(res, 200, {
      ok: true,
      noteUid,
      attachments: existing.attachments,
      learningData: learningData.getSnapshot(),
      idempotentReplay: true,
    });
    if (existing.aiNaming?.status !== 'complete' && (files.length > 0 || !title)) {
      queueMaterialNamingJob(noteUid, { userTitle: Boolean(title) });
    }
    return;
  }

  const finalDir = path.join(MATERIAL_FILES_ROOT, noteUid);
  const stagingDir = path.join(MATERIAL_FILES_ROOT, `.staging-${noteUid}-${crypto.randomUUID()}`);
  if (fs.existsSync(finalDir)) {
    const error = new Error('资料目录已存在但缺少有效保存凭据');
    error.code = 'SAVE_OPERATION_REUSED';
    throw error;
  }
  fs.mkdirSync(stagingDir, { recursive: true });
  const createdAt = new Date().toISOString();
  let snapshot;
  try {
    const staged = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const storedName = `${String(index + 1).padStart(2, '0')}-${file.fileName}`;
      const filePath = path.join(stagingDir, storedName);
      fs.writeFileSync(filePath, file.buffer, { flag: 'wx' });
      staged.push({ file, storedName });
    }
    fs.mkdirSync(MATERIAL_FILES_ROOT, { recursive: true });
    fs.renameSync(stagingDir, finalDir);
    const attachments = staged.map(({ file, storedName }, index) => ({
      id: `material-${index + 1}`,
      kind: file.kind,
      name: file.fileName,
      mimeType: file.mime,
      size: file.buffer.length,
      filePath: path.join(finalDir, storedName),
      checksum: `sha256:${fileHashes[index]}`,
      previewPath: '',
      posterPath: '',
      createdAt,
    }));
    const noteType = facets.includes('mistake') ? 'mistake'
      : facets.includes('memory') ? 'memory'
        : facets.includes('knowledge') ? 'knowledge' : 'quick';
    snapshot = learningData.createNote({
      noteUid,
      capturedDate: typeof payload.capturedDate === 'string' ? payload.capturedDate : undefined,
      title: title || remark.split(/\r?\n/)[0]?.slice(0, 120) || attachments[0]?.name || '快速记录',
      subject,
      remark,
      tags,
      facets: facets.length > 0 ? facets : ['quick'],
      noteType,
      goodQuestion: facets.includes('good'),
      attachments,
      createCard: false,
      autoClassify: subject === DEFAULT_SUBJECT,
      sourceType: 'material-note',
      userEditedFields: [
        ...(subject !== DEFAULT_SUBJECT ? ['subject'] : []),
        ...(title ? ['title'] : []),
        ...(remark ? ['remark'] : []),
        ...(tags.length > 0 ? ['tags'] : []),
        ...(facets.some((facet) => facet !== 'quick') ? ['noteType', 'facets'] : []),
        ...(facets.includes('good') ? ['goodQuestion'] : []),
      ],
    });
    const storedNote = findMaterialLearningNote(snapshot, noteUid);
    const storedAttachments = storedNote?.attachments || attachments;
    writeMaterialReceipt({
      schemaVersion: 1,
      noteUid,
      requestHash,
      attachments: storedAttachments,
      createdAt,
      updatedAt: createdAt,
    });
    broadcastLearningData(snapshot);
    sendJson(res, 201, {
      ok: true,
      noteUid,
      attachments: storedAttachments,
      learningData: snapshot,
      idempotentReplay: false,
    });
    if (files.length > 0 || !title) queueMaterialNamingJob(noteUid, { userTitle: Boolean(title) });
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    if (!snapshot) fs.rmSync(finalDir, { recursive: true, force: true });
    throw error;
  }
}

async function handleAppendMaterial(req, res) {
  const raw = await readBody(req, 24 * 1024 * 1024);
  const payload = JSON.parse(raw || '{}');
  const noteUid = normalizeNoteUid(payload.noteUid);
  const files = (Array.isArray(payload.files) ? payload.files : []).map(decodeMaterialFile);
  const fileHashes = files.map((file) => crypto.createHash('sha256').update(file.buffer).digest('hex'));
  const operationRequestHash = crypto.createHash('sha256').update(JSON.stringify({
    noteUid,
    files: files.map((file, index) => ({ hash: fileHashes[index], name: file.fileName, mime: file.mime })),
  })).digest('hex');
  const operationId = String(payload.operationId || `append-${operationRequestHash.slice(0, 32)}`).trim().slice(0, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(operationId)) {
    const error = new Error('operationId 必须是安全的 ASCII 标识符');
    error.code = 'INVALID_OPERATION_ID';
    throw error;
  }
  if (files.length < 1) {
    const error = new Error('请选择至少一个要加入的资料文件');
    error.code = 'INVALID_MATERIAL_NOTE';
    throw error;
  }
  const totalBytes = files.reduce((sum, file) => sum + file.buffer.length, 0);
  if (totalBytes > MAX_MATERIAL_TOTAL_BYTES) {
    const error = new Error('资料文件合计超过 16 MB');
    error.code = 'PAYLOAD_TOO_LARGE';
    throw error;
  }
  const snapshot = learningData.getSnapshot();
  const note = findMaterialLearningNote(snapshot, noteUid);
  if (!note) {
    const error = new Error('没有找到要追加资料的速记');
    error.code = 'NOTE_NOT_FOUND';
    throw error;
  }
  const currentAttachments = Array.isArray(note.attachments) ? note.attachments : [];
  const rawReceipt = readJson(materialReceiptPath(noteUid), null);
  const existingOperation = rawReceipt?.appendOperations?.[operationId];
  if (existingOperation) {
    if (existingOperation.requestHash !== operationRequestHash) {
      const error = new Error('这个 operationId 已用于另一组资料');
      error.code = 'SAVE_OPERATION_REUSED';
      throw error;
    }
    sendJson(res, 200, {
      ok: true,
      operationId,
      noteUid,
      attachments: currentAttachments,
      learningData: snapshot,
      commitSha: null,
      idempotentReplay: true,
    });
    if (rawReceipt?.aiNaming?.status !== 'complete') {
      queueMaterialNamingJob(noteUid, { userTitle: false });
    }
    return;
  }
  const recordOperation = (attachments, updatedAt) => {
    const appendOperations = {
      ...(rawReceipt?.appendOperations && typeof rawReceipt.appendOperations === 'object' ? rawReceipt.appendOperations : {}),
      [operationId]: { requestHash: operationRequestHash, completedAt: updatedAt },
    };
    const boundedOperations = Object.fromEntries(Object.entries(appendOperations).slice(-64));
    writeMaterialReceipt({
      ...(rawReceipt && rawReceipt.noteUid === noteUid ? rawReceipt : {}),
      schemaVersion: Math.max(2, Number(rawReceipt?.schemaVersion) || 0),
      noteUid,
      requestHash: typeof rawReceipt?.requestHash === 'string'
        ? rawReceipt.requestHash
        : crypto.createHash('sha256').update(`legacy-material:${noteUid}`).digest('hex'),
      attachments,
      appendOperations: boundedOperations,
      createdAt: rawReceipt?.createdAt || updatedAt,
      updatedAt,
    });
  };
  const existingHashes = new Set();
  for (const attachment of currentAttachments) {
    const declared = typeof attachment?.checksum === 'string'
      ? attachment.checksum.replace(/^sha256:/i, '').toLowerCase()
      : '';
    if (/^[a-f0-9]{64}$/.test(declared)) {
      existingHashes.add(declared);
      continue;
    }
    if (typeof attachment?.filePath === 'string' && fs.existsSync(attachment.filePath)) {
      try {
        existingHashes.add(crypto.createHash('sha256').update(fs.readFileSync(attachment.filePath)).digest('hex'));
      } catch {
        // A temporarily unavailable old attachment must not block adding a new one.
      }
    }
  }
  const additions = files
    .map((file, index) => ({ file, hash: fileHashes[index] }))
    .filter(({ hash }, index, source) => !existingHashes.has(hash) && source.findIndex((item) => item.hash === hash) === index);
  const storedBytes = currentAttachments.reduce((sum, attachment) => sum + Math.max(0, Number(attachment?.size) || 0), 0);
  const addedBytes = additions.reduce((sum, addition) => sum + addition.file.buffer.length, 0);
  if (storedBytes + addedBytes > MAX_MATERIAL_TOTAL_BYTES) {
    const error = new Error('这条速记的资料合计不能超过 16 MB');
    error.code = 'PAYLOAD_TOO_LARGE';
    throw error;
  }
  if (additions.length === 0) {
    const completedAt = new Date().toISOString();
    recordOperation(currentAttachments, completedAt);
    sendJson(res, 200, {
      ok: true,
      operationId,
      noteUid,
      attachments: currentAttachments,
      learningData: snapshot,
      commitSha: null,
      idempotentReplay: true,
    });
    if (rawReceipt?.aiNaming?.status !== 'complete') {
      queueMaterialNamingJob(noteUid, { userTitle: false });
    }
    return;
  }

  const finalDir = path.join(MATERIAL_FILES_ROOT, noteUid);
  fs.mkdirSync(finalDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const createdPaths = [];
  let snapshotPersisted = false;
  try {
    const appended = additions.map(({ file, hash }, index) => {
      const storedName = `${String(currentAttachments.length + index + 1).padStart(2, '0')}-${hash.slice(0, 10)}-${file.fileName}`;
      const finalPath = path.join(finalDir, storedName);
      const temporaryPath = `${finalPath}.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(temporaryPath, file.buffer, { flag: 'wx' });
      fs.renameSync(temporaryPath, finalPath);
      createdPaths.push(finalPath);
      return {
        id: `material-${hash.slice(0, 24)}`,
        kind: file.kind,
        name: file.fileName,
        mimeType: file.mime,
        size: file.buffer.length,
        filePath: finalPath,
        previewPath: '',
        posterPath: '',
        checksum: `sha256:${hash}`,
        createdAt,
      };
    });
    const attachments = [...currentAttachments, ...appended];
    const nextSnapshot = learningData.updateNote(noteUid, { attachments });
    snapshotPersisted = true;
    recordOperation(attachments, createdAt);
    broadcastLearningData(nextSnapshot);
    sendJson(res, 200, {
      ok: true,
      operationId,
      noteUid,
      attachments,
      learningData: nextSnapshot,
      commitSha: null,
      idempotentReplay: false,
    });
    queueMaterialNamingJob(noteUid, { userTitle: false });
  } catch (error) {
    if (!snapshotPersisted) {
      for (const filePath of createdPaths) {
        try {
          fs.rmSync(filePath, { force: true });
        } catch {
          // Keep the original failure as the actionable error.
        }
      }
    }
    throw error;
  }
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
      const timeoutText = activeAttempt
        ? `；单次最多等待 ${Math.round(activeAttempt.timeoutMs / 1000)} 秒，${activeAttempt.allowFallback === false ? '超时后结束且不切换模型' : '超时会自动切换模型'}`
        : '';
      const budgetText = Number.isFinite(activeAttempt?.maxTokens)
        ? `；完成 Token 预算 ${activeAttempt.maxTokens}`
        : '';
      const reasoningText = activeAttempt?.reasoningMode
        ? `；${activeAttempt.reasoningMode === 'fast' ? '快速推理' : activeAttempt.reasoningMode === 'balanced' ? '均衡推理' : '深度推理'}`
        : '';
      updateCanvasOrganizationJob(projectId, {
        progress: Math.min(76, 40 + Math.floor(elapsedSeconds / 4)),
        message: `${attemptText} 正在分析画布（已用 ${elapsedSeconds} 秒）${timeoutText}${budgetText}${reasoningText}。`,
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
          const phaseText = attempt.phase === 'repair' ? '修复返回格式' : '分析画布';
          updateCanvasOrganizationJob(projectId, {
            progress: Math.max(40, canvasOrganizationJobs.get(projectId)?.progress || 40),
            message: `${attempt.provider}/${attempt.model} 正在${phaseText}；单次最多等待 ${Math.round(attempt.timeoutMs / 1000)} 秒，${attempt.allowFallback === false ? '超时后结束且不切换模型' : '超时会自动切换模型'}${Number.isFinite(attempt.maxTokens) ? `；完成 Token 预算 ${attempt.maxTokens}` : ''}${attempt.reasoningMode ? `；${attempt.reasoningMode === 'fast' ? '快速推理' : attempt.reasoningMode === 'balanced' ? '均衡推理' : '深度推理'}` : ''}。`,
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
      requireExplicitAiAction(req);
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
  if (req.method === 'POST' && pathname === '/search') {
    const payload = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
    if (payload.mode === 'ai') requireExplicitAiAction(req);
    sendJson(res, 200, await searchLearningDocuments(payload));
    return true;
  }
  if (req.method === 'POST' && pathname === '/ai/taxonomy/consolidate') {
    requireExplicitAiAction(req);
    if (!canControlNoteApp(req)) {
      sendJson(res, 403, { ok: false, error: '全局分类整理只能由运行服务的本机发起' });
      return true;
    }
    const result = enqueueTaxonomyConsolidation();
    sendJson(res, 202, { ok: true, accepted: true, ...result });
    return true;
  }
  const aiJobMatch = /^\/ai\/jobs\/([^/]+)$/.exec(pathname);
  if (req.method === 'GET' && aiJobMatch) {
    const job = manualAiJobs.get(decodeURIComponent(aiJobMatch[1]));
    if (!job) {
      sendJson(res, 404, { ok: false, code: 'JOB_NOT_FOUND', error: '找不到这个 AI 任务' });
      return true;
    }
    sendJson(res, 200, { ok: true, job });
    return true;
  }

  if (req.method === 'GET' && pathname === '/learning-data/events') {
    handleLearningEvents(req, res);
    return true;
  }

  if (req.method === 'GET' && pathname === '/learning-data') {
    sendJson(res, 200, learningData.getSnapshot());
    return true;
  }

  if (req.method === 'POST' && pathname === '/learning-data/note-review-actions') {
    const payload = JSON.parse((await readBody(req, 512 * 1024)) || '{}');
    if (!Array.isArray(payload.actions) || payload.actions.length === 0 || payload.actions.length > 100) {
      throw makeReviewError('actions must contain between 1 and 100 review actions', 'INVALID_NOTE_REVIEW_ACTION');
    }
    const releaseOrganizerLock = acquireOrganizerLock(ORGANIZER_LOCK_PATH);
    const results = [];
    let snapshot = learningData.getSnapshot();
    try {
      const recovery = recoverMoves({ notesRoot: NOTES_ROOT, logPath: ORGANIZER_MOVE_LOG_PATH });
      if (recovery.failed > 0) {
        throw makeReviewError('An interrupted note move requires manual review', 'NOTE_MOVE_RECOVERY_FAILED');
      }
      for (const action of payload.actions) {
        const noteUid = typeof action?.noteUid === 'string' ? action.noteUid : '';
        const operationId = typeof action?.operationId === 'string' ? action.operationId : '';
        try {
          const persisted = persistNoteReviewAction(action, snapshot);
          if (persisted.metadata) {
            const currentNote = findLearningNote(snapshot, noteUid);
            const storeAlreadyApplied = persisted.replayed
              && currentNote?.lastReviewOperationId === operationId
              && currentNote?.decisionRevision === persisted.metadata.learning?.decisionRevision;
            if (!storeAlreadyApplied) {
              const currentCards = snapshot.cards
                .filter((card) => card.noteUid === noteUid)
                .map((card) => ({ ...card, sourceFilePath: persisted.metadata.filePath }));
              const cards = Array.isArray(persisted.metadata.learning?.cards)
                ? persisted.metadata.learning.cards
                : currentCards;
              snapshot = learningData.syncNote(persisted.metadata, {
                enrichment: persisted.metadata.learning,
                cards,
              });
            }
          } else {
            const applied = learningData.applyNoteReviewAction(action);
            snapshot = applied.snapshot;
          }
          const note = findLearningNote(snapshot, noteUid);
          results.push({
            noteUid,
            operationId,
            ok: true,
            replayed: persisted.replayed === true,
            durable: persisted.durable === true,
            reviewStatus: note?.reviewStatus,
            decisionRevision: note?.decisionRevision,
          });
        } catch (error) {
          snapshot = learningData.getSnapshot();
          results.push({
            noteUid,
            operationId,
            ok: false,
            durable: false,
            error: error instanceof Error ? error.message : String(error),
            ...(error && typeof error === 'object' && error.code ? { code: error.code } : {}),
            ...(Number.isInteger(error?.actualDecisionRevision) ? {
              actualDecisionRevision: error.actualDecisionRevision,
            } : {}),
            ...(typeof error?.actualProposalId === 'string' ? { actualProposalId: error.actualProposalId } : {}),
          });
        }
      }
    } finally {
      releaseOrganizerLock();
    }
    broadcastLearningData(snapshot);
    const failedResults = results.filter((result) => !result.ok || result.durable !== true);
    const responseStatus = failedResults.length === 0
      ? 200
      : failedResults.every((result) => result.code === 'INVALID_NOTE_REVIEW_ACTION') ? 400
        : failedResults.some((result) => [
            'NOTE_REVIEW_CONFLICT',
            'NOTE_REVIEW_PROPOSAL_CONFLICT',
            'REVIEW_OPERATION_REUSED',
          ].includes(result.code)) ? 409
          : failedResults.every((result) => result.code === 'NOTE_NOT_FOUND') ? 404 : 500;
    sendJson(res, responseStatus, {
      ok: failedResults.length === 0,
      snapshot,
      results,
    });
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
  const noteRenameMatch = /^\/learning-data\/notes\/([^/]+)\/rename$/.exec(pathname);
  if (noteRenameMatch && req.method === 'POST') {
    requireExplicitAiAction(req);
    const payload = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
    const result = enqueueManualAiRename(decodeURIComponent(noteRenameMatch[1]), payload.operationId);
    sendJson(res, 202, { ok: true, accepted: true, ...result });
    return true;
  }
  const noteAnalyzeMatch = /^\/learning-data\/notes\/([^/]+)\/analyze-wrong-reason$/.exec(pathname);
  if (noteAnalyzeMatch && req.method === 'POST') {
    requireExplicitAiAction(req);
    const noteUid = decodeURIComponent(noteAnalyzeMatch[1]);
    const queued = queueNoteEnrichment(noteUid);
    sendJson(res, 202, { ok: true, queued, noteUid });
    return true;
  }
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
    const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {};
    const classificationKeys = ['subject', 'knowledgePath', 'questionType', 'questionTypePath', 'wrongReason', 'wrongReasonPath', 'learningTypePath'];
    const durableEditKeys = [
      ...classificationKeys,
      'title', 'remark', 'tags', 'noteType', 'goodQuestion', 'goodQuestionType',
    ];
    const editsClassification = durableEditKeys.some((key) => Object.hasOwn(patch, key));
    const reviewAction = editsClassification
      ? 'correct'
      : patch.organizationStatus === 'ignored' ? 'ignore'
        : patch.organizationStatus === 'confirmed' ? 'accept' : null;
    let snapshot;
    if (reviewAction) {
      // AI naming immediately queues a one-note organizer pass. A human correction
      // submitted at that moment must wait for the short-lived filesystem lock,
      // rather than surfacing a false 409 conflict to the user.
      const releaseOrganizerLock = await acquireOrganizerLockForHumanAction();
      try {
        snapshot = learningData.getSnapshot();
        if (
          payload.expectedRevision !== undefined
          && Number(payload.expectedRevision) !== snapshot.revision
        ) {
          throw new LearningDataConflictError(payload.expectedRevision, snapshot.revision);
        }
        const action = {
          noteUid,
          action: reviewAction,
          operationId: typeof payload.operationId === 'string' && payload.operationId.trim()
            ? payload.operationId.trim()
            : `legacy-${crypto.randomUUID()}`,
          expectedDecisionRevision: payload.expectedDecisionRevision,
          proposalId: payload.proposalId,
          patch,
        };
        const persisted = persistNoteReviewAction(action, snapshot);
        if (persisted.metadata) {
          const cards = Array.isArray(persisted.metadata.learning?.cards)
            ? persisted.metadata.learning.cards
            : snapshot.cards
              .filter((card) => card.noteUid === noteUid)
              .map((card) => ({ ...card, sourceFilePath: persisted.metadata.filePath }));
          snapshot = learningData.syncNote(persisted.metadata, {
            enrichment: persisted.metadata.learning,
            cards,
          });
        } else {
          snapshot = learningData.applyNoteReviewAction(action).snapshot;
        }
        const remainingPatch = Object.fromEntries(Object.entries(patch).filter(([key]) => (
          !classificationKeys.includes(key) && key !== 'organizationStatus'
        )));
        if (Object.keys(remainingPatch).length > 0) {
          snapshot = learningData.updateNote(noteUid, remainingPatch);
        }
      } finally {
        releaseOrganizerLock();
      }
    } else {
      snapshot = learningData.updateNote(noteUid, patch, {
        expectedRevision: payload.expectedRevision,
      });
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

async function handleReviewSyncRoute(req, res, pathname) {
  if (!pathname.startsWith('/ai/review/')) return false;
  if (!canControlNoteApp(req)) {
    sendJson(res, 403, { ok: false, error: '综合复习同步只能在运行服务的 Windows 主机上操作。' });
    return true;
  }
  if (req.method === 'GET' && pathname === '/ai/review/status') {
    sendJson(res, 200, { ok: true, ...reviewSync.status() });
    return true;
  }
  if (req.method === 'POST' && pathname === '/ai/review/push') {
    const result = reviewSync.startPush();
    sendJson(res, result.accepted ? 202 : 200, { ...result, status: reviewSync.status() });
    return true;
  }
  if (req.method === 'POST' && pathname === '/ai/review/pull') {
    const result = reviewSync.startPull();
    sendJson(res, result.accepted ? 202 : 200, { ...result, status: reviewSync.status() });
    return true;
  }
  if (req.method === 'POST' && pathname === '/ai/review/select-directory') {
    const payload = JSON.parse((await readBody(req, 16 * 1024)) || '{}');
    const selectedPath = await selectWindowsDirectory(payload.initialPath);
    sendJson(res, 200, { ok: true, path: selectedPath, cancelled: !selectedPath });
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
  const earlyRequestUrl = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const earlyRelayMatch = /^\/relay-transfers\/([A-Za-z0-9_-]{20,80})$/.exec(earlyRequestUrl.pathname);
  if (earlyRelayMatch && (req.method === 'GET' || req.method === 'OPTIONS')) {
    if (req.method === 'OPTIONS') {
      sendRelayJson(res, 200, { ok: true });
      return;
    }
    cleanRelayTransfers();
    const transfer = relayTransfers.get(earlyRelayMatch[1]);
    if (!transfer) {
      sendRelayJson(res, 404, {
        ok: false,
        code: 'RELAY_TRANSFER_NOT_FOUND',
        error: '资料接力已过期或尚未登记。',
      });
      return;
    }
    sendRelayJson(res, 200, {
      ok: true,
      protocol: 'kaoyan-material-v1',
      transferId: earlyRelayMatch[1],
      expiresAt: transfer.expiresAt,
      asset: transfer.asset,
    });
    return;
  }

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
  // AI actions use a non-simple header so browsers send a CORS preflight.
  // Keep the preflight contract identical to sendJson(), otherwise the
  // browser blocks semantic search and rename before they reach this server.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kaoyan-AI-Action');

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

    if (await handleReviewSyncRoute(req, res, pathname)) return;
    if (await handleCanvasProjectRoute(req, res, pathname)) return;
    if (await handleLearningDataRoute(req, res, pathname)) return;
    if (await handleOrganizerRoute(req, res, pathname)) return;
    if (handleLocalCaptureJob(req, res, pathname)) return;

    if (req.method === 'POST' && pathname === '/relay-transfers') {
      const payload = JSON.parse((await readBody(req, 32 * 1024)) || '{}');
      const transferId = String(payload.transferId || '');
      if (!RELAY_TRANSFER_ID_PATTERN.test(transferId)) {
        sendJson(res, 400, { ok: false, error: 'Invalid relay transfer ID' });
        return;
      }
      const now = Date.now();
      cleanRelayTransfers(now);
      const asset = normalizeRelayAsset(payload.asset);
      const expiresAt = now + RELAY_TRANSFER_TTL_MS;
      relayTransfers.set(transferId, { asset, createdAt: now, expiresAt });
      sendJson(res, 201, {
        ok: true,
        protocol: 'kaoyan-material-v1',
        transferId,
        expiresAt,
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/html-preview-sessions') {
      const payload = JSON.parse((await readBody(req, 12 * 1024 * 1024)) || '{}');
      const sessionId = createHtmlPreviewSession(payload.html);
      const expiresAt = htmlPreviewSessions.get(sessionId)?.expiresAt || null;
      sendJson(res, 201, {
        ok: true,
        sessionId,
        expiresAt,
        url: `http://127.0.0.1:${PORT}/html-preview-sessions/${sessionId}`,
      });
      return;
    }

    const htmlPreviewMatch = /^\/html-preview-sessions\/([A-Za-z0-9_-]{32})$/.exec(pathname);
    if (req.method === 'DELETE' && htmlPreviewMatch) {
      htmlPreviewSessions.delete(htmlPreviewMatch[1]);
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (req.method === 'GET' && htmlPreviewMatch) {
      cleanHtmlPreviewSessions();
      const session = htmlPreviewSessions.get(htmlPreviewMatch[1]);
      if (!session) {
        sendJson(res, 404, { ok: false, error: 'GeoGebra 兼容预览已过期，请重新打开资料。' });
        return;
      }
      sendHtmlPreviewSession(res, session);
      return;
    }

    if (req.method === 'GET' && pathname === '/note-file') {
      const file = resolveNoteFile(NOTES_ROOT, requestUrl.searchParams.get('path'));
      const stat = fs.statSync(file.filePath);
      const fileName = path.basename(file.filePath);
      const preview = requestUrl.searchParams.get('preview') === '1';
      res.writeHead(200, {
        'Content-Type': file.mime,
        'Content-Length': stat.size,
        'Content-Disposition': noteFileContentDisposition(file, fileName, preview),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        // The desktop UI is served from :5173 while note files are served from
        // :5174. Keep path access restricted by resolveNoteFile and CORS, but
        // allow the image response itself to be embedded by that local UI.
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      fs.createReadStream(file.filePath).pipe(res);
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
      const snapshot = saveAiTaskConfigurations(payload.tasks, payload.usageProtection);
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
        aiHtmlNoteEndpoint: '/ai/html-note',
        htmlPreviewSessionEndpoint: '/html-preview-sessions',
        noteAppEndpoint: '/open-note-app',
        noteAppCloseEndpoint: '/close-note-app',
        canvasProjectsEndpoint: '/canvas-projects',
        canvasProjectsPath: canvasProjects.rootPath,
        learningDataEndpoint: '/learning-data',
        learningDataPath: learningData.filePath,
        organizerEndpoint: '/organizer/status',
        organizer: readOrganizerStatus(),
        reviewSyncEndpoint: '/ai/review/status',
        reviewSync: reviewSync.status(),
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

    if (req.method === 'PUT' && pathname === '/ai/providers') {
      if (!canControlNoteApp(req)) {
        sendJson(res, 403, { ok: false, error: 'AI 厂家密钥只能在运行服务的 Windows 主机上修改。' });
        return;
      }
      const payload = JSON.parse((await readBody(req, 32 * 1024)) || '{}');
      sendJson(res, 200, saveAiProviderCredential(payload));
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

    if (req.method === 'POST' && pathname === '/save-material-note') {
      await handleSaveMaterial(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/append-material-note') {
      await handleAppendMaterial(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/material-window') {
      if (!canControlNoteApp(req)) {
        sendJson(res, 403, { ok: false, error: 'Only the local Kaoyan desktop page can open floating material windows.' });
        return;
      }
      const payload = JSON.parse((await readBody(req, 256 * 1024)) || '{}');
      sendJson(res, 202, await openMaterialPreviewWindow(payload));
      return;
    }

    if (req.method === 'POST' && pathname === '/capture-batches') {
      await handleLocalCaptureBatch(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/save-note-batch') {
      await handleSaveBatch(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/save-note') {
      await handleSave(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/ai/widget') {
      requireExplicitAiAction(req);
      await handleGenerateWidget(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/ai/html-note') {
      requireExplicitAiAction(req);
      await handleGenerateWidget(req, res, 'interactive_note_generation');
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
      : ['NOTE_ALREADY_EXISTS', 'CARD_ALREADY_EXISTS', 'NOTE_DELETED', 'SAVE_OPERATION_REUSED'].includes(error?.code) ? 409
      : error?.code === 'CANVAS_AI_ALREADY_RUNNING' ? 409
      : error?.code === 'CANVAS_AI_PROJECT_NOT_FOUND' ? 404
      : error?.code === 'CANVAS_AI_EMPTY' ? 400
      : ['INVALID_LEARNING_NOTE', 'INVALID_LEARNING_CARD', 'INVALID_MATERIAL_NOTE'].includes(error?.code) ? 400
      : error?.code === 'INVALID_NOTE_REVIEW_ACTION' ? 400
      : ['NOTE_REVIEW_CONFLICT', 'NOTE_REVIEW_PROPOSAL_CONFLICT', 'REVIEW_OPERATION_REUSED', 'ORGANIZER_LOCKED'].includes(error?.code) ? 409
      : error?.code === 'LEARNING_DATA_BUSY' ? 503
      : error?.code === 'NOTE_PATH_FORBIDDEN' ? 403
      : error?.code === 'NOTE_FILE_NOT_FOUND' ? 404
      : error?.code === 'PAYLOAD_TOO_LARGE' ? 413
      : error?.code === 'NOTE_FILE_UNSUPPORTED' ? 415
      : error?.code === 'NOTE_REVEAL_UNSUPPORTED' ? 501
      : error?.code === 'NOTE_REVEAL_LAUNCH_FAILED' ? 503
      : error?.code === 'AI_EXPLICIT_ACTION_REQUIRED' ? 409
      : error?.code === 'AI_TASK_DISABLED' ? 403
      : error?.code === 'AI_DAILY_REQUEST_LIMIT' ? 429
      : (error?.code === 'AI_TIMEOUT' || error?.code === 'AI_OVERALL_TIMEOUT') ? 504
      : error?.code === 'AI_NO_PROVIDER' ? 503
      : error?.code === 'AI_ALL_PROVIDERS_FAILED' ? 502
      : error?.code === 'AI_HTML_VALIDATION_FAILED' ? 422
      : error?.code === 'HTML_PREVIEW_PROFILE_INVALID' ? 400
      : error?.code === 'NOTE_NOT_FOUND' ? 404
      : error?.code === 'CARD_NOT_FOUND' ? 404 : 500;
    sendJson(res, status, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(error && typeof error === 'object' && 'code' in error ? { code: error.code } : {}),
      ...(error && typeof error === 'object' && 'requestId' in error ? { requestId: error.requestId } : {}),
      ...(error instanceof CanvasDocumentValidationError ? { issues: error.issues } : {}),
      ...(error instanceof LearningDataConflictError ? {
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision,
      } : {}),
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  concealExistingInternalDirectories();
  reviewSync.start();
  console.log(`Kaoyan note server running at http://127.0.0.1:${PORT}`);
  console.log(`Notes root: ${NOTES_ROOT}`);
  console.log(`Assistant root: ${ASSISTANT_ROOT}`);
  console.log(`Layout file: ${LAYOUT_PATH}`);
  console.log(`Canvas projects: ${canvasProjects.rootPath}`);
  console.log(`Metadata placement: subject/.metadata`);
  console.log(`AI widget endpoint: http://127.0.0.1:${PORT}/ai/widget`);
  console.log(`AI HTML note endpoint: http://127.0.0.1:${PORT}/ai/html-note`);
  console.log(`Learning data endpoint: http://127.0.0.1:${PORT}/learning-data`);
  console.log(`Organizer status: http://127.0.0.1:${PORT}/organizer/status`);
  console.log(`Review sync status: http://127.0.0.1:${PORT}/ai/review/status`);
  console.log(`Note app endpoint: http://127.0.0.1:${PORT}/open-note-app`);
  console.log(`Note app close endpoint: http://127.0.0.1:${PORT}/close-note-app`);
  console.log('LAN app proxy: enabled without device authentication (canvas and learning-data routes)');
  console.log(`Qwen: ${qwen.apiKey ? `enabled (${qwen.model})` : `disabled, configPath=${qwen.configPath}`}`);
  const currentRouter = getAiRouter();
  console.log(`AI router providers: ${currentRouter ? currentRouter.getStatus().providers.filter((provider) => provider.enabled).map((provider) => provider.id).join(', ') || 'none' : `unavailable (${aiRouterInitError})`}`);
  console.log('AI startup scans are disabled; only newly saved notes and explicit user actions may run AI.');
});

module.exports = {
  server,
  async close() {
    reviewSync.stop();
    server.closeAllConnections?.();
    if (!server.listening) return;
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  },
};
