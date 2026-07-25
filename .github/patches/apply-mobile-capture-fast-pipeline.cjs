'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve('outputs/kaoyan-schedule-app');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function write(relative, value) {
  fs.writeFileSync(path.join(root, relative), value, 'utf8');
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${label}: anchor not found`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`${label}: anchor is ambiguous`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceRegexOnce(source, pattern, replacement, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) throw new Error(`${label}: expected 1 match, found ${matches.length}`);
  return source.replace(pattern, replacement);
}

let githubStore = read('cloudflare/github-store.js');
githubStore = replaceRegexOnce(
  githubStore,
  /  const tree = \[\];\n  for \(const file of files\) \{[\s\S]*?\n  \}\n  const treeResult = await githubRequest/,
  `  const tree = await Promise.all(files.map(async (file) => {\n    const path = assertRepoPath(file.path);\n    if (file.delete === true) return { path, mode: '100644', type: 'blob', sha: null };\n    const sha = await createBlob(env, toBytes(file.content));\n    return { path, mode: '100644', type: 'blob', sha };\n  }));\n  const treeResult = await githubRequest`,
  'parallelize GitHub blob creation',
);
write('cloudflare/github-store.js', githubStore);

let media = read('cloudflare/media.js');
media = replaceOnce(
  media,
  "import { createNote, createSavedImageNote, getLearningSnapshot, insertSavedImageNote } from './learning.js';",
  "import { createNote, createSavedImageNote, findNote, getLearningSnapshot } from './learning.js';",
  'media learning imports',
);
media = replaceOnce(
  media,
  "  assertRepoPath,\n  publicFileResponse,\n  readFile,\n  writeBinaryFile,",
  "  assertRepoPath,\n  commitFiles,\n  getBranchHead,\n  publicFileResponse,\n  readFile,\n  readJsonFile,\n  writeBinaryFile,",
  'media GitHub imports',
);
media = replaceOnce(
  media,
  "import { readReceipt, writeReceipt } from './storage.js';",
  "import { readReceipt, STORAGE_PATHS, writeReceipt } from './storage.js';",
  'media storage imports',
);
media = replaceOnce(
  media,
  "const MAX_MATERIAL_FILES = 8;",
  "const MAX_MATERIAL_FILES = 8;\nconst MAX_BATCH_IMAGES = 12;\nconst MAX_BATCH_IMAGE_BYTES = 48 * 1024 * 1024;",
  'media batch constants',
);

const fastSaveImplementation = String.raw`function normalizeLearningSnapshot(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : {};
  return {
    ...source,
    version: Number.isFinite(Number(source.version)) ? Number(source.version) : 1,
    revision: Number.isInteger(Number(source.revision)) ? Math.max(0, Number(source.revision)) : 0,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    days: source.days && typeof source.days === 'object' && !Array.isArray(source.days) ? source.days : {},
    cards: Array.isArray(source.cards) ? source.cards : [],
    deletedNotes: source.deletedNotes && typeof source.deletedNotes === 'object' && !Array.isArray(source.deletedNotes)
      ? source.deletedNotes : {},
  };
}

function appendSavedImageNote(snapshot, note) {
  const rawDay = snapshot.days[note.capturedDate];
  const day = rawDay && typeof rawDay === 'object' && !Array.isArray(rawDay) ? { ...rawDay } : {};
  day.manual = day.manual && typeof day.manual === 'object' && !Array.isArray(day.manual)
    ? day.manual : { completedTaskIds: [], note: '', debt: '', mistakes: '' };
  day.autoNotes = Array.isArray(day.autoNotes) ? [...day.autoNotes, note] : [note];
  snapshot.days[note.capturedDate] = day;
}

function buildSavedImageResponse(note, image, repoPath, replayed) {
  const sourceMirror = mirroredCloudImagePaths(note.noteUid, image.extension);
  return {
    ok: true,
    noteUid: note.noteUid,
    filePath: `github://${repoPath}`,
    fileName: `${note.noteUid}.${image.extension}`,
    sourceMirrorPath: sourceMirror.imagePath,
    metadata: {
      noteUid: note.noteUid,
      sourceType: note.sourceType,
      sourceBatchId: note.sourceBatchId,
      sourceSplitIndex: note.sourceSplitIndex,
      learning: { tags: note.tags, noteType: note.noteType },
    },
    learningSyncError: null,
    aiStatus: 'pending',
    aiAvailable: true,
    provisional: false,
    idempotentReplay: replayed,
  };
}

