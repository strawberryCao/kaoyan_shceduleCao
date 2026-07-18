import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileDown,
  FileUp,
  HelpCircle,
  ImageDown,
  ImagePlus,
  Link2,
  Maximize2,
  MessageSquareText,
  MousePointer2,
  Pencil,
  Redo2,
  Save,
  Trash2,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  CANVAS_RELATION_TYPES,
  cloneCanvasDocument,
  createCanvasId,
  createEmptyCanvasDocument,
  parseCanvasDocument,
  serializeCanvasDocument,
  type CanvasAnchor,
  type CanvasAnnotationNode,
  type CanvasDocument,
  type CanvasImageNode,
  type CanvasPoint,
  type CanvasRelationType,
} from '../utils/canvasDocument';
import '../canvas-workspace.css';

// Deliberately roomy rather than visibly finite: fit-to-content keeps users away
// from the edges, while a stable coordinate space makes drafts deterministic.
const WORLD_WIDTH = 4200;
const WORLD_HEIGHT = 3000;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 1.6;
const HISTORY_LIMIT = 60;
const IMAGE_LONG_EDGE_LIMIT = 2800;
const IMAGE_COMPRESSION_TRIGGER_BYTES = 4 * 1024 * 1024;
const SERVER_EMBEDDED_IMAGE_LIMIT_BYTES = 20 * 1024 * 1024;
const CLIENT_EMBEDDED_IMAGE_BUDGET_BYTES = 19 * 1024 * 1024;
const CLIENT_SINGLE_IMAGE_BUDGET_BYTES = 15.5 * 1024 * 1024;
const MARQUEE_MIN_SCREEN_PX = 6;

type CanvasTool = 'select' | 'text' | 'annotation' | 'relation';
type CanvasNodeKind = 'image' | 'text' | 'annotation';
type CanvasSelectionNode = { kind: CanvasNodeKind; id: string };
type SelectedNode = CanvasSelectionNode | null;
type EditingNode = { kind: 'text' | 'annotation'; id: string } | null;

interface NodeMoveOrigin extends CanvasSelectionNode {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

type Gesture =
  | {
      type: 'move';
      nodes: NodeMoveOrigin[];
      pointerId: number;
      start: CanvasPoint;
      originDocument: CanvasDocument;
    }
  | {
      type: 'resize-image';
      id: string;
      pointerId: number;
      start: CanvasPoint;
      originX: number;
      originY: number;
      originWidth: number;
      originHeight: number;
      originDocument: CanvasDocument;
    }
  | {
      type: 'resize-card';
      nodeKind: 'text' | 'annotation';
      id: string;
      pointerId: number;
      start: CanvasPoint;
      originX: number;
      originY: number;
      originWidth: number;
      originHeight: number;
      originDocument: CanvasDocument;
    }
  | {
      type: 'anchor';
      imageId: string;
      pointerId: number;
      start: CanvasPoint;
      current: CanvasPoint;
      targetAnnotationId: string | null;
      annotationKind: 'annotation' | 'relation';
    }
  | {
      type: 'marquee';
      pointerId: number;
      start: CanvasPoint;
      current: CanvasPoint;
      baseSelection: CanvasSelectionNode[];
    };

export interface CanvasPreviewOptions {
  padding?: number;
  scale?: number;
  background?: string;
  maxSide?: number;
}

export interface CanvasWorkspaceProps {
  initialDocument?: CanvasDocument | null;
  /** Set false to disable automatic localStorage drafts. */
  draftKey?: string | false;
  className?: string;
  directoryInitiallyOpen?: boolean;
  onChange?: (document: CanvasDocument) => void;
  /** Saves only the editable project. Preview export/publishing stays explicit. */
  onSave?: (document: CanvasDocument) => void | Promise<void>;
  onError?: (error: Error) => void;
  onDraftStatus?: (status: 'saving' | 'saved' | 'failed') => void;
}

export interface CanvasWorkspaceHandle {
  getDocument: () => CanvasDocument;
  importDocument: (input: string | CanvasDocument) => void;
  exportDocument: () => string;
  addImages: (files: File[] | FileList, at?: CanvasPoint) => Promise<void>;
  exportPreview: (options?: CanvasPreviewOptions) => Promise<Blob>;
  fitToContent: () => void;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error('读取图片失败。'));
  reader.readAsDataURL(file);
});

const readBlobAsDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error('读取压缩图片失败。'));
  reader.readAsDataURL(blob);
});

const loadBrowserImage = (src: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('图片加载失败。'));
  image.src = src;
});

// Image data URLs contain ASCII metadata/base64, so string length equals their
// UTF-8 storage size without allocating another multi-megabyte byte array.
const embeddedImageBytes = (src: string): number => /^data:image\//i.test(src) ? src.length : 0;

const formatMiB = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

interface PreparedImageSource {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  bytes: number;
  compressed: boolean;
}

const optimizeEmbeddedImage = async (src: string, image: HTMLImageElement): Promise<PreparedImageSource> => {
  const originalBytes = embeddedImageBytes(src);
  const originalWidth = image.naturalWidth;
  const originalHeight = image.naturalHeight;
  const longestEdge = Math.max(originalWidth, originalHeight);
  const shouldTryCompression = longestEdge > IMAGE_LONG_EDGE_LIMIT || originalBytes > IMAGE_COMPRESSION_TRIGGER_BYTES;
  if (!shouldTryCompression) {
    return { src, naturalWidth: originalWidth, naturalHeight: originalHeight, bytes: originalBytes, compressed: false };
  }

  const scale = Math.min(1, IMAGE_LONG_EDGE_LIMIT / longestEdge);
  const outputWidth = Math.max(1, Math.round(originalWidth * scale));
  const outputHeight = Math.max(1, Math.round(originalHeight * scale));
  const canvas = window.document.createElement('canvas');
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext('2d');
  if (!context) {
    return { src, naturalWidth: originalWidth, naturalHeight: originalHeight, bytes: originalBytes, compressed: false };
  }
  context.drawImage(image, 0, 0, outputWidth, outputHeight);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.92));
  if (!blob) {
    return { src, naturalWidth: originalWidth, naturalHeight: originalHeight, bytes: originalBytes, compressed: false };
  }
  const compressedSrc = await readBlobAsDataUrl(blob);
  const compressedBytes = embeddedImageBytes(compressedSrc);
  if (compressedBytes >= originalBytes) {
    return { src, naturalWidth: originalWidth, naturalHeight: originalHeight, bytes: originalBytes, compressed: false };
  }
  return {
    src: compressedSrc,
    naturalWidth: outputWidth,
    naturalHeight: outputHeight,
    bytes: compressedBytes,
    compressed: true,
  };
};

const imageLetter = (index: number): string => {
  let value = index;
  let result = '';
  do {
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return result;
};

const nextZ = (document: CanvasDocument): number => Math.max(
  0,
  ...document.images.map((item) => item.z),
  ...document.texts.map((item) => item.z),
  ...document.annotations.map((item) => item.z),
) + 1;

const estimateCardHeight = (text: string, width: number, base = 86): number => {
  const charsPerLine = Math.max(8, Math.floor((width - 32) / 15));
  const lines = Math.max(1, text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0));
  return Math.max(base, 54 + lines * 24);
};

type HeightAwareCard = { text: string; width: number; height?: number };

const getCardHeight = (item: HeightAwareCard, base = 86): number => (
  typeof item.height === 'number' && Number.isFinite(item.height)
    ? item.height
    : estimateCardHeight(item.text, item.width, base)
);

const selectionNodeKey = (node: CanvasSelectionNode): string => `${node.kind}:${node.id}`;

const getNodeMoveOrigin = (document: CanvasDocument, node: CanvasSelectionNode): NodeMoveOrigin | null => {
  if (node.kind === 'image') {
    const item = document.images.find((entry) => entry.id === node.id);
    return item ? { ...node, originX: item.x, originY: item.y, width: item.width, height: item.height } : null;
  }
  if (node.kind === 'text') {
    const item = document.texts.find((entry) => entry.id === node.id);
    return item ? { ...node, originX: item.x, originY: item.y, width: item.width, height: getCardHeight(item, 56) } : null;
  }
  const item = document.annotations.find((entry) => entry.id === node.id);
  return item ? { ...node, originX: item.x, originY: item.y, width: item.width, height: getCardHeight(item) } : null;
};

