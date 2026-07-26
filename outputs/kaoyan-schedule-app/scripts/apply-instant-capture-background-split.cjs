const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const write = (relative, content) => fs.writeFileSync(path.join(root, relative), content, 'utf8');

function replaceOnce(relative, search, replacement, label) {
  const source = read(relative);
  if (!source.includes(search)) throw new Error(`${label}: target not found in ${relative}`);
  const next = source.replace(search, replacement);
  if (next === source) throw new Error(`${label}: replacement made no change in ${relative}`);
  write(relative, next);
}

function replaceRegex(relative, pattern, replacement, label) {
  const source = read(relative);
  if (!pattern.test(source)) throw new Error(`${label}: regex target not found in ${relative}`);
  const next = source.replace(pattern, replacement);
  if (next === source) throw new Error(`${label}: replacement made no change in ${relative}`);
  write(relative, next);
}

const noteDrop = 'src/components/NoteDropApp.tsx';
replaceOnce(
  noteDrop,
  "import { resumeMultiQuestionJobs } from '../utils/noteBackgroundJobs';",
  "import { enqueueMultiQuestionJob, resumeMultiQuestionJobs } from '../utils/noteBackgroundJobs';",
  'import background enqueue',
);
replaceOnce(
  noteDrop,
  `  useEffect(() => {\n    if (!IS_CLOUD_RUNTIME) return undefined;\n    const disposeResumer = installCaptureUploadResumer();\n    const disposeSubscription = subscribeCaptureUploads(setUploadSummary);\n    return () => {\n      disposeSubscription();\n      disposeResumer();\n    };\n  }, []);`,
  `  useEffect(() => {\n    const disposeResumer = installCaptureUploadResumer();\n    const disposeSubscription = subscribeCaptureUploads(setUploadSummary);\n    return () => {\n      disposeSubscription();\n      disposeResumer();\n    };\n  }, []);`,
  'enable outbox for local and cloud',
);
replaceRegex(
  noteDrop,
  /  const saveSingle = async \(\) => \{[\s\S]*?\n  \};\n\n  const confirmSingleCrop/,
  `  const saveSingle = async () => {\n    if (!pendingImage || saving) return;\n    const payload = {\n      imageDataUrl: pendingImage.src,\n      kind: 'single' as const,\n      noteUid: pendingImage.noteUid,\n      remark,\n      sourceType: 'single-capture',\n    };\n    try {\n      setSaving(true);\n      setSaved(false);\n      setDialogError('');\n      await enqueueCaptureUpload([payload]);\n      setPendingImage(null);\n      setRemark('');\n      setSaved(true);\n      setStatus('图片已安全保存在本机，后台自动上传和整理；现在可以立即关闭或继续拍题');\n      if (isMobileCapture) setMobileStep('success');\n    } catch (error) {\n      const message = error instanceof Error\n        ? \`保存失败：\${error.message}\`\n        : '无法写入本机后台队列，请释放存储空间后重试。';\n      setDialogError(message);\n      setStatus(message);\n    } finally {\n      setSaving(false);\n    }\n  };\n\n  const confirmSingleCrop`,
  'make single capture instant',
);
replaceRegex(
  noteDrop,
  /  const startMultiQuestion = async \(\) => \{[\s\S]*?\n  \};\n\n  const confirmBatchCrop/,
  `  const startMultiQuestion = async () => {\n    if (!sourceImage || saving) return;\n    try {\n      setSaving(true);\n      setSaved(false);\n      setDialogError('');\n      await enqueueMultiQuestionJob(sourceImage.src, {\n        subject: batchSubject,\n        remark: batchRemark,\n      });\n      setSourceImage(null);\n      setBatchImages([]);\n      setBatchProgress('');\n      setSaved(true);\n      setStatus('整页原图已安全保存在本机；AI 会在后台自动拆分并保存，无需停留或逐题确认');\n      setMobileStep('success');\n    } catch (error) {\n      setDialogError(error instanceof Error ? error.message : '无法加入后台多题队列，请重试。');\n      setMobileStep('mode');\n    } finally {\n      setSaving(false);\n    }\n  };\n\n  const confirmBatchCrop`,
  'queue multi question in background',
);
replaceRegex(
  noteDrop,
  /  const saveBatch = async \(\) => \{[\s\S]*?\n  \};\n\n  const cancelPending/,
  `  const saveBatch = async () => {\n    const selected = batchImages.filter((item) => item.enabled);\n    if (selected.length === 0 || saving) {\n      setDialogError('请至少保留一道题。');\n      return;\n    }\n    const payloads = selected.map((item, index) => ({\n      imageDataUrl: item.src,\n      kind: 'single' as const,\n      noteUid: item.noteUid,\n      subject: batchSubject,\n      remark: batchRemark,\n      sourceType: 'ai-multi-question',\n      sourceBatchId: sourceImage?.noteUid || '',\n      sourceSplitIndex: index + 1,\n      tags: ['AI多题拆分'],\n    }));\n    try {\n      setSaving(true);\n      setDialogError('');\n      await enqueueCaptureUpload(payloads);\n      setSaved(true);\n      setStatus(\`\${selected.length} 道题已安全保存在本机，后台自动上传；现在可以立即关闭\`);\n      setBatchProgress('');\n      setMobileStep('success');\n    } catch (error) {\n      setDialogError(error instanceof Error ? \`批量保存失败：\${error.message}\` : '批量保存失败，请重试。');\n      setBatchProgress('');\n    } finally {\n      setSaving(false);\n    }\n  };\n\n  const cancelPending`,
  'make manual batch atomic and instant',
);
replaceOnce(
  noteDrop,
  `<button className="ai" type="button" onClick={() => setMobileStep('multi-crop')}>\n              <span><Layers3 size={22} /></span>\n              <strong>多题模式</strong>\n              <small>先预裁剪整页；AI 在当前页识别，保存后后台命名</small>\n              <em><Sparkles size={13} />AI</em>\n            </button>`,
  `<button className="ai" type="button" onClick={() => void startMultiQuestion()} disabled={saving}>\n              <span><Layers3 size={22} /></span>\n              <strong>{saving ? '正在加入后台…' : '多题自动拆分'}</strong>\n              <small>原图先秒存；AI 后台拆分并自动保存，不再逐题确认</small>\n              <em><Sparkles size={13} />AI</em>\n            </button>`,
  'remove forced multi confirmation',
);
replaceOnce(
  noteDrop,
  '<FilePlus2 size={21} /><span><strong>文字 / 多资料速记</strong><small>可附 PDF、Word、HTML 或多张图片</small></span>',
  '<FilePlus2 size={21} /><span><strong>速记</strong><small>文字、图片、PDF、Word、HTML 和多资料组合</small></span>',
  'rename mobile quick entry',
);
replaceOnce(
  noteDrop,
  '<button type="button" onClick={() => setMaterialOpen(true)}><FilePlus2 size={15} /><span>资料</span></button>',
  '<button type="button" onClick={() => setMaterialOpen(true)}><FilePlus2 size={15} /><span>速记</span></button>',
  'rename desktop quick entry',
);

