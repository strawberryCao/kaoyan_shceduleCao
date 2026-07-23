import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, FileImage, ImagePlus, Minus, Save, X } from 'lucide-react';
import { createNoteUid, fileToDataUrl, NOTE_SERVER_URL, saveNoteImage } from '../utils/notes';
import { fetchWithTimeout } from '../utils/localService';

interface PendingImage {
  name: string;
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

const getSavedFileName = (filePath?: string) => {
  if (!filePath) {
    return '图片笔记';
  }
  return filePath.split(/[\\/]/).pop() || '图片笔记';
};

export function NoteDropApp() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const remarkRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dragDepthRef = useRef(0);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [remark, setRemark] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState('拖入、选择或按 Ctrl+V 粘贴图片');
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
      setDialogError('没有检测到图片，请拖入 PNG、JPG、WebP 等图片文件。');
      setStatus('没有检测到图片，请拖入 PNG、JPG、WebP 等图片文件。');
      return;
    }

    try {
      const src = await fileToDataUrl(file);
      setPendingImage({ name: file.name || '粘贴的图片', src, noteUid: createNoteUid() });
      setRemark('');
      setSaved(false);
      setDialogError('');
      setStatus('图片已接收，请补充备注。');
    } catch (error) {
      const message = error instanceof Error ? error.message : '图片读取失败，请重试。';
      setSaved(false);
      setDialogError(message);
      setStatus(message);
    }
  }, [saving]);

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
        setStatus('已取消，继续拖入下一张图片。');
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
      setStatus('正在写入本地笔记……');
      const result = await saveNoteImage({
        imageDataUrl: pendingImage.src,
        kind: 'single',
        noteUid: pendingImage.noteUid,
        remark,
      });
      setPendingImage(null);
      setRemark('');
      setDialogError('');
      setSaved(true);
      const aiMessage = result.aiStatus === 'complete'
        ? 'AI 整理完成'
        : result.aiStatus === 'failed'
          ? 'AI 将在稍后整理'
          : 'AI 正在后台整理';
      setStatus(`已安全保存：${getSavedFileName(result.filePath)} · ${aiMessage}`);
    } catch (error) {
      const message = error instanceof Error ? `保存失败：${error.message}` : '保存失败，请确认笔记服务已启动。';
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
    setStatus('已取消，继续拖入下一张图片。');
  };

  const minimizeWindow = () => window.kaoyanDesktop?.minimize();
  const closeWindow = () => window.kaoyanDesktop?.close();

  const openCanvas = () => {
    if (window.kaoyanDesktop?.openNoteCanvas) {
      void window.kaoyanDesktop.openNoteCanvas();
    }
  };

  return (
    <main
      className={`note-drop-app ${dragActive ? 'is-dragging' : ''} ${pendingImage ? 'is-remark-mode' : ''}`}
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
        {window.kaoyanDesktop?.isElectron && (
          <nav aria-label="窗口控制">
            <button type="button" onClick={minimizeWindow} aria-label="最小化"><Minus size={15} /></button>
            <button type="button" onClick={closeWindow} aria-label="关闭"><X size={15} /></button>
          </nav>
        )}
      </header>

      <section className="note-drop-body">
        <button
          className="note-drop-zone"
          type="button"
          aria-label="拖入图片或点击选择图片"
          onClick={() => fileInputRef.current?.click()}
        >
          <span className="note-drop-zone-icon"><ImagePlus size={18} aria-hidden="true" /></span>
          <span className="note-drop-zone-copy">
            <strong>{dragActive ? '松手放入图片' : '直接拖入图片'}</strong>
            <small>自动弹出备注 · Ctrl+V</small>
          </span>
        </button>
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

      <footer className={saved ? 'is-success' : ''} aria-live="polite">
        {saved ? <CheckCircle2 size={13} aria-hidden="true" /> : <FileImage size={13} aria-hidden="true" />}
        <span>{status}</span>
      </footer>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
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
              <div>
                <p>图片已放入</p>
                <h2 id="note-remark-title">写一句备注</h2>
              </div>
              <button type="button" onClick={cancelPending} disabled={saving} aria-label="取消并关闭备注框"><X size={17} /></button>
            </header>

            <figure>
              <img src={pendingImage.src} alt="待保存的笔记图片" />
              <figcaption>{pendingImage.name}</figcaption>
            </figure>

            <label>
              <span>备注（可以留空）</span>
              <textarea
                ref={remarkRef}
                value={remark}
                onChange={(event) => setRemark(event.target.value)}
                placeholder="例如：线性代数第二章易错题，注意正交矩阵的性质……"
              />
              <small>AI 会按任务难度选择模型，并结合图片和备注自动整理。</small>
            </label>

            {dialogError && <p className="note-remark-error" id="note-remark-error" role="alert">{dialogError}</p>}

            <div className="note-remark-actions">
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={saving}><ImagePlus size={15} /> 换一张</button>
              <button type="button" onClick={cancelPending} disabled={saving}>取消</button>
              <button className="primary" type="submit" disabled={saving}><Save size={15} /> {saving ? '正在本地保存……' : '保存笔记'}</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
