import { HttpError } from './http.js';
import { readJsonFile, writeJsonFile } from './github-store.js';
import { getLearningSnapshot, replaceLearningSnapshot } from './learning.js';
import { readLearningState } from './storage.js';

const REVIEW_INDEX_PATH = 'data/index.json';
const CANVAS_INDEX_PATH = 'data/cloud/canvas-index.json';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EMPTY_MANUAL = Object.freeze({ completedTaskIds: [], note: '', debt: '', mistakes: '' });

function text(value, limit = Infinity) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function uniqueStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
}

function capturedDate(note) {
  if (DATE_PATTERN.test(text(note.capturedDate))) return note.capturedDate;
  const source = text(note.createdAt) || text(note.updatedAt);
  const match = /^\d{4}-\d{2}-\d{2}/.exec(source);
  return match?.[0] || new Date().toISOString().slice(0, 10);
}

function noteBack(note) {
  const itemText = Array.isArray(note.items)
    ? note.items.map((item) => [item?.summary, item?.wrongReason].filter(Boolean).join('\n')).filter(Boolean).join('\n\n')
    : '';
  return [text(note.remark, 8000), text(note.wrongReason, 1000), itemText].filter(Boolean).join('\n\n');
}

function convertReviewIndex(value) {
  const sourceNotes = Array.isArray(value?.notes) ? value.notes : [];
  const days = {};
  const cards = [];
  for (const raw of sourceNotes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const noteUid = text(raw.id, 160).trim();
    if (!noteUid) continue;
    const date = capturedDate(raw);
    const subject = text(raw.subject, 120).trim() || '未分类';
    const noteType = raw.kind === 'mistake' ? 'mistake' : raw.kind === 'memory' ? 'memory' : 'note';
    const createdAt = text(raw.createdAt) || `${date}T00:00:00.000Z`;
    const updatedAt = text(raw.updatedAt) || createdAt;
    const assetPath = text(raw.imagePath, 1000).replaceAll('\\', '/').replace(/^\/+/, '');
    const filePath = assetPath.startsWith('data/assets/') && !assetPath.includes('..')
      ? `github://${assetPath}`
      : '';
    const knowledgePath = [subject, ...uniqueStrings(raw.knowledgePath).filter((item) => item !== subject)].slice(0, 3);
    const cardId = `card-${noteUid}-github-import`;
    const note = {
      noteUid,
      capturedDate: date,
      title: text(raw.title, 240),
      subject,
      remark: text(raw.remark, 8000),
      createdAt,
      updatedAt,
      firstSyncedAt: createdAt,
      filePath,
      pageRefs: [],
      tags: uniqueStrings(raw.tags),
      knowledgePath,
      noteType,
      questionType: text(raw.questionType, 60),
      wrongReason: text(raw.wrongReason, 1000),
      wrongReasonSource: text(raw.wrongReason) ? 'github-import' : '',
      wrongReasonConfidence: null,
      organizationStatus: raw.organizationStatus === 'ignored' ? 'ignored' : 'confirmed',
      classificationSource: 'manual',
      reviewStatus: raw.organizationStatus === 'ignored' ? 'ignored' : 'accepted',
      decisionRevision: 1,
      lastReviewOperationId: `github-import-${noteUid}`,
      lastReviewAction: raw.organizationStatus === 'ignored' ? 'ignore' : 'accept',
      proposalId: '',
      reviewedAt: updatedAt,
      manualCreated: false,
      userEditedFields: [],
      goodQuestion: uniqueStrings(raw.tags).some((tag) => tag.includes('好题')),
      items: Array.isArray(raw.items) ? raw.items.slice(0, 24) : [],
      studyNotes: [],
      confidence: null,
      cardIds: ['mistake', 'memory'].includes(noteType) ? [cardId] : [],
    };
    const day = days[date] || { manual: { ...EMPTY_MANUAL }, autoNotes: [] };
    day.autoNotes.push(note);
    days[date] = day;
    if (['mistake', 'memory'].includes(noteType)) {
      cards.push({
        id: cardId,
        noteUid,
        sourceKey: 'github:index-import',
        kind: noteType,
        front: note.title || subject,
        back: noteBack(raw),
        subject,
        knowledgePath,
        tags: note.tags,
        pageRefs: [],
        sourceTitle: note.title,
        sourceFilePath: filePath,
        status: raw.organizationStatus === 'ignored' ? 'archived' : 'active',
        dueDate: raw.organizationStatus === 'ignored' ? '' : date,
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
  return {
    version: 1,
    revision: 0,
    updatedAt: null,
    days,
    cards,
    deletedNotes: {},
  };
}

function hasLearningContent(snapshot) {
  return Object.values(snapshot.days ?? {}).some((day) => (
    Array.isArray(day?.autoNotes) && day.autoNotes.length > 0
  ) || Object.values(day?.manual ?? {}).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value)))
    || (snapshot.cards?.length ?? 0) > 0
    || Object.keys(snapshot.deletedNotes ?? {}).length > 0;
}

async function ensureCanvasIndex(env) {
  const current = await readJsonFile(env, CANVAS_INDEX_PATH, { allowMissing: true, maxBytes: 4 * 1024 * 1024 });
  if (current) return Array.isArray(current.value?.projects) ? current.value.projects.length : 0;
  await writeJsonFile(env, CANVAS_INDEX_PATH, {
    version: 1,
    revision: 0,
    updatedAt: null,
    projects: [],
  }, { createOnly: true, message: 'cloud: initialize canvas index' });
  return 0;
}

// The historical export name is retained so the Worker route does not need a
// breaking change. The source is now the public Caobijidata GitHub repository.
export async function bootstrapFromR2(env, options = {}) {
  const current = await readLearningState(env);
  const force = options.force === true;
  if (hasLearningContent(current.snapshot) && !force) {
    const canvases = await ensureCanvasIndex(env);
    const snapshot = await getLearningSnapshot(env);
    const notes = Object.values(snapshot.days ?? {}).reduce(
      (count, day) => count + (Array.isArray(day?.autoNotes) ? day.autoNotes.length : 0),
      0,
    );
    return {
      ok: true,
      replayed: true,
      learningImported: false,
      learningRevision: snapshot.revision,
      notes,
      cards: snapshot.cards?.length ?? 0,
      canvases,
      canvasRecordsChanged: 0,
    };
  }
  if (force && (!Number.isInteger(options.expectedRevision) || options.expectedRevision !== current.revision)) {
    throw new HttpError(409, 'Bootstrap expectedRevision is stale.', 'REVISION_CONFLICT', {
      expectedRevision: options.expectedRevision,
      actualRevision: current.revision,
    });
  }
  const source = await readJsonFile(env, REVIEW_INDEX_PATH, {
    allowMissing: false,
    maxBytes: 12 * 1024 * 1024,
  });
  const incoming = convertReviewIndex(source.value);
  const snapshot = await replaceLearningSnapshot(env, incoming, current.revision);
  const canvases = await ensureCanvasIndex(env);
  const notes = Object.values(snapshot.days ?? {}).reduce(
    (count, day) => count + (Array.isArray(day?.autoNotes) ? day.autoNotes.length : 0),
    0,
  );
  return {
    ok: true,
    replayed: false,
    learningImported: true,
    learningRevision: snapshot.revision,
    notes,
    cards: snapshot.cards?.length ?? 0,
    canvases,
    canvasRecordsChanged: 0,
  };
}
