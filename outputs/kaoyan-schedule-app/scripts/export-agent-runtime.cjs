const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  AI_TASK_DEFINITIONS,
  PROVIDER_MODEL_CATALOG,
  TASK_PARAMETER_DEFINITIONS,
  TASK_PROFILES,
  normalizeNamingRules,
  normalizeTaskConfigurations,
  resolveTaskOptions,
} = require('./ai-router.cjs');

const SECRET_REFS = Object.freeze({
  qwen: 'QWEN_API_KEY',
  gemini: 'GEMINI_API_KEY',
  kimi: 'KIMI_API_KEY',
});

const CONFIG_FILES = new Set([
  'ai-providers.json',
  'qwen-config.json',
  'note-taxonomy.json',
  'desktop-layout.json',
]);

const DATA_PATTERNS = [
  /^learning-data\.json$/i,
  /^canvas-projects\//i,
];
const RUNTIME_PATTERNS = [
  /^note-save-receipts\//i,
  /^review-github-sync\//i,
  /^note-organizer-state\.json$/i,
];
const BACKUP_PATTERNS = [
  /^repair-backups\//i,
  /(?:^|\.)pre-rebuild-/i,
  /^canvas-projects\/\.trash\//i,
];
const SENSITIVE_NAME = /(?:^|[_-])(?:api.?key|token|secret|password|passwd|authorization|cookie|private.?key|client.?secret|credential)(?:$|[_-])/i;
const ABSOLUTE_WINDOWS_PATH = /^[A-Za-z]:\\/;
const LOCAL_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
    result[key] = value;
  }
  return result;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function stableJson(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return parsed && typeof parsed === 'object' ? parsed : fallback;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const next = stableJson(value);
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === next) return false;
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, next, 'utf8');
  fs.renameSync(temporary, filePath);
  return true;
}

function relativeUnix(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function listJsonFiles(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) result.push(fullPath);
    }
  };
  visit(root);
  return result.sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function classify(relativePath) {
  if (BACKUP_PATTERNS.some((pattern) => pattern.test(relativePath))) return 'backup';
  if (RUNTIME_PATTERNS.some((pattern) => pattern.test(relativePath))) return 'runtime-state';
  if (DATA_PATTERNS.some((pattern) => pattern.test(relativePath))) return 'user-data';
  if (CONFIG_FILES.has(relativePath)) return relativePath === 'desktop-layout.json' ? 'ui-setting' : 'agent-config';
  if (!relativePath.includes('/')) return 'unclassified-root-config';
  return 'unclassified';
}

function providerSecretRef(providerId) {
  return SECRET_REFS[String(providerId || '').toLowerCase()] || `${String(providerId || 'PROVIDER').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

function sanitizeString(value, report) {
  let result = String(value);
  result = result.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, () => {
    report.redactedValues += 1;
    return 'Bearer __SECRET__';
  });
  result = result.replace(/\b(?:sk-|ghp_|github_pat_|AIza)[A-Za-z0-9_-]{10,}\b/g, () => {
    report.redactedValues += 1;
    return '__SECRET__';
  });
  if (ABSOLUTE_WINDOWS_PATH.test(result)) {
    report.localPaths += 1;
    return '__LOCAL_PATH__';
  }
  if (LOCAL_URL.test(result)) {
    report.localUrls += 1;
    return '__LOCAL_ONLY_URL__';
  }
  return result;
}

function sanitizeValue(value, report, context = {}) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeString(value, report);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, report, context));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_NAME.test(key)) {
      report.redactedFields += 1;
      const ref = context.providerId ? providerSecretRef(context.providerId) : `LOCAL_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
      result[key] = `__SECRET_REF:${ref}__`;
      continue;
    }
    const childContext = key === 'providers' ? context : { ...context };
    result[key] = sanitizeValue(item, report, childContext);
  }
  return result;
}

function sanitizeProviders(value, report) {
  if (!value || typeof value !== 'object') return {};
  const entries = Array.isArray(value)
    ? value.map((provider) => [provider?.id, provider])
    : Object.entries(value);
  const result = {};
  for (const [rawId, rawProvider] of entries) {
    const id = String(rawId || rawProvider?.id || '').trim().toLowerCase();
    if (!id || !rawProvider || typeof rawProvider !== 'object') continue;
    const sanitized = sanitizeValue(rawProvider, report, { providerId: id });
    delete sanitized.apiKey;
    delete sanitized.token;
    delete sanitized.authorization;
    result[id] = {
      ...sanitized,
      id,
      secretRef: providerSecretRef(id),
      cloudUsable: typeof sanitized.baseUrl === 'string' && sanitized.baseUrl !== '__LOCAL_ONLY_URL__',
    };
  }
  return result;
}

function fileRecord(root, filePath) {
  const bytes = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    path: relativeUnix(root, filePath),
    bytes: bytes.length,
    sha256: sha256(bytes),
    modifiedAt: stat.mtime.toISOString(),
  };
}

function workflowSourceRecords() {
  const names = [
    'ai-router.cjs',
    'note-ai-analyzer.cjs',
    'canvas-ai-organizer.cjs',
    'review-github-sync.cjs',
    'note-server.cjs',
  ];
  return names.map((name) => path.join(__dirname, name)).filter(fs.existsSync).map((filePath) => {
    const bytes = fs.readFileSync(filePath);
    return { path: path.basename(filePath), bytes: bytes.length, sha256: sha256(bytes) };
  });
}

