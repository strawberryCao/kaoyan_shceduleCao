from pathlib import Path

ROOT = Path('outputs/kaoyan-schedule-app')


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding='utf-8')


def write(relative: str, value: str) -> None:
    (ROOT / relative).write_text(value, encoding='utf-8')


def replace_once(source: str, before: str, after: str, label: str) -> str:
    count = source.count(before)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one anchor, found {count}')
    return source.replace(before, after, 1)


learning = read('cloudflare/learning.js')
learning_insert = r'''
function aiReviewStatus(note) {
  if (['pending', 'auto_applied', 'accepted', 'corrected', 'ignored'].includes(note?.reviewStatus)) return note.reviewStatus;
  if (note?.organizationStatus === 'ignored') return 'ignored';
  if (note?.classificationSource === 'manual') return 'corrected';
  return note?.organizationStatus === 'confirmed' ? 'auto_applied' : 'pending';
}

function aiHumanDecision(note) {
  return ['accepted', 'corrected', 'ignored'].includes(aiReviewStatus(note));
}

function aiCardId(noteUid, sourceKey, index) {
  const key = text(sourceKey, 80).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `item-${index + 1}`;
  return `card-${text(noteUid, 90)}-ai-${key}`.slice(0, 160);
}

function aiCardRecord(note, card, index, timestamp) {
  const sourceKey = text(card.sourceKey, 160) || `ai:root:${index}`;
  return {
    id: aiCardId(note.noteUid, sourceKey, index),
    noteUid: note.noteUid,
    sourceKey,
    kind: card.kind === 'mistake' ? 'mistake' : 'memory',
    front: text(card.front, 500),
    back: text(card.back, 2000),
    subject: note.subject,
    knowledgePath: uniqueStrings(note.knowledgePath).slice(0, 3),
    tags: uniqueStrings(note.tags),
    pageRefs: Array.isArray(note.pageRefs) ? note.pageRefs.slice(0, 100) : [],
    sourceTitle: note.title,
    sourceFilePath: note.filePath,
    status: 'active',
    dueDate: note.capturedDate,
    reviewStep: 0,
    reviewCount: 0,
    lastReviewedAt: '',
    lastReviewResult: '',
    correctCount: 0,
    incorrectCount: 0,
    correctStreak: 0,
    masteredAt: '',
    reviewHistory: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    userEdited: false,
  };
}

export async function applyAiNoteNaming(env, noteUid, input = {}) {
  const timestamp = new Date().toISOString();
  const result = await mutateLearning(env, {}, (snapshot) => {
    const entry = findNote(snapshot, noteUid);
    if (!entry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
    const note = entry.note;
    const userFields = new Set(Array.isArray(note.userEditedFields) ? note.userEditedFields : []);
    const humanDecision = aiHumanDecision(note);
    const generatedTitle = text(input.title, 240).trim();
    const generatedSubject = text(input.subject, 120).trim();
    const title = userFields.has('title') || !generatedTitle ? note.title : generatedTitle;
    const subject = humanDecision || !generatedSubject ? note.subject : generatedSubject;
    const reviewStatus = humanDecision ? aiReviewStatus(note) : subject === '默认文件夹' ? 'pending' : 'auto_applied';
    const updated = {
      ...note,
      title,
      subject,
      knowledgePath: humanDecision
        ? uniqueStrings(note.knowledgePath).slice(0, 3)
        : [subject, ...uniqueStrings(note.knowledgePath).filter((item) => item !== note.subject && item !== subject)].slice(0, 3),
      organizationStatus: reviewStatus === 'ignored' ? 'ignored' : reviewStatus === 'pending' ? 'pending' : 'confirmed',
      classificationSource: humanDecision ? note.classificationSource || 'manual' : 'ai',
      reviewStatus,
      pendingAiOrganization: true,
      aiNaming: {
        provider: text(input.provider, 120),
        model: text(input.model, 160),
        configurationHash: text(input.configurationHash, 128),
        workflowHash: text(input.workflowHash, 128),
        completedAt: timestamp,
      },
      updatedAt: timestamp,
    };
    entry.day.autoNotes[entry.index] = updated;
    snapshot.days[entry.date] = entry.day;
    snapshot.cards = snapshot.cards.map((card) => card.noteUid !== noteUid ? card : {
      ...card,
      subject: updated.subject,
      knowledgePath: updated.knowledgePath,
      sourceTitle: updated.title,
      updatedAt: timestamp,
    });
    return { touchedDates: [entry.date] };
  });
  const updated = findNote(result.snapshot, noteUid)?.note;
  if (updated) await updateMirroredCloudNote(env, updated);
  return result.snapshot;
}

export async function applyAiNoteEnrichment(env, noteUid, input = {}) {
  const timestamp = new Date().toISOString();
  const result = await mutateLearning(env, {}, (snapshot) => {
    const entry = findNote(snapshot, noteUid);
    if (!entry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
    const note = entry.note;
    const userFields = new Set(Array.isArray(note.userEditedFields) ? note.userEditedFields : []);
    const humanDecision = aiHumanDecision(note);
    const ignored = aiReviewStatus(note) === 'ignored';
    const subjectCandidate = text(input.subject, 120).trim();
    const subject = humanDecision || !subjectCandidate ? note.subject : subjectCandidate;
    const knowledgePath = humanDecision
      ? uniqueStrings(note.knowledgePath).slice(0, 3)
      : [subject, ...uniqueStrings(input.knowledgePath).filter((item) => item !== subject)].slice(0, 3);
    const titleCandidate = text(input.title, 240).trim();
    const title = input.preserveTitle === true || userFields.has('title') || !titleCandidate ? note.title : titleCandidate;
    const tags = userFields.has('tags') ? uniqueStrings(note.tags) : uniqueStrings(input.tags);
    const noteType = userFields.has('noteType') ? note.noteType : text(input.noteType, 40) || note.noteType || 'note';
    const wrongReason = humanDecision && note.wrongReasonSource === 'manual' ? note.wrongReason : text(input.wrongReason, 500);
    const reviewStatus = humanDecision ? aiReviewStatus(note) : subject === '默认文件夹' ? 'pending' : 'auto_applied';
    const updated = {
      ...note,
      title,
      subject,
      knowledgePath,
      tags,
      noteType,
      questionType: humanDecision ? note.questionType : text(input.questionType, 60),
      wrongReason,
      wrongReasonSource: humanDecision && note.wrongReasonSource === 'manual'
        ? 'manual'
        : wrongReason ? text(input.wrongReasonSource, 40) || 'ai_inferred' : 'none',
      wrongReasonConfidence: humanDecision && note.wrongReasonSource === 'manual'
        ? null
        : wrongReason && Number.isFinite(Number(input.wrongReasonConfidence))
          ? Math.max(0, Math.min(1, Number(input.wrongReasonConfidence))) : wrongReason ? 0.55 : null,
      organizationStatus: ignored ? 'ignored' : reviewStatus === 'pending' ? 'pending' : 'confirmed',
      classificationSource: humanDecision ? note.classificationSource || 'manual' : 'ai',
      reviewStatus,
      goodQuestion: userFields.has('goodQuestion') ? note.goodQuestion : input.goodQuestion === true,
      items: Array.isArray(input.items) ? input.items.slice(0, 24) : [],
      confidence: Number.isFinite(Number(input.confidence)) ? Math.max(0, Math.min(1, Number(input.confidence))) : 0,
      pendingAiOrganization: false,
      facets: normalizeFacets(note.facets, {
        ...note,
        tags,
        noteType,
        goodQuestion: input.goodQuestion === true,
      }),
      aiAnalysis: {
        taskId: text(input.taskId, 120),
        provider: text(input.provider, 120),
        model: text(input.model, 160),
        reason: text(input.reason, 1000),
        summary: text(input.summary, 2000),
        configurationHash: text(input.configurationHash, 128),
        workflowHash: text(input.workflowHash, 128),
        completedAt: timestamp,
      },
      updatedAt: timestamp,
    };

    const preservedCards = snapshot.cards.filter((card) => card.noteUid !== noteUid || card.userEdited === true || !String(card.sourceKey || '').startsWith('ai:'));
    const generatedCards = ignored ? [] : (Array.isArray(input.cards) ? input.cards : [])
      .map((card, index) => aiCardRecord(updated, card, index, timestamp))
      .filter((card) => card.front.length >= 4 && card.back.length >= 6 && card.front !== card.back);
    const cardIds = [
      ...preservedCards.filter((card) => card.noteUid === noteUid).map((card) => card.id),
      ...generatedCards.map((card) => card.id),
    ];
    updated.cardIds = [...new Set(cardIds)];
    entry.day.autoNotes[entry.index] = updated;
    snapshot.days[entry.date] = entry.day;
    snapshot.cards = [...preservedCards, ...generatedCards];
    return { touchedDates: [entry.date] };
  });
  const updated = findNote(result.snapshot, noteUid)?.note;
  if (updated) await updateMirroredCloudNote(env, updated);
  return result.snapshot;
}

'''
learning = replace_once(learning, 'function addDays(date, days) {', learning_insert + 'function addDays(date, days) {', 'AI learning merge functions')
write('cloudflare/learning.js', learning)

