import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Brush, Clipboard, FileImage, ImagePlus, MousePointer2, Save, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { fileToDataUrl, loadImage, saveNoteImage } from '../utils/notes';

const BOARD_WIDTH = 2600;
const BOARD_HEIGHT = 1800;

type ElementType = 'image' | 'text' | 'stroke';

type SelectedKey = `${ElementType}:${string}`;

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

interface StrokePoint {
  x: number;
  y: number;
}

interface BoardStroke {
  id: string;
  points: StrokePoint[];
  color: string;
  width: number;
}

interface SelectionBox {
  start: StrokePoint;
  current: StrokePoint;
}

type CanvasTool = 'select' | 'brush';

type DragState =
  | { type: 'image'; id: string; startX: number; startY: number; originX: number; originY: number }
  | { type: 'resize'; id: string; startX: number; startY: number; originWidth: number; originHeight: number }
  | { type: 'text'; id: string; startX: number; startY: number; originX: number; originY: number };

const makeId = () => `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
const makeKey = (type: ElementType, id: string): SelectedKey => `${type}:${id}`;
const parseKey = (key: SelectedKey) => {
  const [type, id] = key.split(':') as [ElementType, string];
  return { type, id };
};

const getImageFileFromFiles = (files: FileList | null): File | null => {
  if (!files) {
    return null;
  }
  return Array.from(files).find((file) => file.type.startsWith('image/')) ?? null;
};

const getImageFileFromClipboard = (items: DataTransferItemList): File | null => {
  return Array.from(items).find((item) => item.type.startsWith('image/'))?.getAsFile() ?? null;
};

const strokeToPath = (points: StrokePoint[]): string => {
  if (points.length === 0) {
    return '';
  }
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
};

const getRectFromBox = (box: SelectionBox) => {
  const left = Math.min(box.start.x, box.current.x);
  const top = Math.min(box.start.y, box.current.y);
  const right = Math.max(box.start.x, box.current.x);
  const bottom = Math.max(box.start.y, box.current.y);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

const intersects = (a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }) => {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
};

const getStrokeBounds = (stroke: BoardStroke) => {
  if (stroke.points.length === 0) {
    return { left: 0, top: 0, right: 0, bottom: 0 };
  }
  const xs = stroke.points.map((point) => point.x);
  const ys = stroke.points.map((point) => point.y);
  const pad = stroke.width + 4;
  return {
    left: Math.min(...xs) - pad,
    top: Math.min(...ys) - pad,
    right: Math.max(...xs) + pad,
    bottom: Math.max(...ys) + pad,
  };
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
  const [strokes, setStrokes] = useState<BoardStroke[]>([]);
  const [tool, setTool] = useState<CanvasTool>('select');
  const [selectedKeys, setSelectedKeys] = useState<SelectedKey[]>([]);
  const [drawingId, setDrawingId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [zoom, setZoom] = useState(0.55);
  const [message, setMessage] = useState('大画布支持缩放、滚动、框选、多删。图片是位图，文字和画笔线条按矢量元素编辑。');
  const [saving, setSaving] = useState(false);

  const getBoardPoint = useCallback((clientX: number, clientY: number): StrokePoint => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) {
      return { x: 0, y: 0 };
    }
    return {
      x: Math.max(0, Math.min(BOARD_WIDTH, (clientX - rect.left) / zoom)),
      y: Math.max(0, Math.min(BOARD_HEIGHT, (clientY - rect.top) / zoom)),
    };
  }, [zoom]);

  const isSelected = (type: ElementType, id: string) => selectedKeys.includes(makeKey(type, id));

  const selectOnly = (type: ElementType, id: string) => {
    setSelectedKeys([makeKey(type, id)]);
  };

  const deleteSelected = useCallback(() => {
    if (selectedKeys.length === 0) {
      setMessage('先点选元素，或在选择模式下拖出一个框选区域，再删除。');
      return;
    }
    const imageIds = new Set(selectedKeys.map(parseKey).filter((item) => item.type === 'image').map((item) => item.id));
    const textIds = new Set(selectedKeys.map(parseKey).filter((item) => item.type === 'text').map((item) => item.id));
    const strokeIds = new Set(selectedKeys.map(parseKey).filter((item) => item.type === 'stroke').map((item) => item.id));
    setImages((current) => current.filter((item) => !imageIds.has(item.id)));
    setTexts((current) => current.filter((item) => !textIds.has(item.id)));
    setStrokes((current) => current.filter((item) => !strokeIds.has(item.id)));
    setSelectedKeys([]);
    setMessage(`已删除 ${selectedKeys.length} 个元素。`);
  }, [selectedKeys]);

  useEffect(() => {
    const handleDelete = (event: KeyboardEvent) => {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const target = event.target as HTMLElement | null;
        if (target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT') {
          return;
        }
        deleteSelected();
      }
    };
    window.addEventListener('keydown', handleDelete);
    return () => window.removeEventListener('keydown', handleDelete);
  }, [deleteSelected]);

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
    const maxWidth = 720;
    const ratio = image.width > maxWidth ? maxWidth / image.width : 1;
    const width = Math.max(180, Math.round(image.width * ratio));
    const height = Math.max(120, Math.round(image.height * ratio));
    const point = clientX && clientY ? getBoardPoint(clientX, clientY) : { x: 120 + images.length * 30, y: 120 + images.length * 30 };
    const id = makeId();

    setImages((current) => [
      ...current,
      {
        id,
        src,
        x: Math.max(0, Math.min(BOARD_WIDTH - width, point.x - width / 2)),
        y: Math.max(0, Math.min(BOARD_HEIGHT - height, point.y - height / 2)),
        width,
        height,
      },
    ]);
    setSelectedKeys([makeKey('image', id)]);
    setTool('select');
    setActiveMode('canvas');
    setMessage('图片已加入大画布。可以缩放视图、滚动画布、框选多个元素删除。');
  }, [getBoardPoint, images.length]);

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
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = BOARD_WIDTH * scale;
    canvas.height = BOARD_HEIGHT * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('无法创建画布');
    }

    ctx.scale(scale, scale);
    ctx.fillStyle = '#f7f4ee';
    ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
    ctx.fillStyle = '#ded6cb';
    for (let x = 0; x < BOARD_WIDTH; x += 32) {
      ctx.fillRect(x, 0, 1, BOARD_HEIGHT);
    }
    for (let y = 0; y < BOARD_HEIGHT; y += 32) {
      ctx.fillRect(0, y, BOARD_WIDTH, 1);
    }

    for (const item of images) {
      const image = await loadImage(item.src);
      ctx.drawImage(image, item.x, item.y, item.width, item.height);
    }

    for (const stroke of strokes) {
      if (stroke.points.length < 2) {
        continue;
      }
      ctx.beginPath();
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (const point of stroke.points.slice(1)) {
        ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();
    }

    ctx.font = '800 28px Microsoft YaHei, sans-serif';
    ctx.fillStyle = '#243039';
    for (const item of texts) {
      ctx.fillText(item.text, item.x, item.y);
    }

    return canvas.toDataURL('image/png');
  };

  const saveCanvas = async () => {
    if (images.length === 0 && texts.length === 0 && strokes.length === 0) {
      setMessage('画布还是空的。先粘贴/拖入图片、双击打字，或切到画笔写东西。');
      return;
    }
    try {
      setSaving(true);
      const imageDataUrl = await renderCanvas();
      const result = await saveNoteImage({ imageDataUrl, kind: 'canvas', remark: canvasRemark });
      setMessage(`画布已保存：${result.filePath ?? ''}`);
      setImages([]);
      setTexts([]);
      setStrokes([]);
      setSelectedKeys([]);
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
    const dx = (event.clientX - dragState.startX) / zoom;
    const dy = (event.clientY - dragState.startY) / zoom;

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
    if (event.target !== boardRef.current || tool !== 'select') {
      return;
    }
    const text = window.prompt('输入要放在画布上的文字：', '');
    if (!text) {
      return;
    }
    const point = getBoardPoint(event.clientX, event.clientY);
    const id = makeId();
    setTexts((current) => [...current, { id, text, x: point.x, y: point.y }]);
    setSelectedKeys([makeKey('text', id)]);
  };

  const selectByBox = (box: SelectionBox) => {
    const rect = getRectFromBox(box);
    if (rect.width < 8 || rect.height < 8) {
      setSelectedKeys([]);
      return;
    }
    const next: SelectedKey[] = [];
    for (const image of images) {
      if (intersects(rect, { left: image.x, top: image.y, right: image.x + image.width, bottom: image.y + image.height })) {
        next.push(makeKey('image', image.id));
      }
    }
    for (const text of texts) {
      const width = Math.max(120, text.text.length * 28);
      if (intersects(rect, { left: text.x, top: text.y - 32, right: text.x + width, bottom: text.y + 8 })) {
        next.push(makeKey('text', text.id));
      }
    }
    for (const stroke of strokes) {
      if (intersects(rect, getStrokeBounds(stroke))) {
        next.push(makeKey('stroke', stroke.id));
      }
    }
    setSelectedKeys(next);
    setMessage(next.length > 0 ? `已框选 ${next.length} 个元素。按 Delete 或点“删除选中”。` : '框选区域内没有元素。');
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== boardRef.current || !boardRef.current) {
      return;
    }
    const point = getBoardPoint(event.clientX, event.clientY);
    if (tool === 'brush') {
      const id = makeId();
      setStrokes((current) => [...current, { id, points: [point], color: '#243039', width: 4 }]);
      setDrawingId(id);
      setSelectedKeys([makeKey('stroke', id)]);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    setSelectionBox({ start: point, current: point });
    setSelectedKeys([]);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!boardRef.current) {
      return;
    }
    const point = getBoardPoint(event.clientX, event.clientY);
    if (drawingId) {
      setStrokes((current) => current.map((stroke) => stroke.id === drawingId ? { ...stroke, points: [...stroke.points, point] } : stroke));
      return;
    }
    if (selectionBox) {
      setSelectionBox((current) => current ? { ...current, current: point } : null);
    }
  };

  const handlePointerUp = () => {
    if (selectionBox) {
      selectByBox(selectionBox);
    }
    setDrawingId(null);
    setSelectionBox(null);
  };

  const selectionRect = selectionBox ? getRectFromBox(selectionBox) : null;

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
        <section className="note-capture-panel single-panel">
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
              <p>{BOARD_WIDTH} × {BOARD_HEIGHT} 逻辑大画布，支持缩放、滚动、框选、多删、画笔。</p>
            </div>
          </header>
          <div className="canvas-toolbar">
            <button className={tool === 'select' ? 'active' : ''} type="button" onClick={() => setTool('select')}><MousePointer2 size={14} /> 选择/框选</button>
            <button className={tool === 'brush' ? 'active' : ''} type="button" onClick={() => setTool('brush')}><Brush size={14} /> 画笔</button>
            <button type="button" onClick={() => setZoom((value) => Math.max(0.25, Number((value - 0.15).toFixed(2))))}><ZoomOut size={14} /> 缩小</button>
            <span className="canvas-zoom-label">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((value) => Math.min(2, Number((value + 0.15).toFixed(2))))}><ZoomIn size={14} /> 放大</button>
            <button type="button" onClick={() => canvasInputRef.current?.click()}>选择图片加入画布</button>
            <button type="button" onClick={deleteSelected}><Trash2 size={14} /> 删除选中 {selectedKeys.length ? `(${selectedKeys.length})` : ''}</button>
            <button type="button" onClick={() => { setImages([]); setTexts([]); setStrokes([]); setSelectedKeys([]); }}>清空画布</button>
          </div>

          <div className="capture-board-viewport">
            <div className="capture-board-stage" style={{ width: BOARD_WIDTH * zoom, height: BOARD_HEIGHT * zoom }}>
              <div
                className={`capture-board tool-${tool}`}
                ref={boardRef}
                style={{ width: BOARD_WIDTH, height: BOARD_HEIGHT, transform: `scale(${zoom})` }}
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
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
              >
                <span className="capture-board-tip">拖动画布滚动条移动视野；选择模式空白处拖拽框选；图片是位图，文字和画笔按矢量元素编辑</span>
                {images.map((image) => (
                  <div
                    className={`capture-board-image ${isSelected('image', image.id) ? 'selected' : ''}`}
                    key={image.id}
                    style={{ left: image.x, top: image.y, width: image.width, height: image.height }}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      if (tool !== 'select') {
                        return;
                      }
                      selectOnly('image', image.id);
                      setDragState({ type: 'image', id: image.id, startX: event.clientX, startY: event.clientY, originX: image.x, originY: image.y });
                    }}
                  >
                    <img src={image.src} alt="画布图片" draggable={false} />
                    <button className="capture-item-delete" type="button" onClick={(event) => { event.stopPropagation(); setImages((current) => current.filter((item) => item.id !== image.id)); }} aria-label="删除图片">×</button>
                    <span
                      className="capture-board-resize"
                      onMouseDown={(event) => {
                        event.stopPropagation();
                        selectOnly('image', image.id);
                        setDragState({ type: 'resize', id: image.id, startX: event.clientX, startY: event.clientY, originWidth: image.width, originHeight: image.height });
                      }}
                    />
                  </div>
                ))}
                <svg className="capture-stroke-layer" viewBox={`0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}`}>
                  {strokes.map((stroke) => (
                    <path
                      className={isSelected('stroke', stroke.id) ? 'selected' : ''}
                      key={stroke.id}
                      d={strokeToPath(stroke.points)}
                      fill="none"
                      stroke={stroke.color}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={stroke.width}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        if (tool === 'select') {
                          selectOnly('stroke', stroke.id);
                        }
                      }}
                    />
                  ))}
                </svg>
                {texts.map((item) => (
                  <span
                    className={`capture-board-text ${isSelected('text', item.id) ? 'selected' : ''}`}
                    key={item.id}
                    style={{ left: item.x, top: item.y }}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      if (tool !== 'select') {
                        return;
                      }
                      selectOnly('text', item.id);
                      setDragState({ type: 'text', id: item.id, startX: event.clientX, startY: event.clientY, originX: item.x, originY: item.y });
                    }}
                  >
                    {item.text}
                    <button type="button" onClick={(event) => { event.stopPropagation(); setTexts((current) => current.filter((text) => text.id !== item.id)); }} aria-label="删除文字">×</button>
                  </span>
                ))}
                {selectionRect && (
                  <span
                    className="capture-selection-box"
                    style={{ left: selectionRect.left, top: selectionRect.top, width: selectionRect.width, height: selectionRect.height }}
                  />
                )}
              </div>
            </div>
          </div>

          <textarea value={canvasRemark} onChange={(event) => setCanvasRemark(event.target.value)} placeholder="画布备注，可为空。" />
          <input ref={canvasInputRef} type="file" accept="image/*" hidden onChange={async (event) => {
            const file = getImageFileFromFiles(event.currentTarget.files);
            if (file) {
              await addCanvasImage(file);
            }
            event.currentTarget.value = '';
          }} />
          <button className="note-primary-button" type="button" onClick={saveCanvas} disabled={saving || (images.length === 0 && texts.length === 0 && strokes.length === 0)}>
            <Save size={15} /> {saving ? '保存中' : '保存画布'}
          </button>
        </section>
      </section>
    </main>
  );
}
