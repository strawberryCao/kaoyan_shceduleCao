const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { PARSER_VERSION, parseRemark } = require('./remark-parser.cjs');
const {
  atomicWriteJson,
  ensureKnowledgePoint,
  ensureSubject,
  loadTaxonomy,
  resolveKnowledgePoint,
  resolveSubject,
  sanitizeCategoryName,
  saveTaxonomyAtomic,
} = require('./note-taxonomy.cjs');
const { unlinkFileIfExists } = require('./safe-file-ops.cjs');

const ORGANIZER_VERSION = 1;
const NOTE_SCHEMA_VERSION = 2;
const DEFAULT_SUBJECT = '默认文件夹';
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

function safeReadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function ensureInside(root, target, label) {
  if (!isInside(root, target)) throw new Error(`${label} escaped notes root: ${target}`);
  return target;
}

function appendJsonLine(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'a');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeMovePhase(logPath, operationId, phase, details = {}) {
  appendJsonLine(logPath, {
    operationId,
    phase,
    at: new Date().toISOString(),
    ...details,
  });
}

function metadataDirFor(imageDir) {
  return path.join(imageDir, '.metadata');
}

function preferredSidecarPath(imagePath) {
  const parsed = path.parse(imagePath);
  return path.join(metadataDirFor(parsed.dir), `${parsed.name}.note.json`);
}

function imageDirFromSidecar(sidecarPath) {
  const parent = path.dirname(sidecarPath);
  return path.basename(parent) === '.metadata' ? path.dirname(parent) : parent;
}

function listImageCandidates(imageDir, stem) {
  if (!fs.existsSync(imageDir)) return [];
  return fs.readdirSync(imageDir)
    .filter((name) => path.parse(name).name === stem && IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(imageDir, name));
}

function resolveImagePath(metadata, sidecarPath, notesRoot) {
  const imageDir = imageDirFromSidecar(sidecarPath);
  const candidates = [];
  if (typeof metadata?.filePath === 'string' && isInside(notesRoot, metadata.filePath)) {
    candidates.push(metadata.filePath);
  }
  if (typeof metadata?.fileName === 'string') candidates.push(path.join(imageDir, metadata.fileName));
  const sidecarName = path.basename(sidecarPath).replace(/\.note\.json$/i, '');
  candidates.push(...listImageCandidates(imageDir, sidecarName));
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function walkMetadata(notesRoot) {
  const sidecars = [];
  const indexes = [];
  if (!fs.existsSync(notesRoot)) return { sidecars, indexes };

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.metadata') {
          for (const metaEntry of fs.readdirSync(fullPath, { withFileTypes: true })) {
            if (!metaEntry.isFile()) continue;
            const metaPath = path.join(fullPath, metaEntry.name);
            if (metaEntry.name === 'metadata.json') indexes.push(metaPath);
            else if (/\.note\.json$/i.test(metaEntry.name)) sidecars.push(metaPath);
          }
        } else {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (entry.name === 'metadata.json') indexes.push(fullPath);
        else if (/\.note\.json$/i.test(entry.name)) sidecars.push(fullPath);
      }
    }
  }

  walk(notesRoot);
  return { sidecars, indexes };
}

function discoverNotes(notesRoot) {
  const { sidecars, indexes } = walkMetadata(notesRoot);
  const discovered = [];
  const imageKeys = new Set();
  const sidecarKeys = new Set();

  function add(metadata, sidecarPath, fromIndex = false) {
    if (!metadata || typeof metadata !== 'object') return;
    const imagePath = resolveImagePath(metadata, sidecarPath, notesRoot);
    if (!imagePath) return;
    const imageKey = path.resolve(imagePath).toLocaleLowerCase('en-US');
    const sidecarKey = path.resolve(sidecarPath).toLocaleLowerCase('en-US');
    if (imageKeys.has(imageKey) || sidecarKeys.has(sidecarKey)) return;
    imageKeys.add(imageKey);
    sidecarKeys.add(sidecarKey);
    discovered.push({ metadata, sidecarPath, imagePath, fromIndex });
  }

  for (const sidecarPath of sidecars) add(safeReadJson(sidecarPath), sidecarPath, false);

  for (const indexPath of indexes) {
    const list = safeReadJson(indexPath, []);
    if (!Array.isArray(list)) continue;
    const indexDir = path.dirname(indexPath);
    const imageDir = path.basename(indexDir) === '.metadata' ? path.dirname(indexDir) : indexDir;
    for (const metadata of list) {
      const id = String(metadata?.id || path.parse(String(metadata?.fileName || '')).name || '').trim();
      if (!id) continue;
      add(metadata, path.join(metadataDirFor(imageDir), `${id}.note.json`), true);
    }
  }

  return discovered.sort((left, right) => left.imagePath.localeCompare(right.imagePath, 'zh-CN'));
}