runtime = read('cloudflare/agent-runtime.js')
runtime = replace_once(
    runtime,
    "if (['note_naming', 'question_splitting'].includes(taskId) && !workflow) {",
    "if (['note_naming', 'question_splitting', 'note_enrichment', 'note_image_understanding'].includes(taskId) && !workflow) {",
    'strict workflow task list',
)
write('cloudflare/agent-runtime.js', runtime)

rename = read('cloudflare/rename-job.js')
rename = replace_once(
    rename,
    "import { findNote, getLearningSnapshot, patchNote } from './learning.js';",
    "import { applyAiNoteNaming, findNote, getLearningSnapshot } from './learning.js';",
    'rename AI merge import',
)
rename = replace_once(
    rename,
    """  const snapshot = await patchNote(env, noteUid, { patch: {
    title: generated.title,
    subject: generated.subject,
    knowledgePath: [generated.subject],
  } });
  const updatedNote = findNote(snapshot, noteUid)?.note;
  if (updatedNote) await updateMirroredCloudNote(env, updatedNote);
""",
    """  const snapshot = await applyAiNoteNaming(env, noteUid, {
    title: generated.title,
    subject: generated.subject,
    provider: generated.provider,
    model: generated.model,
    configurationHash: generated.configurationHash,
    workflowHash: generated.workflowHash,
  });
""",
    'rename AI merge call',
)
rename = rename.replace("import { updateMirroredCloudNote } from './source-mirror.js';\n", '')
write('cloudflare/rename-job.js', rename)