write('src/utils/noteBackgroundJobs.ts', `import { cropImageDataUrl, cropManyImages } from './imageCrop';
import { createNoteUid, detectQuestionRegions, type SaveNotePayload } from './notes';
import { enqueueCaptureUpload } from './captureUploadQueue';

export type MultiQuestionJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface MultiQuestionJob {
  id: string;
  imageDataUrl: string;
  subject: string;
  remark: string;
  status: MultiQuestionJobStatus;
  progress: number;
  message: string;
  error: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  detectedCount: number;
  savedNoteUids: string[];
  feedbackNoteUid: string;
}

const DB_NAME = 'kaoyan-note-background-v1';
const STORE_NAME = 'multi-question-jobs';
const DB_VERSION = 1;
const EVENT_NAME = 'kaoyan-multi-question-job-changed';
const MAX_AUTO_ATTEMPTS = 2;
const AUTO_RETRY_DELAY_MS = 3_000;
const FULL_PAGE = { x: 0, y: 0, width: 1, height: 1 } as const;
let databasePromise: Promise<IDBDatabase> | null = null;
const activeJobs = new Set<string>();

const emit = (job: MultiQuestionJob) => {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: job }));
};

const openDatabase = (): Promise<IDBDatabase> => {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('当前浏览器不支持可靠后台队列。'));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('后台队列数据库打开失败。'));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
  });
  return databasePromise;
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('后台队列读写失败。'));
});

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error ?? new Error('后台队列事务已中止。'));
  transaction.onerror = () => reject(transaction.error ?? new Error('后台队列事务失败。'));
});

const putJob = async (job: MultiQuestionJob): Promise<MultiQuestionJob> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const committed = transactionDone(transaction);
  await requestResult(transaction.objectStore(STORE_NAME).put(job));
  await committed;
  emit(job);
  return job;
};

const readJobs = async (): Promise<MultiQuestionJob[]> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  return requestResult(transaction.objectStore(STORE_NAME).getAll()) as Promise<MultiQuestionJob[]>;
};

const readJob = async (id: string): Promise<MultiQuestionJob | null> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  return (await requestResult(transaction.objectStore(STORE_NAME).get(id)) as MultiQuestionJob | undefined) ?? null;
};

const removeJob = async (id: string): Promise<void> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const committed = transactionDone(transaction);
  await requestResult(transaction.objectStore(STORE_NAME).delete(id));
  await committed;
};

const patchJob = async (id: string, patch: Partial<MultiQuestionJob>): Promise<MultiQuestionJob> => {
  const current = await readJob(id);
  if (!current) throw new Error('后台多题任务不存在。');
  return putJob({
    ...current,
    subject: current.subject || '默认文件夹',
    remark: current.remark || '',
    feedbackNoteUid: current.feedbackNoteUid || '',
    ...patch,
    updatedAt: new Date().toISOString(),
  });
};

const safeJobToken = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);

const saveFailureFeedback = async (job: MultiQuestionJob, errorText: string): Promise<string> => {
  const noteUid = \`multi_failure_\${safeJobToken(job.id)}\`.slice(0, 150);
  await enqueueCaptureUpload([{
    imageDataUrl: job.imageDataUrl,
    kind: 'single',
    noteUid,
    subject: job.subject || '默认文件夹',
    remark: [
      'AI 自动裁剪失败，原图已保留到待确认。',
      \`失败原因：\${errorText || '未知错误'}\`,
      '可在学习中心保留原图，或重新触发后台拆分。',
    ].join('\\n'),
    sourceType: 'ai-multi-question-failure',
    sourceBatchId: job.id,
    tags: ['AI自动裁剪失败', '待确认'],
  }]);
  return noteUid;
};

const materializeFinalFailureFeedback = async (job: MultiQuestionJob): Promise<void> => {
  if (!job.imageDataUrl || job.feedbackNoteUid) return;
  try {
    const feedbackNoteUid = await saveFailureFeedback(job, job.error || '历史自动裁剪任务失败。');
    await patchJob(job.id, { status: 'failed', message: '自动裁剪失败，原图已加入后台保存队列', feedbackNoteUid });
  } catch (error) {
    const feedbackError = error instanceof Error ? error.message : String(error);
    await patchJob(job.id, {
      status: 'failed',
      message: '自动裁剪失败；原图仍保留在本机任务中，可重新打开后重试',
      error: [job.error, \`反馈保存失败：\${feedbackError}\`].filter(Boolean).join('；'),
    });
  }
};

const processJob = async (id: string): Promise<void> => {
  if (activeJobs.has(id)) return;
  const initial = await readJob(id);
  if (!initial || initial.status === 'completed' || !initial.imageDataUrl) return;
  if (initial.attempts >= MAX_AUTO_ATTEMPTS && initial.status === 'failed') return;

  activeJobs.add(id);
  let retryAfterFailure = false;
  try {
    const attempt = initial.attempts + 1;
    await patchJob(id, { status: 'processing', attempts: attempt, progress: 4, message: '正在后台准备轻量识别图', error: '' });

    // AI 只读取压缩后的轻量图，坐标仍是 0-1，最终裁剪始终使用本机保存的原图。
    const detectionImage = await cropImageDataUrl(initial.imageDataUrl, FULL_PAGE, 1500, 0.72);
    await patchJob(id, { progress: 10, message: 'AI 正在后台识别完整题目单元' });
    const detection = await detectQuestionRegions(detectionImage);
    if (!Array.isArray(detection.regions) || detection.regions.length < 1) {
      throw new Error('AI 没有识别到可裁剪的完整题目区域。');
    }

    await patchJob(id, {
      detectedCount: detection.regions.length,
      progress: 45,
      message: \`已识别 \${detection.regions.length} 个完整题目单元，正在从原图裁剪\`,
    });
    const images = await cropManyImages(initial.imageDataUrl, detection.regions, 1800, 0.86);
    if (images.length < 1) throw new Error('识别到了题目区域，但没有生成有效裁剪。');

    const batchToken = safeJobToken(id);
    const payloads: SaveNotePayload[] = images.map((imageDataUrl, index) => ({
      imageDataUrl,
      kind: 'single',
      noteUid: \`multi_\${batchToken}_\${index + 1}\`.slice(0, 150),
      subject: initial.subject || '默认文件夹',
      remark: initial.remark || '',
      sourceType: 'ai-multi-question',
      sourceBatchId: id,
      sourceSplitIndex: index + 1,
      tags: ['AI多题拆分'],
    }));

    await patchJob(id, { progress: 82, message: \`正在把 \${payloads.length} 道题一次性写入本机上传队列\` });
    await enqueueCaptureUpload(payloads);
    const savedNoteUids = payloads.map((item) => item.noteUid || '').filter(Boolean);
    const completed = await patchJob(id, {
      imageDataUrl: '',
      status: 'completed',
      progress: 100,
      message: \`已自动生成并排队保存 \${savedNoteUids.length} 道题；无需人工确认\`,
      error: '',
      completedAt: new Date().toISOString(),
      savedNoteUids,
    });
    window.setTimeout(() => { void removeJob(completed.id); }, 24 * 60 * 60 * 1000);
  } catch (error) {
    const current = await readJob(id);
    const errorText = error instanceof Error ? error.message : String(error);
    const finalFailure = Number(current?.attempts || 0) >= MAX_AUTO_ATTEMPTS;
    let feedbackNoteUid = current?.feedbackNoteUid || '';
    let feedbackError = '';
    if (finalFailure && initial.imageDataUrl && !feedbackNoteUid) {
      try { feedbackNoteUid = await saveFailureFeedback({ ...initial, ...current }, errorText); }
      catch (failure) { feedbackError = failure instanceof Error ? failure.message : String(failure); }
    }
    await patchJob(id, {
      status: 'failed',
      progress: current?.progress || 0,
      message: finalFailure
        ? feedbackNoteUid ? '自动裁剪失败，原图已加入后台保存队列' : '自动裁剪失败；原图仍保留在本机任务中'
        : '后台处理暂时失败，3 秒后自动重试',
      error: [errorText, feedbackError ? \`反馈保存失败：\${feedbackError}\` : ''].filter(Boolean).join('；'),
      feedbackNoteUid,
    });
    retryAfterFailure = !finalFailure;
  } finally {
    activeJobs.delete(id);
    if (retryAfterFailure) window.setTimeout(() => { void processJob(id); }, AUTO_RETRY_DELAY_MS);
  }
};

export const enqueueMultiQuestionJob = async (
  imageDataUrl: string,
  options: { subject?: string; remark?: string } = {},
): Promise<MultiQuestionJob> => {
  const now = new Date().toISOString();
  const id = \`batch_\${createNoteUid()}\`;
  const job: MultiQuestionJob = {
    id,
    imageDataUrl,
    subject: options.subject?.trim() || '默认文件夹',
    remark: options.remark?.trim() || '',
    status: 'queued',
    progress: 0,
    message: '整页原图已安全保存在本机后台队列',
    error: '',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: '',
    detectedCount: 0,
    savedNoteUids: [],
    feedbackNoteUid: '',
  };
  await putJob(job);
  try { await navigator.storage?.persist?.(); } catch {}
  window.setTimeout(() => { void processJob(id); }, 0);
  return job;
};

export const resumeMultiQuestionJobs = async (): Promise<void> => {
  let jobs: MultiQuestionJob[];
  try { jobs = await readJobs(); } catch { return; }
  const now = Date.now();
  for (const job of jobs) {
    if (job.status === 'completed') {
      if (job.completedAt && now - new Date(job.completedAt).getTime() > 24 * 60 * 60 * 1000) await removeJob(job.id);
      continue;
    }
    if (job.status === 'processing') await patchJob(job.id, { status: 'queued', message: '正在恢复后台任务' });
    if (job.status === 'failed' && job.attempts >= MAX_AUTO_ATTEMPTS && job.imageDataUrl && !job.feedbackNoteUid) {
      window.setTimeout(() => { void materializeFinalFailureFeedback(job); }, 0);
      continue;
    }
    if (job.status === 'queued' || (job.status === 'failed' && job.attempts < MAX_AUTO_ATTEMPTS)) {
      window.setTimeout(() => { void processJob(job.id); }, 0);
    }
  }
};

export const subscribeMultiQuestionJobs = (listener: (job: MultiQuestionJob) => void): (() => void) => {
  const handler = (event: Event) => listener((event as CustomEvent<MultiQuestionJob>).detail);
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
};
`);

