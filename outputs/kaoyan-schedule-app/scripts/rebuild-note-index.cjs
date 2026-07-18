const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLearningDataStore, formatDateInTimeZone, normalizeSnapshot } = require('./learning-data-store.cjs');
const {
  acquireOrganizerLock,
  moveWithJournal,
  rebuildMetadataIndex,
} = require('./organize-notes.cjs');
const { parseRemark } = require('./remark-parser.cjs');
const { sanitizeCategoryName } = require('./note-taxonomy.cjs');
const { unlinkFileIfExists } = require('./safe-file-ops.cjs');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_SUBJECT = '默认文件夹';

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
  } finally {
    unlinkFileIfExists(tempPath);
  }
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function uniqueStrings(items) {
  return [...new Set((Array.isArray(items) ? items : [])
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))];
}

function flattenTags(metadata, parsed) {
  const source = metadata?.tags;
  const stored = Array.isArray(source)
    ? source
    : [
      ...(Array.isArray(source?.manual) ? source.manual : []),
      ...(Array.isArray(source?.explicit) ? source.explicit : []),
      ...(Array.isArray(source?.inferred) ? source.inferred : []),
    ];
  const tags = uniqueStrings([
    ...stored,
    ...(Array.isArray(metadata?.learning?.tags) ? metadata.learning.tags : []),
    ...(parsed.explicitTags || []),
    ...(parsed.inferredTags || []),
  ]);
  if (parsed.flags?.isMistake && !tags.includes('错题')) tags.push('错题');
  if (parsed.flags?.isClassic && !tags.includes('经典')) tags.push('经典');
  if (parsed.flags?.shouldMemorize && !tags.includes('背诵')) tags.push('背诵');
  if (parsed.flags?.needsReview && !tags.includes('待复习')) tags.push('待复习');
  return tags;
}

function resolveCapturedAt(metadata, imageStat, sidecarStat, now = () => new Date()) {
  for (const value of [metadata?.capturedAt, metadata?.createdAt]) {
    if (DATE_PATTERN.test(String(value || ''))) return new Date(`${value}T12:00:00+08:00`);
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  for (const value of [metadata?.captureDate, metadata?.learning?.capturedDate]) {
    if (DATE_PATTERN.test(String(value || ''))) return new Date(`${value}T12:00:00+08:00`);
  }
  if (imageStat?.mtime instanceof Date && !Number.isNaN(imageStat.mtime.getTime())) return imageStat.mtime;
  if (sidecarStat?.mtime instanceof Date && !Number.isNaN(sidecarStat.mtime.getTime())) return sidecarStat.mtime;
  return now();
}

function makePageRefs(parsed) {
  if ((parsed.pages || []).length === 1 && (parsed.questions || []).length === 1) {
    return [{
      raw: `${parsed.pageRefs?.[0]?.raw || `p${parsed.pages[0]}`} ${parsed.questionRefs?.[0]?.raw || `${parsed.questions[0]}题`}`,
      page: parsed.pages[0],
      question: parsed.questions[0],
    }];
  }
  const refs = [];
  for (const pageRef of parsed.pageRefs || []) {
    for (const page of parsed.pages || []) {
      if (page >= pageRef.start && page <= pageRef.end) refs.push({ raw: pageRef.raw, page });
    }
  }
  for (const questionRef of parsed.questionRefs || []) {
    refs.push({ raw: questionRef.raw, question: questionRef.number });
  }
  return refs;
}

function mergePageRefs(existing, parsed) {
  const byKey = new Map();
  for (const item of [...(Array.isArray(existing) ? existing : []), ...makePageRefs(parsed)]) {
    if (!item || typeof item !== 'object') continue;
    const page = Number(item.page);
    const question = typeof item.question === 'string' ? item.question.trim() : '';
    const raw = typeof item.raw === 'string' ? item.raw.trim() : '';
    const normalized = {
      raw,
      ...(Number.isFinite(page) && page > 0 ? { page: Math.round(page) } : {}),
      ...(question ? { question } : {}),
    };
    const key = `${normalized.page || ''}|${normalized.question || ''}|${normalized.raw}`;
    if (normalized.raw || normalized.page || normalized.question) byKey.set(key, normalized);
  }
  return [...byKey.values()];
}

function stableNoteUid(notesRoot, imagePath, metadata) {
  const explicit = metadata?.noteUid || metadata?.learning?.noteUid || metadata?.uid;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const relative = path.relative(notesRoot, imagePath).replace(/\\/g, '/').normalize('NFKC').toLocaleLowerCase('zh-CN');
  const digest = crypto.createHash('sha256').update(relative).digest('hex').slice(0, 24);
  return `legacy-${digest}`;
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

function walkNoteFiles(notesRoot) {
  const images = [];
  const sidecars = [];
  if (!fs.existsSync(notesRoot)) return { images, sidecars };
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (/\.note\.json$/i.test(entry.name)) sidecars.push(fullPath);
        else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && path.basename(directory) !== '.metadata') images.push(fullPath);
      }
    }
  };
  walk(notesRoot);
  return { images, sidecars };
}

