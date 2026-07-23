import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  ClipboardPaste,
  Crop,
  ExternalLink,
  FileImage,
  ImagePlus,
  Images,
  Layers3,
  LoaderCircle,
  Minus,
  Save,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  createNoteUid,
  detectQuestionRegions,
  fileToDataUrl,
  IS_CLOUD_RUNTIME,
  NOTE_SERVER_URL,
  renameLearningNoteWithAi,
  saveNoteImage,
} from '../utils/notes';
import { cropImageDataUrl, cropManyImages, type NormalizedCrop } from '../utils/imageCrop';
import { saveLearningDataCache } from '../utils/learningData';
import { fetchWithTimeout } from '../utils/localService';
import { ImageCropEditor } from './ImageCropEditor';
import '../note-drop-mobile.css';

interface PendingImage {
  src: string;
  noteUid: string;
}

interface BatchImage extends PendingImage {
  enabled: boolean;
}

type MobileStep = 'capture' | 'mode' | 'crop' | 'remark' | 'detecting' | 'batch' | 'batch-crop' | 'success';

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

export function NoteDropApp() {
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const remarkRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dragDepthRef = useRef(0);
  const [isMobileCapture, setIsMobileCapture] = useState(() => (
    IS_CLOUD_RUNTIME && typeof window.matchMedia === 'function' && window.matchMedia(mobileMediaQuery).matches
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

  useEffect(() => {
    if (!IS_CLOUD_RUNTIME || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(mobileMediaQuery);
    const update = () => setIsMobileCapture(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
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
      const src = await fileToDataUrl(file);
      const next = { src, noteUid: createNoteUid() };
      setRemark('');
      setSaved(false);
      setDialogError('');
      setStatus('');
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
    const mode = pendingImage ? 'remark' : 'compact';
    if (window.kaoyanDesktop?.setNoteAppMode) void window.kaoyanDesktop.setNoteAppMode(mode);
  }, [pendingImage]);

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

  const saveSingle = async () => {
    if (!pendingImage || saving) return;
    try {
      setSaving(true);
      setSaved(false);
      setDialogError('');
      setStatus('');
      const result = await saveNoteImage({
        imageDataUrl: pendingImage.src,
        kind: 'single',
        noteUid: pendingImage.noteUid,
        remark,
      });
      if (result.learningData) saveLearningDataCache(result.learningData);
      setPendingImage(null);
      setRemark('');
      setDialogError('');
      setSaved(true);
      if (IS_CLOUD_RUNTIME) {
        setStatus(result.learningData ? '已保存，学习中心已更新' : '已保存，学习中心正在同步');
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

  const confirmSingleCrop = async (crop: NormalizedCrop) => {
    if (!sourceImage) return;
    try {
      setSaving(true);
      const src = await cropImageDataUrl(sourceImage.src, crop);
      setPendingImage({ src, noteUid: sourceImage.noteUid });
      setMobileStep('remark');
      setDialogError('');
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : '裁剪失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  const startMultiQuestion = async () => {
    if (!sourceImage || saving) return;
    try {
      setSaving(true);
      setMobileStep('detecting');
      setDialogError('');
      setBatchProgress('AI 正在识别题目边界…');
      const detection = await detectQuestionRegions(sourceImage.src);
      setBatchProgress(`已识别 ${detection.regions.length} 道题，正在裁剪…`);
      const images = await cropManyImages(sourceImage.src, detection.regions);
      setBatchImages(images.map((src) => ({ src, noteUid: createNoteUid(), enabled: true })));
      setMobileStep('batch');
      setBatchProgress('');
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'AI 多题识别失败，请改用单题模式。');
      setMobileStep('mode');
      setBatchProgress('');
    } finally {
      setSaving(false);
    }
  };

  const confirmBatchCrop = async (crop: NormalizedCrop) => {
    if (batchCropIndex === null || !batchImages[batchCropIndex]) return;
    try {
      setSaving(true);
      const src = await cropImageDataUrl(batchImages[batchCropIndex].src, crop);
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
    try {
      setSaving(true);
      setDialogError('');
      let latestSnapshot = null;
      let renameFailures = 0;
      for (let index = 0; index < selected.length; index += 1) {
        const item = selected[index];
        setBatchProgress(`正在保存 ${index + 1}/${selected.length}…`);
        const result = await saveNoteImage({
          imageDataUrl: item.src,
          kind: 'single',
          noteUid: item.noteUid,
          subject: '普通笔记',
          remark: '',
        });
        if (result.learningData) {
          latestSnapshot = result.learningData;
          saveLearningDataCache(result.learningData);
        }
        try {
          setBatchProgress(`正在自动命名 ${index + 1}/${selected.length}…`);
          latestSnapshot = await renameLearningNoteWithAi(item.noteUid);
          saveLearningDataCache(latestSnapshot);
        } catch {
          renameFailures += 1;
        }
      }
      if (latestSnapshot) saveLearningDataCache(latestSnapshot);
      setSaved(true);
      setStatus(renameFailures > 0
        ? `已保存 ${selected.length} 道题，其中 ${renameFailures} 条可稍后在普通笔记中重新 AI 命名`
        : `已保存并自动命名 ${selected.length} 道题`);
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

  if (isMobileCapture) {
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
            <button className="ai" type="button" onClick={() => void startMultiQuestion()}>
              <span><Layers3 size={22} /></span>
              <strong>多题模式</strong>
              <small>AI 识别多个题目并自动裁剪</small>
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
              <button type="button" onClick={() => void startMultiQuestion()} disabled={saving}><Sparkles size={17} />重新识别</button>
              <button className="primary" type="button" onClick={() => void saveBatch()} disabled={saving || batchImages.every((item) => !item.enabled)}>
                <Save size={18} />{saving ? '处理中…' : `保存 ${batchImages.filter((item) => item.enabled).length} 道题`}
              </button>
            </footer>
          </section>
        )}

        {mobileStep === 'success' && (
          <section className="mobile-capture-success">
            <span><CheckCircle2 size={38} /></span>
            <h1>记录完成</h1>
            <p>{status || '笔记已保存并同步到学习中心。'}</p>
            <button className="primary" type="button" onClick={resetMobileCapture}><Camera size={19} />继续拍题</button>
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
            aria-label="从相册选择图片，也可拖入或粘贴图片"
            onClick={() => galleryInputRef.current?.click()}
          >
            <span className="note-drop-zone-icon"><ImagePlus size={18} aria-hidden="true" /></span>
            <span className="note-drop-zone-copy"><strong>{dragActive ? '松手放入图片' : '快速记录题目图片'}</strong></span>
          </button>
          <div className="note-drop-source-actions" role="group" aria-label="图片来源">
            <button type="button" onClick={() => cameraInputRef.current?.click()}><Camera size={15} /><span>拍照</span></button>
            <button type="button" onClick={() => galleryInputRef.current?.click()}><Images size={15} /><span>相册</span></button>
            <button type="button" onClick={() => void pasteFromClipboard()}><ClipboardPaste size={15} /><span>粘贴</span></button>
          </div>
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