const getNodesIntersectingRect = (
  document: CanvasDocument,
  rect: { left: number; top: number; right: number; bottom: number },
): CanvasSelectionNode[] => {
  const nodes: CanvasSelectionNode[] = [
    ...document.images.map((item) => ({ kind: 'image' as const, id: item.id })),
    ...document.texts.map((item) => ({ kind: 'text' as const, id: item.id })),
    ...document.annotations.map((item) => ({ kind: 'annotation' as const, id: item.id })),
  ];
  return nodes.filter((node) => {
    const box = getNodeMoveOrigin(document, node);
    return !!box
      && box.originX < rect.right
      && box.originX + box.width > rect.left
      && box.originY < rect.bottom
      && box.originY + box.height > rect.top;
  });
};

/** Compare editable structure without traversing multi-megabyte image data URLs. */
const lightweightDocumentSignature = (document: CanvasDocument): string => {
  const { images, ...documentWithoutImages } = document;
  return JSON.stringify({
    ...documentWithoutImages,
    images: images.map(({ src: _src, ...image }) => image),
  });
};

const getContentBounds = (document: CanvasDocument) => {
  const boxes: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  document.images.forEach((item) => boxes.push({ left: item.x, top: item.y, right: item.x + item.width, bottom: item.y + item.height }));
  document.texts.forEach((item) => boxes.push({
    left: item.x,
    top: item.y,
    right: item.x + item.width,
    bottom: item.y + getCardHeight(item, 56),
  }));
  document.annotations.forEach((item) => boxes.push({
    left: item.x,
    top: item.y,
    right: item.x + item.width,
    bottom: item.y + getCardHeight(item),
  }));
  if (boxes.length === 0) return { left: 120, top: 120, right: 1080, bottom: 760, width: 960, height: 640 };
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.right));
  const bottom = Math.max(...boxes.map((box) => box.bottom));
  return { left, top, right, bottom, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
};

const roundRect = (context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) => {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
};

const drawWrappedText = (
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxBottom: number,
) => {
  let cursorY = y;
  const paragraphs = (text || '（未填写）').split('\n');
  for (const paragraph of paragraphs) {
    let line = '';
    for (const char of paragraph || ' ') {
      const test = line + char;
      if (context.measureText(test).width > maxWidth && line) {
        context.fillText(line, x, cursorY);
        cursorY += lineHeight;
        line = char;
        if (cursorY > maxBottom) return;
      } else {
        line = test;
      }
    }
    if (cursorY <= maxBottom) context.fillText(line, x, cursorY);
    cursorY += lineHeight;
    if (cursorY > maxBottom) return;
  }
};

const getAnchorBoardRect = (document: CanvasDocument, anchor: CanvasAnchor) => {
  const image = document.images.find((item) => item.id === anchor.imageId);
  if (!image) return null;
  return {
    x: image.x + anchor.x * image.width,
    y: image.y + anchor.y * image.height,
    width: anchor.width * image.width,
    height: anchor.height * image.height,
  };
};

