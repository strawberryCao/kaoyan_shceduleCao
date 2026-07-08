import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Clipboard, FileImage, ImagePlus, Save } from 'lucide-react';
import { fileToDataUrl, loadImage, saveNoteImage } from '../utils/notes';

interface BoardImage {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BoardText {
  id: string;
  text: string;
  x: number;
  y: number;
}

type DragState =
  | { type: 'image'; id: string; startX: number; startY: number; originX: number; originY: number }
  | { type: 'resize'; id: string; startX: number; startY: number; originWidth: number; originHeight: number }
  | { type: 'text'; id: string; startX: number; startY: number; originX: number; originY: number };

const makeId = () => `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

const getImageFileFromFiles = (files: FileList | null): File | null => {
  if (!files) {
    return null;
  }
  return Array.from(files).find((file) => file.type.startsWith('image/')) ?? null;
};

const getImageFileFromClipboard = (items: DataTransferItemList): File | null => {
  return Array.from(items).find((item) => item.type.startsWith('image/'))?.getAsFile() ?? null;
};

export function NoteCapturePage() {
  const singleInputRef = useRef<HTMLInputElement>(null);
  const canvasInputRef = useRef<HTMLInputElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [singleImage, setSingleImage] = useState<string | null>(null);
  const [singleRemark, setSingleRemark] = useState('');
  const [canvasRemark, setCanvasRemark] = useState('');
  const [activeMode, setActiveMode] = useState<'single' | 'canvas'>('single');
  const [images, setImages] = useState<BoardImage[]>([]);
  const [texts, setTexts] = useState<BoardText[]>([]);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [message, setMessage] = useState('打开本页面后，拖拽、Ctrl+V、选择文件都会比 Lively 壁纸里稳定。');
  const [saving, setSaving] = useState(false);

  const addSingleFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setMessage('目前只支持图片文件。');
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    setSingleImage(dataUrl);
    setActiveMode('single');
    setMessage('图片已放入单图保存区，补充备注后点击保存。');
  };

  const addCanvasImage = useCallback(async (file: File, clientX?: number, clientY?: number) => {
    if (!file.type.startsWith('image/')) {
      setMessage('目前只支持图片文件。');
      return;
    }
    const src = await fileToDataUrl(file);
    const image = await loadImage(src);
    const rect = boardRef.current?.getBoundingClientRect();
    const maxWidth = 340;
    const ratio = image.width > maxWidth ? maxWidth / image.width : 1;
    const width = Math.max(140, Math.round(image.width * ratio));
    const height = Math.max(90, Math.round(image.height * ratio));

    setImages((current) => [
      ...current,
      {
        id: makeId(),
        src,
        x: rect && clientX ? Math.max(16, clientX - rect.left - width / 2) : 48 + current.length * 26,
        y: rect && clientY ? Math.max(16, clientY - rect.top - height / 2) : 48 + current.length * 26,
        width,
        height,
      },
    ]);
    setActiveMode('canvas');
    setMessage('图片已加入画布。可以拖动位置，拖右下角调整大小。');
  }, []);

  useEffect(() => {
    const handlePaste = async (event: ClipboardEvent) => {
      const file = event.clipboardData ? getImageFileFromClipboard(event.clipboardData.items) : null;
      if (!file) {
        return;
      }
      event.preventDefault();
      if (activeMode === 'canvas') {
        await addCanvasImage(file);
      } else {
        await addSingleFile(file);
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [activeMode, addCanvasImage]);

  const saveSingle = async () => {
    if (!singleImage) {
      setMessage('先拖入、粘贴或选择一张图片。');
      return;
    }
    try {
      setSaving(true);
      const result = await saveNoteImage({ imageDataUrl: singleImage, kind: 'single', remark: singleRemark });
      setMessage(`单图已保存：${result.filePath ?? ''}`);
      setSingleImage(null);
      setSingleRemark('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const renderCanvas = async (): Promise<string> => {
    const rect = boardRef.current?.getBoundingClientRect();
    const width = Math.round(rect?.width ?? 1100);
    const height = Math.round(rect?.height ?? 660);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('无法创建画布');
    }

    ctx.fillStyle = '#f7f4ee';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#ded6cb';
    for (let x = 0; x < width; x += 32) {
      ctx.fillRect(x, 0, 1, height);
    }
    for (let y = 0; y < height; y += 32) {
      ctx.fillRect(0, y, width, 1);
    }

    for (const item of images) {
      const image = await loadImage(item.src);
      ctx.drawImage(image, item.x, item.y, item.width, item.height);
    }

    ctx.font = '800 22px Microsoft YaHei, sans-serif';
    ctx.fillStyle = '#243039';
    for (const item of texts) {
      ctx.fillText(item.text, item.x, item.y);
    }

    return canvas.toDataURL('image/png');
  };

  const saveCanvas = async () => {
    if (images.length === 0 && texts.length === 0) {
      setMessage('画布还是空的。先粘贴/拖入图片，或者双击空白处打字。');
      return;
    }
    try {
      setSaving(true);
      const imageDataUrl = await renderCanvas();
      const result = await saveNoteImage({ imageDataUrl, kind: 'canvas', remark: canvasRemark });
      setMessage(`画布已保存：${result.filePath ?? ''}`);
      setImages([]);
      setTexts([]);
      setCanvasRemark('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const move = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!dragState) {
      return;
    }
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;

    if (dragState.type === 'image') {
      setImages((current) => current.map((image) => image.id === dragState.id ? { ...image, x: Math.max(0, dragState.originX + dx), y: Math.max(0, dragState.originY + dy) } : image));
    }

    if (dragState.type === 'resize') {
      setImages((current) => current.map((image) => image.id === dragState.id ? { ...image, width: Math.max(90, dragState.originWidth + dx), height: Math.max(70, dragState.originHeight + dy) } : image));
    }

    if (dragState.type === 'text') {
      setTexts((current) => current.map((item) => item.id === dragState.id ? { ...item, x: Math.max(0, dragState.originX + dx), y: Math.max(0, dragState.originY + dy) } : item));
    }
  };

  const addText = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target !== boardRef.current) {
      return;
    }
    const text = window.prompt('输入要放在画布上的文字：', '');
    if (!text) {
      return;
    }
    const rect = boardRef.current.getBoundingClientRect();
    setTexts((current) => [...current, { id: makeId(), text, x: event.clientX - rect.left, y: event.clientY - rect.top }]);
  };

  return (
    <main className="note-capture-page">
      <header className="note-capture-header">
        <div>
          <p>考研笔记台</p>
          <h1>稳定保存图片和画布</h1>
          <span>{message}</span>
        </div>
        <div className="note-capture-header-actions">
          <button type="button" onClick={() => window.open(`${window.location.origin}/?wallpaper=1`, '_blank', 'noopener,noreferrer')}>
            <ArrowLeft size={15} /> 回到壁纸页
          </button>
          <button type="button" onClick={() => window.open('http://127.0.0.1:5174/health', '_blank', 'noopener,noreferrer')}>
            检查保存服务
          </button>
        </div>
      </header>

      <section className="note-capture-tabs">
        <button className={activeMode === 'single' ? 'active' : ''} type="button" onClick={() => setActiveMode('single')}>单图保存</button>
        <button className={activeMode === 'canvas' ? 'active' : ''} type="button" onClick={() => setActiveMode('canvas')}>存储画布</button>
      </section>

      <section className="note-capture-layout">
        <section className="note-capture-panel">
          <header>
            <FileImage size={18} />
            <div>
              <h2>单图保存</h2>
              <p>拖入图片、Ctrl+V 粘贴，或选择文件。</p>
            </div>
          </header>
          <div
            className={`single-drop-zone ${singleImage ? 'has-image' : ''}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={async (event) => {
              event.preventDefault();
              const file = getImageFileFromFiles(event.dataTransfer.files);
              if (file) {
                await addSingleFile(file);
              }
            }}
            onClick={() => singleInputRef.current?.click()}
          >
            {singleImage ? <img src={singleImage} alt="待保存图片" /> : <span><Clipboard size={20} /> 拖入 / 粘贴 / 点击选择图片</span>}
          </div>
          <textarea value={singleRemark} onChange={(event) => setSingleRemark(event.target.value)} placeholder="备注，可为空。千问会结合图片和备注命名。" />
          <input ref={singleInputRef} type="file" accept="image/*" hidden onChange={async (event) => {
            const file = getImageFileFromFiles(event.currentTarget.files);
            if (file) {
              await addSingleFile(file);
            }
            event.currentTarget.value = '';
          }} />
          <button className="note-primary-button" type="button" onClick={saveSingle} disabled={saving || !singleImage}>
            <Save size={15} /> {saving ? '保存中' : '保存单图'}
          </button>
        </section>