const aiFile = 'cloudflare/ai.js';
replaceOnce(
  aiFile,
  `    containsRequiredDiagram: object?.containsRequiredDiagram !== false && object?.contains_required_diagram !== false,\n  };`,
  `    containsRequiredDiagram: object?.containsRequiredDiagram !== false && object?.contains_required_diagram !== false,\n    containsSolution: object?.containsSolution === true || object?.contains_solution === true,\n    continuationOfPrevious: object?.continuationOfPrevious === true || object?.continuation_of_previous === true,\n    questionKey: String(object?.questionKey ?? object?.question_key ?? object?.questionNumber ?? object?.question_number ?? object?.label ?? '').trim().slice(0, 80),\n  };`,
  'preserve question grouping metadata',
);
replaceOnce(
  aiFile,
  `function regionCandidates(result) {\n  if (Array.isArray(result)) return result;\n  for (const key of ['regions', 'questions', 'objects', 'detections', 'boxes']) {\n    if (Array.isArray(result?.[key])) return result[key];\n  }\n  return [];\n}\n`,
  `function regionCandidates(result) {\n  if (Array.isArray(result)) return result;\n  for (const key of ['regions', 'questions', 'objects', 'detections', 'boxes']) {\n    if (Array.isArray(result?.[key])) return result[key];\n  }\n  return [];\n}\n\nfunction horizontalCoverage(left, right) {\n  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));\n  return width / Math.max(0.0001, Math.min(left.width, right.width));\n}\n\nfunction unionRegion(left, right) {\n  const x1 = Math.min(left.x, right.x);\n  const y1 = Math.min(left.y, right.y);\n  const x2 = Math.max(left.x + left.width, right.x + right.width);\n  const y2 = Math.max(left.y + left.height, right.y + right.height);\n  return {\n    ...left,\n    x: x1, y: y1, width: x2 - x1, height: y2 - y1,\n    confidence: Math.min(left.confidence, right.confidence),\n    completeQuestion: left.completeQuestion !== false || right.completeQuestion !== false,\n    containsStem: left.containsStem !== false || right.containsStem !== false,\n    containsOptions: left.containsOptions !== false || right.containsOptions !== false,\n    containsRequiredDiagram: left.containsRequiredDiagram !== false || right.containsRequiredDiagram !== false,\n    containsSolution: left.containsSolution === true || right.containsSolution === true,\n    continuationOfPrevious: false,\n    questionKey: left.questionKey || right.questionKey || '',\n  };\n}\n\nfunction shouldMergeQuestionFragments(previous, current) {\n  const sameKey = Boolean(previous.questionKey && current.questionKey && previous.questionKey === current.questionKey);\n  if (sameKey) return true;\n  const gap = current.y - (previous.y + previous.height);\n  const aligned = horizontalCoverage(previous, current) >= 0.58;\n  const continuation = current.continuationOfPrevious === true\n    || current.containsSolution === true\n    || current.containsStem === false\n    || current.completeQuestion === false;\n  return continuation && aligned && gap >= -0.025 && gap <= 0.055;\n}\n\nfunction mergeQuestionFragments(candidates) {\n  const merged = [];\n  for (const candidate of candidates) {\n    const previous = merged.at(-1);\n    if (previous && shouldMergeQuestionFragments(previous, candidate)) merged[merged.length - 1] = unionRegion(previous, candidate);\n    else merged.push(candidate);\n  }\n  return merged;\n}\n`,
  'add deterministic fragment merge',
);
replaceOnce(
  aiFile,
  `  const candidates = regionCandidates(result)\n    .map((object) => normalizeBox(object, width, height, settings))\n    .filter(Boolean)\n    .sort((left, right) => left.y - right.y || left.x - right.x);\n  const unique = [];`,
  `  const rawCandidates = regionCandidates(result)\n    .map((object) => normalizeBox(object, width, height, settings))\n    .filter(Boolean)\n    .sort((left, right) => left.y - right.y || left.x - right.x);\n  const candidates = mergeQuestionFragments(rawCandidates);\n  const unique = [];`,
  'merge before quality rejection',
);
replaceOnce(
  aiFile,
  `    candidateCount: candidates.length,`,
  `    candidateCount: rawCandidates.length,`,
  'report raw candidate count',
);
replaceOnce(
  aiFile,
  `    diagramRule: options.includeDiagram !== false ? '必须包含与题干相关的公式、表格和配图。' : '',\n  };`,
  `    diagramRule: options.includeDiagram !== false ? '必须包含与题干相关的公式、表格和配图。' : '',\n  };`,
  'keep splitting variables stable',
);
replaceOnce(
  aiFile,
  `    ...workflow.prompt.instructions.map((line) => fillTemplate(line, variables)).filter(Boolean),\n    fillTemplate(workflow.prompt.outputFormat, variables),`,
  `    ...workflow.prompt.instructions.map((line) => fillTemplate(line, variables)).filter(Boolean),\n    '最高优先级分组规则：同一题号或例号的题干、分析、解答、答案、公式和续接内容必须合成一个区域；从题号开始，到下一题号开始之前结束。',\n    '禁止把“分析”“解”“答案”或同一例题的下半部分单独输出成另一道题。每个区域返回稳定 questionKey；续接片段设置 continuationOfPrevious=true，解答区域设置 containsSolution=true。',\n    fillTemplate(workflow.prompt.outputFormat, variables),`,
  'add hard grouping contract',
);
replaceOnce(
  aiFile,
  `    maxTokens: Number(settings.options.maxTokens) || 1600,`,
  `    maxTokens: Math.min(1200, Math.max(500, Number(settings.options.maxTokens) || 900)),`,
  'cap detection output for latency',
);
replaceOnce(
  aiFile,
  `export const questionDetectionInternals = Object.freeze({ evaluateRegion, normalizeRegions, splittingPrompt });`,
  `export const questionDetectionInternals = Object.freeze({ evaluateRegion, normalizeRegions, splittingPrompt, mergeQuestionFragments });`,
  'export grouping internals',
);