function resolveSidecarImage(notesRoot, sidecarPath, metadata) {
  const imageDir = imageDirFromSidecar(sidecarPath);
  const candidates = [];
  if (typeof metadata?.filePath === 'string' && isInside(notesRoot, metadata.filePath)) {
    candidates.push({ path: metadata.filePath, filePathMatched: true });
  }
  if (typeof metadata?.fileName === 'string') {
    candidates.push({ path: path.join(imageDir, metadata.fileName), filePathMatched: false });
  }
  const stems = uniqueStrings([
    path.basename(sidecarPath).replace(/\.note\.json$/i, ''),
    metadata?.id,
    typeof metadata?.fileName === 'string' ? path.parse(metadata.fileName).name : '',
  ]);
  if (fs.existsSync(imageDir)) {
    for (const name of fs.readdirSync(imageDir)) {
      if (!IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
      if (stems.includes(path.parse(name).name)) candidates.push({ path: path.join(imageDir, name), filePathMatched: false });
    }
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.path);
    const key = resolved.toLocaleLowerCase('en-US');
    if (seen.has(key) || !isInside(notesRoot, resolved)) continue;
    seen.add(key);
    try {
      if (fs.statSync(resolved).isFile()) return { imagePath: resolved, filePathMatched: candidate.filePathMatched };
    } catch {}
  }
  return null;
}

function makeGeneratedCards(metadata, enrichment, intent) {
  const existing = Array.isArray(metadata?.learning?.cards) ? metadata.learning.cards : [];
  if (existing.length > 0) {
    return existing.map((card, index) => ({
      ...card,
      sourceKey: card?.sourceKey || card?.cardKey || `rebuild:${card?.kind === 'mistake' ? 'mistake' : 'memory'}:${index}`,
    }));
  }
  const back = enrichment.wrongReason || metadata.remark || metadata.title || '';
  if (!back) return [];
  const cards = [];
  if (intent.shouldMemorize) {
    cards.push({
      sourceKey: 'remark-memory:0',
      kind: 'memory',
      front: metadata.title || '回忆这条笔记的核心内容',
      back: metadata.remark || metadata.title || back,
      status: 'draft',
      knowledgePath: enrichment.knowledgePath,
      tags: enrichment.tags,
      pageRefs: enrichment.pageRefs,
    });
  }
  if (intent.isMistake) {
    cards.push({
      sourceKey: 'remark-mistake:0',
      kind: 'mistake',
      front: metadata.title ? `重做：${metadata.title}` : '重新说明这道错题的正确思路',
      back,
      status: 'draft',
      knowledgePath: enrichment.knowledgePath,
      tags: enrichment.tags,
      pageRefs: enrichment.pageRefs,
    });
  }
  return cards;
}

