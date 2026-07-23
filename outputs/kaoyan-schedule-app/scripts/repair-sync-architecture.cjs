const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const write = (file, value) => fs.writeFileSync(path.join(root, file), value, 'utf8');

function replaceOnce(value, search, replacement, label) {
  if (value.includes(replacement)) return value;
  const index = value.indexOf(search);
  if (index < 0) throw new Error(`Missing repair anchor: ${label}`);
  return value.slice(0, index) + replacement + value.slice(index + search.length);
}

function repairAiRouter() {
  const file = 'scripts/ai-router.cjs';
  let value = read(file);
  const misplaced = "  question_splitting: Object.freeze({\n"
    + "    label: '多题识别与自动裁剪',\n"
    + "    description: '对预裁剪后的整页题目识别多个完整题目区域，并交给后台批量保存。',\n"
    + "    active: true,\n"
    + "    defaultTimeoutMs: 90_000,\n"
    + "  }),\n";
  value = value.replace(misplaced, '');

  const definitionsStart = value.indexOf('const AI_TASK_DEFINITIONS = Object.freeze({');
  if (definitionsStart < 0) throw new Error('AI task definitions not found');
  const definitionsEnd = value.indexOf('\n});', definitionsStart);
  const definitions = value.slice(definitionsStart, definitionsEnd);
  if (!definitions.includes("label: '多题识别与自动裁剪'")) {
    const anchor = value.indexOf('  note_enrichment: Object.freeze({', definitionsStart);
    if (anchor < 0 || anchor > definitionsEnd) throw new Error('AI definition insertion anchor not found');
    value = value.slice(0, anchor) + misplaced + value.slice(anchor);
  }
  write(file, value);
}

function repairLearningBackend() {
  const file = 'cloudflare/learning.js';
  let value = read(file);
  if (!value.includes("from './source-mirror.js'")) {
    const firstImportEnd = value.indexOf('\n', value.indexOf("from './http.js'"));
    value = value.slice(0, firstImportEnd + 1)
      + "import { updateMirroredCloudNote } from './source-mirror.js';\n"
      + value.slice(firstImportEnd + 1);
  }

  const functionStart = value.indexOf('export async function patchNote(env, noteUid, payload) {');
  const functionEnd = value.indexOf('\nfunction addDays(', functionStart);
  if (functionStart < 0 || functionEnd < 0) throw new Error('patchNote function not found');
  let segment = value.slice(functionStart, functionEnd);
  if (!segment.includes('updateMirroredCloudNote')) {
    segment = segment.replace('  return (await mutateLearning(env, payload, (snapshot) => {', '  const result = await mutateLearning(env, payload, (snapshot) => {');
    const ending = '  })).snapshot;\n}';
    if (!segment.includes(ending)) throw new Error('patchNote ending not found');
    segment = segment.replace(ending,
      "  });\n"
      + "  const updatedNote = findNote(result.snapshot, noteUid)?.note;\n"
      + "  if (updatedNote) {\n"
      + "    try { await updateMirroredCloudNote(env, updatedNote); } catch (error) {\n"
      + "      console.error(JSON.stringify({ event: 'cloud_note_mirror_update_failed', noteUid, error: error instanceof Error ? error.message : String(error) }));\n"
      + "    }\n"
      + "  }\n"
      + "  return result.snapshot;\n"
      + "}");
    value = value.slice(0, functionStart) + segment + value.slice(functionEnd);
  }

  const createStart = value.indexOf('export function createSavedImageNote(payload, file, timestamp) {');
  const createEnd = value.indexOf('\nexport async function insertSavedImageNote', createStart);
  if (createStart < 0 || createEnd < 0) throw new Error('createSavedImageNote not found');
  let createSegment = value.slice(createStart, createEnd);
  if (!createSegment.includes("sourceType: text(payload.sourceType")) {
    createSegment = createSegment.replace(
      "...noteDefaults({ title, subject, remark, noteType: 'note' }, payload.noteUid, timestamp),",
      "...noteDefaults({ title, subject, remark, noteType: 'note', tags: uniqueStrings(payload.tags) }, payload.noteUid, timestamp),\n"
        + "    sourceType: text(payload.sourceType, 80).trim() || 'single-capture',\n"
        + "    sourceBatchId: text(payload.sourceBatchId, 160).trim(),\n"
        + "    sourceSplitIndex: Number.isFinite(Number(payload.sourceSplitIndex)) ? Math.max(1, Math.round(Number(payload.sourceSplitIndex))) : null,"
    );
    value = value.slice(0, createStart) + createSegment + value.slice(createEnd);
  }
  write(file, value);
}

function repairLearningTypes() {
  const file = 'src/utils/learningData.ts';
  let value = read(file);
  if (!value.includes('  sourceType: string;')) {
    value = replaceOnce(
      value,
      '  filePath: string;\n  pageRefs: LearningPageRef[];',
      '  filePath: string;\n  sourceType: string;\n  sourceBatchId: string;\n  sourceSplitIndex: number | null;\n  pageRefs: LearningPageRef[];',
      'learning source type interface',
    );
  }
  if (!value.includes("sourceType: typeof value.sourceType === 'string'")) {
    value = replaceOnce(
      value,
      '    filePath,\n    pageRefs: normalizePageRefs(value.pageRefs),',
      "    filePath,\n    sourceType: typeof value.sourceType === 'string' ? value.sourceType : '',\n    sourceBatchId: typeof value.sourceBatchId === 'string' ? value.sourceBatchId : '',\n    sourceSplitIndex: Number.isFinite(Number(value.sourceSplitIndex)) ? Math.max(1, Math.round(Number(value.sourceSplitIndex))) : null,\n    pageRefs: normalizePageRefs(value.pageRefs),",
      'learning source type normalization',
    );
  }
  write(file, value);
}

repairAiRouter();
repairLearningBackend();
repairLearningTypes();