const contracts = 'scripts/agent-workflow-contracts.cjs';
replaceOnce(contracts, "version: 'question-splitting-v4'", "version: 'question-splitting-v5'", 'bump splitting workflow');
replaceOnce(
  contracts,
  `        '不要把同一道题拆成多个区域，也不要把相邻的不同题目合并。',`,
  `        '不要把同一道题拆成多个区域，也不要把相邻的不同题目合并。',\n        '同一题号或例号的题干、分析、解答、答案和续接公式属于一个题目单元；必须从题号开始框到下一题号开始之前。',\n        '禁止把“分析”“解”“答案”或同一例题的下半部分单独输出成另一道题。',`,
  'strengthen shared split instructions',
);
replaceOnce(
  contracts,
  `      outputFormat: '只返回 JSON 对象：{"regions":[{"x":0.0,"y":0.0,"width":0.5,"height":0.3,"confidence":0.95,"completeQuestion":true,"containsStem":true,"containsOptions":true,"containsRequiredDiagram":true}]}',`,
  `      outputFormat: '只返回 JSON 对象：{"regions":[{"x":0.0,"y":0.0,"width":0.5,"height":0.3,"confidence":0.95,"questionKey":"例4.9","completeQuestion":true,"containsStem":true,"containsOptions":true,"containsRequiredDiagram":true,"containsSolution":true,"continuationOfPrevious":false}]}',`,
  'extend split output contract',
);