function getCurrentCategory(notesRoot, imagePath, metadata) {
  const relativeDir = path.relative(notesRoot, path.dirname(imagePath));
  const segments = relativeDir.split(path.sep).filter(Boolean);
  const storedKnowledgePoint = metadata?.classification?.knowledgePointName
    || (Array.isArray(metadata?.learning?.knowledgePath) ? metadata.learning.knowledgePath[1] : null);
  return {
    subject: sanitizeCategoryName(metadata?.subject || segments[0] || DEFAULT_SUBJECT, DEFAULT_SUBJECT),
    knowledgePoint: storedKnowledgePoint
      ? sanitizeCategoryName(storedKnowledgePoint, '')
      : segments[1] ? sanitizeCategoryName(segments[1], '') : null,
  };
}

function localDateString(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function resolveCaptureDate(metadata, stat) {
  for (const value of [metadata?.capturedAt, metadata?.createdAt]) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = localDateString(value);
    if (date) return date;
  }
  for (const value of [metadata?.captureDate, metadata?.learning?.capturedDate]) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  }
  return localDateString(stat?.mtime) || localDateString(new Date());
}

function normalizeTags(metadata, parsed, analysis) {
  const current = metadata?.tags;
  const manual = Array.isArray(current)
    ? current
    : Array.isArray(current?.manual) ? current.manual : [];
  const existingInferred = !Array.isArray(current) && Array.isArray(current?.inferred) ? current.inferred : [];
  const analysisTags = [
    ...(Array.isArray(analysis?.tags) ? analysis.tags : []),
    ...(analysis?.intent?.isMistake ? ['错题'] : []),
    ...(analysis?.intent?.shouldMemorize ? ['背诵'] : []),
  ];
  const clean = (items) => [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
  return {
    manual: clean(manual),
    explicit: clean(parsed.explicitTags),
    inferred: clean([...existingInferred, ...parsed.inferredTags, ...analysisTags]),
  };
}

function makeInputHash(metadata, imagePath, analyzerVersion) {
  const stat = fs.statSync(imagePath);
  const tags = Array.isArray(metadata?.tags)
    ? metadata.tags
    : Array.isArray(metadata?.tags?.manual) ? metadata.tags.manual : [];
  const payload = {
    organizerVersion: ORGANIZER_VERSION,
    parserVersion: PARSER_VERSION,
    analyzerVersion,
    remark: typeof metadata?.remark === 'string' ? metadata.remark : '',
    manualTags: tags,
    file: { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) },
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function defaultAnalyzeNote(context) {
  return {
    subject: context.currentCategory.subject,
    knowledgePoint: context.currentCategory.knowledgePoint,
    confidence: 1,
    provider: 'local-rules',
    model: null,
    tags: context.parsed.inferredTags,
  };
}
defaultAnalyzeNote.analyzerVersion = 'local-rules-v1';

function cleanAliases(value) {
  return Array.isArray(value)
    ? value.map((item) => sanitizeCategoryName(item, '')).filter(Boolean)
    : [];
}

function normalizeAnalysis(result, fallback) {
  const source = result && typeof result === 'object' ? result : {};
  const confidenceValue = Number(source.confidence);
  const normalizeIntent = (intent) => ({
    isQuestion: intent?.isQuestion === true,
    isMistake: intent?.isMistake === true,
    shouldMemorize: intent?.shouldMemorize === true,
  });
  const intent = normalizeIntent(source.intent);
  const items = Array.isArray(source.items) ? source.items.slice(0, 24).map((item) => ({
    title: typeof item?.title === 'string' ? item.title.trim().slice(0, 120) : '',
    knowledgePoint: typeof item?.knowledgePoint === 'string' ? item.knowledgePoint.trim().slice(0, 60) || null : null,
    questionType: typeof item?.questionType === 'string' ? item.questionType.trim().slice(0, 60) || null : null,
    summary: typeof item?.summary === 'string' ? item.summary.trim().slice(0, 1000) : '',
    tags: Array.isArray(item?.tags) ? item.tags.map(String).map((tag) => tag.trim()).filter(Boolean).slice(0, 20) : [],
    wrongReason: typeof item?.wrongReason === 'string' ? item.wrongReason.trim().slice(0, 500) || null : null,
    intent: normalizeIntent(item?.intent),
  })) : [];
  return {
    subject: sanitizeCategoryName(source.subject || fallback.subject || DEFAULT_SUBJECT, DEFAULT_SUBJECT),
    subjectAliases: cleanAliases(source.subjectAliases),
    knowledgePoint: source.knowledgePoint
      ? sanitizeCategoryName(source.knowledgePoint, '')
      : source.clearKnowledgePoint === true ? null : fallback.knowledgePoint,
    knowledgePointAliases: cleanAliases(source.knowledgePointAliases),
    clearKnowledgePoint: source.clearKnowledgePoint === true,
    confidence: Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 0.5,
    title: typeof source.title === 'string' ? source.title.trim().slice(0, 120) : null,
    summary: typeof source.summary === 'string' ? source.summary.trim().slice(0, 2000) : null,
    tags: Array.isArray(source.tags) ? source.tags.map(String) : [],
    questionType: typeof source.questionType === 'string' ? source.questionType.trim().slice(0, 60) || null : null,
    wrongReason: typeof source.wrongReason === 'string' ? source.wrongReason.trim().slice(0, 500) : null,
    memoryCard: source.memoryCard && typeof source.memoryCard === 'object' ? source.memoryCard : null,
    cards: Array.isArray(source.cards) ? source.cards.filter((card) => card && typeof card === 'object') : [],
    intent,
    items,
    provider: typeof source.provider === 'string' ? source.provider : null,
    model: typeof source.model === 'string' ? source.model : null,
    reason: typeof source.reason === 'string' ? source.reason.trim().slice(0, 1000) : null,
  };
}

function ensureUniqueDestination(directory, fileName, sourcePath) {
  const parsed = path.parse(fileName);
  let candidate = path.join(directory, fileName);
  if (path.resolve(candidate) === path.resolve(sourcePath) || !fs.existsSync(candidate)) return candidate;
  let counter = 2;
  do {
    candidate = path.join(directory, `${parsed.name}_${counter}${parsed.ext}`);
    counter += 1;
  } while (fs.existsSync(candidate));
  return candidate;
}

function collectDirectoryMetadata(directory) {
  const candidates = [];
  const metadataDir = metadataDirFor(directory);
  if (fs.existsSync(metadataDir)) {
    for (const name of fs.readdirSync(metadataDir)) {
      if (/\.note\.json$/i.test(name)) candidates.push(path.join(metadataDir, name));
    }
  }
  if (fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory)) {
      if (/\.note\.json$/i.test(name)) candidates.push(path.join(directory, name));
    }
  }
  const byUid = new Map();
  for (const sidecar of candidates) {
    const metadata = safeReadJson(sidecar);
    if (!metadata || typeof metadata !== 'object') continue;
    const key = metadata.noteUid || metadata.id || metadata.fileName || sidecar;
    byUid.set(String(key), metadata);
  }
  return [...byUid.values()].sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
}

