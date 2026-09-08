import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  ClipboardPaste,
  Crop,
  ExternalLink,
  FileImage,
  FilePlus2,
  ImagePlus,
  Images,
  Layers3,
  LoaderCircle,
  Minus,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  createNoteUid,
  detectQuestionRegions,
  imageFileToCaptureDataUrl,
  IS_CLOUD_RUNTIME,
  NOTE_SERVER_URL,
  fetchNoteVisionModelChoices,
  saveNoteImage,
  saveNoteImagesBatch,
  type NoteAiSelection,
  type NoteVisionModelChoice,
} from '../utils/notes';
import { cropImageDataUrl, cropManyImages, type NormalizedCrop } from '../utils/imageCrop';
import { saveLearningDataCache } from '../utils/learningData';
import {
  completeMultiQuestionReview,
  enqueueMultiQuestionJob,
  loadMultiQuestionJobForReview,
  retryMultiQuestionJob,
  subscribeMultiQuestionJobs,
  type MultiQuestionJob,
} from '../utils/noteBackgroundJobs';
import { enqueueCaptureUpload, getCaptureUploadSummary, subscribeCaptureUploads, type CaptureUploadSummary } from '../utils/captureUploadQueue';
import { fetchWithTimeout } from '../utils/localService';
import { ImageCropEditor } from './ImageCropEditor';
import { QuickMaterialComposer } from './QuickMaterialComposer';
import '../note-drop-mobile.css';

interface PendingImage {
  src: string;
  noteUid: string;
}

interface BatchImage extends PendingImage {
  enabled: boolean;
}

type MobileStep = 'capture' | 'mode' | 'crop' | 'multi-crop' | 'remark' | 'detecting' | 'batch' | 'batch-crop' | 'success';

const imageFilePattern = /\.(jpe?g|png|webp)$/i;

const isImageFile = (file: File) => file.type.startsWith('image/') || imageFilePattern.test(file.name);

const getFirstImage = (files: FileList | null): File | null => {
  if (!files) return null;
  return Array.from(files).find(isImageFile) ?? null;
};

const getClipboardImage = (items: DataTransferItemList): File | null => {
  return Array.from(items).find((item) => item.type.startsWith('image/'))?.getAsFile() ?? null;
};

const clipboardFileExtension = (mime: string): string => {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/svg+xml') return 'svg';
  return mime.split('/')[1]?.replace(/[^a-z0-9.+-]/gi, '') || 'png';
};

const mobileMediaQuery = '(max-width: 760px), (pointer: coarse) and (max-width: 1024px)';
const NOTE_AI_SELECTION_KEY = 'kaoyan.noteApp.aiSelection.v1';
const PROVIDER_LABELS: Record<string, string> = { qwen: '千问', kimi: 'Kimi', gemini: 'Gemini', deepseek: 'DeepSeek' };
const DEFAULT_AI_SELECTION: NoteAiSelection = { mode: 'auto-light' };

const storedAiSelection = (): NoteAiSelection => {
  try {
    const value = JSON.parse(localStorage.getItem(NOTE_AI_SELECTION_KEY) || 'null') as NoteAiSelection | null;
    if (value && ['auto-light', 'auto-advanced', 'model', 'off'].includes(value.mode)) return value;
  } catch {
    // A damaged preference must not block note capture.
  }
  return DEFAULT_AI_SELECTION;
};

const selectionValue = (selection: NoteAiSelection) => selection.mode === 'model'
  ? `model:${selection.providerId || ''}:${selection.modelId || ''}` : selection.mode;

const parseSelectionValue = (value: string): NoteAiSelection => {
  if (value.startsWith('model:')) {
    const [, providerId, ...modelParts] = value.split(':');
    return { mode: 'model', providerId, modelId: modelParts.join(':') };
  }
  return { mode: value as NoteAiSelection['mode'] };
};

function NoteAiSelectionField({ selection, models, disabled, onChange }: {
  selection: NoteAiSelection;
  models: NoteVisionModelChoice[];
  disabled: boolean;
  onChange: (selection: NoteAiSelection) => void;
}) {
  const currentValue = selectionValue(selection);
  const selectedModelAvailable = selection.mode !== 'model' || models.some((model) => (
    `model:${model.providerId}:${model.modelId}` === currentValue
  ));
  return (
    <label className="note-ai-selection">
      <span><Sparkles size={14} />识别 AI <small>会记住选择</small></span>
      <select
        aria-label="选择本次笔记使用的 AI"
        value={currentValue}
        disabled={disabled}
        onChange={(event) => onChange(parseSelectionValue(event.target.value))}
      >
        <option value="auto-light">自动 · 轻量省额度</option>
        <option value="auto-advanced">自动 · 高质量</option>
        {!selectedModelAvailable && selection.mode === 'model' && (
          <option value={currentValue}>
            {PROVIDER_LABELS[selection.providerId || ''] || selection.providerId} · {selection.modelId}（已记住，当前配置未返回）
          </option>
        )}
        {models.map((model) => (
          <option key={`${model.providerId}:${model.modelId}`} value={`model:${model.providerId}:${model.modelId}`}>
            {PROVIDER_LABELS[model.providerId] || model.providerId} · {model.modelId}
          </option>
        ))}
        <option value="off">暂不使用 AI</option>
      </select>
    </label>
  );
}

