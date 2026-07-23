const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { prepareCloudflareSeed } = require('./prepare-cloudflare-seed.cjs');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MANUAL = Object.freeze({ completedTaskIds: [], note: '', debt: '', mistakes: '' });

function readJson(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${label}: ${error.message}`);
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Unable to parse ${label}: ${error.message}`);
  }
}

function text(value, limit = Infinity) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function uniqueStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function dateFromNote(note) {
  if (DATE_PATTERN.test(text(note.capturedDate))) return note.capturedDate;
  for (const candidate of [note.createdAt, note.updatedAt]) {
    const parsed = new Date(candidate);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function timestampFromNote(note) {
  for (const candidate of [note.createdAt, note.updatedAt]) {
    const parsed = new Date(candidate);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function normalizeItems(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === 'object').slice(0, 24).map((item) => ({
    title: text(item.title, 240),
    knowledgePoint: text(item.knowledgePoint, 160),
    questionType: text(item.questionType, 80),
    summary: text(item.summary, 4000),
    tags: uniqueStrings(item.tags),
    wrongReason: text(item.wrongReason, 1000),
    intent: {
      isQuestion: item.intent?.isQuestion === true,
      isMistake: item.intent?.isMistake === true,
      isGood: item.intent?.isGood === true,
      shouldMemorize: item.intent?.shouldMemorize === true,
    },
  }));
}

function resolveAsset(sourceRoot, note) {
  const relativePath = text(note.imagePath, 1000);
  if (!relativePath) return '';
  const filePath = path.resolve(sourceRoot, relativePath);
  if (!filePath.startsWith(`${sourceRoot}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return '';
  }
  const expectedHash = text(note.imageSha256, 64).toLowerCase();
  if (expectedHash && !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error(`Invalid imageSha256 for note ${note.id}`);
  }
  if (expectedHash && sha256(fs.readFileSync(filePath)) !== expectedHash) {
    throw new Error(`Image SHA-256 mismatch for note ${note.id}`);
  }
  return filePath;
}

function cardBack(note, items) {
  return text(note.wrongReason, 1000)
    || text(note.remark, 8000)
    || items.map((item) => item.summary || item.wrongReason).find(Boolean)
    || text(note.title, 240);
}

function buildSnapshot(index, sourceRoot) {
  if (!index || typeof index !== 'object' || !Array.isArray(index.notes)) {
    throw new Error('Caobijidata data/index.json must contain a notes array');
  }

  const days = {};
  const cards = [];
  const seen = new Set();

  for (const raw of index.notes) {
    if (!raw || typeof raw !== 'object') continue;
    const noteUid = text(raw.id, 160);
    if (!noteUid || seen.has(noteUid)) continue;
    seen.add(noteUid);

    const kind = raw.kind === 'memory' ? 'memory' : 'mistake';
    const subject = text(raw.subject, 120) || '未分类';
    const title = text(raw.title, 240) || (kind === 'memory' ? '背诵内容' : '错题记录');
    const capturedDate = dateFromNote(raw);
    const createdAt = timestampFromNote(raw);
    const updatedAt = Number.isFinite(new Date(raw.updatedAt).getTime())
      ? new Date(raw.updatedAt).toISOString()
      : createdAt;
    const tags = uniqueStrings(raw.tags);
    const knowledgePath = [subject, ...uniqueStrings(raw.knowledgePath).filter((item) => item !== subject)].slice(0, 3);
    const items = normalizeItems(raw.items);
    const sourceFilePath = resolveAsset(sourceRoot, raw);
    const back = cardBack(raw, items);
    const cardId = back ? `card-${noteUid}-caobijidata` : '';
    const goodQuestion = tags.includes('好题') || items.some((item) => item.intent.isGood);

    const note = {
      noteUid,
      capturedDate,
      title,
      subject,
      remark: text(raw.remark, 8000),
      createdAt,
      updatedAt,
      firstSyncedAt: createdAt,
      filePath: sourceFilePath,
      pageRefs: [],
      tags,
      knowledgePath,
      noteType: kind,
      questionType: text(raw.questionType, 80),
      wrongReason: text(raw.wrongReason, 1000),
      wrongReasonSource: text(raw.wrongReason, 1000) ? 'caobijidata' : '',
      wrongReasonConfidence: null,
      organizationStatus: 'confirmed',
      classificationSource: 'manual',
      reviewStatus: 'corrected',
      decisionRevision: 1,
      lastReviewOperationId: `import-${noteUid}`,
      lastReviewAction: 'correct',
      proposalId: '',
      reviewedAt: updatedAt,
      manualCreated: false,
      userEditedFields: [],
      goodQuestion,
      items,
      studyNotes: [],
      confidence: null,
      cardIds: cardId ? [cardId] : [],
    };

    if (!days[capturedDate]) {
      days[capturedDate] = { manual: { ...DEFAULT_MANUAL }, autoNotes: [] };
    }
    days[capturedDate].autoNotes.push(note);

    if (cardId) {
      cards.push({
        id: cardId,
        noteUid,
        sourceKey: `caobijidata:${noteUid}`,
        kind,
        front: kind === 'mistake' ? `重做：${title}` : title,
        back,
        subject,
        knowledgePath,
        tags,
        pageRefs: [],
        sourceTitle: title,
        sourceFilePath,
        status: 'active',
        dueDate: capturedDate,
        reviewStep: 0,
        reviewCount: 0,
        lastReviewedAt: '',
        lastReviewResult: '',
        correctCount: 0,
        incorrectCount: 0,
        correctStreak: 0,
        masteredAt: '',
        reviewHistory: [],
        createdAt,
        updatedAt,
        userEdited: false,
      });
    }
  }

  for (const day of Object.values(days)) {
    day.autoNotes.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  return {
    version: 1,
    revision: 0,
    updatedAt: Number.isFinite(new Date(index.exportedAt).getTime())
      ? new Date(index.exportedAt).toISOString()
      : new Date().toISOString(),
    days,
    cards,
    deletedNotes: {},
  };
}

function prepareFromCaobijidata(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot || options.source || process.cwd());
  const outputRoot = path.resolve(options.outputRoot || options.output || path.join(process.cwd(), 'cloudflare', '.seed'));
  const index = readJson(path.join(sourceRoot, 'data', 'index.json'), 'Caobijidata data/index.json');
  const snapshot = buildSnapshot(index, sourceRoot);
  const assistantRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-caobijidata-'));
  try {
    fs.writeFileSync(path.join(assistantRoot, 'learning-data.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    const result = prepareCloudflareSeed({ assistantRoot, outputRoot });
    const noteCount = Object.values(snapshot.days).reduce((total, day) => total + day.autoNotes.length, 0);
    return {
      ...result,
      sourceRoot,
      notes: noteCount,
      cards: snapshot.cards.length,
      days: Object.keys(snapshot.days).length,
    };
  } finally {
    fs.rmSync(assistantRoot, { recursive: true, force: true });
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

function runCli() {
  try {
    const result = prepareFromCaobijidata({
      sourceRoot: readFlag(process.argv.slice(2), 'source'),
      outputRoot: readFlag(process.argv.slice(2), 'output'),
    });
    console.log(`Caobijidata seed ready: ${result.outputRoot}`);
    console.log(`Learning data: ${result.notes} notes, ${result.cards} cards, ${result.days} days`);
    console.log(`R2 manifest: ${result.manifest.totals.objectCount} objects, ${result.manifest.totals.objectBytes} bytes`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) runCli();

module.exports = {
  buildSnapshot,
  prepareFromCaobijidata,
};