function buildIndexEntry({ notesRoot, imagePath, sidecarPath, metadata = {}, filePathMatched = false, now = () => new Date() }) {
  const imageStat = fs.statSync(imagePath);
  let sidecarStat = null;
  try { sidecarStat = sidecarPath && fs.existsSync(sidecarPath) ? fs.statSync(sidecarPath) : null; } catch {}
  const relativeSegments = path.relative(notesRoot, imagePath).split(path.sep).filter(Boolean);
  const subject = sanitizeCategoryName(
    metadata?.classification?.subjectName || metadata.subject || relativeSegments[0] || DEFAULT_SUBJECT,
    DEFAULT_SUBJECT,
  );
  const pathKnowledgePoint = relativeSegments.length > 2 ? relativeSegments[1] : '';
  const existingKnowledgePath = uniqueStrings(metadata?.learning?.knowledgePath);
  const knowledgePoint = metadata?.classification?.knowledgePointName
    || existingKnowledgePath.find((item) => item !== subject)
    || pathKnowledgePoint;
  const knowledgePath = uniqueStrings([subject, knowledgePoint]);
  const remark = typeof metadata.remark === 'string' ? metadata.remark : '';
  const parsed = parseRemark(remark || metadata.title || path.parse(imagePath).name);
  const storedIntent = metadata?.learning?.intent || metadata?.organizer?.intent || {};
  const intent = {
    isQuestion: storedIntent.isQuestion === true || (parsed.questions || []).length > 0,
    isMistake: storedIntent.isMistake === true || parsed.flags?.isMistake === true,
    shouldMemorize: storedIntent.shouldMemorize === true || parsed.flags?.shouldMemorize === true,
  };
  const tags = flattenTags(metadata, parsed);
  if (intent.isMistake && !tags.includes('错题')) tags.push('错题');
  if (intent.shouldMemorize && !tags.includes('背诵')) tags.push('背诵');
  const capturedAt = resolveCapturedAt(metadata, imageStat, sidecarStat, now);
  const capturedDate = formatDateInTimeZone(capturedAt, 'Asia/Shanghai');
  const noteUid = stableNoteUid(notesRoot, imagePath, metadata);
  const wrongReason = metadata?.learning?.wrongReason
    || metadata?.organizer?.wrongReason
    || metadata?.wrongReason
    || parsed.wrongReasons?.[0]
    || '';
  const questionType = metadata?.learning?.questionType || metadata?.questionType || metadata?.organizer?.questionType || '';
  const noteType = intent.isMistake
    ? 'mistake'
    : intent.shouldMemorize
      ? 'memory'
      : metadata?.learning?.noteType || (metadata.kind === 'canvas' ? 'canvas' : intent.isQuestion ? 'question' : 'note');
  const enrichment = {
    ...(metadata.learning && typeof metadata.learning === 'object' ? metadata.learning : {}),
    noteUid,
    capturedDate,
    title: metadata.title || path.parse(imagePath).name,
    subject,
    pageRefs: mergePageRefs(metadata?.learning?.pageRefs, parsed),
    tags,
    knowledgePath,
    noteType,
    questionType,
    wrongReason,
    intent,
    items: Array.isArray(metadata?.learning?.items)
      ? metadata.learning.items
      : Array.isArray(metadata?.items) ? metadata.items : [],
  };
  const normalizedMetadata = {
    ...metadata,
    noteUid,
    subject,
    title: metadata.title || path.parse(imagePath).name,
    remark,
    createdAt: typeof metadata.createdAt === 'string' && metadata.createdAt
      ? metadata.createdAt
      : capturedAt.toISOString(),
    captureDate: capturedDate,
    filePath: imagePath,
    fileName: path.basename(imagePath),
    learning: enrichment,
  };
  const cards = makeGeneratedCards(normalizedMetadata, enrichment, intent);
  normalizedMetadata.learning.cards = cards;
  const enriched = Boolean(
    knowledgePoint
    || questionType
    || wrongReason
    || tags.length > 0
    || enrichment.items.length > 0
    || cards.length > 0
  );
  return {
    metadata: normalizedMetadata,
    enrichment,
    cards,
    imagePath,
    sidecarPath: sidecarPath || preferredSidecarPath(imagePath),
    filePathMatched,
    imageMtimeMs: imageStat.mtimeMs,
    sidecarMtimeMs: sidecarStat?.mtimeMs || 0,
    enriched,
  };
}

function isCandidatePreferred(candidate, previous) {
  const left = [
    candidate.filePathMatched ? 1 : 0,
    candidate.enriched ? 1 : 0,
    candidate.sidecarMtimeMs || 0,
    candidate.imageMtimeMs || 0,
  ];
  const right = [
    previous.filePathMatched ? 1 : 0,
    previous.enriched ? 1 : 0,
    previous.sidecarMtimeMs || 0,
    previous.imageMtimeMs || 0,
  ];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return candidate.sidecarPath.localeCompare(previous.sidecarPath, 'zh-CN') > 0;
}