async function prepareSavedImage(payload) {
  const noteUid = normalizeNoteUid(payload.noteUid);
  const image = decodeImageDataUrl(payload.imageDataUrl);
  const imageHash = await sha256(image.bytes);
  const requestHash = await sha256(JSON.stringify({
    noteUid,
    kind: payload.kind === 'canvas' ? 'canvas' : 'single',
    subject: typeof payload.subject === 'string' ? payload.subject : '',
    remark: typeof payload.remark === 'string' ? payload.remark : '',
    canvasProjectId: typeof payload.canvasProjectId === 'string' ? payload.canvasProjectId : '',
    sourceType: typeof payload.sourceType === 'string' ? payload.sourceType : '',
    sourceBatchId: typeof payload.sourceBatchId === 'string' ? payload.sourceBatchId : '',
    sourceSplitIndex: Number(payload.sourceSplitIndex) || 0,
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    imageHash,
  }));
  return {
    payload: { ...payload, noteUid },
    noteUid,
    image,
    imageHash,
    requestHash,
    repoPath: `${ASSET_ROOT}${noteUid}.${image.extension}`,
  };
}

async function finishSavedImagesInBackground(env, staged, responses, timestamp) {
  const responseByUid = new Map(responses.map((response) => [response.noteUid, response]));
  const postSave = await Promise.allSettled(staged.flatMap((item) => {
    const response = responseByUid.get(item.noteUid);
    return [
      mirrorNewCloudImage(env, item.image, item.note, item.payload, timestamp),
      saveReceipt(env, 'save-note', item.noteUid, item.requestHash, response),
    ];
  }));
  reportBackgroundFailure('cloud_note_batch_post_save_failed', staged.map((item) => item.noteUid).join(','), postSave);

  const naming = await Promise.allSettled(staged.map(async (item) => {
    const queued = await enqueueRenameJob(env, item.noteUid);
    await processBackgroundJob(env, queued.job.id);
  }));
  reportBackgroundFailure('cloud_note_batch_naming_failed', staged.map((item) => item.noteUid).join(','), naming);
}

