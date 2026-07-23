import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  ClipboardPaste,
  ExternalLink,
  FileImage,
  ImagePlus,
  Images,
  Minus,
  Save,
  X,
} from 'lucide-react';
import { createNoteUid, fileToDataUrl, IS_CLOUD_RUNTIME, NOTE_SERVER_URL, saveNoteImage } from '../utils/notes';
import { saveLearningDataCache } from '../utils/learningData';
import { fetchWithTimeout } from '../utils/localService';

interface PendingImage {
  src: string;
  noteUid: string;
}

const imageFilePattern = /\.(jpe?g|png|webp)$/i;

const isImageFile = (file: File) => file.type.startsWith('image/') || imageFilePattern.test(file.name);

const getFirstImage = (files: FileList | null): File | null => {
  if (!files) {
    return null;
  }
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

export function NoteDropApp() {
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const remarkRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dragDepthRef = useRef(0);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [remark, setRemark] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState('');
  const [dialogError, setDialogError] = useState('');

  useEffect(() => {
    if (!window.kaoyanDesktop?.isElectron) {
      return;
    }
    const reportReady = () => {
      void fetchWithTimeout(`${NOTE_SERVER_URL}/note-app-ready`, { method: 'POST' }, 900).catch(() => undefined);
    };
    reportReady();
    const timer = window.setInterval(reportReady, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const acceptImage = useCallback(async (file: File | null) => {
    if (saving) {
      return;
    }

    if (!file) {
      setSaved(false);
      setDialogError('没有检测到图片，请拍照、从相册选择或粘贴图片。');
      setStatus('没有检测到图片，请拍照、从相册选择或粘贴图片。');
      return;
    }

    try {
      const src = await fileToDataUrl(file);
      setPendingImage({ src, noteUid: createNoteUid() });
      setRemark('');
      setSaved(false);
      setDialogError('');
      setStatus('');
    } catch (error) {
      const message = error instanceof Error ? error.message : '图片读取失败，请重试。';
      setSaved(false);
      setDialogError(message);
      setStatus(message);
    }
  }, [saving]);

  const pasteFromClipboard = useCallback(async () => {
    if (saving) return;
    if (!navigator.clipboard?.read) {
      setSaved(false);
      setStatus('当前浏览器不支持按钮读取剪贴板；复制图片后在页面长按选择“粘贴”，或按 Ctrl+V。');
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
    if (window.kaoyanDesktop?.setNoteAppMode) {
      void window.kaoyanDesktop.setNoteAppMode(mode);
    }
  }, [pendingImage]);

  useEffect(() => {
    if (window.kaoyanDesktop?.setNoteAppDirty) {
      void window.kaoyanDesktop.setNoteAppDirty(Boolean(pendingImage) || saving, saving);
    }
  }, [pendingImage, saving]);

  useEffect(() => {
    if (!pendingImage) {
      return;
    }
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => remarkRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [pendingImage]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const file = event.clipboardData ? getClipboardImage(event.clipboardData.items) : null;
      if (!file) {
        return;
      }
      event.preventDefault();
      void acceptImage(file);
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [acceptImage]);

  useEffect(() => {
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pendingImage && !saving) {
        event.preventDefault();
        setPendingImage(null);
        setRemark('');
        setDialogError('');
        setStatus('');
        return;
      }

      if (event.key !== 'Tab' || !pendingImage || !dialogRef.current) {
        return;
      }

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
  }, [pendingImage, saving]);

  const save = async () => {
    if (!pendingImage || saving) {
      return;
    }

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
      } else {
        const aiMessage = result.aiStatus === 'complete'
          ? 'AI 整理完成'
          : result.aiStatus === 'failed'
            ? 'AI 将在稍后整理'
            : 'AI 正在后台整理';
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

  const cancelPending = () => {
    if (saving) {
      return;
    }
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
    if (window.kaoyanDesktop?.openNoteCanvas) {
      void window.kaoyanDesktop.openNoteCanvas();
    }
  };

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
        if (dragDepthRef.current === 0) {
          setDragActive(false);
        }
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
            <span className="note-drop-zone-copy">
              <strong>{dragActive ? '松手放入图片' : '快速记录题目图片'}</strong>
            </span>
          </button>
          <div className="note-drop-source-actions" role="group" aria-label="图片来源">
            <button type="button" onClick={() => cameraInputRef.current?.click()}><Camera size={15} /><span>拍照</span></button>
            <button type="button" onClick={() => galleryInputRef.current?.click()}><Images size={15} /><span>相册</span></button>
            <button type="button" onClick={() => void pasteFromClipboard()}><ClipboardPaste size={15} /><span>粘贴</span></button>
          </div>
        </div>
        <button
          className="note-canvas-launch"
          type="button"
          onClick={openCanvas}
          title="在浏览器打开笔记大画布"
          aria-label="在浏览器打开笔记大画布"
        >
          <ExternalLink size={16} aria-hidden="true" />
        </button>
      </section>

      {status && !pendingImage && (
        <footer className={saved ? 'is-success' : ''} aria-live="polite">
          {saved ? <CheckCircle2 size={13} aria-hidden="true" /> : <FileImage size={13} aria-hidden="true" />}
          <span>{status}</span>
        </footer>
      )}

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

      {pendingImage && (
        <div className="note-remark-backdrop" role="presentation">
          <form
            ref={dialogRef}
            className="note-remark-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="note-remark-title"
            aria-describedby={dialogError ? 'note-remark-error' : undefined}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <header>
              <h2 id="note-remark-title">备注</h2>
              <button type="button" onClick={cancelPending} disabled={saving} aria-label="取消并关闭备注框"><X size={17} /></button>
            </header>

            <figure>
              <img src={pendingImage.src} alt="待保存的笔记图片" />
            </figure>

            <textarea
              ref={remarkRef}
              aria-label="备注"
              value={remark}
              onChange={(event) => setRemark(event.target.value)}
              placeholder="补充一句（可选）"
            />

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