export async function renderCanvasPreview(document: CanvasDocument, options: CanvasPreviewOptions = {}): Promise<Blob> {
  const padding = options.padding ?? 52;
  const requestedScale = options.scale ?? 1.5;
  const maxSide = options.maxSide ?? 8192;
  const bounds = getContentBounds(document);
  const rawWidth = bounds.width + padding * 2;
  const rawHeight = bounds.height + padding * 2;
  const scale = Math.min(requestedScale, maxSide / rawWidth, maxSide / rawHeight);
  const canvas = window.document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(rawWidth * scale));
  canvas.height = Math.max(1, Math.ceil(rawHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建预览画布。');
  context.scale(scale, scale);
  context.fillStyle = options.background ?? '#fbf7ee';
  context.fillRect(0, 0, rawWidth, rawHeight);
  context.translate(padding - bounds.left, padding - bounds.top);

  // Weak paper grid: enough spatial guidance without competing with notes.
  context.strokeStyle = 'rgba(111, 91, 68, 0.055)';
  context.lineWidth = 1;
  context.beginPath();
  for (let x = Math.floor(bounds.left / 48) * 48; x <= bounds.right; x += 48) {
    context.moveTo(x, bounds.top);
    context.lineTo(x, bounds.bottom);
  }
  for (let y = Math.floor(bounds.top / 48) * 48; y <= bounds.bottom; y += 48) {
    context.moveTo(bounds.left, y);
    context.lineTo(bounds.right, y);
  }
  context.stroke();

  const loadedImages = new Map<string, HTMLImageElement>();
  await Promise.all(document.images.map(async (item) => {
    try {
      loadedImages.set(item.id, await loadBrowserImage(item.src));
    } catch {
      // Keep the rest of a recoverable canvas exportable if one source vanished.
    }
  }));

  // Connections stay below every node so their direction remains visible without obscuring content.
  document.annotations.forEach((annotation) => {
    const cardX = annotation.x + annotation.width / 2;
    const cardY = annotation.y + getCardHeight(annotation) / 2;
    annotation.anchorIds.forEach((anchorId) => {
      const anchor = document.anchors.find((item) => item.id === anchorId);
      if (!anchor) return;
      const rect = getAnchorBoardRect(document, anchor);
      if (!rect) return;
      const anchorX = rect.x + rect.width / 2;
      const anchorY = rect.y + rect.height / 2;
      context.beginPath();
      context.moveTo(cardX, cardY);
      const middleX = (cardX + anchorX) / 2;
      context.bezierCurveTo(middleX, cardY, middleX, anchorY, anchorX, anchorY);
      context.strokeStyle = annotation.kind === 'relation' ? 'rgba(173, 91, 43, 0.72)' : 'rgba(156, 108, 53, 0.62)';
      context.lineWidth = annotation.kind === 'relation' ? 3 : 2;
      context.stroke();
    });
  });

  const drawAnchor = (anchor: CanvasAnchor) => {
    const rect = getAnchorBoardRect(document, anchor);
    if (!rect) return;
    context.save();
    context.strokeStyle = '#ae7434';
    context.fillStyle = 'rgba(245, 223, 190, 0.58)';
    context.lineWidth = 3;
    if (anchor.shape === 'rect') {
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
      context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    } else {
      context.beginPath();
      context.arc(rect.x, rect.y, 11, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    context.font = '700 12px "Microsoft YaHei", sans-serif';
    context.fillStyle = '#70471c';
    context.fillText(anchor.label, rect.x + 14, rect.y - 8);
    context.restore();
  };

  type PreviewNode =
    | { kind: 'image'; item: CanvasDocument['images'][number] }
    | { kind: 'text'; item: CanvasDocument['texts'][number] }
    | { kind: 'annotation'; item: CanvasDocument['annotations'][number] };

  const previewNodes: PreviewNode[] = [
    ...document.images.map((item) => ({ kind: 'image' as const, item })),
    ...document.texts.map((item) => ({ kind: 'text' as const, item })),
    ...document.annotations.map((item) => ({ kind: 'annotation' as const, item })),
  ];

  previewNodes.sort((a, b) => a.item.z - b.item.z).forEach((node) => {
    if (node.kind === 'image') {
      const { item } = node;
      context.save();
      roundRect(context, item.x, item.y, item.width, item.height, 14);
      context.clip();
      const image = loadedImages.get(item.id);
      if (image) context.drawImage(image, item.x, item.y, item.width, item.height);
      else {
        context.fillStyle = '#eee5d8';
        context.fillRect(item.x, item.y, item.width, item.height);
      }
      context.restore();
      context.strokeStyle = 'rgba(139, 94, 43, 0.34)';
      context.lineWidth = 2;
      roundRect(context, item.x, item.y, item.width, item.height, 14);
      context.stroke();
      document.anchors.filter((anchor) => anchor.imageId === item.id).forEach(drawAnchor);
      return;
    }

    if (node.kind === 'text') {
      const { item } = node;
      const height = getCardHeight(item, 56);
      context.fillStyle = 'rgba(255, 253, 248, 0.96)';
      roundRect(context, item.x, item.y, item.width, height, 12);
      context.fill();
      context.strokeStyle = 'rgba(102, 78, 51, 0.16)';
      context.lineWidth = 1;
      context.stroke();
      context.fillStyle = '#403329';
      context.font = `700 ${item.fontSize}px "Microsoft YaHei", sans-serif`;
      drawWrappedText(context, item.text, item.x + 15, item.y + 28, item.width - 30, item.fontSize * 1.55, item.y + height - 12);
      return;
    }

    const { item } = node;
    const height = getCardHeight(item);
    context.fillStyle = item.kind === 'relation' ? '#fff2e4' : '#fffaf0';
    roundRect(context, item.x, item.y, item.width, height, 15);
    context.fill();
    context.strokeStyle = item.kind === 'relation' ? '#b87543' : '#bd915d';
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = item.kind === 'relation' ? '#a35d30' : '#8a5a28';
    context.font = '800 13px "Microsoft YaHei", sans-serif';
    context.fillText(item.kind === 'relation' ? item.relationType : '批注', item.x + 16, item.y + 24);
    context.fillStyle = '#403329';
    context.font = '700 15px "Microsoft YaHei", sans-serif';
    drawWrappedText(context, item.text, item.x + 16, item.y + 52, item.width - 32, 24, item.y + height - 12);
  });

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('生成预览 PNG 失败。')), 'image/png');
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const CanvasWorkspace = forwardRef<CanvasWorkspaceHandle, CanvasWorkspaceProps>(function CanvasWorkspace({
  initialDocument,
  draftKey = 'kaoyan.canvas.draft.v1',
  className = '',
  directoryInitiallyOpen = true,
  onChange,
  onSave,
  onError,
  onDraftStatus,
}, ref) {
  const storageKey = draftKey === false ? null : draftKey;
  const initialIdRef = useRef(initialDocument?.id ?? null);
  const makeInitialDocument = () => {
    if (storageKey && typeof localStorage !== 'undefined') {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          const draft = parseCanvasDocument(saved);
          const draftIsNewer = !initialDocument
            || (draft.id === initialDocument.id && draft.updatedAt > initialDocument.updatedAt);
          if (draftIsNewer) return draft;
        }
      } catch {
        // A malformed or over-quota draft should never prevent opening the editor.
      }
    }
    if (initialDocument) return cloneCanvasDocument(initialDocument);
    return createEmptyCanvasDocument();
  };

  const [documentState, setDocumentState] = useState<CanvasDocument>(makeInitialDocument);
  const documentRef = useRef(documentState);
  const [past, setPast] = useState<CanvasDocument[]>([]);
  const [future, setFuture] = useState<CanvasDocument[]>([]);
  const [tool, setTool] = useState<CanvasTool>('select');
  const [selection, setSelection] = useState<CanvasSelectionNode[]>([]);
  const [editing, setEditing] = useState<EditingNode>(null);
  const editOriginRef = useRef<CanvasDocument | null>(null);
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [linkingAnnotationId, setLinkingAnnotationId] = useState<string | null>(null);
  const [relationType, setRelationType] = useState<CanvasRelationType>('解释');
  const [zoom, setZoomState] = useState(() => clamp(documentState.viewport.zoom || 0.72, MIN_ZOOM, MAX_ZOOM));
  const [directoryOpen, setDirectoryOpen] = useState(directoryInitiallyOpen);
  const [helpOpen, setHelpOpen] = useState(false);
  const [status, setStatus] = useState('拖入或粘贴图片，然后用“批注”精确指向。');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const selected: SelectedNode = selection[selection.length - 1] ?? null;
  const setSelected = useCallback((node: SelectedNode) => {
    setSelection(node ? [node] : []);
  }, []);

  const reportError = useCallback((error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    setStatus(normalized.message);
    onError?.(normalized);
  }, [onError]);

  const setCurrentDocument = useCallback((next: CanvasDocument, notify = true) => {
    documentRef.current = next;
    setDocumentState(next);
    if (notify) onChange?.(cloneCanvasDocument(next));
  }, [onChange]);

  const pushOriginToHistory = useCallback((origin: CanvasDocument) => {
    setPast((items) => [...items.slice(-(HISTORY_LIMIT - 1)), cloneCanvasDocument(origin)]);
    setFuture([]);
  }, []);

  const commit = useCallback((mutate: (draft: CanvasDocument) => void) => {
    const origin = cloneCanvasDocument(documentRef.current);
    const next = cloneCanvasDocument(documentRef.current);
    mutate(next);
    next.updatedAt = new Date().toISOString();
    pushOriginToHistory(origin);
    setCurrentDocument(next);
    return next;
  }, [pushOriginToHistory, setCurrentDocument]);

  const replaceTransient = useCallback((mutate: (draft: CanvasDocument) => void) => {
    const next = cloneCanvasDocument(documentRef.current);
    mutate(next);
    setCurrentDocument(next, false);
  }, [setCurrentDocument]);

  const finalizeTransient = useCallback((origin: CanvasDocument) => {
    const current = documentRef.current;
    if (lightweightDocumentSignature(origin) === lightweightDocumentSignature(current)) return;
    pushOriginToHistory(origin);
    const next = cloneCanvasDocument(current);
    next.updatedAt = new Date().toISOString();
    setCurrentDocument(next);
  }, [pushOriginToHistory, setCurrentDocument]);

  const setActiveGesture = useCallback((next: Gesture | null) => {
    gestureRef.current = next;
    setGestureState(next);
  }, []);

  const cancelActiveGesture = useCallback((message = '已取消当前拖动。') => {
    const active = gestureRef.current;
    if (!active) return false;
    setActiveGesture(null);
    if ('originDocument' in active) {
      setCurrentDocument(cloneCanvasDocument(active.originDocument), false);
    } else if (active.type === 'marquee') {
      setSelection(active.baseSelection);
    }
    setStatus(message);
    return true;
  }, [setActiveGesture, setCurrentDocument]);

  const setZoom = useCallback((nextZoom: number) => {
    const next = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    setZoomState(next);
    const updated = cloneCanvasDocument(documentRef.current);
    updated.viewport.zoom = next;
    setCurrentDocument(updated, false);
  }, [setCurrentDocument]);

  const getWorldPoint = useCallback((clientX: number, clientY: number): CanvasPoint => {
    const rect = worldRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clamp((clientX - rect.left) / zoom, 0, WORLD_WIDTH),
      y: clamp((clientY - rect.top) / zoom, 0, WORLD_HEIGHT),
    };
  }, [zoom]);

  const fitToContent = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const bounds = getContentBounds(documentRef.current);
    const usableWidth = Math.max(240, viewport.clientWidth - 96);
    const usableHeight = Math.max(220, viewport.clientHeight - 96);
    const nextZoom = clamp(Math.min(usableWidth / bounds.width, usableHeight / bounds.height, 1.15), MIN_ZOOM, MAX_ZOOM);
    setZoom(nextZoom);
    requestAnimationFrame(() => {
      viewport.scrollTo({
        left: Math.max(0, (bounds.left + bounds.width / 2) * nextZoom - viewport.clientWidth / 2),
        top: Math.max(0, (bounds.top + bounds.height / 2) * nextZoom - viewport.clientHeight / 2),
        behavior: 'smooth',
      });
    });
  }, [setZoom]);

  const focusNode = useCallback((node: SelectedNode) => {
    if (!node) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    let x = 0;
    let y = 0;
    if (node.kind === 'image') {
      const item = documentRef.current.images.find((entry) => entry.id === node.id);
      if (!item) return;
      x = item.x + item.width / 2;
      y = item.y + item.height / 2;
    } else if (node.kind === 'text') {
      const item = documentRef.current.texts.find((entry) => entry.id === node.id);
      if (!item) return;
      x = item.x + item.width / 2;
      y = item.y + getCardHeight(item, 56) / 2;
    } else {
      const item = documentRef.current.annotations.find((entry) => entry.id === node.id);
      if (!item) return;
      x = item.x + item.width / 2;
      y = item.y + getCardHeight(item) / 2;
    }
    viewport.scrollTo({
      left: Math.max(0, x * zoom - viewport.clientWidth / 2),
      top: Math.max(0, y * zoom - viewport.clientHeight / 2),
      behavior: 'smooth',
    });
    setSelected(node);
  }, [zoom]);

  const addImages = useCallback(async (filesInput: File[] | FileList, at?: CanvasPoint) => {
    const files = Array.from(filesInput).filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) {
      reportError(new Error('请选择图片文件。'));
      return;
    }
    try {
      const existingBytes = documentRef.current.images.reduce((sum, image) => sum + embeddedImageBytes(image.src), 0);
      if (existingBytes >= CLIENT_EMBEDDED_IMAGE_BUDGET_BYTES) {
        throw new Error(
          `当前画布图片已占用约 ${formatMiB(existingBytes)} MiB，接近服务端 ${formatMiB(SERVER_EMBEDDED_IMAGE_LIMIT_BYTES)} MiB 上限。请先保存并新建画布，或删除部分图片后再添加。`,
        );
      }
      const baseZ = nextZ(documentRef.current);
      const prepared: Array<{ node: CanvasImageNode; bytes: number; compressed: boolean }> = [];
      let newBytes = 0;
      for (const [index, file] of files.entries()) {
        const src = await readFileAsDataUrl(file);
        const browserImage = await loadBrowserImage(src);
        const optimized = await optimizeEmbeddedImage(src, browserImage);
        if (optimized.bytes > CLIENT_SINGLE_IMAGE_BUDGET_BYTES) {
          throw new Error(
            `“${file.name || '这张图片'}”处理后仍有约 ${formatMiB(optimized.bytes)} MiB，超过单张图片的安全范围（服务端上限约 16 MiB）。请先缩小或压缩图片。`,
          );
        }
        newBytes += optimized.bytes;
        const projectedBytes = existingBytes + newBytes;
        if (projectedBytes > CLIENT_EMBEDDED_IMAGE_BUDGET_BYTES) {
          throw new Error(
            `加入这批图片后预计占用约 ${formatMiB(projectedBytes)} MiB，已接近服务端 ${formatMiB(SERVER_EMBEDDED_IMAGE_LIMIT_BYTES)} MiB 总上限。为避免保存失败，本次图片没有加入；请减少图片数量或拆分到另一个画布。`,
          );
        }
        const maxWidth = 720;
        const ratio = Math.min(1, maxWidth / optimized.naturalWidth);
        const width = Math.max(160, Math.round(optimized.naturalWidth * ratio));
        const height = Math.max(100, Math.round(optimized.naturalHeight * ratio));
        const base = at ?? { x: 180, y: 160 };
        const node = {
          id: createCanvasId('image'),
          kind: 'image' as const,
          src: optimized.src,
          name: file.name || `图片 ${documentRef.current.images.length + index + 1}`,
          x: clamp(base.x + index * 44, 0, WORLD_WIDTH - width),
          y: clamp(base.y + index * 44, 0, WORLD_HEIGHT - height),
          width,
          height,
          naturalWidth: optimized.naturalWidth,
          naturalHeight: optimized.naturalHeight,
          z: baseZ + index,
        } satisfies CanvasImageNode;
        prepared.push({ node, bytes: optimized.bytes, compressed: optimized.compressed });
      }
      commit((draft) => { draft.images.push(...prepared.map((item) => item.node)); });
      setSelection(prepared.map((item) => ({ kind: 'image' as const, id: item.node.id })));
      setTool('select');
      const compressedCount = prepared.filter((item) => item.compressed).length;
      const totalBytes = existingBytes + prepared.reduce((sum, item) => sum + item.bytes, 0);
      setStatus(`已加入 ${prepared.length} 张图片${compressedCount ? `，其中 ${compressedCount} 张过大图片已压缩` : ''}。当前图片约占 ${formatMiB(totalBytes)} MiB。`);
    } catch (error) {
      reportError(error);
    }
  }, [commit, reportError]);

  const beginEditing = useCallback((next: EditingNode) => {
    editOriginRef.current = cloneCanvasDocument(documentRef.current);
    setEditing(next);
    requestAnimationFrame(() => {
      const selector = `[data-edit-id="${next?.id ?? ''}"]`;
      const field = rootRef.current?.querySelector<HTMLTextAreaElement>(selector);
      field?.focus();
      field?.select();
    });
  }, []);

  const finishEditing = useCallback((cancel = false) => {
    if (!editing) return;
    const origin = editOriginRef.current;
    editOriginRef.current = null;
    setEditing(null);
    if (!origin) return;
    if (cancel) {
      setCurrentDocument(origin);
      return;
    }
    finalizeTransient(origin);
  }, [editing, finalizeTransient, setCurrentDocument]);

  const createTextAt = useCallback((point: CanvasPoint) => {
    const id = createCanvasId('text');
    commit((draft) => {
      draft.texts.push({
        id,
        kind: 'text',
        text: '',
        x: clamp(point.x, 0, WORLD_WIDTH - 280),
        y: clamp(point.y, 0, WORLD_HEIGHT - 80),
        width: 280,
        height: 96,
        fontSize: 17,
        color: '#403329',
        z: nextZ(draft),
      } as CanvasDocument['texts'][number] & { height: number });
    });
    setSelected({ kind: 'text', id });
    beginEditing({ kind: 'text', id });
    setStatus('自由文字已放置。拖动卡片可以继续调整位置。');
  }, [beginEditing, commit]);

  const createRelationAt = useCallback((point: CanvasPoint) => {
    const id = createCanvasId('annotation');
    commit((draft) => {
      draft.annotations.push({
        id,
        kind: 'relation',
        text: '',
        x: clamp(point.x, 0, WORLD_WIDTH - 310),
        y: clamp(point.y, 0, WORLD_HEIGHT - 100),
        width: 310,
        height: 120,
        anchorIds: [],
        relationType,
        color: '#eca76d',
        z: nextZ(draft),
      } as CanvasDocument['annotations'][number] & { height: number });
    });
    setSelected({ kind: 'annotation', id });
    setLinkingAnnotationId(id);
    beginEditing({ kind: 'annotation', id });
    setStatus('关系卡已放置。填写文字后，在图片上点击或框选多个位置。');
  }, [beginEditing, commit, relationType]);

  const deleteSelected = useCallback(() => {
    if (selection.length === 0) return;
    const deleting = [...selection];
    const imageIds = new Set(deleting.filter((node) => node.kind === 'image').map((node) => node.id));
    const textIds = new Set(deleting.filter((node) => node.kind === 'text').map((node) => node.id));
    const annotationIds = new Set(deleting.filter((node) => node.kind === 'annotation').map((node) => node.id));
    commit((draft) => {
      const deletedAnnotationAnchorIds = new Set(
        draft.annotations
          .filter((item) => annotationIds.has(item.id))
          .flatMap((item) => item.anchorIds),
      );
      const deletedImageAnchorIds = new Set(
        draft.anchors.filter((anchor) => imageIds.has(anchor.imageId)).map((anchor) => anchor.id),
      );
      draft.images = draft.images.filter((item) => !imageIds.has(item.id));
      draft.texts = draft.texts.filter((item) => !textIds.has(item.id));
      draft.annotations = draft.annotations.filter((item) => !annotationIds.has(item.id));

      const anchorsStillReferenced = new Set(draft.annotations.flatMap((item) => item.anchorIds));
      const removedAnchorIds = new Set([
        ...deletedImageAnchorIds,
        ...[...deletedAnnotationAnchorIds].filter((id) => !anchorsStillReferenced.has(id)),
      ]);
      draft.anchors = draft.anchors.filter((anchor) => !removedAnchorIds.has(anchor.id));
      draft.annotations.forEach((item) => {
        item.anchorIds = item.anchorIds.filter((id) => !removedAnchorIds.has(id));
      });
    });
    if (linkingAnnotationId && annotationIds.has(linkingAnnotationId)) setLinkingAnnotationId(null);
    setSelected(null);
    setEditing(null);
    setStatus(`已删除 ${deleting.length} 项所选内容。`);
  }, [commit, linkingAnnotationId, selection, setSelected]);

  const undo = useCallback(() => {
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    setPast(past.slice(0, -1));
    setFuture([cloneCanvasDocument(documentRef.current), ...future].slice(0, HISTORY_LIMIT));
    setCurrentDocument(cloneCanvasDocument(previous));
    setSelected(null);
    setEditing(null);
  }, [future, past, setCurrentDocument, setSelected]);

  const redo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture(future.slice(1));
    setPast([...past.slice(-(HISTORY_LIMIT - 1)), cloneCanvasDocument(documentRef.current)]);
    setCurrentDocument(cloneCanvasDocument(next));
    setSelected(null);
    setEditing(null);
  }, [future, past, setCurrentDocument, setSelected]);

  const importDocument = useCallback((input: string | CanvasDocument) => {
    try {
      const parsed = parseCanvasDocument(input);
      pushOriginToHistory(cloneCanvasDocument(documentRef.current));
      setCurrentDocument(parsed);
      setZoomState(clamp(parsed.viewport.zoom || 0.72, MIN_ZOOM, MAX_ZOOM));
      setSelected(null);
      setEditing(null);
      setLinkingAnnotationId(null);
      setStatus('画布已导入，可以继续编辑。');
      requestAnimationFrame(fitToContent);
    } catch (error) {
      reportError(error);
    }
  }, [fitToContent, pushOriginToHistory, reportError, setCurrentDocument]);

  const exportPreview = useCallback((options?: CanvasPreviewOptions) => renderCanvasPreview(documentRef.current, options), []);

  const save = useCallback(async () => {
    if (savingRef.current) return;
    cancelActiveGesture('保存前已撤销未完成的拖动。');
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave?.(cloneCanvasDocument(documentRef.current));
      setStatus(onSave ? '可编辑画布工程已保存。' : '草稿已保存在本机；接入 onSave 后可保存工程。');
    } catch (error) {
      reportError(error);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [cancelActiveGesture, onSave, reportError]);

  useImperativeHandle(ref, () => ({
    getDocument: () => cloneCanvasDocument(documentRef.current),
    importDocument,
    exportDocument: () => serializeCanvasDocument(documentRef.current),
    addImages,
    exportPreview,
    fitToContent,
  }), [addImages, exportPreview, fitToContent, importDocument]);

  // A parent can switch to another saved canvas without remounting this component.
  useEffect(() => {
    if (!initialDocument || initialDocument.id === initialIdRef.current) return;
    initialIdRef.current = initialDocument.id;
    const next = cloneCanvasDocument(initialDocument);
    setCurrentDocument(next);
    setZoomState(clamp(next.viewport.zoom || 0.72, MIN_ZOOM, MAX_ZOOM));
    setPast([]);
    setFuture([]);
    setSelected(null);
  }, [initialDocument, setCurrentDocument]);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const flushDraft = useCallback((notify = true) => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, serializeCanvasDocument(documentRef.current));
      if (notify) onDraftStatus?.('saved');
    } catch (error) {
      if (notify) {
        onDraftStatus?.('failed');
        onError?.(error instanceof Error ? error : new Error('本地草稿保存失败。'));
      }
    }
  }, [onDraftStatus, onError, storageKey]);

  useEffect(() => {
    if (!storageKey) return;
    onDraftStatus?.('saving');
    const timer = window.setTimeout(() => flushDraft(), 550);
    return () => window.clearTimeout(timer);
  }, [documentState, flushDraft, onDraftStatus, storageKey]);

  useEffect(() => {
    if (!storageKey) return;
    const handleBeforeUnload = () => flushDraft(false);
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      // React unmount is the last chance to persist edits that have not reached
      // the debounce timer yet. localStorage is synchronous by design here.
      flushDraft(false);
    };
  }, [flushDraft, storageKey]);

  useEffect(() => {
    const active = gestureRef.current;
    if (!active) return;
    const handleMove = (event: PointerEvent) => {
      const current = gestureRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const point = getWorldPoint(event.clientX, event.clientY);
      if (current.type === 'move') {
        const requestedDx = point.x - current.start.x;
        const requestedDy = point.y - current.start.y;
        const dx = clamp(
          requestedDx,
          Math.max(...current.nodes.map((node) => -node.originX)),
          Math.min(...current.nodes.map((node) => WORLD_WIDTH - node.originX - node.width)),
        );
        const dy = clamp(
          requestedDy,
          Math.max(...current.nodes.map((node) => -node.originY)),
          Math.min(...current.nodes.map((node) => WORLD_HEIGHT - node.originY - node.height)),
        );
        replaceTransient((draft) => {
          current.nodes.forEach((node) => {
            const item = node.kind === 'image'
              ? draft.images.find((entry) => entry.id === node.id)
              : node.kind === 'text'
                ? draft.texts.find((entry) => entry.id === node.id)
                : draft.annotations.find((entry) => entry.id === node.id);
            if (!item) return;
            item.x = node.originX + dx;
            item.y = node.originY + dy;
          });
        });
      } else if (current.type === 'resize-image') {
        const dx = point.x - current.start.x;
        const dy = point.y - current.start.y;
        const aspect = current.originWidth / current.originHeight;
        const deltaWidth = Math.abs(dx) >= Math.abs(dy * aspect) ? dx : dy * aspect;
        const maxWidth = Math.max(120, Math.min(
          1800,
          WORLD_WIDTH - current.originX,
          (WORLD_HEIGHT - current.originY) * aspect,
        ));
        const nextWidth = clamp(current.originWidth + deltaWidth, 120, maxWidth);
        replaceTransient((draft) => {
          const image = draft.images.find((item) => item.id === current.id);
          if (!image) return;
          image.width = nextWidth;
          image.height = nextWidth / aspect;
        });
      } else if (current.type === 'resize-card') {
        const dx = point.x - current.start.x;
        const dy = point.y - current.start.y;
        const minimumHeight = current.nodeKind === 'text' ? 58 : 90;
        const maxWidth = Math.max(170, Math.min(1200, WORLD_WIDTH - current.originX));
        const maxHeight = Math.max(minimumHeight, Math.min(1400, WORLD_HEIGHT - current.originY));
        const nextWidth = clamp(current.originWidth + dx, 170, maxWidth);
        const nextHeight = clamp(current.originHeight + dy, minimumHeight, maxHeight);
        replaceTransient((draft) => {
          const item = current.nodeKind === 'text'
            ? draft.texts.find((entry) => entry.id === current.id)
            : draft.annotations.find((entry) => entry.id === current.id);
          if (!item) return;
          item.width = nextWidth;
          (item as typeof item & { height?: number }).height = nextHeight;
        });
      } else if (current.type === 'marquee') {
        setActiveGesture({ ...current, current: point });
      } else {
        const image = documentRef.current.images.find((item) => item.id === current.imageId);
        if (!image) return;
        const next = {
          ...current,
          current: {
            x: clamp((point.x - image.x) / image.width, 0, 1),
            y: clamp((point.y - image.y) / image.height, 0, 1),
          },
        } satisfies Gesture;
        setActiveGesture(next);
      }
    };
    const handleUp = (event: PointerEvent) => {
      const current = gestureRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      setActiveGesture(null);
      if (current.type === 'move' || current.type === 'resize-image' || current.type === 'resize-card') {
        finalizeTransient(current.originDocument);
        return;
      }
      if (current.type === 'marquee') {
        const screenDistance = Math.max(
          Math.abs(current.current.x - current.start.x),
          Math.abs(current.current.y - current.start.y),
        ) * zoom;
        if (screenDistance < MARQUEE_MIN_SCREEN_PX) {
          setSelection(current.baseSelection);
          setStatus(current.baseSelection.length > 0 ? `已保留 ${current.baseSelection.length} 项选择。` : '已取消选择。');
          return;
        }
        const rect = {
          left: Math.min(current.start.x, current.current.x),
          top: Math.min(current.start.y, current.current.y),
          right: Math.max(current.start.x, current.current.x),
          bottom: Math.max(current.start.y, current.current.y),
        };
        const hits = getNodesIntersectingRect(documentRef.current, rect);
        const combined = new Map(current.baseSelection.map((node) => [selectionNodeKey(node), node]));
        hits.forEach((node) => combined.set(selectionNodeKey(node), node));
        const nextSelection = [...combined.values()];
        setSelection(nextSelection);
        setStatus(nextSelection.length > 0
          ? `已框选 ${nextSelection.length} 项；拖动其中任一项可整组移动，按 Delete 批量删除。`
          : '选择框内没有内容。');
        return;
      }
      const image = documentRef.current.images.find((item) => item.id === current.imageId);
      if (!image) return;
      const dx = current.current.x - current.start.x;
      const dy = current.current.y - current.start.y;
      const isRect = Math.abs(dx * image.width) > 9 || Math.abs(dy * image.height) > 9;
      const x = isRect ? Math.min(current.start.x, current.current.x) : current.start.x;
      const y = isRect ? Math.min(current.start.y, current.current.y) : current.start.y;
      const width = isRect ? Math.max(0.008, Math.abs(dx)) : 0;
      const height = isRect ? Math.max(0.008, Math.abs(dy)) : 0;
      const imageIndex = documentRef.current.images.findIndex((item) => item.id === image.id);
      const imageAnchorCount = documentRef.current.anchors.filter((item) => item.imageId === image.id).length;
      const anchorId = createCanvasId('anchor');
      const targetId = current.targetAnnotationId;
      let createdAnnotationId: string | null = null;
      commit((draft) => {
        draft.anchors.push({
          id: anchorId,
          imageId: image.id,
          shape: isRect ? 'rect' : 'point',
          x,
          y,
          width,
          height,
          label: `${imageLetter(imageIndex)}·${imageAnchorCount + 1}`,
        });
        const target = targetId ? draft.annotations.find((item) => item.id === targetId) : null;
        if (target) {
          target.anchorIds.push(anchorId);
          return;
        }
        createdAnnotationId = createCanvasId('annotation');
        draft.annotations.push({
          id: createdAnnotationId,
          kind: current.annotationKind,
          text: '',
          x: clamp(image.x + image.width + 28, 0, WORLD_WIDTH - 310),
          y: clamp(image.y + y * image.height - 34, 0, WORLD_HEIGHT - 100),
          width: 310,
          height: 120,
          anchorIds: [anchorId],
          relationType,
          color: current.annotationKind === 'relation' ? '#eca76d' : '#f2ca97',
          z: nextZ(draft),
        } as CanvasDocument['annotations'][number] & { height: number });
      });
      if (targetId) {
        setSelected({ kind: 'annotation', id: targetId });
        setStatus('已追加一个指向位置。继续点击，或按 Esc 结束关联。');
      } else if (createdAnnotationId) {
        const node = { kind: 'annotation' as const, id: createdAnnotationId };
        setSelected(node);
        if (current.annotationKind === 'relation') setLinkingAnnotationId(createdAnnotationId);
        beginEditing(node);
        setStatus(current.annotationKind === 'relation'
          ? '先填写关系说明，再继续指向其他图片位置。'
          : '批注已精确绑定到图片位置。');
      }
    };
    const handleCancel = (event: PointerEvent) => {
      const current = gestureRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      cancelActiveGesture('拖动已中止，内容已恢复到操作前。');
    };
    const handleWindowBlur = () => {
      cancelActiveGesture('窗口失去焦点，未完成的拖动已撤销。');
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [beginEditing, cancelActiveGesture, commit, finalizeTransient, gesture, getWorldPoint, relationType, replaceTransient, setActiveGesture, zoom]);

  const beginNodeMove = (event: ReactPointerEvent, nodeKind: CanvasNodeKind, id: string, _x: number, _y: number) => {
    if (event.button !== 0 || tool !== 'select' || editing?.id === id) return;
    event.preventDefault();
    event.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    const node: CanvasSelectionNode = { kind: nodeKind, id };
    const alreadySelected = selection.some((item) => selectionNodeKey(item) === selectionNodeKey(node));
    if (event.shiftKey) {
      const nextSelection = alreadySelected
        ? selection.filter((item) => selectionNodeKey(item) !== selectionNodeKey(node))
        : [...selection, node];
      setSelection(nextSelection);
      setStatus(nextSelection.length > 0 ? `已选择 ${nextSelection.length} 项。` : '已取消选择。');
      return;
    }
    const movingSelection = alreadySelected && selection.length > 1 ? selection : [node];
    const nodes = movingSelection
      .map((item) => getNodeMoveOrigin(documentRef.current, item))
      .filter((item): item is NodeMoveOrigin => !!item);
    if (nodes.length === 0) return;
    if (!alreadySelected) setSelection([node]);
    setActiveGesture({
      type: 'move',
      nodes,
      pointerId: event.pointerId,
      start: getWorldPoint(event.clientX, event.clientY),
      originDocument: cloneCanvasDocument(documentRef.current),
    });
  };

  const beginCardResize = (
    event: ReactPointerEvent,
    nodeKind: 'text' | 'annotation',
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    setSelected({ kind: nodeKind, id });
    setActiveGesture({
      type: 'resize-card',
      nodeKind,
      id,
      pointerId: event.pointerId,
      start: getWorldPoint(event.clientX, event.clientY),
      originX: x,
      originY: y,
      originWidth: width,
      originHeight: height,
      originDocument: cloneCanvasDocument(documentRef.current),
    });
  };

  const beginImageInteraction = (event: ReactPointerEvent, image: CanvasImageNode) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    if (tool === 'annotation' || tool === 'relation' || linkingAnnotationId) {
      event.preventDefault();
      const point = getWorldPoint(event.clientX, event.clientY);
      const normalized = {
        x: clamp((point.x - image.x) / image.width, 0, 1),
        y: clamp((point.y - image.y) / image.height, 0, 1),
      };
      const target = linkingAnnotationId && documentRef.current.annotations.some((item) => item.id === linkingAnnotationId)
        ? linkingAnnotationId
        : null;
      const existing = target ? documentRef.current.annotations.find((item) => item.id === target) : null;
      setActiveGesture({
        type: 'anchor',
        imageId: image.id,
        pointerId: event.pointerId,
        start: normalized,
        current: normalized,
        targetAnnotationId: target,
        annotationKind: existing?.kind ?? (tool === 'relation' ? 'relation' : 'annotation'),
      });
      return;
    }
    beginNodeMove(event, 'image', image.id, image.x, image.y);
  };

  const handleWorldPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    rootRef.current?.focus({ preventScroll: true });
    const point = getWorldPoint(event.clientX, event.clientY);
    if (tool === 'text') createTextAt(point);
    else if (tool === 'relation') createRelationAt(point);
    else if (tool === 'annotation') setStatus('请在图片上点击一个点，或拖出一个区域。');
    else {
      event.preventDefault();
      setActiveGesture({
        type: 'marquee',
        pointerId: event.pointerId,
        start: point,
        current: point,
        baseSelection: event.shiftKey ? selection : [],
      });
      setStatus('拖出选择框，可一次选中图片和各种卡片。');
    }
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const point = getWorldPoint(event.clientX, event.clientY);
    await addImages(event.dataTransfer.files, point);
  };

  const handlePaste = async (event: React.ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (files.length === 0) return;
    event.preventDefault();
    await addImages(files);
  };

  const chooseTool = (next: CanvasTool) => {
    if (editing) finishEditing();
    if (next !== 'annotation' && next !== 'relation') setLinkingAnnotationId(null);
    setTool(next);
    const messages: Record<CanvasTool, string> = {
      select: '选择模式：空白处拖框可多选；拖动所选内容可整组移动，右下角可调大小。',
      text: '自由文字：点击画布任意位置放置文字卡。',
      annotation: '批注模式：在图片上点击定位，或拖框圈出区域。',
      relation: '关系模式：先放关系卡或指向图片，再连续关联多个位置。',
    };
    setStatus(messages[next]);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const typing = target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable;
    if (typing) {
      if (event.key === 'Escape') {
        event.preventDefault();
        finishEditing(true);
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        finishEditing();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (event.repeat) return;
        finishEditing();
        void save();
      }
      return;
    }
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      if (cancelActiveGesture('未完成的拖动已撤销。')) return;
      if (event.shiftKey) redo(); else undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 's') {
      event.preventDefault();
      if (event.repeat) return;
      void save();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteSelected();
      return;
    }
    if (event.key === 'Escape') {
      if (cancelActiveGesture('已取消当前拖动，内容已恢复。')) return;
      setLinkingAnnotationId(null);
      setSelected(null);
      setStatus('已取消当前操作。');
      return;
    }
    if (key === 'v') chooseTool('select');
    else if (key === 't') chooseTool('text');
    else if (key === 'a') chooseTool('annotation');
    else if (key === 'r') chooseTool('relation');
    else if (key === 'i') imageInputRef.current?.click();
    else if (key === '0') fitToContent();
    else if (event.key === '?') setHelpOpen(true);
  };

  const handleJsonImport = async (file?: File) => {
    if (!file) return;
    try {
      importDocument(await file.text());
    } catch (error) {
      reportError(error);
    }
  };

  const exportJson = () => {
    const blob = new Blob([serializeCanvasDocument(documentRef.current)], { type: 'application/json' });
    downloadBlob(blob, `${documentRef.current.title || '画布'}.canvas.json`);
    setStatus('已导出可继续编辑的画布文件。');
  };

  const downloadPreview = async () => {
    try {
      const blob = await exportPreview();
      downloadBlob(blob, `${documentRef.current.title || '画布'}-预览.png`);
      setStatus('已生成内容裁边的预览 PNG。');
    } catch (error) {
      reportError(error);
    }
  };

  const imageLabels = useMemo(() => new Map(documentState.images.map((image, index) => [image.id, imageLetter(index)])), [documentState.images]);
  const selectionKeys = useMemo(() => new Set(selection.map(selectionNodeKey)), [selection]);
  const selectedAnnotation = selected?.kind === 'annotation'
    ? documentState.annotations.find((item) => item.id === selected.id)
    : null;

  const connectionPaths = useMemo(() => documentState.annotations.flatMap((annotation) => {
    const cardHeight = getCardHeight(annotation);
    const startX = annotation.x + annotation.width / 2;
    const startY = annotation.y + cardHeight / 2;
    return annotation.anchorIds.flatMap((anchorId) => {
      const anchor = documentState.anchors.find((item) => item.id === anchorId);
      if (!anchor) return [];
      const rect = getAnchorBoardRect(documentState, anchor);
      if (!rect) return [];
      const endX = rect.x + rect.width / 2;
      const endY = rect.y + rect.height / 2;
      const middleX = (startX + endX) / 2;
      return [{
        id: `${annotation.id}:${anchor.id}`,
        annotationId: annotation.id,
        d: `M ${startX} ${startY} C ${middleX} ${startY}, ${middleX} ${endY}, ${endX} ${endY}`,
        relation: annotation.kind === 'relation',
      }];
    });
  }), [documentState]);

  const anchorDraftStyle = (image: CanvasImageNode): CSSProperties | null => {
    if (gesture?.type !== 'anchor' || gesture.imageId !== image.id) return null;
    const left = Math.min(gesture.start.x, gesture.current.x) * image.width;
    const top = Math.min(gesture.start.y, gesture.current.y) * image.height;
    const width = Math.abs(gesture.current.x - gesture.start.x) * image.width;
    const height = Math.abs(gesture.current.y - gesture.start.y) * image.height;
    return { left, top, width: Math.max(10, width), height: Math.max(10, height) };
  };

  const marqueeStyle: CSSProperties | null = gesture?.type === 'marquee'
    ? {
        left: Math.min(gesture.start.x, gesture.current.x),
        top: Math.min(gesture.start.y, gesture.current.y),
        width: Math.abs(gesture.current.x - gesture.start.x),
        height: Math.abs(gesture.current.y - gesture.start.y),
      }
    : null;

  return (
    <div
      ref={rootRef}
      className={`canvas-workspace ${linkingAnnotationId ? 'has-linking-banner' : ''} ${className}`.trim()}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      aria-label="图片关联笔记画布"
    >
      <input
        ref={imageInputRef}
        className="cw-hidden-input"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => {
          if (event.target.files) void addImages(event.target.files);
          event.target.value = '';
        }}
      />
      <input
        ref={jsonInputRef}
        className="cw-hidden-input"
        type="file"
        accept="application/json,.json"
        onChange={(event) => {
          void handleJsonImport(event.target.files?.[0]);
          event.target.value = '';
        }}
      />

      <div className="cw-toolbar" role="toolbar" aria-label="画布工具">
        <label className="cw-title-field">
          <input
            aria-label="画布名称"
            value={documentState.title}
            maxLength={80}
            onChange={(event) => commit((draft) => { draft.title = event.target.value; })}
            placeholder="给画布起个名字"
          />
        </label>
        <div className="cw-tool-group">
          <button className={tool === 'select' ? 'active' : ''} onClick={() => chooseTool('select')} title="选择（V）"><MousePointer2 size={17} /><span>选择</span></button>
          <button className={tool === 'text' ? 'active' : ''} onClick={() => chooseTool('text')} title="自由文字（T）"><Type size={17} /><span>文字</span></button>
          <button className={tool === 'annotation' ? 'active' : ''} onClick={() => chooseTool('annotation')} title="精确批注（A）"><MessageSquareText size={17} /><span>批注</span></button>
          <button className={tool === 'relation' ? 'active' : ''} onClick={() => chooseTool('relation')} title="多图关系（R）"><Link2 size={17} /><span>关系</span></button>
          {(tool === 'relation' || selectedAnnotation?.kind === 'relation') && (
            <select
              value={selectedAnnotation?.relationType ?? relationType}
              aria-label="关系类型"
              onChange={(event) => {
                const next = event.target.value as CanvasRelationType;
                setRelationType(next);
                if (selectedAnnotation) commit((draft) => {
                  const item = draft.annotations.find((entry) => entry.id === selectedAnnotation.id);
                  if (item) item.relationType = next;
                });
              }}
            >
              {CANVAS_RELATION_TYPES.map((item) => <option key={item}>{item}</option>)}
            </select>
          )}
        </div>

        <div className="cw-tool-group cw-tool-group-secondary">
          <button onClick={() => imageInputRef.current?.click()} title="添加图片（I）"><ImagePlus size={17} /><span>图片</span></button>
          <button onClick={undo} disabled={past.length === 0} title="撤销（Ctrl+Z）"><Undo2 size={17} /></button>
          <button onClick={redo} disabled={future.length === 0} title="重做（Ctrl+Shift+Z）"><Redo2 size={17} /></button>
          <button onClick={() => setZoom(zoom - 0.1)} title="缩小"><ZoomOut size={17} /></button>
          <span className="cw-zoom-value">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(zoom + 0.1)} title="放大"><ZoomIn size={17} /></button>
          <button onClick={fitToContent} title="适应内容（0）"><Maximize2 size={17} /></button>
        </div>

        <div className="cw-tool-group cw-tool-group-files">
          <button onClick={() => jsonInputRef.current?.click()} title="导入可编辑画布"><FileUp size={17} /></button>
          <button onClick={exportJson} title="导出可编辑画布"><FileDown size={17} /></button>
          <button onClick={() => void downloadPreview()} title="导出裁边预览 PNG"><ImageDown size={17} /></button>
          <button className="cw-save-button" onClick={() => void save()} disabled={saving} title="保存可编辑工程（Ctrl+S）"><Save size={17} /><span>{saving ? '保存中' : '存工程'}</span></button>
          <button onClick={() => setHelpOpen(true)} title="快捷键帮助（?）"><HelpCircle size={17} /></button>
        </div>
      </div>

      {linkingAnnotationId && (
        <div className="cw-linking-banner">
          <Link2 size={15} />
          <span>正在为这条{documentState.annotations.find((item) => item.id === linkingAnnotationId)?.kind === 'relation' ? '关系' : '批注'}追加指向：继续点击或框选图片</span>
          <button onClick={() => { setLinkingAnnotationId(null); setStatus('已结束追加指向。'); }}><Check size={15} />完成</button>
        </div>
      )}

      <div className="cw-main">
        <div
          ref={viewportRef}
          className={`cw-viewport cw-cursor-${tool}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          onScroll={(event) => {
            documentRef.current.viewport.scrollLeft = event.currentTarget.scrollLeft;
            documentRef.current.viewport.scrollTop = event.currentTarget.scrollTop;
          }}
        >
          <div className="cw-world-spacer" style={{ width: WORLD_WIDTH * zoom, height: WORLD_HEIGHT * zoom }}>
            <div
              ref={worldRef}
              className="cw-world"
              style={{ width: WORLD_WIDTH, height: WORLD_HEIGHT, transform: `scale(${zoom})` }}
              onPointerDown={handleWorldPointerDown}
            >
              <svg className="cw-connections" width={WORLD_WIDTH} height={WORLD_HEIGHT} aria-hidden="true">
                {connectionPaths.map((path) => (
                  <path
                    key={path.id}
                    d={path.d}
                    className={`${path.relation ? 'relation' : ''} ${selectionKeys.has(`annotation:${path.annotationId}`) ? 'active' : ''}`.trim()}
                  />
                ))}
              </svg>

              {marqueeStyle && <div className="cw-selection-marquee" style={marqueeStyle} aria-hidden="true" />}

              {documentState.images.map((image, index) => {
                const isSelected = selectionKeys.has(`image:${image.id}`);
                const isPrimary = selected?.kind === 'image' && selected.id === image.id;
                const draftStyle = anchorDraftStyle(image);
                return (
                  <div
                    key={image.id}
                    className={`cw-image-node ${isSelected ? 'selected' : ''}`}
                    style={{ left: image.x, top: image.y, width: image.width, height: image.height, zIndex: image.z }}
                    onPointerDown={(event) => beginImageInteraction(event, image)}
                  >
                    <img src={image.src} alt={image.name} draggable={false} />
                    <span className="cw-image-label">图 {imageLetter(index)}</span>
                    {documentState.anchors.filter((anchor) => anchor.imageId === image.id).map((anchor) => (
                      <span
                        key={anchor.id}
                        className={`cw-anchor cw-anchor-${anchor.shape}`}
                        style={anchor.shape === 'rect'
                          ? { left: anchor.x * image.width, top: anchor.y * image.height, width: anchor.width * image.width, height: anchor.height * image.height }
                          : { left: anchor.x * image.width, top: anchor.y * image.height }}
                        title={anchor.label}
                      >
                        <b>{anchor.label}</b>
                      </span>
                    ))}
                    {draftStyle && <span className="cw-anchor-draft" style={draftStyle} />}
                    {isPrimary && tool === 'select' && (
                      <button
                        className="cw-resize-handle"
                        aria-label="等比缩放图片"
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          event.preventDefault();
                          event.stopPropagation();
                          setSelected({ kind: 'image', id: image.id });
                          setActiveGesture({
                            type: 'resize-image',
                            id: image.id,
                            pointerId: event.pointerId,
                            start: getWorldPoint(event.clientX, event.clientY),
                            originX: image.x,
                            originY: image.y,
                            originWidth: image.width,
                            originHeight: image.height,
                            originDocument: cloneCanvasDocument(documentRef.current),
                          });
                        }}
                      />
                    )}
                  </div>
                );
              })}

              {documentState.texts.map((textNode) => {
                const isSelected = selectionKeys.has(`text:${textNode.id}`);
                const isPrimary = selected?.kind === 'text' && selected.id === textNode.id;
                const isEditing = editing?.kind === 'text' && editing.id === textNode.id;
                const textHeight = getCardHeight(textNode, 56);
                return (
                  <div
                    key={textNode.id}
                    className={`cw-text-node ${isSelected ? 'selected' : ''}`}
                    style={{ left: textNode.x, top: textNode.y, width: textNode.width, height: textHeight, color: textNode.color, fontSize: textNode.fontSize, zIndex: textNode.z }}
                    onPointerDown={(event) => beginNodeMove(event, 'text', textNode.id, textNode.x, textNode.y)}
                    onDoubleClick={(event) => { event.stopPropagation(); setSelected({ kind: 'text', id: textNode.id }); beginEditing({ kind: 'text', id: textNode.id }); }}
                  >
                    {isEditing ? (
                      <textarea
                        data-edit-id={textNode.id}
                        value={textNode.text}
                        placeholder="输入文字；Ctrl+Enter 完成"
                        onPointerDown={(event) => event.stopPropagation()}
                        onChange={(event) => replaceTransient((draft) => {
                          const item = draft.texts.find((entry) => entry.id === textNode.id);
                          if (item) item.text = event.target.value;
                        })}
                        onBlur={() => finishEditing()}
                      />
                    ) : <p>{textNode.text || '双击输入文字'}</p>}
                    {isPrimary && !isEditing && (
                      <div className="cw-node-actions">
                        <button onPointerDown={(event) => event.stopPropagation()} onClick={() => beginEditing({ kind: 'text', id: textNode.id })} title="编辑"><Pencil size={14} /></button>
                        <button onPointerDown={(event) => event.stopPropagation()} onClick={deleteSelected} title="删除"><Trash2 size={14} /></button>
                      </div>
                    )}
                    {isPrimary && tool === 'select' && (
                      <button
                        className="cw-resize-handle cw-card-resize-handle"
                        aria-label="自由缩放文字卡"
                        onPointerDown={(event) => beginCardResize(event, 'text', textNode.id, textNode.x, textNode.y, textNode.width, textHeight)}
                      />
                    )}
                  </div>
                );
              })}

              {documentState.annotations.map((annotation) => {
                const isSelected = selectionKeys.has(`annotation:${annotation.id}`);
                const isPrimary = selected?.kind === 'annotation' && selected.id === annotation.id;
                const isEditing = editing?.kind === 'annotation' && editing.id === annotation.id;
                const linked = linkingAnnotationId === annotation.id;
                const annotationHeight = getCardHeight(annotation);
                return (
                  <div
                    key={annotation.id}
                    className={`cw-annotation-node ${annotation.kind === 'relation' ? 'relation' : ''} ${isSelected ? 'selected' : ''} ${linked ? 'linking' : ''}`.trim()}
                    style={{ left: annotation.x, top: annotation.y, width: annotation.width, height: annotationHeight, zIndex: annotation.z, '--annotation-color': annotation.color } as CSSProperties}
                    onPointerDown={(event) => beginNodeMove(event, 'annotation', annotation.id, annotation.x, annotation.y)}
                    onDoubleClick={(event) => { event.stopPropagation(); setSelected({ kind: 'annotation', id: annotation.id }); beginEditing({ kind: 'annotation', id: annotation.id }); }}
                  >
                    <header>
                      <span>{annotation.kind === 'relation' ? annotation.relationType : '批注'}</span>
                      <small>{annotation.anchorIds.length} 个指向</small>
                    </header>
                    {isEditing ? (
                      <textarea
                        data-edit-id={annotation.id}
                        value={annotation.text}
                        placeholder={annotation.kind === 'relation' ? '描述这些位置之间的关系…' : '写下对这个位置的说明…'}
                        onPointerDown={(event) => event.stopPropagation()}
                        onChange={(event) => replaceTransient((draft) => {
                          const item = draft.annotations.find((entry) => entry.id === annotation.id);
                          if (item) item.text = event.target.value;
                        })}
                        onBlur={() => finishEditing()}
                      />
                    ) : <p>{annotation.text || '双击填写说明'}</p>}
                    {isPrimary && !isEditing && (
                      <div className="cw-node-actions">
                        <button onPointerDown={(event) => event.stopPropagation()} onClick={() => beginEditing({ kind: 'annotation', id: annotation.id })} title="编辑"><Pencil size={14} /></button>
                        <button
                          className={linked ? 'active' : ''}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => {
                            setLinkingAnnotationId(linked ? null : annotation.id);
                            if (!linked) setStatus('点击或框选图片，为这条内容追加指向。');
                          }}
                          title={linked ? '结束追加指向' : '再指向一个位置'}
                        >{linked ? <Check size={14} /> : <Link2 size={14} />}</button>
                        <button onPointerDown={(event) => event.stopPropagation()} onClick={deleteSelected} title="删除"><Trash2 size={14} /></button>
                      </div>
                    )}
                    {isPrimary && tool === 'select' && (
                      <button
                        className="cw-resize-handle cw-card-resize-handle"
                        aria-label={annotation.kind === 'relation' ? '自由缩放关系卡' : '自由缩放批注卡'}
                        onPointerDown={(event) => beginCardResize(event, 'annotation', annotation.id, annotation.x, annotation.y, annotation.width, annotationHeight)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <aside className={`cw-directory ${directoryOpen ? 'open' : 'closed'}`} aria-label="批注目录">
          <button className="cw-directory-toggle" onClick={() => setDirectoryOpen((open) => !open)} title={directoryOpen ? '收起目录' : '展开目录'}>
            {directoryOpen ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
          </button>
          {directoryOpen && (
            <div className="cw-directory-content">
              <header>
                <strong>批注目录</strong>
                <MessageSquareText size={18} />
              </header>
              {documentState.annotations.length === 0 ? (
                <div className="cw-directory-empty">还没有批注。按 A 后点击图片试试。</div>
              ) : documentState.annotations.map((annotation, index) => (
                <button
                  key={annotation.id}
                  className={selectionKeys.has(`annotation:${annotation.id}`) ? 'active' : ''}
                  onClick={() => focusNode({ kind: 'annotation', id: annotation.id })}
                >
                  <b>{annotation.kind === 'relation' ? annotation.relationType : `批注 ${index + 1}`}</b>
                  <span>{annotation.text || '未填写说明'}</span>
                  <small>{annotation.anchorIds.map((id) => documentState.anchors.find((item) => item.id === id)?.label).filter(Boolean).join('、') || '尚未指向'}</small>
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>

      <footer className="cw-statusbar">
        <span>{status}</span>
        <span>{selection.length > 1 ? `已选 ${selection.length} 项 · ` : ''}{documentState.images.length} 图 · {documentState.annotations.length} 批注/关系 · {documentState.texts.length} 自由文字</span>
      </footer>

      {documentState.images.length === 0 && documentState.texts.length === 0 && documentState.annotations.length === 0 && (
        <button className="cw-empty-state" onClick={() => imageInputRef.current?.click()}>
          <ImagePlus size={38} />
          <strong>把图片拖进来</strong>
          <span>也可以点击选择，或直接 Ctrl+V 粘贴</span>
        </button>
      )}

      {helpOpen && (
        <div className="cw-help-backdrop" onPointerDown={() => setHelpOpen(false)}>
          <section className="cw-help" onPointerDown={(event) => event.stopPropagation()}>
            <header><div><strong>画布快捷键</strong><span>输入文字时，单字母快捷键自动停用</span></div><button onClick={() => setHelpOpen(false)}><X size={18} /></button></header>
            <dl>
              <div><dt>V</dt><dd>选择；空白处拖框多选，拖动可整组移动</dd></div>
              <div><dt>T</dt><dd>在任意位置放自由文字</dd></div>
              <div><dt>A</dt><dd>点锚或拖框精确批注</dd></div>
              <div><dt>R</dt><dd>关联多个位置并描述关系</dd></div>
              <div><dt>I</dt><dd>添加图片</dd></div>
              <div><dt>Shift + 点击</dt><dd>追加或移出当前选择</dd></div>
              <div><dt>Delete</dt><dd>批量删除全部所选内容</dd></div>
              <div><dt>Ctrl Z / Ctrl Shift Z</dt><dd>撤销 / 重做</dd></div>
              <div><dt>Ctrl S</dt><dd>保存可编辑工程，不发布为笔记</dd></div>
              <div><dt>Esc</dt><dd>取消编辑或结束当前操作</dd></div>
              <div><dt>0</dt><dd>适应全部内容</dd></div>
              <div><dt>?</dt><dd>打开本帮助</dd></div>
            </dl>
          </section>
        </div>
      )}
    </div>
  );
});

CanvasWorkspace.displayName = 'CanvasWorkspace';