        <section className="note-capture-panel canvas-panel">
          <header>
            <ImagePlus size={18} />
            <div>
              <h2>存储画布</h2>
              <p>在画布区拖入/粘贴多张图片，双击空白处打字。</p>
            </div>
          </header>
          <div className="canvas-toolbar">
            <button type="button" onClick={() => canvasInputRef.current?.click()}>选择图片加入画布</button>
            <button type="button" onClick={() => { setImages([]); setTexts([]); }}>清空画布</button>
          </div>
          <div
            className="capture-board"
            ref={boardRef}
            onDoubleClick={addText}
            onDragOver={(event) => event.preventDefault()}
            onDrop={async (event) => {
              event.preventDefault();
              const file = getImageFileFromFiles(event.dataTransfer.files);
              if (file) {
                await addCanvasImage(file, event.clientX, event.clientY);
              }
            }}
            onMouseMove={move}
            onMouseUp={() => setDragState(null)}
            onMouseLeave={() => setDragState(null)}
          >
            <span className="capture-board-tip">Ctrl+V 直接粘贴到当前模式；图片可拖动，右下角可缩放</span>
            {images.map((image) => (
              <div
                className="capture-board-image"
                key={image.id}
                style={{ left: image.x, top: image.y, width: image.width, height: image.height }}
                onMouseDown={(event) => {
                  event.stopPropagation();
                  setDragState({ type: 'image', id: image.id, startX: event.clientX, startY: event.clientY, originX: image.x, originY: image.y });
                }}
              >
                <img src={image.src} alt="画布图片" draggable={false} />
                <span
                  className="capture-board-resize"
                  onMouseDown={(event) => {
                    event.stopPropagation();
                    setDragState({ type: 'resize', id: image.id, startX: event.clientX, startY: event.clientY, originWidth: image.width, originHeight: image.height });
                  }}
                />
              </div>
            ))}
            {texts.map((item) => (
              <span
                className="capture-board-text"
                key={item.id}
                style={{ left: item.x, top: item.y }}
                onMouseDown={(event) => {
                  event.stopPropagation();
                  setDragState({ type: 'text', id: item.id, startX: event.clientX, startY: event.clientY, originX: item.x, originY: item.y });
                }}
              >
                {item.text}
              </span>
            ))}
          </div>
          <textarea value={canvasRemark} onChange={(event) => setCanvasRemark(event.target.value)} placeholder="画布备注，可为空。" />
          <input ref={canvasInputRef} type="file" accept="image/*" hidden onChange={async (event) => {
            const file = getImageFileFromFiles(event.currentTarget.files);
            if (file) {
              await addCanvasImage(file);
            }
            event.currentTarget.value = '';
          }} />
          <button className="note-primary-button" type="button" onClick={saveCanvas} disabled={saving || (images.length === 0 && texts.length === 0)}>
            <Save size={15} /> {saving ? '保存中' : '保存画布'}
          </button>
        </section>
      </section>
    </main>
  );
}