function scanNoteIndex(options = {}) {
  const notesRoot = path.resolve(options.notesRoot || path.join(os.homedir(), 'Desktop', '笔记'));
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const { images, sidecars } = walkNoteFiles(notesRoot);
  const imageKeys = new Set(images.map((item) => path.resolve(item).toLocaleLowerCase('en-US')));
  const matchedImages = new Set();
  const candidates = [];
  const invalidSidecars = [];
  const missingImages = [];
  const unresolvedSidecars = [];

  for (const sidecarPath of sidecars) {
    const metadata = safeReadJson(sidecarPath);
    if (!metadata || typeof metadata !== 'object') {
      invalidSidecars.push(sidecarPath);
      continue;
    }
    const resolved = resolveSidecarImage(notesRoot, sidecarPath, metadata);
    if (!resolved) {
      unresolvedSidecars.push({ sidecarPath, metadata });
      continue;
    }
    const imageKey = path.resolve(resolved.imagePath).toLocaleLowerCase('en-US');
    if (!imageKeys.has(imageKey)) continue;
    matchedImages.add(imageKey);
    candidates.push(buildIndexEntry({
      notesRoot,
      imagePath: resolved.imagePath,
      sidecarPath,
      metadata,
      filePathMatched: resolved.filePathMatched,
      now,
    }));
  }

  for (const imagePath of images) {
    const key = path.resolve(imagePath).toLocaleLowerCase('en-US');
    if (matchedImages.has(key)) continue;
    candidates.push(buildIndexEntry({ notesRoot, imagePath, metadata: {}, now }));
  }

  const byUid = new Map();
  const duplicates = [];
  for (const candidate of candidates) {
    const uid = candidate.metadata.noteUid;
    const previous = byUid.get(uid);
    if (!previous) {
      byUid.set(uid, candidate);
      continue;
    }
    const winner = isCandidatePreferred(candidate, previous) ? candidate : previous;
    const loser = winner === candidate ? previous : candidate;
    byUid.set(uid, winner);
    duplicates.push({
      noteUid: uid,
      kept: winner.sidecarPath,
      ignored: loser.sidecarPath,
      keptFilePathExists: winner.filePathMatched,
    });
  }
  for (const unresolved of unresolvedSidecars) {
    const uid = unresolved.metadata?.noteUid || unresolved.metadata?.learning?.noteUid || unresolved.metadata?.uid;
    const winner = typeof uid === 'string' && uid.trim() ? byUid.get(uid.trim()) : null;
    if (winner) {
      duplicates.push({
        noteUid: uid.trim(),
        kept: winner.sidecarPath,
        ignored: unresolved.sidecarPath,
        keptFilePathExists: winner.filePathMatched,
      });
    } else {
      missingImages.push(unresolved.sidecarPath);
    }
  }

  const entries = [...byUid.values()].sort((left, right) => (
    left.enrichment.capturedDate.localeCompare(right.enrichment.capturedDate)
    || left.imagePath.localeCompare(right.imagePath, 'zh-CN')
  ));
  const flattenPlans = entries.flatMap((entry) => {
    const directorySegments = path.relative(notesRoot, path.dirname(entry.imagePath)).split(path.sep).filter(Boolean);
    if (directorySegments.length <= 1) return [];
    const physicalSubject = sanitizeCategoryName(directorySegments[0] || entry.metadata.subject, DEFAULT_SUBJECT);
    return [{
      noteUid: entry.metadata.noteUid,
      sourceImage: entry.imagePath,
      sourceSidecar: entry.sidecarPath,
      destinationDir: path.join(notesRoot, physicalSubject),
    }];
  });
  const notesByDate = {};
  for (const entry of entries) {
    const date = entry.enrichment.capturedDate;
    notesByDate[date] = (notesByDate[date] || 0) + 1;
  }
  const indexedCards = entries.flatMap((entry) => entry.cards);

  return {
    notesRoot,
    entries,
    flattenPlans,
    report: {
      images: images.length,
      sidecars: sidecars.length,
      indexedNotes: entries.length,
      notesByDate,
      mistakeNotes: entries.filter((entry) => entry.enrichment.noteType === 'mistake' || entry.enrichment.tags.includes('错题')).length,
      memoryNotes: entries.filter((entry) => entry.enrichment.noteType === 'memory' || entry.enrichment.tags.includes('背诵')).length,
      indexedCards: indexedCards.length,
      mistakeCards: indexedCards.filter((card) => card.kind === 'mistake').length,
      memoryCards: indexedCards.filter((card) => card.kind === 'memory').length,
      duplicates,
      invalidSidecars,
      missingImages,
      orphanImages: candidates.filter((item) => !item.sidecarPath || !fs.existsSync(item.sidecarPath)).length,
      flattenMoves: flattenPlans.map((plan) => ({
        noteUid: plan.noteUid,
        from: plan.sourceImage,
        to: plan.destinationDir,
      })),
    },
  };
}