function buildTaskContracts(configuredTasks) {
  const normalized = normalizeTaskConfigurations(configuredTasks || {});
  return Object.fromEntries(Object.entries(AI_TASK_DEFINITIONS).map(([taskId, definition]) => {
    const settings = normalized[taskId] || {};
    const profile = TASK_PROFILES[taskId] || TASK_PROFILES.custom;
    return [taskId, {
      id: taskId,
      label: definition.label,
      description: definition.description,
      active: definition.active === true,
      defaultTimeoutMs: Number(definition.defaultTimeoutMs) || null,
      profile: {
        difficulty: profile.difficulty,
        capabilities: [...profile.capabilities],
      },
      parameterDefinitions: (TASK_PARAMETER_DEFINITIONS[taskId] || []).map((parameter) => ({
        ...parameter,
        ...(Array.isArray(parameter.options) ? { options: parameter.options.map((option) => ({ ...option })) } : {}),
      })),
      settings: {
        ...settings,
        ...(taskId === 'note_naming' ? { namingRules: normalizeNamingRules(settings.namingRules) } : {}),
        options: resolveTaskOptions(taskId, settings),
      },
    }];
  }));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const assistantRoot = path.resolve(String(args['assistant-root'] || process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手')));
  const outputRoot = path.resolve(String(args['output-root'] || path.join(assistantRoot, '.agent-runtime-export')));
  const allJson = listJsonFiles(assistantRoot);
  const includedClasses = new Set(['agent-config', 'ui-setting', 'unclassified-root-config']);
  const report = { redactedFields: 0, redactedValues: 0, localPaths: 0, localUrls: 0 };
  const manifestFiles = [];
  const safeFilesRoot = path.join(outputRoot, 'files');

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(safeFilesRoot, { recursive: true });

  for (const filePath of allJson) {
    const relativePath = relativeUnix(assistantRoot, filePath);
    const category = classify(relativePath);
    const record = { ...fileRecord(assistantRoot, filePath), category, included: includedClasses.has(category) };
    manifestFiles.push(record);
    if (!record.included) continue;
    const parsed = readJson(filePath, {});
    const sanitized = relativePath === 'ai-providers.json'
      ? { ...sanitizeValue(parsed, report), providers: sanitizeProviders(parsed.providers, report) }
      : sanitizeValue(parsed, report);
    writeJson(path.join(safeFilesRoot, relativePath), sanitized);
  }

  const aiConfig = readJson(path.join(assistantRoot, 'ai-providers.json'), {});
  const legacyQwen = readJson(path.join(assistantRoot, 'qwen-config.json'), {});
  const providerReport = { redactedFields: 0, redactedValues: 0, localPaths: 0, localUrls: 0 };
  const providers = sanitizeProviders(aiConfig.providers || {}, providerReport);
  if (!providers.qwen) {
    providers.qwen = {
      id: 'qwen',
      enabled: true,
      model: String(legacyQwen.model || 'qwen-vl-plus'),
      baseUrl: LOCAL_URL.test(String(legacyQwen.baseUrl || '')) ? '__LOCAL_ONLY_URL__' : String(legacyQwen.baseUrl || ''),
      secretRef: 'QWEN_API_KEY',
      cloudUsable: Boolean(legacyQwen.baseUrl) && !LOCAL_URL.test(String(legacyQwen.baseUrl || '')),
      models: [{ id: String(legacyQwen.model || 'qwen-vl-plus') }],
    };
  }
  for (const [providerId, catalog] of Object.entries(PROVIDER_MODEL_CATALOG)) {
    if (!providers[providerId]) continue;
    providers[providerId].catalog = [...catalog];
  }

  const taskContracts = buildTaskContracts(aiConfig.tasks);
  const workflowSources = workflowSourceRecords();
  const workflowHash = sha256(stableJson({ taskContracts, workflowSources }));
  const includedRecords = manifestFiles.filter((file) => file.included);
  const sourceUpdatedAt = [...includedRecords.map((file) => file.modifiedAt), ...workflowSources.map(() => null)]
    .filter(Boolean).sort().at(-1) || null;

  const runtime = {
    schemaVersion: 2,
    strictMode: true,
    failClosed: true,
    allowBuiltInFallback: false,
    requireLocalWorkflow: true,
    source: {
      assistantRoot: '__LOCAL_PATH__',
      updatedAt: sourceUpdatedAt,
      configurationHash: sha256(stableJson(includedRecords.map(({ path: filePath, sha256: hash }) => ({ path: filePath, sha256: hash })))),
      workflowHash,
      workflowSources,
    },
    providers,
    routing: sanitizeValue(aiConfig.routing || {}, report),
    tasks: taskContracts,
  };

  const manifest = {
    schemaVersion: 2,
    sourceRoot: '__LOCAL_PATH__',
    generatedFromJsonFiles: allJson.length,
    includedFiles: includedRecords.length,
    excludedFiles: manifestFiles.length - includedRecords.length,
    categories: Object.fromEntries([...new Set(manifestFiles.map((file) => file.category))].sort().map((category) => [category, manifestFiles.filter((file) => file.category === category).length])),
    redaction: {
      redactedFields: report.redactedFields + providerReport.redactedFields,
      redactedValues: report.redactedValues + providerReport.redactedValues,
      localPaths: report.localPaths + providerReport.localPaths,
      localUrls: report.localUrls + providerReport.localUrls,
    },
    runtimeHash: sha256(stableJson(runtime)),
    files: manifestFiles,
  };

  writeJson(path.join(outputRoot, 'agent-runtime.json'), runtime);
  writeJson(path.join(outputRoot, 'manifest.json'), manifest);
  process.stdout.write(`${JSON.stringify({ ok: true, outputRoot, runtimeHash: manifest.runtimeHash, includedFiles: manifest.includedFiles, excludedFiles: manifest.excludedFiles })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildTaskContracts,
  classify,
  providerSecretRef,
  sanitizeProviders,
  sanitizeValue,
};