export function NoteDropApp() {
  const requestedReviewJobId = new URLSearchParams(window.location.search).get('reviewJob') || '';
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const remarkRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dragDepthRef = useRef(0);
  const detectionRunRef = useRef(0);
  const [isMobileCapture, setIsMobileCapture] = useState(() => (
    Boolean(requestedReviewJobId) || (!window.kaoyanDesktop?.isElectron
    && typeof window.matchMedia === 'function'
    && window.matchMedia(mobileMediaQuery).matches)
  ));
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [sourceImage, setSourceImage] = useState<PendingImage | null>(null);
  const [mobileStep, setMobileStep] = useState<MobileStep>('capture');
  const [batchImages, setBatchImages] = useState<BatchImage[]>([]);
  const [batchCropIndex, setBatchCropIndex] = useState<number | null>(null);
  const [remark, setRemark] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [batchProgress, setBatchProgress] = useState('');
  const [batchSubject, setBatchSubject] = useState('默认文件夹');
  const [batchRemark, setBatchRemark] = useState('');
  const [materialOpen, setMaterialOpen] = useState(false);
  const [backgroundJob, setBackgroundJob] = useState<MultiQuestionJob | null>(null);
  const [activeReviewJobId, setActiveReviewJobId] = useState(requestedReviewJobId);
  const [uploadSummary, setUploadSummary] = useState<CaptureUploadSummary>({ queued: 0, uploading: 0, failed: 0, completed: 0, message: '', encrypted: true });
  const [aiSelection, setAiSelection] = useState<NoteAiSelection>(storedAiSelection);
  const [visionModels, setVisionModels] = useState<NoteVisionModelChoice[]>([]);

  useEffect(() => {
    let active = true;
    void fetchNoteVisionModelChoices().then((models) => {
      if (active) setVisionModels(models);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const updateAiSelection = useCallback((next: NoteAiSelection) => {
    setAiSelection(next);
    try { localStorage.setItem(NOTE_AI_SELECTION_KEY, JSON.stringify(next)); } catch { /* local persistence is optional */ }
  }, []);

  useEffect(() => {
    if (requestedReviewJobId) {
      setIsMobileCapture(true);
      return undefined;
    }
    if (window.kaoyanDesktop?.isElectron) {
      setIsMobileCapture(false);
      return undefined;
    }
    if (typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(mobileMediaQuery);
    const update = () => setIsMobileCapture(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, [requestedReviewJobId]);

  const openMultiQuestionReview = useCallback(async (jobId: string) => {
    setSaving(true);
    setDialogError('');
    try {
      const restored = await loadMultiQuestionJobForReview(jobId);
      setActiveReviewJobId(jobId);
      setBackgroundJob(restored.job);
      setSourceImage({ src: restored.imageDataUrl, noteUid: restored.job.sourceEntryId || restored.job.id });
      setBatchSubject(restored.job.subject || '默认文件夹');
      setBatchRemark(restored.job.remark || '');
      setBatchImages([]);
      setBatchProgress('原图已恢复，请先确认整页范围。');
      setSaved(false);
      setMobileStep('multi-crop');
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : '无法恢复这条多题审核任务。');
      setMobileStep('success');
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => {
    if (!requestedReviewJobId) return;
    void openMultiQuestionReview(requestedReviewJobId);
  }, [openMultiQuestionReview, requestedReviewJobId]);

  useEffect(() => {
    if (!isMobileCapture) return undefined;
    const dispose = subscribeMultiQuestionJobs((job) => {
      if (activeReviewJobId && job.id !== activeReviewJobId) return;
      setBackgroundJob(job);
      const progress = job.progress > 0 && !['completed', 'failed', 'needs_review'].includes(job.status)
        ? ` ${job.progress}%`
        : '';
      setStatus(`${job.message || '后台任务状态已更新'}${progress}`);
      if (['failed', 'needs_review'].includes(job.status) && job.error) setDialogError(job.error);
    });
    return dispose;
  }, [activeReviewJobId, isMobileCapture]);

  useEffect(() => {
    if (!IS_CLOUD_RUNTIME) return undefined;
    const disposeSubscription = subscribeCaptureUploads(setUploadSummary);
    void getCaptureUploadSummary().then(setUploadSummary).catch(() => undefined);
    return () => {
      disposeSubscription();
    };
  }, []);

  useEffect(() => {
    if (!window.kaoyanDesktop?.isElectron) return;
    const reportReady = () => {
      void fetchWithTimeout(`${NOTE_SERVER_URL}/note-app-ready`, { method: 'POST' }, 900).catch(() => undefined);
    };
    reportReady();
    const timer = window.setInterval(reportReady, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const resetMobileCapture = useCallback(() => {
    setPendingImage(null);
    setSourceImage(null);
    setBatchImages([]);
    setBatchCropIndex(null);
    setRemark('');
    setSaved(false);
    setStatus('');
    setDialogError('');
    setBatchProgress('');
    setBatchSubject('默认文件夹');
    setBatchRemark('');
    setActiveReviewJobId('');
    setBackgroundJob(null);
    setMobileStep('capture');
  }, []);

  const acceptImage = useCallback(async (file: File | null) => {
    if (saving) return;
    if (!file) {
      const message = '没有检测到图片，请拍照、从相册选择或粘贴图片。';
      setSaved(false);
      setDialogError(message);
      setStatus(message);
      return;
    }

    try {
      const src = await imageFileToCaptureDataUrl(file, 2560);
      const next = { src, noteUid: createNoteUid() };
      setRemark('');
      setSaved(false);
      setDialogError('');
      setStatus(uploadSummary.message);
      if (isMobileCapture) {
        setSourceImage(next);
        setPendingImage(null);
        setBatchImages([]);
        setMobileStep('mode');
      } else {
        setPendingImage(next);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '图片读取失败，请重试。';
      setSaved(false);
      setDialogError(message);
      setStatus(message);
    }
  }, [isMobileCapture, saving]);

  const pasteFromClipboard = useCallback(async () => {
    if (saving) return;
    if (!navigator.clipboard?.read) {
      setSaved(false);
      setStatus('当前浏览器不支持按钮读取剪贴板；复制图片后长按页面选择“粘贴”，或按 Ctrl+V。');
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const mime = item.types.find((type) => type.startsWith('image/'));
        if (!mime) continue;
        const blob = await item.getType(mime);
        const file = new File(
          [blob],
          `clipboard-${Date.now()}.${clipboardFileExtension(mime)}`,
          { type: mime },
        );
        await acceptImage(file);
        return;
      }
      setSaved(false);
      setStatus('剪贴板中没有图片。');
    } catch (error) {
      const message = error instanceof Error && error.name === 'NotAllowedError'
        ? '浏览器未允许读取剪贴板；请长按页面选择“粘贴”，或按 Ctrl+V。'
        : error instanceof Error ? error.message : '读取剪贴板失败。';
      setSaved(false);
      setStatus(message);
    }
  }, [acceptImage, saving]);

  useEffect(() => {
    const mode = pendingImage || materialOpen ? 'remark' : 'compact';
    if (window.kaoyanDesktop?.setNoteAppMode) void window.kaoyanDesktop.setNoteAppMode(mode);
  }, [materialOpen, pendingImage]);

  useEffect(() => {
    if (window.kaoyanDesktop?.setNoteAppDirty) {
      void window.kaoyanDesktop.setNoteAppDirty(Boolean(pendingImage) || saving, saving);
    }
  }, [pendingImage, saving]);

  useEffect(() => {
    if (!pendingImage || isMobileCapture) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => remarkRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isMobileCapture, pendingImage]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const file = event.clipboardData ? getClipboardImage(event.clipboardData.items) : null;
      if (!file || saving) return;
      event.preventDefault();
      void acceptImage(file);
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [acceptImage, saving]);

  useEffect(() => {
    if (isMobileCapture) return undefined;
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pendingImage && !saving) {
        event.preventDefault();
        setPendingImage(null);
        setRemark('');
        setDialogError('');
        setStatus('');
        return;
      }
      if (event.key !== 'Tab' || !pendingImage || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('hidden'));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleDialogKeys);
    return () => window.removeEventListener('keydown', handleDialogKeys);
  }, [isMobileCapture, pendingImage, saving]);

  const saveImageReliably = async (
    payload: Parameters<typeof saveNoteImage>[0],
    onRetry: (message: string) => void,
  ) => {
    try {
      return await saveNoteImage(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = IS_CLOUD_RUNTIME
        && /load failed|failed to fetch|network|暂未确认|请求超时/i.test(message);
      if (!retryable) throw error;
      onRetry('连接中断，正在自动确认保存结果…');
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
      return saveNoteImage(payload);
    }
  };


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

  const saveSingle = async () => {
    if (!pendingImage || saving) return;
    const payload = {
      imageDataUrl: pendingImage.src,
      kind: 'single' as const,
      noteUid: pendingImage.noteUid,
      remark,
      sourceType: 'single-capture',
      aiSelection,
    };
    let replicaState: Awaited<ReturnType<typeof saveNoteImage>>['sync'] = undefined;
    try {
      setSaving(true);
      setSaved(false);
      setDialogError('');
      if (IS_CLOUD_RUNTIME) {
        await enqueueCaptureUpload([payload]);
      } else {
        replicaState = (await saveImageReliably(payload, setStatus)).sync;
      }
      setPendingImage(null);
      setRemark('');
      setSaved(true);
      setStatus(IS_CLOUD_RUNTIME
        ? '图片已加密暂存；送达 Mac 后会自动清除本机临时内容'
        : replicaState?.state === 'conflict'
          ? '已保存到 Windows 本机；与 Mac 的同字段修改需要稍后确认，数据不会被静默覆盖'
          : replicaState
            ? '已保存到 Windows 本机；正在等待同步到 Mac，AI 将由 Mac 统一处理'
            : '已保存到本地；正在后台识别标题和科目，可立即继续记录');
      if (isMobileCapture) setMobileStep('success');
    } catch (error) {
      const message = error instanceof Error
        ? `保存失败：${error.message}`
        : '无法写入本机后台队列，请释放存储空间后重试。';
      setDialogError(message);
      setStatus(message);
    } finally {
      setSaving(false);
    }
  };

  const confirmSingleCrop = async (crop: NormalizedCrop) => {
    if (!sourceImage) return;
    try {
      setSaving(true);
      const src = await cropImageDataUrl(sourceImage.src, crop, 2000, 0.9);
      setPendingImage({ src, noteUid: sourceImage.noteUid });
      setMobileStep('remark');
      setDialogError('');
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : '裁剪失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  const buildDetectedBatch = async (src: string, sourceUid: string) => {
    const runId = ++detectionRunRef.current;
    setMobileStep('detecting');
    setBatchProgress('2/4 已上传，正在按局域网控制面选择模型…');
    const slowTimer = window.setTimeout(() => {
      if (detectionRunRef.current === runId) setBatchProgress('2/4 AI 仍在识别复杂页面，结果会在当前页返回…');
    }, 15_000);
    try {
      const detection = await detectQuestionRegions(src, (message) => {
        if (detectionRunRef.current === runId) setBatchProgress(message);
      });
      if (detectionRunRef.current !== runId) return;
      const rejectedCount = detection.quality?.rejectedCount ?? detection.rejectedRegions?.length ?? 0;
      setBatchProgress(('3/4 ' + (detection.provider || '') + ' ' + (detection.model || '') + ' 已保留 ' + detection.regions.length + ' 道完整题目' + (rejectedCount ? '，过滤 ' + rejectedCount + ' 个可疑区域' : '') + '，正在生成裁剪结果…').replace(/\s+/g, ' ').trim());
      const images = await cropManyImages(src, detection.regions, 1800, 0.9);
      if (detectionRunRef.current !== runId) return;
      setBatchImages(images.map((imageSrc) => ({ src: imageSrc, noteUid: createNoteUid(), enabled: true })));
      setBatchProgress('4/4 裁剪完成，请检查每一道题和批次信息。');
      setMobileStep('batch');
    } finally {
      window.clearTimeout(slowTimer);
    }
  };

  const confirmMultiPreCrop = async (crop: NormalizedCrop) => {
    if (!sourceImage || saving) return;
    try {
      setSaving(true);
      setSaved(false);
      setDialogError('');
      setMobileStep('detecting');
      setBatchProgress('1/4 正在压缩并上传整页图片…');
      const src = await cropImageDataUrl(sourceImage.src, crop, 2200, 0.88);
      setSourceImage({ src, noteUid: sourceImage.noteUid });
      await buildDetectedBatch(src, sourceImage.noteUid);
    } catch (error) {
      if (detectionRunRef.current === 0) return;
      setDialogError(error instanceof Error ? error.message : 'AI 多题识别失败，请调整范围后重试。');
      setBatchProgress('');
      setMobileStep('mode');
    } finally {
      setSaving(false);
    }
  };

  const startMultiQuestion = async () => {
    if (!sourceImage || saving) return;
    try {
      setSaving(true);
      setSaved(false);
      setDialogError('');
      const job = await enqueueMultiQuestionJob(sourceImage.src, {
        subject: batchSubject,
        remark: batchRemark,
      });
      setSourceImage(null);
      setBatchImages([]);
      setBatchProgress('');
      setSaved(true);
      setStatus(job.message || '整页原图已安全保存，可以离开当前页面，稍后从活动中心逐题确认');
      setMobileStep('success');
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : '无法加入后台多题队列，请重试。');
      setMobileStep('mode');
    } finally {
      setSaving(false);
    }
  };

  const confirmBatchCrop = async (crop: NormalizedCrop) => {
    if (batchCropIndex === null || !batchImages[batchCropIndex]) return;
    try {
      setSaving(true);
      const src = await cropImageDataUrl(batchImages[batchCropIndex].src, crop, 1800, 0.9);
      setBatchImages((current) => current.map((item, index) => index === batchCropIndex ? { ...item, src } : item));
      setBatchCropIndex(null);
      setMobileStep('batch');
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : '裁剪失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  const saveBatch = async () => {
    const selected = batchImages.filter((item) => item.enabled);
    if (selected.length === 0 || saving) {
      setDialogError('请至少保留一道题。');
      return;
    }
    const payloads = selected.map((item, index) => ({
      imageDataUrl: item.src,
      kind: 'single' as const,
      noteUid: item.noteUid,
      subject: batchSubject,
      subjectLocked: batchSubject !== '默认文件夹',
      remark: batchRemark,
      sourceType: 'ai-multi-question',
      aiSelection,
      sourceBatchId: sourceImage?.noteUid || '',
      sourceSplitIndex: index + 1,
      tags: ['AI多题拆分'],
    }));
    try {
      setSaving(true);
      setDialogError('');
      let replicaQueued = false;
      if (IS_CLOUD_RUNTIME) {
        await enqueueCaptureUpload(payloads);
      } else {
        const result = await saveBatchReliably(payloads, setBatchProgress);
        replicaQueued = result.notes.some((note) => Boolean(note.sync));
      }
      if (activeReviewJobId) {
        await completeMultiQuestionReview(activeReviewJobId, selected.map((item) => item.noteUid));
      }
      setSaved(true);
      setStatus(IS_CLOUD_RUNTIME
        ? `${selected.length} 道题已加密暂存；送达 Mac 后会自动清除本机临时内容`
        : replicaQueued
          ? `${selected.length} 道题已保存到 Windows 本机；等待 Mac 同步并统一处理 AI`
          : `${selected.length} 道题已保存到本地；正在后台识别标题和科目`);
      setBatchProgress('');
      setMobileStep('success');
    } catch (error) {
      setDialogError(error instanceof Error ? `批量保存失败：${error.message}` : '批量保存失败，请重试。');
      setBatchProgress('');
    } finally {
      setSaving(false);
    }
  };

  const cancelPending = () => {
    if (saving) return;
    setPendingImage(null);
    setRemark('');
    setDialogError('');
    setStatus('');
  };

  const minimizeWindow = () => window.kaoyanDesktop?.minimize();
  const closeWindow = () => {
    if (activeReviewJobId || requestedReviewJobId) {
      window.location.assign(`${window.location.origin}/?activity=1`);
      return;
    }
    if (IS_CLOUD_RUNTIME) {
      window.location.assign(`${window.location.origin}/?hub=1`);
      return;
    }
    window.kaoyanDesktop?.close();
  };

  const openCanvas = () => {
    if (IS_CLOUD_RUNTIME) {
      window.location.assign(`${window.location.origin}/?notes=1&mode=canvas`);
      return;
    }
    if (window.kaoyanDesktop?.openNoteCanvas) void window.kaoyanDesktop.openNoteCanvas();
  };

  const hiddenInputs = (
    <>
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          void acceptImage(getFirstImage(event.currentTarget.files));
          event.currentTarget.value = '';
        }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => {
          void acceptImage(getFirstImage(event.currentTarget.files));
          event.currentTarget.value = '';
        }}
      />
    </>
  );

  if (materialOpen) {
    return <QuickMaterialComposer
      compact={isMobileCapture || Boolean(window.kaoyanDesktop?.isElectron)}
      desktop={Boolean(window.kaoyanDesktop?.isElectron)}
      onClose={() => setMaterialOpen(false)}
      onSaved={(message) => { setSaved(true); setStatus(message); }}
    />;
  }

  if (isMobileCapture) {
    if (mobileStep === 'multi-crop' && sourceImage) {
      return (
        <ImageCropEditor
          imageSrc={sourceImage.src}
          title="预裁剪整页题目"
          confirmLabel={saving ? '正在准备…' : '开始 AI 识别'}
          onCancel={() => setMobileStep('mode')}
          onConfirm={(crop) => void confirmMultiPreCrop(crop)}
        />
      );
    }
    if (mobileStep === 'crop' && sourceImage) {
      return <ImageCropEditor imageSrc={sourceImage.src} onCancel={() => setMobileStep('mode')} onConfirm={(crop) => void confirmSingleCrop(crop)} />;
    }
    if (mobileStep === 'batch-crop' && batchCropIndex !== null && batchImages[batchCropIndex]) {
      return (
        <ImageCropEditor
          imageSrc={batchImages[batchCropIndex].src}
          title={`调整第 ${batchCropIndex + 1} 题`}
          confirmLabel="完成调整"
          onCancel={() => { setBatchCropIndex(null); setMobileStep('batch'); }}
          onConfirm={(crop) => void confirmBatchCrop(crop)}
        />
      );
    }

    return (
      <main className={`mobile-note-capture is-${mobileStep}`}>
        <header className="mobile-capture-header">
          {mobileStep !== 'capture' && mobileStep !== 'success' ? (
            <button type="button" onClick={() => {
              if (mobileStep === 'detecting') {
                detectionRunRef.current += 1;
                setSaving(false);
                setBatchProgress('');
                setMobileStep('mode');
                return;
              }
              if (saving) return;
              if (mobileStep === 'remark') setMobileStep('crop');
              else if (mobileStep === 'batch') setMobileStep('mode');
              else setMobileStep('capture');
            }} aria-label="返回"><ArrowLeft size={21} /></button>
          ) : <span />}
          <strong>{mobileStep === 'batch' ? '确认多题' : mobileStep === 'remark' ? '保存题目' : '快速记题'}</strong>
          <button type="button" onClick={closeWindow} aria-label="关闭"><X size={21} /></button>
        </header>

        {mobileStep === 'capture' && (
          <section className="mobile-capture-home">
            <div className="mobile-capture-intro">
              <span><Camera size={26} /></span>
              <h1>拍下题目，马上归档</h1>
              <p>单题可手动裁剪；一页多题可由 AI 自动拆分。</p>
            </div>
            <aside className="mobile-private-status" aria-live="polite">
              <ShieldCheck size={18} />
              <span>
                <strong>{uploadSummary.queued || uploadSummary.uploading || uploadSummary.failed ? uploadSummary.message : 'Mac 私有直连'}</strong>
                <small>未送达内容仅以设备内不可导出密钥加密暂存</small>
              </span>
            </aside>
            <div className="mobile-capture-primary-actions">
              <button className="primary" type="button" onClick={() => cameraInputRef.current?.click()}>
                <Camera size={22} /><span><strong>拍照</strong><small>直接调用后置摄像头</small></span>
              </button>
              <button type="button" onClick={() => galleryInputRef.current?.click()}>
                <Images size={21} /><span><strong>从相册导入</strong><small>选择已有截图或照片</small></span>
              </button>
              <button type="button" onClick={() => void pasteFromClipboard()}>
                <ClipboardPaste size={21} /><span><strong>粘贴图片</strong><small>使用刚复制的截图</small></span>
              </button>
              <button type="button" onClick={() => setMaterialOpen(true)}>
                <FilePlus2 size={21} /><span><strong>速记</strong><small>文字、图片、PDF、Word、HTML 和多资料组合</small></span>
              </button>
            </div>
            <button className="mobile-canvas-link" type="button" onClick={openCanvas}><ExternalLink size={17} />打开笔记大画布</button>
          </section>
        )}

        {mobileStep === 'mode' && sourceImage && (
          <section className="mobile-mode-picker">
            <figure><img src={sourceImage.src} alt="刚选择的题目图片" /></figure>
            <div>
              <h1>这张图里有几道题？</h1>
              <p>选择后仍可检查和调整，不会直接覆盖原图。</p>
            </div>
            <button type="button" onClick={() => setMobileStep('crop')}>
              <span><Crop size={22} /></span>
              <strong>单题模式</strong>
              <small>手动裁剪出一道完整题目</small>
            </button>
            <button className="ai" type="button" onClick={() => void startMultiQuestion()} disabled={saving}>
              <span><Layers3 size={22} /></span>
              <strong>{saving ? '正在加入后台…' : '多题自动拆分'}</strong>
              <small>原图先秒存；完成后可从活动中心逐题确认</small>
              <em><Sparkles size={13} />AI</em>
            </button>
            {dialogError && <p className="mobile-capture-error" role="alert">{dialogError}</p>}
            <button className="mobile-change-image" type="button" onClick={() => cameraInputRef.current?.click()}><Camera size={16} />重新拍照</button>
          </section>
        )}

        {mobileStep === 'detecting' && (
          <section className="mobile-detecting">
            <span><LoaderCircle size={34} /></span>
            <h1>正在拆分题目</h1>
            <p>{batchProgress || 'AI 正在寻找每一道完整题目的边界。'}</p>
             <ol className="mobile-detecting-steps">
               <li>上传并压缩原图</li><li>读取局域网 AI 配置</li><li>识别题目边界</li><li>生成可调整裁剪</li>
             </ol>
          </section>
        )}

        {mobileStep === 'remark' && pendingImage && (
          <form className="mobile-single-review" onSubmit={(event) => { event.preventDefault(); void saveSingle(); }}>
            <figure><img src={pendingImage.src} alt="裁剪后的题目" /></figure>
            <label>
              <span>备注 <small>可选</small></span>
              <textarea
                ref={remarkRef}
                value={remark}
                onChange={(event) => setRemark(event.target.value)}
                placeholder="例如：p128 例4.2，隐函数二阶导错题"
              />
            </label>
            <NoteAiSelectionField selection={aiSelection} models={visionModels} disabled={saving} onChange={updateAiSelection} />
            {dialogError && <p className="mobile-capture-error" role="alert">{dialogError}</p>}
            <div className="mobile-review-actions">
              <button type="button" onClick={() => setMobileStep('crop')} disabled={saving}><Crop size={17} />重新裁剪</button>
              <button className="primary" type="submit" disabled={saving}><Save size={18} />{saving ? '正在保存…' : '保存笔记'}</button>
            </div>
          </form>
        )}

        {mobileStep === 'batch' && (
          <section className="mobile-batch-review">
            <header>
              <div><h1>识别到 {batchImages.length} 道题</h1><p>点图片可再裁剪；关闭不需要的题目后批量保存。</p></div>
              <span>{batchImages.filter((item) => item.enabled).length} 道待保存</span>
            </header>
            <div className="mobile-batch-context">
              <label><span>整批科目</span><select value={batchSubject} onChange={(event) => setBatchSubject(event.target.value)} disabled={saving}>
                {['默认文件夹', '高等数学', '线性代数', '概率论', '数据结构', '计算机组成', '操作系统', '计算机网络', '英语', '政治'].map((subject) => <option key={subject} value={subject}>{subject}</option>)}
              </select></label>
              <label><span>整批备注 <small>将参与每道题的中文命名与分类</small></span><textarea value={batchRemark} onChange={(event) => setBatchRemark(event.target.value)} placeholder="例如：张宇高数18讲 p128，例4.2，多题错题" disabled={saving} /></label>
            </div>
            <div className="mobile-batch-list">
              {batchImages.map((item, index) => (
                <article className={item.enabled ? '' : 'is-disabled'} key={item.noteUid}>
                  <button type="button" className="mobile-batch-image" onClick={() => {
                    if (!item.enabled || saving) return;
                    setBatchCropIndex(index);
                    setMobileStep('batch-crop');
                  }}>
                    <img src={item.src} alt={`第 ${index + 1} 题`} />
                    <span><Crop size={14} />调整</span>
                  </button>
                  <div><strong>第 {index + 1} 题</strong><small>{item.enabled ? '将保存到普通笔记' : '已排除'}</small></div>
                  <button type="button" className="mobile-batch-toggle" onClick={() => setBatchImages((current) => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, enabled: !entry.enabled } : entry))} aria-label={item.enabled ? `排除第 ${index + 1} 题` : `恢复第 ${index + 1} 题`}>
                    {item.enabled ? <Trash2 size={17} /> : <ImagePlus size={17} />}
                  </button>
                </article>
              ))}
            </div>
            {dialogError && <p className="mobile-capture-error" role="alert">{dialogError}</p>}
            {batchProgress && <p className="mobile-batch-progress"><LoaderCircle size={16} />{batchProgress}</p>}
            <footer>
              <button type="button" onClick={() => sourceImage && void buildDetectedBatch(sourceImage.src, sourceImage.noteUid)} disabled={saving || !sourceImage}><Sparkles size={17} />重新识别</button>
              <button className="primary" type="button" onClick={() => void saveBatch()} disabled={saving || batchImages.every((item) => !item.enabled)}>
                <Save size={18} />{saving ? '处理中…' : `保存 ${batchImages.filter((item) => item.enabled).length} 道题`}
              </button>
            </footer>
          </section>
        )}

        {mobileStep === 'success' && (
          <section className="mobile-capture-success">
            <span><CheckCircle2 size={38} /></span>
            <h1>{backgroundJob && !['completed', 'failed', 'needs_review'].includes(backgroundJob.status) ? '原图已保存' : '记录完成'}</h1>
            <p>{status || '笔记已保存并同步到学习中心。'}</p>
            {backgroundJob && (
              <div className={`mobile-background-job is-${backgroundJob.status}`} role="status" aria-live="polite">
                <span style={{ width: `${Math.max(4, Math.min(100, backgroundJob.progress || 4))}%` }} />
                <small>
                  {backgroundJob.status === 'completed'
                    ? `AI 已完成，生成 ${backgroundJob.detectedCount} 道题`
                    : ['failed', 'needs_review'].includes(backgroundJob.status)
                      ? 'AI 未完成，原图仍然安全保留'
                      : `AI 后台处理中 ${backgroundJob.progress || 5}%`}
                </small>
              </div>
            )}
            {backgroundJob && ['failed', 'needs_review'].includes(backgroundJob.status) && (
              <>
                {backgroundJob.error && <p className="mobile-capture-error" role="alert">{backgroundJob.error}</p>}
                {backgroundJob.status === 'needs_review' ? (
                  <button type="button" onClick={() => void openMultiQuestionReview(backgroundJob.id)}>
                    <Crop size={18} />进入逐题审核
                  </button>
                ) : (
                  <button type="button" onClick={() => {
                    setDialogError('');
                    void retryMultiQuestionJob(backgroundJob.id).catch((error) => {
                      setDialogError(error instanceof Error ? error.message : '重试失败，请稍后再试。');
                    });
                  }}>
                    <Sparkles size={18} />重试 AI 裁剪
                  </button>
                )}
              </>
            )}
            {dialogError && <p className="mobile-capture-error" role="alert">{dialogError}</p>}
            <button className="primary" type="button" onClick={() => {
              if (activeReviewJobId || requestedReviewJobId) {
                window.location.assign(`${window.location.origin}/?noteApp=1`);
                return;
              }
              resetMobileCapture();
            }}><Camera size={19} />继续拍题</button>
            <button type="button" onClick={() => window.location.assign(`${window.location.origin}/?panel=learning&view=uncategorized`)}>查看普通笔记</button>
          </section>
        )}

        {status && mobileStep === 'capture' && <p className="mobile-home-status" role="status">{status}</p>}
        {hiddenInputs}
      </main>
    );
  }

  return (
    <main
      className={`note-drop-app ${dragActive ? 'is-dragging' : ''} ${pendingImage ? 'is-remark-mode' : ''} ${status && !pendingImage ? 'has-status' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        setDragActive(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setDragActive(false);
        void acceptImage(getFirstImage(event.dataTransfer.files));
      }}
    >
      <header className="note-drop-titlebar">
        <div>
          <span className="note-drop-grip" aria-hidden="true"><i /><i /><i /><i /><i /><i /></span>
          <strong>笔记小 App</strong>
        </div>
        {(window.kaoyanDesktop?.isElectron || IS_CLOUD_RUNTIME) && (
          <nav aria-label="窗口控制">
            {window.kaoyanDesktop?.isElectron && (
              <button type="button" onClick={minimizeWindow} aria-label="最小化"><Minus size={15} /></button>
            )}
            <button type="button" onClick={closeWindow} aria-label="关闭"><X size={15} /></button>
          </nav>
        )}
      </header>

      <section className="note-drop-body">
        <div className="note-drop-capture">
          <button
            className="note-drop-zone"
            type="button"
            aria-label="选择题目图片，也可以直接拖入图片"
            onClick={() => galleryInputRef.current?.click()}
          >
            <span className="note-drop-zone-icon"><ImagePlus size={18} aria-hidden="true" /></span>
            <span className="note-drop-zone-copy">
              <strong>{dragActive ? '松手放入图片' : '拖入题目图片'}</strong>
              {!dragActive && <small>自动保存，分析在后台完成</small>}
            </span>
          </button>
          <button className="note-drop-quick-switch" type="button" onClick={() => setMaterialOpen(true)}>
            <FilePlus2 size={15} aria-hidden="true" />
            <span>切换到速记</span>
          </button>
        </div>
        <button className="note-canvas-launch" type="button" onClick={openCanvas} title="在浏览器打开笔记大画布" aria-label="在浏览器打开笔记大画布">
          <ExternalLink size={16} aria-hidden="true" />
        </button>
      </section>

      {status && !pendingImage && (
        <footer className={saved ? 'is-success' : ''} aria-live="polite">
          {saved ? <CheckCircle2 size={13} aria-hidden="true" /> : <FileImage size={13} aria-hidden="true" />}
          <span>{status}</span>
        </footer>
      )}

      {hiddenInputs}

      {pendingImage && (
        <div className="note-remark-backdrop" role="presentation">
          <form
            ref={dialogRef}
            className="note-remark-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="note-remark-title"
            aria-describedby={dialogError ? 'note-remark-error' : undefined}
            onSubmit={(event) => { event.preventDefault(); void saveSingle(); }}
          >
            <header>
              <h2 id="note-remark-title">备注</h2>
              <button type="button" onClick={cancelPending} disabled={saving} aria-label="取消并关闭备注框"><X size={17} /></button>
            </header>
            <figure><img src={pendingImage.src} alt="待保存的笔记图片" /></figure>
            <textarea ref={remarkRef} aria-label="备注" value={remark} onChange={(event) => setRemark(event.target.value)} placeholder="补充一句（可选）" />
            <NoteAiSelectionField selection={aiSelection} models={visionModels} disabled={saving} onChange={updateAiSelection} />
            {dialogError && <p className="note-remark-error" id="note-remark-error" role="alert">{dialogError}</p>}
            <div className="note-remark-actions">
              <button type="button" onClick={() => galleryInputRef.current?.click()} disabled={saving}><ImagePlus size={15} /> 换一张</button>
              <button type="button" onClick={cancelPending} disabled={saving}>取消</button>
              <button className="primary" type="submit" disabled={saving}><Save size={15} /> {saving ? '正在保存……' : '保存笔记'}</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