export async function saveNoteBatch(env, payload, ctx) {
  const inputs = Array.isArray(payload?.notes) ? payload.notes : [];
  if (inputs.length < 1 || inputs.length > MAX_BATCH_IMAGES) {
    throw new HttpError(400, `notes must contain between 1 and ${MAX_BATCH_IMAGES} images.`, 'INVALID_NOTE_BATCH');
  }
  const prepared = await Promise.all(inputs.map((item) => prepareSavedImage(item && typeof item === 'object' ? item : {})));
  const noteUids = new Set();
  let totalBytes = 0;
  for (const item of prepared) {
    if (noteUids.has(item.noteUid)) throw new HttpError(400, 'A noteUid may appear only once in a batch.', 'DUPLICATE_NOTE_UID');
    noteUids.add(item.noteUid);
    totalBytes += item.image.bytes.byteLength;
  }
  if (totalBytes > MAX_BATCH_IMAGE_BYTES) throw new HttpError(413, 'The image batch is too large.', 'PAYLOAD_TOO_LARGE');

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const head = await getBranchHead(env);
    const learningFile = await readJsonFile(env, STORAGE_PATHS.learning, {
      ref: head,
      allowMissing: true,
      maxBytes: 24 * 1024 * 1024,
    });
    const snapshot = normalizeLearningSnapshot(learningFile?.value);
    const timestamp = new Date().toISOString();
    const staged = [];
    const responses = [];

    for (const item of prepared) {
      const existing = findNote(snapshot, item.noteUid)?.note;
      if (existing) {
        if (existing.sourceImageHash && existing.sourceImageHash !== item.imageHash) {
          throw new HttpError(409, 'noteUid was already used for another image.', 'SAVE_OPERATION_REUSED');
        }
        const existingPath = typeof existing.filePath === 'string' && existing.filePath.startsWith('github://')
          ? existing.filePath.slice('github://'.length) : item.repoPath;
        responses.push(buildSavedImageResponse(existing, item.image, existingPath, true));
        continue;
      }
      if (snapshot.deletedNotes[item.noteUid]) throw new HttpError(409, 'Learning note is deleted.', 'NOTE_DELETED');
      const note = {
        ...createSavedImageNote(
          { ...item.payload, sourceType: item.payload.sourceType || 'single-capture' },
          { repoPath: item.repoPath },
          timestamp,
        ),
        sourceImageHash: item.imageHash,
      };
      appendSavedImageNote(snapshot, note);
      staged.push({ ...item, note });
      responses.push(buildSavedImageResponse(note, item.image, item.repoPath, false));
    }

    if (staged.length === 0) {
      return { ok: true, notes: responses, learningData: snapshot, idempotentReplay: true };
    }

    const stored = {
      ...snapshot,
      revision: Number(snapshot.revision || 0) + 1,
      updatedAt: timestamp,
    };
    const files = [
      ...staged.map((item) => ({ path: item.repoPath, content: item.image.bytes })),
      { path: STORAGE_PATHS.learning, content: `${JSON.stringify(stored, null, 2)}\n` },
    ];

    try {
      await commitFiles(env, {
        expectedHeadSha: head,
        message: staged.length === 1
          ? `cloud: save note ${staged[0].noteUid}`
          : `cloud: save ${staged.length} captured questions`,
        files,
      });
    } catch (error) {
      if (error instanceof HttpError && error.code === 'GITHUB_REVISION_CONFLICT' && attempt < 3) continue;
      throw error;
    }

    const backgroundWork = finishSavedImagesInBackground(env, staged, responses, timestamp);
    if (ctx?.waitUntil) ctx.waitUntil(backgroundWork);
    else await backgroundWork;
    return { ok: true, notes: responses, learningData: stored, idempotentReplay: false };
  }
  throw new HttpError(409, 'GitHub repository changed while saving; retry.', 'GITHUB_REVISION_CONFLICT');
}

export async function saveNote(env, payload, ctx) {
  const batch = await saveNoteBatch(env, { notes: [payload] }, ctx);
  return {
    ...batch.notes[0],
    learningData: batch.learningData,
    idempotentReplay: batch.idempotentReplay || batch.notes[0]?.idempotentReplay === true,
  };
}`;

media = replaceRegexOnce(
  media,
  /export async function saveNote\(env, payload, ctx\) \{[\s\S]*?\n\}\n\nfunction snapshotNote/,
  `${fastSaveImplementation}\n\nfunction snapshotNote`,
  'replace synchronous save-note implementation',
);
write('cloudflare/media.js', media);

let worker = read('cloudflare/worker.js');
worker = replaceOnce(
  worker,
  "import { getNoteFile, saveMaterialNote, saveNote } from './media.js';",
  "import { getNoteFile, saveMaterialNote, saveNote, saveNoteBatch } from './media.js';",
  'worker media imports',
);

const streamHelper = String.raw`function streamQuestionDetection(env, payload) {
  const encoder = new TextEncoder();
  let timer = null;
  let closed = false;
  const stream = new ReadableStream({
    start(controller) {
      const send = (value) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)); }
        catch { closed = true; }
      };
      send({ type: 'progress', message: '2/4 已连接 AI，正在读取局域网控制面…' });
      timer = setInterval(() => {
        send({ type: 'progress', message: '2/4 AI 仍在识别，连接正常，请保持当前页面…', at: new Date().toISOString() });
      }, 4000);
      Promise.resolve(detectQuestions(env, payload)).then((result) => {
        send({ type: 'result', result });
      }).catch((error) => {
        send({
          type: 'error',
          code: error instanceof HttpError ? error.code : 'QUESTION_DETECTION_FAILED',
          error: error instanceof Error ? error.message : String(error),
        });
      }).finally(() => {
        if (timer !== null) clearInterval(timer);
        timer = null;
        if (!closed) {
          closed = true;
          try { controller.close(); } catch {}
        }
      });
    },
    cancel() {
      closed = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'private, no-store, no-transform',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    },
  });
}