function makeRecoveryBackup(filePath, now = () => new Date()) {
  if (!fs.existsSync(filePath)) return null;
  const parsed = path.parse(filePath);
  const stamp = now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  let counter = 1;
  let backupPath;
  do {
    const suffix = counter === 1 ? '' : `-${counter}`;
    backupPath = path.join(parsed.dir, `${parsed.name}.pre-rebuild-${stamp}${suffix}${parsed.ext}`);
    counter += 1;
  } while (fs.existsSync(backupPath));
  fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  return backupPath;
}

function applyFlattenPlans(scan, options) {
  const moved = [];
  for (const plan of scan.flattenPlans) {
    const entry = scan.entries.find((item) => item.metadata.noteUid === plan.noteUid && item.imagePath === plan.sourceImage);
    if (!entry || !fs.existsSync(entry.imagePath)) continue;
    const movement = moveWithJournal({
      notesRoot: scan.notesRoot,
      logPath: options.moveLogPath,
      imagePath: entry.imagePath,
      sidecarPath: entry.sidecarPath,
      destinationDir: plan.destinationDir,
      metadata: entry.metadata,
    });
    moved.push({ noteUid: plan.noteUid, from: entry.imagePath, to: movement.imagePath });
  }
  return moved;
}

function persistEntrySidecars(entries) {
  for (const entry of entries) {
    atomicWriteJson(entry.sidecarPath || preferredSidecarPath(entry.imagePath), entry.metadata);
  }
}

function cleanupFlattenedDirectories(moved, notesRoot) {
  const removed = [];
  const sourceDirectories = [...new Set(moved.map((item) => path.dirname(item.from)))];
  for (const sourceDir of sourceDirectories) {
    // `moved` is produced only by moveWithJournal, which already validates
    // every source against notesRoot before returning it.
    if (path.resolve(sourceDir) === path.resolve(notesRoot)) continue;
    const metadataDir = path.join(sourceDir, '.metadata');
    if (fs.existsSync(metadataDir)) {
      for (const name of fs.readdirSync(metadataDir)) {
        if (!/\.note\.json$/i.test(name)) continue;
        const sidecarPath = path.join(metadataDir, name);
        const metadata = safeReadJson(sidecarPath);
        const imagePath = typeof metadata?.filePath === 'string' ? metadata.filePath : '';
        if (
          !imagePath
          || !fs.existsSync(imagePath)
          || path.resolve(path.dirname(imagePath)) !== path.resolve(sourceDir)
        ) {
          unlinkFileIfExists(sidecarPath);
        }
      }
      const metadataFiles = fs.readdirSync(metadataDir);
      const hasLiveSidecar = metadataFiles.some((name) => /\.note\.json$/i.test(name));
      const hasUnexpectedFile = metadataFiles.some((name) => name !== 'metadata.json' && !/\.note\.json$/i.test(name));
      if (!hasLiveSidecar && !hasUnexpectedFile) {
        const metadataIndexPath = path.join(metadataDir, 'metadata.json');
        unlinkFileIfExists(metadataIndexPath);
        if (fs.readdirSync(metadataDir).length === 0) fs.rmdirSync(metadataDir);
      }
    }
    if (fs.existsSync(sourceDir) && fs.readdirSync(sourceDir).length === 0) {
      fs.rmdirSync(sourceDir);
      removed.push(sourceDir);
    }
  }
  return removed;
}

