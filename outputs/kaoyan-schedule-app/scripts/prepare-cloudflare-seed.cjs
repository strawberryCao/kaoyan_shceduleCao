const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_ASSISTANT_ROOT = path.join(os.homedir(), 'Desktop', '考研桌面助手');
const DEFAULT_OUTPUT_ROOT = path.resolve(process.cwd(), 'cloudflare', '.seed');
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|file:\/\/[A-Za-z]:[\\/])/i;
const CANVAS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SAFE_ASSET_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.heic', '.heif', '.jpeg', '.jpg', '.pdf', '.png',
  '.svg', '.tif', '.tiff', '.webp',
]);
const CONTENT_TYPES = Object.freeze({
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
});
const SENSITIVE_FILE_NAMES = new Set([
  '.env', 'ai-providers.json', 'qwen-config.json', 'credentials.json',
]);
const SENSITIVE_KEYS = new Set([
  'apikey', 'apitoken', 'accesstoken', 'refreshtoken', 'authorization',
  'bearertoken', 'clientsecret', 'credentials', 'password', 'privatekey',
  'secret', 'secretkey',
]);

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function contentTypeForKey(r2Key) {
  // SVG is deliberately served as a download, not executable active image content.
  return CONTENT_TYPES[path.posix.extname(r2Key).toLowerCase()] || 'application/octet-stream';
}

function readJson(filePath, label) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${label}: ${error.message}`);
  }
  try {
    return JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Unable to parse ${label}: ${error.message}`);
  }
}

function normalizeSensitiveKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(normalizeSensitiveKey(key));
}

function looksSensitiveFile(filePath) {
  const baseName = path.basename(filePath).toLowerCase();
  if (SENSITIVE_FILE_NAMES.has(baseName)) return true;
  return /(?:^|[._-])(?:api[-_]?key|credential|private[-_]?key|secret|token|密钥)(?:[._-]|$)/iu.test(baseName)
    || baseName.startsWith('ai-providers.')
    || baseName.startsWith('qwen-config.');
}

function looksLikeWindowsAbsolutePath(value) {
  return typeof value === 'string' && WINDOWS_ABSOLUTE_PATH.test(value.trim());
}

function assertSafeOutputRoot(outputRoot, assistantRoot) {
  const resolvedOutput = path.resolve(outputRoot);
  const resolvedAssistant = path.resolve(assistantRoot);
  const parsed = path.parse(resolvedOutput);
  if (resolvedOutput === parsed.root) {
    throw new Error('Refusing to use a filesystem root as the seed output');
  }
  if (
    resolvedOutput === resolvedAssistant
    || resolvedAssistant.startsWith(`${resolvedOutput}${path.sep}`)
  ) {
    throw new Error('Seed output cannot replace or contain the assistant data root');
  }
  return resolvedOutput;
}

function canvasSummary(document) {
  const count = (field) => (Array.isArray(document?.[field]) ? document[field].length : 0);
  return {
    imageCount: count('images') + count('nodes'),
    textCount: count('texts'),
    annotationCount: count('annotations'),
    relationCount: count('relations'),
    strokeCount: count('strokes'),
    groupCount: count('groups'),
  };
}

function createStagingRoot(outputRoot) {
  const parent = path.dirname(outputRoot);
  const base = path.basename(outputRoot);
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, `.${base}.prepare-${process.pid}-`));
}