`;
worker = replaceOnce(worker, 'async function handleApi(request, env, pathname, url, ctx) {', `${streamHelper}async function handleApi(request, env, pathname, url, ctx) {`, 'insert streaming detector');
worker = replaceOnce(
  worker,
  "  if (request.method === 'POST' && pathname === '/ai/detect-questions') {\n    return json(await detectQuestions(env, await readJson(request, 28 * 1024 * 1024)));\n  }",
  "  if (request.method === 'POST' && pathname === '/ai/detect-questions/stream') {\n    return streamQuestionDetection(env, await readJson(request, 28 * 1024 * 1024));\n  }\n  if (request.method === 'POST' && pathname === '/ai/detect-questions') {\n    return json(await detectQuestions(env, await readJson(request, 28 * 1024 * 1024)));\n  }",
  'worker streaming route',
);
worker = replaceOnce(
  worker,
  "  if (request.method === 'POST' && pathname === '/save-note') {",
  "  if (request.method === 'POST' && pathname === '/save-note-batch') {\n    const result = await saveNoteBatch(env, await readJson(request, 64 * 1024 * 1024), ctx);\n    return json(result, result.idempotentReplay ? 200 : 202);\n  }\n  if (request.method === 'POST' && pathname === '/save-note') {",
  'worker batch save route',
);
write('cloudflare/worker.js', worker);

let notes = read('src/utils/notes.ts');
notes = replaceOnce(
  notes,
  "export interface DetectQuestionResult {",
  "export interface SaveNoteBatchResult {\n  ok: boolean;\n  notes: SaveNoteResult[];\n  learningData?: LearningDataSnapshot;\n  idempotentReplay?: boolean;\n  error?: string;\n}\n\nexport interface DetectQuestionResult {",
  'notes batch result type',
);
notes = replaceOnce(
  notes,
  "export const saveLearningMaterial = async (payload: SaveMaterialPayload): Promise<SaveMaterialResult> => {",
  "export const saveNoteImagesBatch = async (payloads: SaveNotePayload[]): Promise<SaveNoteBatchResult> => {\n  if (!Array.isArray(payloads) || payloads.length === 0) throw new Error('没有可保存的题目。');\n  const notes = payloads.map((payload) => ({ subject: '默认文件夹', remark: '', ...payload, noteUid: payload.noteUid || createNoteUid() }));\n  return fetchJsonWithTimeout<SaveNoteBatchResult>(`${NOTE_SERVER_URL}/save-note-batch`, {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ notes }),\n  }, 90_000);\n};\n\nexport const saveLearningMaterial = async (payload: SaveMaterialPayload): Promise<SaveMaterialResult> => {",
  'notes batch save client',
);

const streamingClient = String.raw`const detectQuestionRegionsOnce = async (
  imageDataUrl: string,
  onProgress?: (message: string) => void,
): Promise<DetectQuestionResult> => {
  const size = await getImageDimensions(imageDataUrl);
  if (!IS_CLOUD_RUNTIME) {
    return fetchJsonWithTimeout<DetectQuestionResult>(`${NOTE_SERVER_URL}/ai/detect-questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl, imageWidth: size.width, imageHeight: size.height }),
    }, AI_REQUEST_TIMEOUT_MS);
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), AI_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${NOTE_SERVER_URL}/ai/detect-questions/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      signal: controller.signal,
      body: JSON.stringify({ imageDataUrl, imageWidth: size.width, imageHeight: size.height }),
    });
    if (!response.ok) {
      const failed = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(failed?.error || `服务返回 ${response.status}`);
    }
    if (!response.body) throw new Error('浏览器没有返回 AI 识别数据流。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as {
          type?: string;
          message?: string;
          error?: string;
          result?: DetectQuestionResult;
        };
        if (message.type === 'progress' && message.message) onProgress?.(message.message);
        if (message.type === 'error') throw new Error(message.error || 'AI 多题识别失败。');
        if (message.type === 'result' && message.result) return message.result;
      }
      if (done) break;
    }
    throw new Error('AI 识别连接结束，但没有返回裁剪结果。');
  } catch (error) {
    if (controller.signal.aborted) throw new Error('AI 识别超时，请缩小预裁剪范围后重试。');
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
};

export const detectQuestionRegions = async (
  imageDataUrl: string,
  onProgress?: (message: string) => void,
): Promise<DetectQuestionResult> => {
  try {
    return await detectQuestionRegionsOnce(imageDataUrl, onProgress);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!IS_CLOUD_RUNTIME || !/load failed|failed to fetch|network/i.test(message)) throw error;
    onProgress?.('2/4 连接短暂中断，正在自动重新建立 AI 识别连接…');
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    return detectQuestionRegionsOnce(imageDataUrl, onProgress);
  }
};`;
notes = replaceRegexOnce(
  notes,
  /export const detectQuestionRegions = async \(imageDataUrl: string\): Promise<DetectQuestionResult> => \{[\s\S]*?\n\};/,
  streamingClient,
  'replace direct AI detection client',
);
write('src/utils/notes.ts', notes);

let crop = read('src/utils/imageCrop.ts');
crop = replaceOnce(crop, '  maxDimension = 2600,\n): Promise<string> => {', '  maxDimension = 2600,\n  quality = 0.94,\n): Promise<string> => {', 'image crop quality parameter');
crop = replaceOnce(crop, "  return canvas.toDataURL('image/jpeg', 0.94);", "  return canvas.toDataURL('image/jpeg', Math.min(0.96, Math.max(0.72, quality)));", 'image crop quality usage');
crop = replaceOnce(
  crop,
  "export const cropManyImages = async (\n  src: string,\n  crops: NormalizedCrop[],\n): Promise<string[]> => {\n  const results: string[] = [];\n  for (const crop of crops) results.push(await cropImageDataUrl(src, crop));",
  "export const cropManyImages = async (\n  src: string,\n  crops: NormalizedCrop[],\n  maxDimension = 2200,\n  quality = 0.9,\n): Promise<string[]> => {\n  const results: string[] = [];\n  for (const crop of crops) results.push(await cropImageDataUrl(src, crop, maxDimension, quality));",
  'image batch compression controls',
);
write('src/utils/imageCrop.ts', crop);

let drop = read('src/components/NoteDropApp.tsx');
drop = replaceOnce(drop, '  saveNoteImage,\n', '  saveNoteImage,\n  saveNoteImagesBatch,\n', 'NoteDropApp batch import');
drop = replaceOnce(
  drop,
  "      setStatus('');\n      const result = await saveImageReliably({",
  "      setStatus(IS_CLOUD_RUNTIME ? '正在一次性保存图片与学习记录…' : '');\n      const result = await saveImageReliably({",
  'single save progress',
);
drop = replaceOnce(drop, '      const src = await cropImageDataUrl(sourceImage.src, crop);', '      const src = await cropImageDataUrl(sourceImage.src, crop, 2000, 0.9);', 'single mobile compression');
drop = replaceOnce(
  drop,
  '      const detection = await detectQuestionRegions(src);',
  "      const detection = await detectQuestionRegions(src, (message) => {\n        if (detectionRunRef.current === runId) setBatchProgress(message);\n      });",
  'streaming detection progress',
);
drop = replaceOnce(drop, '      const images = await cropManyImages(src, detection.regions);', '      const images = await cropManyImages(src, detection.regions, 1800, 0.9);', 'batch crop compression');
drop = replaceOnce(drop, '      const src = await cropImageDataUrl(sourceImage.src, crop, 2200);', '      const src = await cropImageDataUrl(sourceImage.src, crop, 2200, 0.88);', 'multi source compression');
drop = replaceOnce(drop, '      const src = await cropImageDataUrl(batchImages[batchCropIndex].src, crop);', '      const src = await cropImageDataUrl(batchImages[batchCropIndex].src, crop, 1800, 0.9);', 'manual batch crop compression');

const batchReliableHelper = String.raw`
  const saveBatchReliably = async (
    payloads: Parameters<typeof saveNoteImagesBatch>[0],
    onRetry: (message: string) => void,
  ) => {
    try {
      return await saveNoteImagesBatch(payloads);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = IS_CLOUD_RUNTIME && /load failed|failed to fetch|network|请求超时/i.test(message);
      if (!retryable) throw error;
      onRetry('批次连接中断，正在用同一批 noteUid 自动确认结果…');
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      return saveNoteImagesBatch(payloads);
    }
  };
`;
drop = replaceOnce(drop, '  const saveSingle = async () => {', `${batchReliableHelper}\n  const saveSingle = async () => {`, 'insert batch reliable helper');

const fastBatchSave = String.raw`  const saveBatch = async () => {
    const selected = batchImages.filter((item) => item.enabled);
    if (selected.length === 0 || saving) {
      setDialogError('请至少保留一道题。');
      return;
    }
    const payloads = selected.map((item, index) => ({
      imageDataUrl: item.src,
      kind: 'single' as const,
      noteUid: item.noteUid,
      subject: '默认文件夹',
      remark: '',
      sourceType: 'ai-multi-question',
      sourceBatchId: sourceImage?.noteUid || '',
      sourceSplitIndex: index + 1,
      tags: ['AI多题拆分'],
    }));
    try {
      setSaving(true);
      setDialogError('');
      if (IS_CLOUD_RUNTIME) {
        setBatchProgress(`正在一次性上传并归档 ${selected.length} 道题…`);
        const result = await saveBatchReliably(payloads, setBatchProgress);
        if (result.learningData) saveLearningDataCache(result.learningData);
      } else {
        let latestSnapshot = null;
        for (let index = 0; index < payloads.length; index += 1) {
          setBatchProgress(`正在保存 ${index + 1}/${payloads.length}…`);
          const result = await saveImageReliably(payloads[index], setBatchProgress);
          if (result.learningData) {
            latestSnapshot = result.learningData;
            saveLearningDataCache(result.learningData);
          }
        }
        if (latestSnapshot) saveLearningDataCache(latestSnapshot);
      }
      setSaved(true);
      setStatus(`已保存 ${selected.length} 道题，AI 正在后台按局域网规则命名`);
      setBatchProgress('');
      setMobileStep('success');
    } catch (error) {
      setDialogError(error instanceof Error ? `批量保存失败：${error.message}` : '批量保存失败，请重试。');
      setBatchProgress('');
    } finally {
      setSaving(false);
    }
  };`;
drop = replaceRegexOnce(
  drop,
  /  const saveBatch = async \(\) => \{[\s\S]*?\n  \};\n\n  const cancelPending/,
  `${fastBatchSave}\n\n  const cancelPending`,
  'replace sequential batch save',
);
write('src/components/NoteDropApp.tsx', drop);

const testPath = path.join(root, 'scripts', 'cloud-capture-fast-pipeline.test.cjs');
fs.writeFileSync(testPath, String.raw`'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('cloud capture uses one atomic batch commit', () => {
  const media = read('cloudflare/media.js');
  const worker = read('cloudflare/worker.js');
  const store = read('cloudflare/github-store.js');
  assert.match(media, /export async function saveNoteBatch/);
  assert.match(media, /STORAGE_PATHS\.learning/);
  assert.match(media, /cloud: save \$\{staged\.length\} captured questions/);
  assert.match(worker, /pathname === '\/save-note-batch'/);
  assert.match(store, /const tree = await Promise\.all\(files\.map/);
});

test('mobile multi-question detection keeps Safari connection alive', () => {
  const worker = read('cloudflare/worker.js');
  const notes = read('src/utils/notes.ts');
  assert.match(worker, /application\/x-ndjson/);
  assert.match(worker, /AI 仍在识别，连接正常/);
  assert.match(notes, /ai\/detect-questions\/stream/);
  assert.match(notes, /response\.body\.getReader\(\)/);
});

test('mobile batch save no longer performs cloud saves one by one', () => {
  const app = read('src/components/NoteDropApp.tsx');
  const start = app.indexOf('const saveBatch = async () =>');
  const end = app.indexOf('const cancelPending', start);
  const block = app.slice(start, end);
  assert.match(block, /saveNoteImagesBatch|saveBatchReliably/);
  assert.match(block, /正在一次性上传并归档/);
  assert.match(app, /cropManyImages\(src, detection\.regions, 1800, 0\.9\)/);
});
`, 'utf8');

for (const relative of [
  'cloudflare/github-store.js',
  'cloudflare/media.js',
  'cloudflare/worker.js',
  'src/utils/notes.ts',
  'src/utils/imageCrop.ts',
  'src/components/NoteDropApp.tsx',
  'scripts/cloud-capture-fast-pipeline.test.cjs',
]) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`missing generated file: ${relative}`);
}

console.log('mobile capture fast pipeline patch applied');
