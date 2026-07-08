import { useMemo, useRef, useState } from 'react';
import { Clipboard, Images, Save, X } from 'lucide-react';
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

const getImageFileFromDataTransfer = (files: FileList | null): File | null => {
  if (!files) {
    return null;
  }
  return Array.from(files).find((file) => file.type.startsWith('image/')) ?? null;
};

const getImageFileFromClipboard = (items: DataTransferItemList): File | null => {
  return Array.from(items)
    .find((item) => item.type.startsWith('image/'))
    ?.getAsFile() ?? null;
};

interface CanvasBoardModalProps {
  onClose: () => void;
  onSaved: (message: string) => void;
}

function CanvasBoardModal({ onClose, onSaved }: CanvasBoardModalProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [images, setImages] = useState<BoardImage[]>([]);
  const [texts, setTexts] = useState<BoardText[]>([]);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [saving, setSaving] = useState(false);

  const addImage = async (file: File, clientX?: number, clientY?: number) => {
    const src = await fileToDataUrl(file);
    const image = await loadImage(src);
    const rect = boardRef.current?.getBoundingClientRect();
    const maxWidth = 280;
    const ratio = image.width > maxWidth ? maxWidth / image.width : 1;
    const width = Math.max(120, Math.round(image.width * ratio));
    const height = Math.max(80, Math.round(image.height * ratio));

    setImages((current) => [
      ...current,
      {
        id: makeId(),
        src,
        x: rect && clientX ? Math.max(20, clientX - rect.left - width / 2) : 40 + current.length * 24,
        y: rect && clientY ? Math.max(20, clientY - rect.top - height / 2) : 40 + current.length * 24,
        width,
        height,
      },
    ]);
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = getImageFileFromDataTransfer(event.dataTransfer.files);
    if (file) {
      await addImage(file, event.clientX, event.clientY);
    }
  };

  const handlePaste = async (event: React.ClipboardEvent<HTMLDivElement>) => {
    const file = getImageFileFromClipboard(event.clipboardData.items);
    if (file) {
      event.preventDefault();
      await addImage(file);
    }
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target !== boardRef.current) {
      return;
    }
    const text = window.prompt('输入要放在画布上的文字：', '');
    if (!text) {
      return;
    }
    const rect = boardRef.current.getBoundingClientRect();
    setTexts((current) => [
      ...current,
      {
        id: makeId(),
        text,
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      },
    ]);
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
      setImages((current) => current.map((image) => image.id === dragState.id ? { ...image, width: Math.max(80, dragState.originWidth + dx), height: Math.max(60, dragState.originHeight + dy) } : image));
    }

    if (dragState.type === 'text') {
      setTexts((current) => current.map((item) => item.id === dragState.id ? { ...item, x: Math.max(0, dragState.originX + dx), y: Math.max(0, dragState.originY + dy) } : item));
    }
  };

  const renderCanvas = async (): Promise<string> => {
    const rect = boardRef.current?.getBoundingClientRect();
    const width = Math.round(rect?.width ?? 1000);
    const height = Math.round(rect?.height ?? 640);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('无法创建画布');
    }

    ctx.fillStyle = '#f7f4ee';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#d8d0c4';
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

    ctx.font = '700 22px Microsoft YaHei, sans-serif';
    ctx.fillStyle = '#243039';
    for (const item of texts) {
      ctx.fillText(item.text, item.x, item.y);
    }

    return canvas.toDataURL('image/png');
  };

  const saveCanvas = async () => {
    if (images.length === 0 && texts.length === 0) {
      window.alert('画布还是空的，先贴图片或双击添加文字。');
      return;
    }
    const remark = window.prompt('给这个画布添加备注，可以为空：', '') ?? '';
    try {
      setSaving(true);
      const imageDataUrl = await renderCanvas();
      const result = await saveNoteImage({ imageDataUrl, kind: 'canvas', remark });
      onSaved(`画布已保存：${result.filePath ?? ''}`);
      onClose();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="note-modal-backdrop" role="dialog" aria-modal="true">
      <section className="note-modal">
        <header className="note-modal-header">
          <div>
            <p>存储画布</p>
            <h2>图片拼接 / 临时整理</h2>
          </div>
          <div className="note-modal-actions">
            <button type="button" onClick={saveCanvas} disabled={saving}>
              <Save size={14} aria-hidden="true" />
              {saving ? '保存中' : '保存画布'}
            </button>
            <button type="button" onClick={onClose} aria-label="关闭画布">
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div
          className="note-board"
          onDoubleClick={handleDoubleClick}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          onMouseMove={move}
          onMouseUp={() => setDragState(null)}
          onMouseLeave={() => setDragState(null)}
          onPaste={handlePaste}
          ref={boardRef}
          tabIndex={0}
        >
          <span className="note-board-tip">拖入/粘贴图片，拖动调整位置，右下角拖拽缩放，双击空白处打字</span>
          {images.map((image) => (
            <div
              className="note-board-image"
              key={image.id}
              style={{ left: image.x, top: image.y, width: image.width, height: image.height }}
              onMouseDown={(event) => {
                event.stopPropagation();
                setDragState({ type: 'image', id: image.id, startX: event.clientX, startY: event.clientY, originX: image.x, originY: image.y });
              }}
            >
              <img alt="画布图片" draggable={false} src={image.src} />
              <span
                className="note-board-resize"
                onMouseDown={(event) => {
                  event.stopPropagation();
                  setDragState({ type: 'resize', id: image.id, startX: event.clientX, startY: event.clientY, originWidth: image.width, originHeight: image.height });
                }}
              />
            </div>
          ))}
          {texts.map((item) => (
            <span
              className="note-board-text"
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
      </section>
    </div>
  );
}

export function NoteDock() {
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [message, setMessage] = useState('拖图或点击后 Ctrl+V 保存');
  const [saving, setSaving] = useState(false);
  const dockTitle = useMemo(() => saving ? '保存中...' : '笔记暂存', [saving]);

  const saveFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      window.alert('目前只支持保存图片。');
      return;
    }
    const remark = window.prompt('给这张图片添加备注，可以为空：', '') ?? '';
    try {
      setSaving(true);
      const imageDataUrl = await fileToDataUrl(file);
      const result = await saveNoteImage({ imageDataUrl, kind: 'single', remark });
      setMessage(`已保存：${result.filePath ?? ''}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
      window.alert('保存失败。确认 启动壁纸模式.cmd 已经启动本地笔记服务。');
    } finally {
      setSaving(false);
    }
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = getImageFileFromDataTransfer(event.dataTransfer.files);
    if (file) {
      await saveFile(file);
    }
  };

  const handlePaste = async (event: React.ClipboardEvent<HTMLDivElement>) => {
    const file = getImageFileFromClipboard(event.clipboardData.items);
    if (file) {
      event.preventDefault();
      await saveFile(file);
    }
  };

  return (
    <>
      <section
        className="note-dock"
        onClick={(event) => event.currentTarget.focus()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        onPaste={handlePaste}
        tabIndex={0}
        aria-label="笔记暂存"
      >
        <div className="note-dock-main">
          <span className="note-dock-icon"><Clipboard size={16} aria-hidden="true" /></span>
          <div>
            <p>{dockTitle}</p>
            <span>{message}</span>
          </div>
        </div>
        <button
          className="note-canvas-button"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setCanvasOpen(true);
          }}
          title="画布拼接"
        >
          <Images size={15} aria-hidden="true" />
        </button>
      </section>

      {canvasOpen && (
        <CanvasBoardModal
          onClose={() => setCanvasOpen(false)}
          onSaved={(nextMessage) => setMessage(nextMessage)}
        />
      )}
    </>
  );
}