const learningCenter = 'src/components/LearningCenter.tsx';
replaceOnce(
  learningCenter,
  `import { IS_CLOUD_RUNTIME, NOTE_SERVER_URL } from '../utils/notes';`,
  `import { enqueueLearningNoteRename, IS_CLOUD_RUNTIME, NOTE_SERVER_URL } from '../utils/notes';`,
  'import ai rename action',
);
replaceOnce(
  learningCenter,
  `  const [wrongReasonSaving, setWrongReasonSaving] = useState(false);`,
  `  const [wrongReasonSaving, setWrongReasonSaving] = useState(false);\n  const [aiRenameNoteUid, setAiRenameNoteUid] = useState<string | null>(null);`,
  'add ai rename state',
);
replaceOnce(
  learningCenter,
  `  const copySourcePath = async (filePath: string) => {`,
  `  const renameNoteWithAi = async (note: LearningAutoNote) => {\n    if (aiRenameNoteUid) return;\n    try {\n      setAiRenameNoteUid(note.noteUid);\n      setFeedback('');\n      await enqueueLearningNoteRename(note.noteUid);\n      setFeedback('AI 重命名已加入后台队列；可以继续浏览，完成后标题会自动刷新。');\n    } catch (error) {\n      setFeedback(error instanceof Error ? error.message : 'AI 重命名任务提交失败，请重试。');\n    } finally {\n      setAiRenameNoteUid(null);\n    }\n  };\n\n  const copySourcePath = async (filePath: string) => {`,
  'add ai rename handler',
);
replaceOnce(
  learningCenter,
  `            <button type="button" onClick={() => beginEditNote(note)}><Pencil size={15} />编辑</button>`,
  `            {imagePath && <button type="button" disabled={Boolean(aiRenameNoteUid)} onClick={() => void renameNoteWithAi(note)}><Zap size={15} />{aiRenameNoteUid === note.noteUid ? 'AI处理中…' : 'AI重命名'}</button>}\n            <button type="button" onClick={() => beginEditNote(note)}><Pencil size={15} />编辑</button>`,
  'add ai rename button',
);