function installStagingRoot(stagingRoot, outputRoot) {
  const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const backupRoot = `${outputRoot}.previous-${suffix}`;
  let movedPrevious = false;
  try {
    if (fs.existsSync(outputRoot)) {
      fs.renameSync(outputRoot, backupRoot);
      movedPrevious = true;
    }
    fs.renameSync(stagingRoot, outputRoot);
    if (movedPrevious) fs.rmSync(backupRoot, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(outputRoot) && movedPrevious && fs.existsSync(backupRoot)) {
      try { fs.renameSync(backupRoot, outputRoot); } catch {}
    }
    throw error;
  } finally {
    if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function prepareCloudflareSeed(options = {}) {
  const assistantRoot = path.resolve(options.assistantRoot || DEFAULT_ASSISTANT_ROOT);
  const outputRoot = assertSafeOutputRoot(options.outputRoot || DEFAULT_OUTPUT_ROOT, assistantRoot);
  const learningDataPath = path.join(assistantRoot, 'learning-data.json');
  const canvasProjectsRoot = path.join(assistantRoot, 'canvas-projects');
  const learningData = readJson(learningDataPath, 'learning-data.json');
  const stagingRoot = createStagingRoot(outputRoot);
  const objectsRoot = path.join(stagingRoot, 'objects');
  const fileRecords = [];
  const objectKeys = new Set();
  const sourceAssetCache = new Map();
  const counters = {
    rewrittenAssetReferences: 0,
    missingAssetReferences: 0,
    blockedAssetReferences: 0,
  };

  function writeObject(r2Key, content, kind) {
    if (objectKeys.has(r2Key)) return;
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const destination = path.join(objectsRoot, ...r2Key.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    objectKeys.add(r2Key);
    fileRecords.push({
      r2Key,
      kind,
      contentType: contentTypeForKey(r2Key),
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }

  function migrateAssetReference(rawPath) {
    if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.startsWith('r2://')) {
      counters.missingAssetReferences += 1;
      return '';
    }
    const sourcePath = path.isAbsolute(rawPath)
      ? path.normalize(rawPath)
      : path.resolve(assistantRoot, rawPath);
    if (sourceAssetCache.has(sourcePath)) {
      const cached = sourceAssetCache.get(sourcePath);
      counters[cached.status] += 1;
      return cached.uri;
    }

    const extension = path.extname(sourcePath).toLowerCase();
    if (!SAFE_ASSET_EXTENSIONS.has(extension) || looksSensitiveFile(sourcePath)) {
      const result = { uri: '', status: 'blockedAssetReferences' };
      sourceAssetCache.set(sourcePath, result);
      counters[result.status] += 1;
      return result.uri;
    }

    let stat;
    let realPath;
    try {
      stat = fs.statSync(sourcePath);
      realPath = fs.realpathSync(sourcePath);
    } catch {
      const result = { uri: '', status: 'missingAssetReferences' };
      sourceAssetCache.set(sourcePath, result);
      counters[result.status] += 1;
      return result.uri;
    }
    if (!stat.isFile() || looksSensitiveFile(realPath)) {
      const result = { uri: '', status: 'blockedAssetReferences' };
      sourceAssetCache.set(sourcePath, result);
      counters[result.status] += 1;
      return result.uri;
    }

    const content = fs.readFileSync(realPath);
    const objectName = `${sha256(content)}${extension}`;
    const r2Key = `note-assets/${objectName}`;
    writeObject(r2Key, content, 'note-asset');
    const result = { uri: `r2://${r2Key}`, status: 'rewrittenAssetReferences' };
    sourceAssetCache.set(sourcePath, result);
    counters[result.status] += 1;
    return result.uri;
  }

  function sanitize(value, key = '') {
    if (Array.isArray(value)) return value.map((item) => sanitize(item));
    if (value && typeof value === 'object') {
      const result = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        if (isSensitiveKey(childKey)) continue;
        if (childKey === 'filePath' || childKey === 'sourceFilePath') {
          result[childKey] = migrateAssetReference(childValue);
        } else {
          result[childKey] = sanitize(childValue, childKey);
        }
      }
      return result;
    }
    if (typeof value === 'string' && looksLikeWindowsAbsolutePath(value)) return '';
    if (isSensitiveKey(key)) return undefined;
    return value;
  }

  try {
    const sanitizedLearningData = sanitize(learningData);
    writeObject('bootstrap/learning-data.json', jsonBytes(sanitizedLearningData), 'bootstrap');

    const canvasIndex = [];
    if (fs.existsSync(canvasProjectsRoot)) {
      const entries = fs.readdirSync(canvasProjectsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== '.trash')
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (!CANVAS_ID_PATTERN.test(entry.name) || entry.name === '.' || entry.name === '..') continue;
        const sourcePath = path.join(canvasProjectsRoot, entry.name, 'document.json');
        if (!fs.existsSync(sourcePath)) continue;
        const document = readJson(sourcePath, `canvas ${entry.name}`);
        if (!document || typeof document !== 'object' || Array.isArray(document)) {
          throw new Error(`Canvas ${entry.name} document must be an object`);
        }
        const sanitizedDocument = sanitize(document);
        const canvasBytes = jsonBytes(sanitizedDocument);
        const r2Key = `bootstrap/canvases/${entry.name}/${sha256(canvasBytes)}.json`;
        writeObject(r2Key, canvasBytes, 'canvas');
        const revisionCandidate = Number.isInteger(document.syncRevision)
          ? document.syncRevision
          : document.revision;
        canvasIndex.push({
          id: entry.name,
          title: typeof document.title === 'string' ? document.title : '',
          revision: Number.isInteger(revisionCandidate) && revisionCandidate >= 0
            ? revisionCandidate
            : 0,
          r2Key,
          updatedAt: typeof document.updatedAt === 'string' ? document.updatedAt : null,
          summary: canvasSummary(document),
        });
      }
    }
    writeObject('bootstrap/canvas-index.json', jsonBytes(canvasIndex), 'bootstrap');

    fileRecords.sort((left, right) => left.r2Key.localeCompare(right.r2Key));
    const sum = (records) => records.reduce((total, record) => total + record.bytes, 0);
    const byKind = (kind) => fileRecords.filter((record) => record.kind === kind);
    const noteAssets = byKind('note-asset');
    const canvases = byKind('canvas');
    const bootstrap = byKind('bootstrap');
    const reconciliationInput = fileRecords
      .map((record) => `${record.r2Key}\0${record.sha256}\0${record.bytes}`)
      .join('\n');
    const manifest = {
      version: 1,
      algorithm: 'sha256',
      files: fileRecords,
      totals: {
        objectCount: fileRecords.length,
        objectBytes: sum(fileRecords),
        bootstrapCount: bootstrap.length,
        bootstrapBytes: sum(bootstrap),
        noteAssetCount: noteAssets.length,
        noteAssetBytes: sum(noteAssets),
        canvasCount: canvases.length,
        canvasBytes: sum(canvases),
        ...counters,
      },
      contentSha256: sha256(Buffer.from(reconciliationInput, 'utf8')),
    };
    fs.writeFileSync(path.join(stagingRoot, 'manifest.json'), jsonBytes(manifest));
    installStagingRoot(stagingRoot, outputRoot);
    return { assistantRoot, outputRoot, manifest, canvasIndex };
  } catch (error) {
    if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function readFlag(argv, name) {
  const prefix = `--${name}=`;
  const inline = argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
}

function parseCliOptions(argv = process.argv.slice(2)) {
  const assistantRoot = readFlag(argv, 'assistant-root');
  const outputRoot = readFlag(argv, 'output') || readFlag(argv, 'output-root');
  return { assistantRoot, outputRoot };
}

function runCli() {
  try {
    const result = prepareCloudflareSeed(parseCliOptions());
    const totals = result.manifest.totals;
    console.log(`Cloudflare seed ready: ${result.outputRoot}`);
    console.log(`Objects: ${totals.objectCount}; assets: ${totals.noteAssetCount}; canvases: ${totals.canvasCount}`);
    if (totals.missingAssetReferences || totals.blockedAssetReferences) {
      console.log(`Cleared unavailable paths: ${totals.missingAssetReferences}; blocked paths: ${totals.blockedAssetReferences}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) runCli();

module.exports = {
  DEFAULT_ASSISTANT_ROOT,
  DEFAULT_OUTPUT_ROOT,
  looksLikeWindowsAbsolutePath,
  parseCliOptions,
  prepareCloudflareSeed,
  sha256,
};