function rebuildNoteIndex(options = {}) {
  const notesRoot = path.resolve(options.notesRoot || process.env.KAOYAN_NOTES_ROOT || path.join(os.homedir(), 'Desktop', '笔记'));
  const assistantRoot = path.resolve(options.assistantRoot || process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手'));
  const dryRun = options.apply !== true;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const lockPath = path.resolve(options.lockPath || path.join(assistantRoot, 'note-organizer.lock'));
  const moveLogPath = path.resolve(options.moveLogPath || path.join(assistantRoot, 'note-organizer-moves.jsonl'));
  let scan = scanNoteIndex({ notesRoot, now });
  const learningDataPath = path.join(assistantRoot, 'learning-data.json');
  const beforePayload = safeReadJson(learningDataPath) || safeReadJson(`${learningDataPath}.bak`) || {};
  const before = normalizeSnapshot(beforePayload);
  const beforeNotes = Object.values(before.days).reduce((sum, day) => sum + day.autoNotes.length, 0);
  const baseReport = {
    dryRun,
    assistantRoot,
    learningDataPath,
    beforeNotes,
    beforeCards: before.cards.length,
    ...scan.report,
  };
  if (dryRun) return { ...baseReport, backupPath: null, moved: [], revision: before.revision };

  if ((scan.report.invalidSidecars.length > 0 || scan.report.missingImages.length > 0) && options.allowPartial !== true) {
    const error = new Error('Index rebuild stopped because invalid sidecars or missing images require review');
    error.code = 'NOTE_INDEX_REVIEW_REQUIRED';
    error.report = scan.report;
    throw error;
  }

  fs.mkdirSync(assistantRoot, { recursive: true });
  const store = createLearningDataStore({ assistantRoot, now, timeZone: 'Asia/Shanghai' });
  const releaseLock = acquireOrganizerLock(lockPath, options.lockStaleMs);
  let backupPath = null;
  try {
    backupPath = makeRecoveryBackup(store.filePath, now);
    // Persist stable UIDs and captured dates before touching physical paths so
    // orphan images remain discoverable by later organizer runs.
    persistEntrySidecars(scan.entries);
    let snapshot = store.rebuildNoteIndex(scan.entries.map((entry) => ({
      metadata: entry.metadata,
      enrichment: entry.enrichment,
      cards: entry.cards,
    })));

    let moved = [];
    let removedDirectories = [];
    if (options.flatten !== false) {
      try {
        moved = applyFlattenPlans(scan, { moveLogPath });
        removedDirectories = cleanupFlattenedDirectories(moved, notesRoot);
      } catch (error) {
        // A move journal protects every file pair. Re-scan whatever physical
        // state exists and atomically point the index at those paths before
        // surfacing the migration error.
        const recoveryScan = scanNoteIndex({ notesRoot, now });
        persistEntrySidecars(recoveryScan.entries);
        store.rebuildNoteIndex(recoveryScan.entries.map((entry) => ({
          metadata: entry.metadata,
          enrichment: entry.enrichment,
          cards: entry.cards,
        })));
        throw error;
      }
    }
    if (moved.length > 0) {
      scan = scanNoteIndex({ notesRoot, now });
      persistEntrySidecars(scan.entries);
      snapshot = store.rebuildNoteIndex(scan.entries.map((entry) => ({
        metadata: entry.metadata,
        enrichment: entry.enrichment,
        cards: entry.cards,
      })));
      removedDirectories = [...new Set([
        ...removedDirectories,
        ...cleanupFlattenedDirectories(moved, notesRoot),
      ])];
    }
    for (const subjectDir of new Set(scan.entries.map((entry) => path.dirname(entry.imagePath)))) {
      rebuildMetadataIndex(subjectDir);
    }
    return {
      ...baseReport,
      ...scan.report,
      dryRun: false,
      backupPath,
      moved,
      removedDirectories,
      indexedNotes: scan.entries.length,
      indexedCards: snapshot.cards.length,
      revision: snapshot.revision,
    };
  } finally {
    releaseLock();
  }
}

function restoreLearningData(options = {}) {
  if (options.apply !== true) throw new Error('Restore requires --apply');
  const assistantRoot = path.resolve(options.assistantRoot || process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手'));
  const backupPath = path.resolve(String(options.backupPath || ''));
  if (!backupPath || !fs.existsSync(backupPath)) throw new Error(`Recovery snapshot not found: ${backupPath}`);
  const payload = safeReadJson(backupPath);
  if (!payload || typeof payload !== 'object') throw new Error(`Invalid recovery snapshot: ${backupPath}`);
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const store = createLearningDataStore({ assistantRoot, now, timeZone: 'Asia/Shanghai' });
  const safetyBackup = makeRecoveryBackup(store.filePath, now);
  const snapshot = store.restoreSnapshot(payload);
  return { restoredFrom: backupPath, safetyBackup, revision: snapshot.revision };
}

function readFlag(name) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : '';
}

function main() {
  const flags = new Set(process.argv.slice(2));
  const apply = flags.has('--apply');
  const assistantRoot = readFlag('assistant-root') || undefined;
  const notesRoot = readFlag('notes-root') || undefined;
  const restorePath = readFlag('restore');
  const report = restorePath
    ? restoreLearningData({ apply, assistantRoot, backupPath: restorePath })
    : rebuildNoteIndex({
      apply,
      assistantRoot,
      notesRoot,
      allowPartial: flags.has('--allow-partial'),
      flatten: !flags.has('--no-flatten'),
    });
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  buildIndexEntry,
  makeRecoveryBackup,
  rebuildNoteIndex,
  resolveCapturedAt,
  restoreLearningData,
  scanNoteIndex,
};