function rebuildMetadataIndex(directory) {
  if (!directory || !fs.existsSync(directory)) return;
  const list = collectDirectoryMetadata(directory);
  atomicWriteJson(path.join(metadataDirFor(directory), 'metadata.json'), list);
}

function removeSourceDirectoryWhenMetadataOnly(directory) {
  if (!directory || !fs.existsSync(directory)) return false;
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.name !== '.metadata')) return false;
  const metaDir = metadataDirFor(directory);
  if (fs.existsSync(metaDir)) {
    const metadataEntries = fs.readdirSync(metaDir, { withFileTypes: true });
    if (metadataEntries.some((entry) => !entry.isFile() || entry.name !== 'metadata.json')) return false;
    const metadataIndexPath = path.join(metaDir, 'metadata.json');
    unlinkFileIfExists(metadataIndexPath);
    if (fs.readdirSync(metaDir).length === 0) fs.rmdirSync(metaDir);
  }
  if (fs.readdirSync(directory).length === 0) {
    fs.rmdirSync(directory);
    return true;
  }
  return false;
}

function moveWithJournal({ notesRoot, logPath, imagePath, sidecarPath, destinationDir, metadata }) {
  ensureInside(notesRoot, imagePath, 'source image');
  ensureInside(notesRoot, destinationDir, 'destination directory');
  fs.mkdirSync(destinationDir, { recursive: true });
  const destinationImage = ensureUniqueDestination(destinationDir, path.basename(imagePath), imagePath);
  const destinationSidecar = preferredSidecarPath(destinationImage);
  const sourceDir = path.dirname(imagePath);

  if (path.resolve(destinationImage) === path.resolve(imagePath)) {
    atomicWriteJson(sidecarPath, metadata);
    rebuildMetadataIndex(sourceDir);
    return { imagePath, sidecarPath, metadata, moved: false };
  }

  const operationId = crypto.randomUUID();
  const planned = {
    noteUid: metadata.noteUid,
    sourceImage: imagePath,
    destinationImage,
    sourceSidecar: sidecarPath,
    destinationSidecar,
    sourceDir,
    destinationDir,
  };
  writeMovePhase(logPath, operationId, 'planned', planned);

  fs.renameSync(imagePath, destinationImage);
  writeMovePhase(logPath, operationId, 'image_moved');

  const parsedDestination = path.parse(destinationImage);
  const movedMetadata = {
    ...metadata,
    id: parsedDestination.name,
    fileName: parsedDestination.base,
    filePath: destinationImage,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(destinationSidecar, movedMetadata);
  writeMovePhase(logPath, operationId, 'sidecar_written');

  if (path.resolve(sidecarPath) !== path.resolve(destinationSidecar) && fs.existsSync(sidecarPath)) {
    unlinkFileIfExists(sidecarPath);
  }
  writeMovePhase(logPath, operationId, 'source_sidecar_removed');
  if (!removeSourceDirectoryWhenMetadataOnly(sourceDir)) rebuildMetadataIndex(sourceDir);
  rebuildMetadataIndex(destinationDir);
  writeMovePhase(logPath, operationId, 'completed');
  return { imagePath: destinationImage, sidecarPath: destinationSidecar, metadata: movedMetadata, moved: true };
}

function readMoveOperations(logPath) {
  if (!fs.existsSync(logPath)) return new Map();
  const operations = new Map();
  for (const line of fs.readFileSync(logPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event?.operationId) continue;
    const current = operations.get(event.operationId) || { events: [], planned: null, lastPhase: null };
    current.events.push(event);
    if (event.phase === 'planned') current.planned = event;
    current.lastPhase = event.phase;
    operations.set(event.operationId, current);
  }
  return operations;
}

function recoverMoves({ notesRoot, logPath, logger = () => {} }) {
  let recovered = 0;
  let failed = 0;
  for (const [operationId, operation] of readMoveOperations(logPath)) {
    if (['completed', 'recovery_failed', 'rolled_back'].includes(operation.lastPhase) || !operation.planned) continue;
    const plan = operation.planned;
    try {
      for (const target of [plan.sourceImage, plan.destinationImage, plan.sourceSidecar, plan.destinationSidecar]) {
        ensureInside(notesRoot, target, 'move journal path');
      }
      const sourceExists = fs.existsSync(plan.sourceImage);
      const destinationExists = fs.existsSync(plan.destinationImage);
      if (sourceExists && destinationExists) throw new Error('source and destination images both exist; manual review required');
      if (!sourceExists && !destinationExists) throw new Error('source and destination images are both missing');

      fs.mkdirSync(plan.destinationDir, { recursive: true });
      if (sourceExists) {
        fs.renameSync(plan.sourceImage, plan.destinationImage);
        writeMovePhase(logPath, operationId, 'recovered_image_moved');
      }

      const metadata = safeReadJson(plan.destinationSidecar, safeReadJson(plan.sourceSidecar, {}));
      const parsedDestination = path.parse(plan.destinationImage);
      const recoveredMetadata = {
        ...metadata,
        noteUid: metadata.noteUid || plan.noteUid || crypto.randomUUID(),
        id: parsedDestination.name,
        fileName: parsedDestination.base,
        filePath: plan.destinationImage,
        updatedAt: new Date().toISOString(),
        organizer: {
          ...(metadata.organizer || {}),
          recovery: { recoveredAt: new Date().toISOString(), operationId },
        },
      };
      atomicWriteJson(plan.destinationSidecar, recoveredMetadata);
      if (path.resolve(plan.sourceSidecar) !== path.resolve(plan.destinationSidecar) && fs.existsSync(plan.sourceSidecar)) {
        unlinkFileIfExists(plan.sourceSidecar);
      }
      if (!removeSourceDirectoryWhenMetadataOnly(plan.sourceDir)) rebuildMetadataIndex(plan.sourceDir);
      rebuildMetadataIndex(plan.destinationDir);
      writeMovePhase(logPath, operationId, 'completed', { recovered: true });
      recovered += 1;
      logger(`RECOVERED ${path.basename(plan.destinationImage)}`);
    } catch (error) {
      failed += 1;
      writeMovePhase(logPath, operationId, 'recovery_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      logger(`RECOVERY FAIL ${operationId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { recovered, failed };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function removeStaleOrganizerLock(lockPath, staleMs = 2 * 60 * 60 * 1000) {
  if (!fs.existsSync(lockPath)) return false;
  const existing = safeReadJson(lockPath, {});
  let lockTime = new Date(existing.startedAt || existing.createdAt || 0).getTime();
  if (!Number.isFinite(lockTime) || lockTime <= 0) {
    try { lockTime = fs.statSync(lockPath).mtimeMs; } catch { lockTime = Date.now(); }
  }
  const age = Math.max(0, Date.now() - lockTime);
  const ownerAlive = isProcessAlive(Number(existing.pid));
  if (ownerAlive && age < staleMs) return false;
  if (!ownerAlive || age >= staleMs) {
    unlinkFileIfExists(lockPath);
    return !fs.existsSync(lockPath);
  }
  return false;
}

function acquireOrganizerLock(lockPath, staleMs = 2 * 60 * 60 * 1000) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  if (fs.existsSync(lockPath)) {
    if (!removeStaleOrganizerLock(lockPath, staleMs)) {
      const error = new Error(`Note organizer is already running (lock: ${lockPath})`);
      error.code = 'ORGANIZER_LOCKED';
      throw error;
    }
  }
  const fd = fs.openSync(lockPath, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return () => unlinkFileIfExists(lockPath);
}

async function loadInjectedAnalyzer(modulePath) {
  if (!modulePath) return defaultAnalyzeNote;
  const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(process.cwd(), modulePath);
  let loaded;
  try {
    loaded = require(resolved);
  } catch (error) {
    if (error?.code !== 'ERR_REQUIRE_ESM') throw error;
    loaded = await import(pathToFileURL(resolved).href);
  }
  const analyzer = loaded.analyzeNote || loaded.default || loaded;
  if (typeof analyzer !== 'function') throw new Error(`Analyzer module must export a function: ${resolved}`);
  return analyzer;
}

function makeLearningPageRefs(parsed) {
  const refs = [];
  for (const pageRef of parsed.pageRefs || []) {
    const pages = parsed.pages.filter((page) => page >= pageRef.start && page <= pageRef.end);
    for (const page of pages) refs.push({ raw: pageRef.raw, page });
  }
  for (const questionRef of parsed.questionRefs || []) {
    refs.push({ raw: questionRef.raw, question: questionRef.number });
  }
  return refs;
}

function combinedIntent(parsed, analysis) {
  return {
    isQuestion: analysis.intent.isQuestion || parsed.questions.length > 0,
    isMistake: analysis.intent.isMistake || parsed.flags.isMistake,
    shouldMemorize: analysis.intent.shouldMemorize || parsed.flags.shouldMemorize,
  };
}

function makeDraftCards(metadata, parsed, analysis, intent, knowledgePath, tags, pageRefs) {
  if (analysis.cards.length > 0) return analysis.cards;
  if (analysis.memoryCard) return [{ ...analysis.memoryCard, sourceKey: analysis.memoryCard.sourceKey || 'ai-memory:0' }];
  const cards = [];
  const back = analysis.summary || metadata.remark || metadata.title || '';
  if (intent.shouldMemorize && back) {
    cards.push({
      sourceKey: 'remark-memory:0',
      kind: 'memory',
      front: metadata.title || '回忆这条笔记的核心内容',
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
      front: metadata.title ? `重做：${metadata.title}` : '重新说明这道错题的正确思路',
      back: analysis.wrongReason || parsed.wrongReasons[0] || back,
      status: 'draft',
      knowledgePath,
      tags,
      pageRefs,
    });
  }
  return cards;
}

function attachLearningEnrichment(metadata, parsed, analysis, subject, knowledgePoint) {
  const tags = [
    ...(metadata.tags?.manual || []),
    ...(metadata.tags?.explicit || []),
    ...(metadata.tags?.inferred || []),
  ];
  const uniqueTags = [...new Set(tags)];
  const knowledgePath = [subject.name, ...(knowledgePoint ? [knowledgePoint.name] : [])];
  const pageRefs = makeLearningPageRefs(parsed);
  const intent = combinedIntent(parsed, analysis);
  if (intent.isMistake && !uniqueTags.includes('错题')) uniqueTags.push('错题');
  if (intent.shouldMemorize && !uniqueTags.includes('背诵')) uniqueTags.push('背诵');
  if (analysis.questionType) {
    const questionTypeTag = `题型:${analysis.questionType}`.slice(0, 40);
    if (!uniqueTags.includes(questionTypeTag)) uniqueTags.push(questionTypeTag);
  }
  if (analysis.wrongReason) {
    const wrongReasonTag = `错因:${analysis.wrongReason}`.slice(0, 40);
    if (!uniqueTags.includes(wrongReasonTag)) uniqueTags.push(wrongReasonTag);
  }
  const noteType = intent.isMistake ? 'mistake' : intent.shouldMemorize ? 'memory' : intent.isQuestion ? 'question' : 'note';
  const cards = makeDraftCards(metadata, parsed, analysis, intent, knowledgePath, uniqueTags, pageRefs);
  metadata.learning = {
    ...(metadata.learning || {}),
    noteUid: metadata.noteUid,
    capturedDate: metadata.captureDate,
    title: metadata.title,
    subject: subject.name,
    pageRefs,
    tags: uniqueTags,
    knowledgePath,
    noteType,
    questionType: analysis.questionType,
    wrongReason: analysis.wrongReason,
    intent,
    items: analysis.items,
    confidence: analysis.confidence,
    cards,
    enrichedAt: new Date().toISOString(),
  };
  return { metadata, cards };
}

function resolveLearningSync(assistantRoot, override) {
  if (override === false) return null;
  if (typeof override === 'function') return override;
  try {
    const learningData = require('./learning-data-store.cjs');
    if (typeof learningData.syncNote === 'function') return learningData.syncNote;
    if (typeof learningData.createLearningDataStore === 'function') {
      const store = learningData.createLearningDataStore({ assistantRoot });
      return (metadata, syncOptions) => store.syncNote(metadata, syncOptions);
    }
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
  }
  return null;
}

async function organizeNotes(options = {}) {
  const notesRoot = path.resolve(options.notesRoot || process.env.KAOYAN_NOTES_ROOT || path.join(os.homedir(), 'Desktop', '笔记'));
  const assistantRoot = path.resolve(options.assistantRoot || process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手'));
  const taxonomyPath = path.resolve(options.taxonomyPath || path.join(assistantRoot, 'note-taxonomy.json'));
  const moveLogPath = path.resolve(options.moveLogPath || path.join(assistantRoot, 'note-organizer-moves.jsonl'));
  const lockPath = path.resolve(options.lockPath || path.join(assistantRoot, 'note-organizer.lock'));
  const statePath = path.resolve(options.statePath || path.join(assistantRoot, 'note-organizer-state.json'));
  const analyzer = options.analyzeNote || defaultAnalyzeNote;
  const analyzerVersion = String(options.analyzerVersion || analyzer.analyzerVersion || analyzer.name || 'injected-v1');
  const minAutoCreateConfidence = Number.isFinite(Number(options.minAutoCreateConfidence))
    ? Number(options.minAutoCreateConfidence)
    : 0.82;
  const autoCreateCategories = options.autoCreateCategories !== false;
  const dryRun = options.dryRun === true;
  const cadenceMs = Number.isFinite(Number(options.cadenceMs)) ? Number(options.cadenceMs) : 72 * 60 * 60 * 1000;
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const syncNote = resolveLearningSync(assistantRoot, options.syncNote);
  const releaseLock = acquireOrganizerLock(lockPath, options.lockStaleMs);
  const report = {
    dryRun,
    cadenceSkipped: false,
    discovered: 0,
    processed: 0,
    skipped: 0,
    moved: 0,
    wouldMove: 0,
    needsReview: 0,
    failed: 0,
    synced: 0,
    syncFailed: 0,
    recovered: 0,
    recoveryFailed: 0,
  };

  try {
    if (!dryRun) {
      fs.mkdirSync(notesRoot, { recursive: true });
      fs.mkdirSync(assistantRoot, { recursive: true });
    }
    const recovery = dryRun ? { recovered: 0, failed: 0 } : recoverMoves({ notesRoot, logPath: moveLogPath, logger });
    report.recovered = recovery.recovered;
    report.recoveryFailed = recovery.failed;

    const previousState = safeReadJson(statePath, {});
    const lastSuccessfulAt = new Date(previousState.lastSuccessfulAt || 0).getTime();
    if (!dryRun && !options.force && Number.isFinite(lastSuccessfulAt) && Date.now() - lastSuccessfulAt < cadenceMs) {
      report.cadenceSkipped = true;
      return { ...report, notesRoot, assistantRoot, taxonomyPath, moveLogPath, statePath };
    }

    let taxonomy = loadTaxonomy(taxonomyPath, { createIfMissing: !dryRun });
    const taxonomyBefore = JSON.stringify(taxonomy.subjects);
    const notes = discoverNotes(notesRoot);
    report.discovered = notes.length;

    for (const note of notes) {
      let metadata = { ...note.metadata };
      const parsed = parseRemark(metadata.remark || '');
      const currentCategory = getCurrentCategory(notesRoot, note.imagePath, metadata);
      const stat = fs.statSync(note.imagePath);
      const parsedImagePath = path.parse(note.imagePath);
      metadata.schemaVersion = Math.max(Number(metadata.schemaVersion) || 0, NOTE_SCHEMA_VERSION);
      metadata.noteUid = typeof metadata.noteUid === 'string' && metadata.noteUid
        ? metadata.noteUid
        : crypto.randomUUID();
      metadata.captureDate = resolveCaptureDate(metadata, stat);
      metadata.id = parsedImagePath.name;
      metadata.fileName = parsedImagePath.base;
      metadata.filePath = note.imagePath;
      metadata.extracted = parsed;

      // Persist the immutable UID before any external AI call or filesystem move.
      if (!dryRun) atomicWriteJson(note.sidecarPath, metadata);
      const inputHash = makeInputHash(metadata, note.imagePath, analyzerVersion);
      const previousStatus = metadata.organizer?.status;
      const learningAlreadySynced = !syncNote || metadata.organizer?.learningSyncStatus === 'synced';
      if (!options.force && learningAlreadySynced && metadata.organizer?.inputHash === inputHash && ['organized', 'needs_review'].includes(previousStatus)) {
        report.skipped += 1;
        continue;
      }

      try {
        const rawAnalysis = await analyzer({
          imagePath: note.imagePath,
          sidecarPath: note.sidecarPath,
          metadata: { ...metadata },
          parsed,
          currentCategory,
          taxonomy,
          notesRoot,
        });
        const analysis = normalizeAnalysis(rawAnalysis, currentCategory);
        const currentSubject = ensureSubject(taxonomy, currentCategory.subject, { createdBy: 'user' });
        const currentPoint = currentCategory.knowledgePoint
          ? ensureKnowledgePoint(taxonomy, currentSubject, currentCategory.knowledgePoint, { createdBy: 'user' })
          : null;

        let subject = resolveSubject(taxonomy, analysis.subject);
        let needsReview = false;
        const lowConfidenceCategoryChange = analysis.confidence < minAutoCreateConfidence
          && (!subject || subject.id !== currentSubject.id);
        if (lowConfidenceCategoryChange) {
          subject = currentSubject;
          needsReview = true;
        } else if (!subject) {
          if (autoCreateCategories && analysis.confidence >= minAutoCreateConfidence) {
            subject = ensureSubject(taxonomy, analysis.subject, {
              aliases: analysis.subjectAliases,
              createdBy: 'ai',
            });
          } else {
            subject = currentSubject;
            needsReview = true;
          }
        }

        let knowledgePoint = null;
        if (analysis.knowledgePoint) {
          knowledgePoint = resolveKnowledgePoint(subject, analysis.knowledgePoint);
          const lowConfidencePointChange = analysis.confidence < minAutoCreateConfidence
            && (!knowledgePoint || knowledgePoint.id !== currentPoint?.id);
          if (lowConfidencePointChange) {
            knowledgePoint = subject.id === currentSubject.id ? currentPoint : null;
            needsReview = true;
          } else if (!knowledgePoint) {
            if (autoCreateCategories && analysis.confidence >= minAutoCreateConfidence) {
              knowledgePoint = ensureKnowledgePoint(taxonomy, subject, analysis.knowledgePoint, {
                aliases: analysis.knowledgePointAliases,
                createdBy: 'ai',
              });
            } else {
              knowledgePoint = subject.id === currentSubject.id ? currentPoint : null;
              needsReview = true;
            }
          }
        } else if (!analysis.clearKnowledgePoint && subject.id === currentSubject.id) {
          knowledgePoint = currentPoint;
        }

        // Physical files stay at one stable depth: notes/<subject>. Knowledge
        // points, question types and intents remain searchable metadata instead
        // of producing a mixture of loose files and nested folders.
        const destinationDir = path.join(notesRoot, sanitizeCategoryName(subject.name, DEFAULT_SUBJECT));
        ensureInside(notesRoot, destinationDir, 'classified directory');
        metadata = {
          ...metadata,
          subject: subject.name,
          title: analysis.title || metadata.title,
          questionType: analysis.questionType,
          tags: normalizeTags(metadata, parsed, analysis),
          items: analysis.items,
          classification: {
            ...(metadata.classification || {}),
            subjectId: subject.id,
            subjectName: subject.name,
            knowledgePointId: knowledgePoint?.id || null,
            knowledgePointName: knowledgePoint?.name || null,
          },
          organizer: {
            version: ORGANIZER_VERSION,
            inputHash,
            analyzerVersion,
            status: needsReview ? 'needs_review' : 'organized',
            processedAt: new Date().toISOString(),
            confidence: analysis.confidence,
            provider: analysis.provider,
            model: analysis.model,
            reason: analysis.reason,
            summary: analysis.summary,
            questionType: analysis.questionType,
            wrongReason: analysis.wrongReason,
            memoryCard: analysis.memoryCard,
            intent: combinedIntent(parsed, analysis),
            items: analysis.items,
            proposed: needsReview ? {
              subject: analysis.subject,
              knowledgePoint: analysis.knowledgePoint,
            } : null,
          },
        };

        const learning = attachLearningEnrichment(metadata, parsed, analysis, subject, knowledgePoint);
        metadata = learning.metadata;

        if (dryRun) {
          if (path.resolve(destinationDir) !== path.resolve(path.dirname(note.imagePath))) report.wouldMove += 1;
          if (needsReview) report.needsReview += 1;
          report.processed += 1;
          logger(`DRY RUN ${path.basename(note.imagePath)} -> ${subject.name}${knowledgePoint ? ` (知识点: ${knowledgePoint.name})` : ''}`);
          continue;
        }

        const movement = moveWithJournal({
          notesRoot,
          logPath: moveLogPath,
          imagePath: note.imagePath,
          sidecarPath: note.sidecarPath,
          destinationDir,
          metadata,
        });
        const finalMetadata = movement.metadata || metadata;
        let postProcessError = null;
        if (syncNote) {
          try {
            await syncNote(finalMetadata, { enrichment: finalMetadata.learning, cards: learning.cards });
            finalMetadata.organizer.learningSyncStatus = 'synced';
            finalMetadata.organizer.learningSyncedAt = new Date().toISOString();
            delete finalMetadata.organizer.syncError;
            report.synced += 1;
          } catch (error) {
            report.syncFailed += 1;
            postProcessError = error;
          }
        }
        if (typeof options.onOrganized === 'function') {
          try {
            await options.onOrganized({
              metadata: finalMetadata,
              imagePath: movement.imagePath,
              sidecarPath: movement.sidecarPath,
              parsed,
              analysis,
              subject,
              knowledgePoint,
            });
          } catch (error) {
            report.syncFailed += 1;
            postProcessError = postProcessError || error;
          }
        }
        if (postProcessError) {
          finalMetadata.organizer = {
            ...finalMetadata.organizer,
            status: 'sync_failed',
            syncError: postProcessError instanceof Error ? postProcessError.message : String(postProcessError),
          };
        }
        atomicWriteJson(movement.sidecarPath, finalMetadata);
        rebuildMetadataIndex(path.dirname(movement.imagePath));
        if (movement.moved) report.moved += 1;
        if (needsReview) report.needsReview += 1;
        report.processed += 1;
        logger(`OK ${path.basename(note.imagePath)} -> ${subject.name}${knowledgePoint ? ` (知识点: ${knowledgePoint.name})` : ''}`);
      } catch (error) {
        report.failed += 1;
        metadata.organizer = {
          ...(metadata.organizer || {}),
          version: ORGANIZER_VERSION,
          inputHash,
          analyzerVersion,
          status: 'failed',
          attemptedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
        if (!dryRun && fs.existsSync(note.imagePath)) {
          atomicWriteJson(note.sidecarPath, metadata);
          rebuildMetadataIndex(path.dirname(note.imagePath));
        }
        logger(`FAIL ${path.basename(note.imagePath)}: ${metadata.organizer.error}`);
      }
    }

    if (!dryRun && JSON.stringify(taxonomy.subjects) !== taxonomyBefore) {
      taxonomy = saveTaxonomyAtomic(taxonomyPath, taxonomy);
    }
    if (!dryRun && report.failed === 0 && report.recoveryFailed === 0 && report.syncFailed === 0) {
      atomicWriteJson(statePath, {
        lastSuccessfulAt: new Date().toISOString(),
        organizerVersion: ORGANIZER_VERSION,
        report,
      });
    }
    return { ...report, notesRoot, assistantRoot, taxonomyPath, moveLogPath, statePath };
  } finally {
    releaseLock();
  }
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  const bundledAnalyzerPath = path.join(__dirname, 'note-ai-analyzer.cjs');
  const analyzer = await loadInjectedAnalyzer(
    process.env.KAOYAN_AI_ANALYZER || (fs.existsSync(bundledAnalyzerPath) ? bundledAnalyzerPath : ''),
  );
  const report = await organizeNotes({
    analyzeNote: analyzer,
    analyzerVersion: process.env.KAOYAN_AI_ANALYZER_VERSION,
    force: flags.has('--force'),
    dryRun: flags.has('--dry-run'),
    autoCreateCategories: !flags.has('--no-auto-create'),
    minAutoCreateConfidence: process.env.KAOYAN_AUTO_CATEGORY_CONFIDENCE,
    logger: flags.has('--json') ? () => {} : (message) => console.log(`[${new Date().toISOString()}] ${message}`),
  });
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  NOTE_SCHEMA_VERSION,
  ORGANIZER_VERSION,
  defaultAnalyzeNote,
  discoverNotes,
  acquireOrganizerLock,
  loadInjectedAnalyzer,
  moveWithJournal,
  organizeNotes,
  rebuildMetadataIndex,
  recoverMoves,
  removeStaleOrganizerLock,
  resolveCaptureDate,
};