const testFile = `const assert = require('assert');\nconst fs = require('fs');\nconst path = require('path');\nconst root = path.resolve(__dirname, '..');\nconst source = (file) => fs.readFileSync(path.join(root, file), 'utf8');\n\n(async () => {\n  const noteDrop = source('src/components/NoteDropApp.tsx');\n  assert.match(noteDrop, /await enqueueMultiQuestionJob\\(sourceImage\\.src/);\n  assert.match(noteDrop, /AI 后台拆分并自动保存，不再逐题确认/);\n  assert.doesNotMatch(noteDrop, /className="ai"[^>]+setMobileStep\\('multi-crop'\\)/);\n  assert.match(noteDrop, /await enqueueCaptureUpload\\(\\[payload\\]\\)/);\n  assert.match(noteDrop, /<span>速记<\\/span>/);\n\n  const jobs = source('src/utils/noteBackgroundJobs.ts');\n  assert.match(jobs, /cropImageDataUrl\\(initial\\.imageDataUrl, FULL_PAGE, 1500, 0\\.72\\)/);\n  assert.match(jobs, /await enqueueCaptureUpload\\(payloads\\)/);\n  assert.doesNotMatch(jobs, /for \\(let index = 0; index < images\\.length/);\n\n  const ai = await import('../cloudflare/ai.js');\n  const settings = { options: { minimumRegionPercent: 3.5, minimumConfidence: 0.5, maxQuestions: 12, edgePaddingPercent: 0 } };\n  const grouped = ai.questionDetectionInternals.normalizeRegions({ regions: [\n    { x: 0.05, y: 0.10, width: 0.90, height: 0.20, confidence: 0.9, questionKey: '例4.9', completeQuestion: true, containsStem: true },\n    { x: 0.05, y: 0.305, width: 0.90, height: 0.20, confidence: 0.88, questionKey: '例4.9', completeQuestion: false, containsStem: false, containsSolution: true, continuationOfPrevious: true },\n    { x: 0.05, y: 0.55, width: 0.90, height: 0.30, confidence: 0.92, questionKey: '例4.10', completeQuestion: true, containsStem: true, containsSolution: true },\n  ] }, 1000, 1500, settings);\n  assert.equal(grouped.accepted.length, 2, 'same numbered question stem and solution must merge');\n  assert.ok(grouped.accepted[0].height > 0.39, 'merged question must cover stem and solution');\n  assert.equal(grouped.candidateCount, 3);\n\n  const learning = source('src/components/LearningCenter.tsx');\n  assert.match(learning, /AI重命名/);\n  assert.match(learning, /enqueueLearningNoteRename\\(note\\.noteUid\\)/);\n  console.log('instant capture background flow: ok');\n})().catch((error) => { console.error(error); process.exit(1); });\n`;
write('scripts/instant-capture-background-flow.test.cjs', testFile);

console.log('instant capture background patch applied');