media = read('cloudflare/media.js')
media = replace_once(
    media,
    "import { enqueueRenameJob, processBackgroundJob } from './background-jobs.js';",
    "import { enqueueNotePipelineJob, processBackgroundJob } from './background-jobs.js';",
    'media pipeline import',
)
media = replace_once(
    media,
    "const queued = await enqueueRenameJob(env, item.noteUid);",
    "const queued = await enqueueNotePipelineJob(env, item.noteUid);",
    'media enqueue pipeline',
)
media = media.replace("reportBackgroundFailure('cloud_note_batch_naming_failed'", "reportBackgroundFailure('cloud_note_batch_ai_pipeline_failed'")
write('cloudflare/media.js', media)

capture = read('src/components/NoteDropApp.tsx')
capture = replace_once(
    capture,
    "import { resumeMultiQuestionJobs } from '../utils/noteBackgroundJobs';",
    "import { resumeMultiQuestionJobs } from '../utils/noteBackgroundJobs';\nimport { enqueueCaptureUpload, installCaptureUploadResumer, subscribeCaptureUploads, type CaptureUploadSummary } from '../utils/captureUploadQueue';",
    'capture queue import',
)
capture = replace_once(
    capture,
    "  const [materialOpen, setMaterialOpen] = useState(false);",
    "  const [materialOpen, setMaterialOpen] = useState(false);\n  const [uploadSummary, setUploadSummary] = useState<CaptureUploadSummary>({ queued: 0, uploading: 0, failed: 0, completed: 0, message: '' });",
    'capture upload summary state',
)
capture = replace_once(
    capture,
    """  useEffect(() => {
    if (isMobileCapture) void resumeMultiQuestionJobs();
  }, [isMobileCapture]);
""",
    """  useEffect(() => {
    if (isMobileCapture) void resumeMultiQuestionJobs();
  }, [isMobileCapture]);

  useEffect(() => {
    if (!IS_CLOUD_RUNTIME) return undefined;
    const disposeResumer = installCaptureUploadResumer();
    const disposeSubscription = subscribeCaptureUploads(setUploadSummary);
    return () => {
      disposeSubscription();
      disposeResumer();
    };
  }, []);
""",
    'capture queue lifecycle',
)
old_single = r'''  const saveSingle = async () => {
    if (!pendingImage || saving) return;
    try {
      setSaving(true);
      setSaved(false);
      setDialogError('');
      setStatus(IS_CLOUD_RUNTIME ? '正在一次性保存图片与学习记录…' : '');
      const result = await saveImageReliably({
        imageDataUrl: pendingImage.src,
        kind: 'single',
        noteUid: pendingImage.noteUid,
        remark,
      }, setStatus);
      if (result.learningData) saveLearningDataCache(result.learningData);
      setPendingImage(null);
      setRemark('');
      setDialogError('');
      setSaved(true);
      if (IS_CLOUD_RUNTIME) {
        setStatus(result.learningData ? '图片已保存；AI 正在后台按局域网规则命名' : '图片已保存；学习中心与 AI 命名正在后台同步');
        if (isMobileCapture) setMobileStep('success');
      } else {
        const aiMessage = result.aiStatus === 'complete'
          ? 'AI 整理完成'
          : result.aiStatus === 'failed' ? 'AI 将在稍后整理' : 'AI 正在后台整理';
        setStatus(`已保存 · ${aiMessage}`);
      }
    } catch (error) {
      const message = error instanceof Error
        ? `保存失败：${error.message}`
        : IS_CLOUD_RUNTIME ? '保存失败，请稍后重试。' : '保存失败，请确认笔记服务已启动。';
      setDialogError(message);
      setStatus(message);
    } finally {
      setSaving(false);
    }
  };
'''
new_single = r'''  const saveSingle = async () => {
    if (!pendingImage || saving) return;
    const payload = {
      imageDataUrl: pendingImage.src,
      kind: 'single' as const,
      noteUid: pendingImage.noteUid,
      remark,
      sourceType: 'single-capture',
    };
    try {
      setSaving(true);
      setSaved(false);
      setDialogError('');
      if (IS_CLOUD_RUNTIME) {
        await enqueueCaptureUpload([payload]);
        setPendingImage(null);
        setRemark('');
        setSaved(true);
        setStatus('已存入本机后台队列，可以立即退出；命名和完整分类会自动完成');
        if (isMobileCapture) setMobileStep('success');
        return;
      }
      const result = await saveImageReliably(payload, setStatus);
      if (result.learningData) saveLearningDataCache(result.learningData);
      setPendingImage(null);
      setRemark('');
      setDialogError('');
      setSaved(true);
      const aiMessage = result.aiStatus === 'complete'
        ? 'AI 整理完成'
        : result.aiStatus === 'failed' ? 'AI 将在稍后整理' : 'AI 正在后台整理';
      setStatus(`已保存 · ${aiMessage}`);
    } catch (error) {
      const message = error instanceof Error
        ? `保存失败：${error.message}`
        : IS_CLOUD_RUNTIME ? '无法写入本机后台队列，请释放浏览器存储后重试。' : '保存失败，请确认笔记服务已启动。';
      setDialogError(message);
      setStatus(message);
    } finally {
      setSaving(false);
    }
  };
'''
capture = replace_once(capture, old_single, new_single, 'local-first single capture')
old_batch = r'''  const saveBatch = async () => {
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
  };
'''
new_batch = r'''  const saveBatch = async () => {
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
        await enqueueCaptureUpload(payloads);
        setSaved(true);
        setStatus(`${selected.length} 道题已存入本机后台队列，可以立即退出`);
        setBatchProgress('');
        setMobileStep('success');
        return;
      }
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
      setSaved(true);
      setStatus(`已保存 ${selected.length} 道题，AI 正在后台按局域网规则整理`);
      setBatchProgress('');
      setMobileStep('success');
    } catch (error) {
      setDialogError(error instanceof Error ? `批量保存失败：${error.message}` : '批量保存失败，请重试。');
      setBatchProgress('');
    } finally {
      setSaving(false);
    }
  };
'''
capture = replace_once(capture, old_batch, new_batch, 'local-first batch capture')
# Use the queue summary whenever the current operation has no more specific status.
capture = replace_once(
    capture,
    "      setStatus('');\n      if (isMobileCapture) {",
    "      setStatus(uploadSummary.message);\n      if (isMobileCapture) {",
    'surface outbox summary after selecting image',
)
write('src/components/NoteDropApp.tsx', capture)

print('mobile local-first and AI merge transformations applied')
