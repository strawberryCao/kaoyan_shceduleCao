import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useId,
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
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Eraser,
  FileDown,
  FileUp,
  HelpCircle,
  Highlighter,
  ImageDown,
  ImagePlus,
  Link2,
  Maximize2,
  MessageSquareText,
  Minimize2,
  MousePointer2,
  PenLine,
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
  type CanvasArrowRelation,
  type CanvasDocument,
  type CanvasImageNode,
  type CanvasInkPoint,
  type CanvasInkStroke,
  type CanvasInkTool,
  type CanvasPoint,
  type CanvasRelationType,
} from '../utils/canvasDocument';
import '../canvas-workspace.css';

// Deliberately roomy rather than visibly finite: fit-to-content keeps users away
// from the edges, while a stable coordinate space makes drafts deterministic.
const WORLD_WIDTH = 4200;
const WORLD_HEIGHT = 3000;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const HISTORY_LIMIT = 60;
const IMAGE_LONG_EDGE_LIMIT = 2800;
const IMAGE_COMPRESSION_TRIGGER_BYTES = 4 * 1024 * 1024;
const SERVER_EMBEDDED_IMAGE_LIMIT_BYTES = 20 * 1024 * 1024;
const CLIENT_EMBEDDED_IMAGE_BUDGET_BYTES = 19 * 1024 * 1024;
const CLIENT_SINGLE_IMAGE_BUDGET_BYTES = 15.5 * 1024 * 1024;
const MARQUEE_MIN_SCREEN_PX = 6;
const ERASER_RADIUS = 18;
const PALM_REJECTION_MS = 700;
const VIEWPORT_PERSIST_DELAY_MS = 180;
const WHEEL_ZOOM_SETTLE_MS = 120;
const PEN_WIDTHS = [2, 4, 6, 9, 13] as const;
const HIGHLIGHTER_WIDTHS = [12, 20, 30, 42] as const;
const TEXT_SIZES = [12, 14, 17, 20, 24, 32, 40, 56] as const;
const INK_COLORS = ['#272522', '#1478ff', '#f04444', '#2f8f62', '#9a632d'] as const;
const HIGHLIGHTER_COLORS = ['#f1c84b', '#f09a77', '#78c9ae', '#83b6e6', '#c6a3dc'] as const;

const CUSTOM_RELATION_TYPE = '自定义';

function isPresetRelationType(value: string | undefined): boolean {
  return Boolean(value && CANVAS_RELATION_TYPES.includes(value as (typeof CANVAS_RELATION_TYPES)[number]));
}

function relationDisplayLabel(item: { relationType?: string; relationLabel?: string }): string {
  if (item.relationType === CUSTOM_RELATION_TYPE) return item.relationLabel?.trim() || CUSTOM_RELATION_TYPE;
  return item.relationType?.trim() || '解释';
}

function relationEditorValue(item: { relationType?: string; relationLabel?: string } | null | undefined): string {
  if (!item) return '';
  if (item.relationType === CUSTOM_RELATION_TYPE) return item.relationLabel || '';
  return isPresetRelationType(item.relationType) ? '' : (item.relationType || '');
}

type CanvasTool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'text' | 'annotation' | 'relation' | 'arrow';
type InkCanvasTool = Extract<CanvasTool, 'pen' | 'highlighter'>;
type CanvasNodeKind = 'image' | 'text' | 'annotation' | 'relation';
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
      type: 'arrow';
      pointerId: number;
      sourceNode: { kind: 'image' | 'text' | 'annotation'; id: string };
      source: CanvasPoint;
      current: CanvasPoint;
      relationType: CanvasRelationType;
      relationLabel?: string;
    }
  | {
      type: 'viewport-pan';
      pointerId: number;
      startClient: CanvasPoint;
      scrollLeft: number;
      scrollTop: number;
    }
  | {
      type: 'ink';
      pointerId: number;
      stroke: CanvasInkStroke;
      originDocument: CanvasDocument;
    }
  | {
      type: 'erase';
      pointerId: number;
      current: CanvasPoint;
      originDocument: CanvasDocument;
    }
  | {
      type: 'marquee';
      pointerId: number;
      start: CanvasPoint;
      current: CanvasPoint;
      baseSelection: CanvasSelectionNode[];
    };

type TouchSample = { clientX: number; clientY: number };
type TouchNavigation =
  | {
      type: 'pan';
      pointerId: number;
      start: TouchSample;
      scrollLeft: number;
      scrollTop: number;
      lastAppliedAt: number;
      velocityX: number;
      velocityY: number;
    }
  | {
      type: 'pinch';
      startDistance: number;
      startZoom: number;
      anchorWorld: CanvasPoint;
      lastAppliedAt: number;
      velocityX: number;
      velocityY: number;
    };

type PendingWheelZoom = {
  zoom: number;
  anchorWorld: CanvasPoint;
  pointerX: number;
  pointerY: number;
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
  /** Lightweight live ink packets; callers may relay these without saving the whole document. */
  onInkStrokePreview?: (stroke: CanvasInkStroke) => void;
  onInkStrokeCommit?: (stroke: CanvasInkStroke) => void;
  /** Saves only the editable project. Preview export/publishing stays explicit. */
  onSave?: (document: CanvasDocument) => void | Promise<void>;
  onError?: (error: Error) => void;
  onDraftStatus?: (status: 'saving' | 'saved' | 'failed') => void;
}

export interface CanvasWorkspaceHandle {
  getDocument: () => CanvasDocument;
  /** Applies a clean remote revision without remounting and interrupting Pencil input. */
  applyRemoteDocument: (document: CanvasDocument) => boolean;
  applyRemoteInkStroke: (stroke: CanvasInkStroke) => boolean;
  /** Advances the server revision while preserving edits made during an in-flight save. */
  acknowledgeSyncRevision: (revision: number) => void;
  isInteractionActive: () => boolean;
  importDocument: (input: string | CanvasDocument) => void;
  exportDocument: () => string;
  addImages: (files: File[] | FileList, at?: CanvasPoint) => Promise<void>;
  exportPreview: (options?: CanvasPreviewOptions) => Promise<Blob>;
  fitToContent: () => void;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const isCoarsePointerDevice = (): boolean => (
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
);

const readStoredNumber = (key: string, allowed: readonly number[], fallback: number): number => {
  try {
    const value = Number(localStorage.getItem(key));
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
};

const normalizedPressure = (pressure: number, pointerType: string): number => {
  if (pointerType !== 'pen') return 0.56;
  return clamp(Number.isFinite(pressure) && pressure > 0 ? pressure : 0.2, 0.08, 1);
};

const pressureStrokeWidth = (stroke: CanvasInkStroke, pressure: number): number => (
  stroke.tool === 'highlighter'
    ? stroke.width
    : stroke.width * (0.58 + clamp(pressure, 0, 1) * 0.68)
);

interface InkCurveSegment {
  d: string;
  start: CanvasInkPoint;
  end: CanvasInkPoint;
  control1: CanvasPoint;
  control2: CanvasPoint;
  pressure: number;
}

const appendSmoothedInkPoint = (
  points: CanvasInkPoint[],
  rawPoint: CanvasInkPoint,
  zoom: number,
  finalPoint = false,
): boolean => {
  const previous = points[points.length - 1];
  if (!previous) {
    points.push(rawPoint);
    return true;
  }
  const screenDistance = Math.hypot(rawPoint.x - previous.x, rawPoint.y - previous.y) * zoom;
  if (!finalPoint && screenDistance < 0.45) return false;
  const positionAlpha = finalPoint
    ? clamp(0.78 + screenDistance / 36, 0.78, 0.94)
    : clamp(0.34 + screenDistance / 11, 0.34, 0.84);
  const pressureAlpha = finalPoint ? 0.68 : clamp(0.28 + screenDistance / 22, 0.28, 0.62);
  const next = {
    x: previous.x + (rawPoint.x - previous.x) * positionAlpha,
    y: previous.y + (rawPoint.y - previous.y) * positionAlpha,
    pressure: previous.pressure + (rawPoint.pressure - previous.pressure) * pressureAlpha,
  };
  if (Math.hypot(next.x - previous.x, next.y - previous.y) * zoom < 0.12) return false;
  points.push(next);
  return true;
};

const makeInkCurveSegments = (points: CanvasInkPoint[]): InkCurveSegment[] => {
  if (points.length < 2) return [];
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1];
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 2)];
    const control1 = {
      x: start.x + (end.x - before.x) / 6,
      y: start.y + (end.y - before.y) / 6,
    };
    const control2 = {
      x: end.x - (after.x - start.x) / 6,
      y: end.y - (after.y - start.y) / 6,
    };
    return {
      d: `M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`,
      start,
      end,
      control1,
      control2,
      pressure: (start.pressure + end.pressure) / 2,
    };
  });
};

interface InkPathRun {
  d: string;
  pressure: number;
}

/**
 * Keep pressure variation without mounting one SVG node per sample. A typical
 * handwritten character now uses a handful of continuous, round-joined paths
 * instead of dozens of tiny capped segments.
 */
const makeInkPathRuns = (points: CanvasInkPoint[]): InkPathRun[] => {
  const segments = makeInkCurveSegments(points);
  if (segments.length === 0) return [];
  const runs: InkPathRun[] = [];
  let path = '';
  let pressureTotal = 0;
  let segmentCount = 0;

  const flush = () => {
    if (!path || segmentCount === 0) return;
    runs.push({ d: path, pressure: pressureTotal / segmentCount });
    path = '';
    pressureTotal = 0;
    segmentCount = 0;
  };

  segments.forEach((segment) => {
    const averagePressure = segmentCount > 0 ? pressureTotal / segmentCount : segment.pressure;
    if (segmentCount >= 8 || (segmentCount >= 2 && Math.abs(segment.pressure - averagePressure) > 0.13)) flush();
    if (segmentCount === 0) path = `M ${segment.start.x} ${segment.start.y}`;
    path += ` C ${segment.control1.x} ${segment.control1.y}, ${segment.control2.x} ${segment.control2.y}, ${segment.end.x} ${segment.end.y}`;
    pressureTotal += segment.pressure;
    segmentCount += 1;
  });
  flush();
  return runs;
};

const InkStrokeShape = memo(function InkStrokeShape({ stroke }: { stroke: CanvasInkStroke }) {
  const runs = useMemo(() => makeInkPathRuns(stroke.points), [stroke]);
  return (
    <g
      opacity={stroke.opacity}
      style={{ mixBlendMode: stroke.tool === 'highlighter' ? 'multiply' : 'normal' }}
    >
      {stroke.points.length === 1 && (
        <circle
          cx={stroke.points[0].x}
          cy={stroke.points[0].y}
          r={pressureStrokeWidth(stroke, stroke.points[0].pressure) / 2}
          fill={stroke.color}
        />
      )}
      {runs.map((run, index) => (
        <path
          key={`${stroke.id}:${index}`}
          d={run.d}
          fill="none"
          stroke={stroke.color}
          strokeWidth={pressureStrokeWidth(stroke, run.pressure)}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </g>
  );
});

const distanceToSegment = (point: CanvasPoint, start: CanvasPoint, end: CanvasPoint): number => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
};

const strokeTouchesEraser = (stroke: CanvasInkStroke, point: CanvasPoint): boolean => {
  const threshold = ERASER_RADIUS + stroke.width / 2;
  if (stroke.points.length === 1) return distanceToSegment(point, stroke.points[0], stroke.points[0]) <= threshold;
  for (let index = 1; index < stroke.points.length; index += 1) {
    if (distanceToSegment(point, stroke.points[index - 1], stroke.points[index]) <= threshold) return true;
  }
  return false;
};

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

const HEIC_FILE_NAME_PATTERN = /\.(?:heic|heif)$/i;
const HEIC_MIME_PATTERN = /^image\/(?:heic|heif)$/i;
const HEIC_DATA_URL_PATTERN = /^data:image\/(?:heic|heif)[;,]/i;

const isHeicFile = (file: File): boolean => (
  HEIC_MIME_PATTERN.test(file.type)
  || HEIC_FILE_NAME_PATTERN.test(file.name)
);

const isSupportedImageFile = (file: File): boolean => (
  file.type.startsWith('image/')
  || /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i.test(file.name)
);

const dataUrlToBlob = async (src: string): Promise<Blob> => {
  const response = await fetch(src);
  if (!response.ok) throw new Error('无法读取画布中的 HEIC 图片。');
  return response.blob();
};

const convertHeicToJpeg = async (blob: Blob): Promise<Blob> => {
  const { heicTo } = await import('heic-to');
  return heicTo({
    blob,
    type: 'image/jpeg',
    quality: 0.94,
  });
};

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
  ...document.relations.map((item) => item.z),
  ...document.strokes.map((item) => item.z),
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
  if (node.kind === 'relation') {
    const item = document.relations.find((entry) => entry.id === node.id);
    const geometry = item ? getArrowGeometry(document, item) : null;
    if (!geometry) return null;
    const left = Math.min(geometry.start.x, geometry.end.x) - 12;
    const top = Math.min(geometry.start.y, geometry.end.y) - 12;
    return {
      ...node,
      originX: left,
      originY: top,
      width: Math.abs(geometry.end.x - geometry.start.x) + 24,
      height: Math.abs(geometry.end.y - geometry.start.y) + 24,
    };
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
    ...document.relations.map((item) => ({ kind: 'relation' as const, id: item.id })),
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

/** Existing ink strokes are immutable (new strokes append, erasing filters). */
const cloneCanvasDocumentForEditing = (document: CanvasDocument): CanvasDocument => ({
  ...document,
  images: document.images.map((item) => ({ ...item })),
  texts: document.texts.map((item) => ({ ...item })),
  anchors: document.anchors.map((item) => ({ ...item })),
  annotations: document.annotations.map((item) => ({ ...item, anchorIds: [...item.anchorIds] })),
  relations: document.relations.map((item) => ({ ...item })),
  // Sharing immutable point arrays across undo snapshots avoids quadratic
  // memory growth on handwriting-heavy canvases.
  strokes: [...document.strokes],
  viewport: { ...document.viewport },
});

const hasDocumentContent = (document: CanvasDocument): boolean => (
  document.images.length > 0
  || document.texts.length > 0
  || document.annotations.length > 0
  || document.relations.length > 0
  || document.strokes.length > 0
);

const getStableStrokeRange = (points: CanvasInkPoint[]): { start: number; end: number } => {
  if (points.length < 4) return { start: 0, end: points.length };
  const distances: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    distances.push(Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y));
  }
  const ordered = [...distances].sort((left, right) => left - right);
  const median = ordered[Math.floor(ordered.length / 2)] || 1;
  const implausibleJump = Math.max(120, median * 12);
  let start = 0;
  let end = points.length;
  if (distances[0] > implausibleJump) start = 1;
  if (distances[distances.length - 1] > implausibleJump) end -= 1;
  return end > start ? { start, end } : { start: 0, end: points.length };
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
  document.strokes.forEach((stroke) => {
    if (stroke.points.length === 0) return;
    const padding = stroke.width / 2 + 2;
    const range = getStableStrokeRange(stroke.points);
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (let index = range.start; index < range.end; index += 1) {
      const point = stroke.points[index];
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
    boxes.push({
      left: left - padding,
      top: top - padding,
      right: right + padding,
      bottom: bottom + padding,
    });
  });
  if (boxes.length === 0) {
    const left = WORLD_WIDTH / 2 - 480;
    const top = WORLD_HEIGHT / 2 - 320;
    return { left, top, right: left + 960, bottom: top + 640, width: 960, height: 640 };
  }
  const left = clamp(Math.min(...boxes.map((box) => box.left)), 0, WORLD_WIDTH - 1);
  const top = clamp(Math.min(...boxes.map((box) => box.top)), 0, WORLD_HEIGHT - 1);
  const right = clamp(Math.max(...boxes.map((box) => box.right)), left + 1, WORLD_WIDTH);
  const bottom = clamp(Math.max(...boxes.map((box) => box.bottom)), top + 1, WORLD_HEIGHT);
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

type ConnectableNodeKind = 'image' | 'text' | 'annotation';
type ConnectableNode = { kind: ConnectableNodeKind; id: string; z: number };
type BoardRect = { x: number; y: number; width: number; height: number };

const getConnectableNodeRect = (
  document: CanvasDocument,
  kind: ConnectableNodeKind,
  id: string,
): BoardRect | null => {
  if (kind === 'image') {
    const item = document.images.find((entry) => entry.id === id);
    return item ? { x: item.x, y: item.y, width: item.width, height: item.height } : null;
  }
  if (kind === 'text') {
    const item = document.texts.find((entry) => entry.id === id);
    return item ? { x: item.x, y: item.y, width: item.width, height: getCardHeight(item, 56) } : null;
  }
  const item = document.annotations.find((entry) => entry.id === id);
  return item ? { x: item.x, y: item.y, width: item.width, height: getCardHeight(item) } : null;
};

const getConnectableNodeAtPoint = (document: CanvasDocument, point: CanvasPoint): ConnectableNode | null => {
  const nodes: ConnectableNode[] = [
    ...document.images.map((item) => ({ kind: 'image' as const, id: item.id, z: item.z })),
    ...document.texts.map((item) => ({ kind: 'text' as const, id: item.id, z: item.z })),
    ...document.annotations.map((item) => ({ kind: 'annotation' as const, id: item.id, z: item.z })),
  ];
  return nodes.sort((left, right) => right.z - left.z).find((node) => {
    const rect = getConnectableNodeRect(document, node.kind, node.id);
    return !!rect
      && point.x >= rect.x
      && point.x <= rect.x + rect.width
      && point.y >= rect.y
      && point.y <= rect.y + rect.height;
  }) ?? null;
};

const normalizedPointInRect = (point: CanvasPoint, rect: BoardRect): CanvasPoint => ({
  x: clamp((point.x - rect.x) / Math.max(1, rect.width), 0, 1),
  y: clamp((point.y - rect.y) / Math.max(1, rect.height), 0, 1),
});

const getAnchorBoardRect = (document: CanvasDocument, anchor: CanvasAnchor): BoardRect | null => {
  const targetRect = anchor.imageId
    ? getConnectableNodeRect(document, 'image', anchor.imageId)
    : anchor.nodeId && anchor.nodeKind
      ? getConnectableNodeRect(document, anchor.nodeKind, anchor.nodeId)
      : null;
  if (!targetRect) return null;
  return {
    x: targetRect.x + anchor.x * targetRect.width,
    y: targetRect.y + anchor.y * targetRect.height,
    width: anchor.width * targetRect.width,
    height: anchor.height * targetRect.height,
  };
};

type ArrowGeometry = {
  start: CanvasPoint;
  control1: CanvasPoint;
  control2: CanvasPoint;
  end: CanvasPoint;
  label: CanvasPoint;
  d: string;
};

const rectCenter = (rect: { x: number; y: number; width: number; height: number }): CanvasPoint => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});

const rectEdgeToward = (
  rect: { x: number; y: number; width: number; height: number },
  toward: CanvasPoint,
): CanvasPoint => {
  const center = rectCenter(rect);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return center;
  const halfWidth = Math.max(1, rect.width / 2);
  const halfHeight = Math.max(1, rect.height / 2);
  const scale = 1 / Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
};

const makeArrowGeometry = (
  sourceRect: { x: number; y: number; width: number; height: number },
  targetRect: { x: number; y: number; width: number; height: number },
): ArrowGeometry => {
  const start = rectCenter(sourceRect);
  const end = rectCenter(targetRect);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const control1 = horizontal
    ? { x: start.x + dx * 0.36, y: start.y }
    : { x: start.x, y: start.y + dy * 0.36 };
  const control2 = horizontal
    ? { x: end.x - dx * 0.36, y: end.y }
    : { x: end.x, y: end.y - dy * 0.36 };
  const label = {
    x: (start.x + 3 * control1.x + 3 * control2.x + end.x) / 8,
    y: (start.y + 3 * control1.y + 3 * control2.y + end.y) / 8,
  };
  return {
    start,
    control1,
    control2,
    end,
    label,
    d: `M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`,
  };
};

const getArrowGeometry = (document: CanvasDocument, relation: CanvasArrowRelation): ArrowGeometry | null => {
  const source = document.anchors.find((item) => item.id === relation.fromAnchorId);
  const target = document.anchors.find((item) => item.id === relation.toAnchorId);
  if (!source || !target) return null;
  const sourceRect = getAnchorBoardRect(document, source);
  const targetRect = getAnchorBoardRect(document, target);
  if (!sourceRect || !targetRect) return null;
  return makeArrowGeometry(sourceRect, targetRect);
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

  const plainAnnotationNumberById = new Map<string, number>();
  const plainAnnotationNumbersByAnchorId = new Map<string, number[]>();
  let plainAnnotationCount = 0;
  document.annotations.forEach((annotation) => {
    if (annotation.kind !== 'annotation') return;
    plainAnnotationCount += 1;
    plainAnnotationNumberById.set(annotation.id, plainAnnotationCount);
    annotation.anchorIds.forEach((anchorId) => {
      const numbers = plainAnnotationNumbersByAnchorId.get(anchorId) ?? [];
      numbers.push(plainAnnotationCount);
      plainAnnotationNumbersByAnchorId.set(anchorId, numbers);
    });
  });

  // Connections stay below every node so their direction remains visible without obscuring content.
  document.annotations.forEach((annotation) => {
    const annotationRect = {
      x: annotation.x,
      y: annotation.y,
      width: annotation.width,
      height: getCardHeight(annotation),
    };
    annotation.anchorIds.forEach((anchorId) => {
      const anchor = document.anchors.find((item) => item.id === anchorId);
      if (!anchor) return;
      const rect = getAnchorBoardRect(document, anchor);
      if (!rect) return;
      const anchorX = rect.x + rect.width / 2;
      const anchorY = rect.y + rect.height / 2;
      const origin = annotation.kind === 'annotation'
        ? rectEdgeToward(annotationRect, { x: anchorX, y: anchorY })
        : rectCenter(annotationRect);
      context.beginPath();
      context.moveTo(origin.x, origin.y);
      const middleX = (origin.x + anchorX) / 2;
      context.bezierCurveTo(middleX, origin.y, middleX, anchorY, anchorX, anchorY);
      context.strokeStyle = annotation.kind === 'relation' ? 'rgba(173, 91, 43, 0.72)' : 'rgba(156, 108, 53, 0.62)';
      context.lineWidth = annotation.kind === 'relation' ? 3 : 2;
      context.stroke();
      if (annotation.kind === 'annotation') {
        context.beginPath();
        context.arc(origin.x, origin.y, 3.5, 0, Math.PI * 2);
        context.fillStyle = '#a8642e';
        context.fill();
      }
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
    const annotationNumbers = plainAnnotationNumbersByAnchorId.get(anchor.id) ?? [];
    const markerLabel = annotationNumbers.length > 0 ? annotationNumbers.join('/') : anchor.label;
    context.font = '800 12px "Microsoft YaHei", sans-serif';
    context.fillStyle = '#70471c';
    context.fillText(markerLabel, rect.x + 14, rect.y - 8);
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
    if (item.kind === 'annotation') {
      const annotationNumber = plainAnnotationNumberById.get(item.id) ?? 1;
      context.fillStyle = '#8a5a28';
      context.font = '800 13px "Microsoft YaHei", sans-serif';
      context.fillText(`批注 ${annotationNumber}`, item.x, item.y + 18);
      context.fillStyle = '#403329';
      context.font = '700 15px "Microsoft YaHei", sans-serif';
      drawWrappedText(context, item.text, item.x, item.y + 46, item.width, 24, item.y + height - 8);
      return;
    }
    context.fillStyle = item.kind === 'relation' ? '#fff2e4' : '#fffaf0';
    roundRect(context, item.x, item.y, item.width, height, 15);
    context.fill();
    context.strokeStyle = item.kind === 'relation' ? '#b87543' : '#bd915d';
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = item.kind === 'relation' ? '#a35d30' : '#8a5a28';
    context.font = '800 13px "Microsoft YaHei", sans-serif';
    context.fillText(item.kind === 'relation' ? relationDisplayLabel(item) : '批注', item.x + 16, item.y + 24);
    context.fillStyle = '#403329';
    context.font = '700 15px "Microsoft YaHei", sans-serif';
    drawWrappedText(context, item.text, item.x + 16, item.y + 52, item.width - 32, 24, item.y + height - 12);
  });

  // Directional relations sit above images so the target arrowhead remains visible.
  document.relations.forEach((relation) => {
    const arrow = getArrowGeometry(document, relation);
    if (!arrow) return;
    const traceArrow = () => {
      context.beginPath();
      context.moveTo(arrow.start.x, arrow.start.y);
      context.bezierCurveTo(
        arrow.control1.x,
        arrow.control1.y,
        arrow.control2.x,
        arrow.control2.y,
        arrow.end.x,
        arrow.end.y,
      );
    };
    context.save();
    traceArrow();
    context.strokeStyle = 'rgba(255, 252, 245, 0.92)';
    context.lineWidth = 8;
    context.stroke();
    traceArrow();
    context.strokeStyle = '#a35d30';
    context.lineWidth = 3.5;
    context.stroke();

    const angle = Math.atan2(arrow.end.y - arrow.control2.y, arrow.end.x - arrow.control2.x);
    context.translate(arrow.end.x, arrow.end.y);
    context.rotate(angle);
    context.beginPath();
    context.moveTo(1, 0);
    context.lineTo(-16, -10);
    context.lineTo(-12, 0);
    context.lineTo(-16, 10);
    context.closePath();
    context.fillStyle = '#a35d30';
    context.fill();
    context.restore();

    context.save();
    context.font = '700 13px "Microsoft YaHei", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'bottom';
    context.lineJoin = 'round';
    context.lineWidth = 5;
    context.strokeStyle = 'rgba(255, 252, 245, 0.96)';
    context.strokeText(relationDisplayLabel(relation), arrow.label.x, arrow.label.y - 7);
    context.fillStyle = relation.color || '#a35d30';
    context.fillText(relationDisplayLabel(relation), arrow.label.x, arrow.label.y - 7);
    context.restore();
  });

  // Handwriting is the top paper layer, matching what the user sees while writing.
  [...document.strokes].sort((left, right) => left.z - right.z).forEach((stroke) => {
    if (stroke.points.length === 0) return;
    context.save();
    context.globalAlpha = stroke.opacity;
    context.globalCompositeOperation = stroke.tool === 'highlighter' ? 'multiply' : 'source-over';
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      context.beginPath();
      context.arc(point.x, point.y, pressureStrokeWidth(stroke, point.pressure) / 2, 0, Math.PI * 2);
      context.fill();
      context.restore();
      return;
    }
    makeInkCurveSegments(stroke.points).forEach((segment) => {
      context.beginPath();
      context.moveTo(segment.start.x, segment.start.y);
      context.bezierCurveTo(
        segment.control1.x,
        segment.control1.y,
        segment.control2.x,
        segment.control2.y,
        segment.end.x,
        segment.end.y,
      );
      context.lineWidth = pressureStrokeWidth(stroke, segment.pressure);
      context.stroke();
    });
    context.restore();
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
  directoryInitiallyOpen = false,
  onChange,
  onInkStrokePreview,
  onInkStrokeCommit,
  onSave,
  onError,
  onDraftStatus,
}, ref) {
  const arrowMarkerId = useId().replace(/:/g, '');
  const storageKey = draftKey === false ? null : draftKey;
const viewportStorageKey = storageKey ? `${storageKey}.viewport` : null;
const initialIdRef = useRef(initialDocument?.id ?? null);
const restoreStoredViewport = (document: CanvasDocument): CanvasDocument => {
  if (!viewportStorageKey || typeof localStorage === 'undefined') return document;
  try {
    const saved = localStorage.getItem(viewportStorageKey);
    if (!saved) return document;
    const parsed = JSON.parse(saved) as Partial<CanvasDocument['viewport']>;
    const savedZoom = Number(parsed.zoom);
    const savedScrollLeft = Number(parsed.scrollLeft);
    const savedScrollTop = Number(parsed.scrollTop);
    if (
      Number.isFinite(savedZoom)
      && Number.isFinite(savedScrollLeft)
      && Number.isFinite(savedScrollTop)
    ) {
      document.viewport = {
        zoom: clamp(savedZoom, MIN_ZOOM, MAX_ZOOM),
        scrollLeft: Math.max(0, savedScrollLeft),
        scrollTop: Math.max(0, savedScrollTop),
      };
    }
  } catch {
    // Viewport state is optional; an invalid lightweight snapshot is ignored.
  }
  return document;
};
const makeInitialDocument = () => {
  if (storageKey && typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const draft = parseCanvasDocument(saved);
        const draftIsNewer = !initialDocument
          || (
            draft.id === initialDocument.id
            && draft.syncRevision === initialDocument.syncRevision
            && draft.updatedAt !== initialDocument.updatedAt
          );
        if (draftIsNewer) return restoreStoredViewport(draft);
      }
    } catch {
      // A malformed or over-quota draft should never prevent opening the editor.
    }
  }
  if (initialDocument) return restoreStoredViewport(cloneCanvasDocument(initialDocument));
  return restoreStoredViewport(createEmptyCanvasDocument());
};

const [documentState, setDocumentState] = useState<CanvasDocument>(makeInitialDocument);
  const documentRef = useRef(documentState);
  const [remoteInkPreviews, setRemoteInkPreviews] = useState<CanvasInkStroke[]>([]);
  const draftRevisionRef = useRef(0);
  const persistedDraftRevisionRef = useRef(-1);
  const [past, setPast] = useState<CanvasDocument[]>([]);
  const [future, setFuture] = useState<CanvasDocument[]>([]);
  const [tool, setTool] = useState<CanvasTool>(() => isCoarsePointerDevice() ? 'pen' : 'select');
  const [lastInkTool, setLastInkTool] = useState<InkCanvasTool>('pen');
  const [penColor, setPenColor] = useState<string>(INK_COLORS[0]);
  const [highlighterColor, setHighlighterColor] = useState<string>(HIGHLIGHTER_COLORS[0]);
  const [penWidth, setPenWidth] = useState<number>(() => readStoredNumber('kaoyan.canvas.penWidth.v1', PEN_WIDTHS, PEN_WIDTHS[1]));
  const [highlighterWidth, setHighlighterWidth] = useState<number>(() => readStoredNumber('kaoyan.canvas.highlighterWidth.v1', HIGHLIGHTER_WIDTHS, HIGHLIGHTER_WIDTHS[1]));
  const [textFontSize, setTextFontSize] = useState<number>(() => readStoredNumber('kaoyan.canvas.textFontSize.v1', TEXT_SIZES, 17));
  const [focusMode, setFocusMode] = useState(() => {
    try {
      const saved = localStorage.getItem('kaoyan.canvas.focusMode.v1');
      if (saved !== null) return saved === '1';
    } catch {
      // Storage can be unavailable in private browsing; device defaults still work.
    }
    return isCoarsePointerDevice();
  });
  const [selection, setSelection] = useState<CanvasSelectionNode[]>([]);
  const [editing, setEditing] = useState<EditingNode>(null);
  const editOriginRef = useRef<CanvasDocument | null>(null);
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const gestureRenderFrameRef = useRef<number | null>(null);
  const touchPointersRef = useRef(new Map<number, TouchSample>());
  const suppressedTouchIdsRef = useRef(new Set<number>());
  const touchNavigationRef = useRef<TouchNavigation | null>(null);
  const touchNavigationFrameRef = useRef<number | null>(null);
  const touchMomentumFrameRef = useRef<number | null>(null);
  const compatibilityRepairInFlightRef = useRef(new Set<string>());
  const lastPenInputAtRef = useRef(0);
  const lastLiveInkSentAtRef = useRef(0);
  const [linkingAnnotationId, setLinkingAnnotationId] = useState<string | null>(null);
  const [relationType, setRelationType] = useState<CanvasRelationType>('解释');
  const [customRelationLabel, setCustomRelationLabel] = useState('');
  const [zoom, setZoomState] = useState(() => clamp(documentState.viewport.zoom || 0.72, MIN_ZOOM, MAX_ZOOM));
  const zoomRef = useRef(zoom);
  const wheelZoomFrameRef = useRef<number | null>(null);
  const wheelZoomSettleTimerRef = useRef<number | null>(null);
  const pendingWheelZoomRef = useRef<PendingWheelZoom | null>(null);
  const viewportPersistTimerRef = useRef<number | null>(null);
  const [directoryOpen, setDirectoryOpen] = useState(() => directoryInitiallyOpen && !isCoarsePointerDevice());
  const [helpOpen, setHelpOpen] = useState(false);
  const [status, setStatus] = useState('Apple Pencil 已进入钢笔模式；双指移动或缩放画布。');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const spacePressedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldSpacerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const zoomValueRef = useRef<HTMLSpanElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  const writeViewportSnapshot = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const snapshot = {
      zoom: clamp(zoomRef.current, MIN_ZOOM, MAX_ZOOM),
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
    documentRef.current.viewport = snapshot;
    if (!viewportStorageKey) return;
    try {
      localStorage.setItem(viewportStorageKey, JSON.stringify(snapshot));
    } catch {
      // A lightweight viewport snapshot must never interrupt canvas interaction.
    }
  }, [viewportStorageKey]);

  const scheduleViewportPersistence = useCallback((delay = VIEWPORT_PERSIST_DELAY_MS) => {
    if (!viewportStorageKey) return;
    if (viewportPersistTimerRef.current !== null) {
      window.clearTimeout(viewportPersistTimerRef.current);
    }
    viewportPersistTimerRef.current = window.setTimeout(() => {
      viewportPersistTimerRef.current = null;
      writeViewportSnapshot();
    }, delay);
  }, [viewportStorageKey, writeViewportSnapshot]);

  const applyZoomToDom = useCallback((nextZoom: number): number => {
    const next = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    zoomRef.current = next;
    documentRef.current.viewport.zoom = next;
    const spacer = worldSpacerRef.current;
    const world = worldRef.current;
    if (spacer) {
      spacer.style.width = `${WORLD_WIDTH * next}px`;
      spacer.style.height = `${WORLD_HEIGHT * next}px`;
    }
    if (world) world.style.transform = `scale(${next})`;
    if (zoomValueRef.current) zoomValueRef.current.textContent = `${Math.round(next * 100)}%`;
    return next;
  }, []);

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
    draftRevisionRef.current += 1;
    setDocumentState(next);
    if (notify) onChange?.(cloneCanvasDocumentForEditing(next));
  }, [onChange]);

  const pushOriginToHistory = useCallback((origin: CanvasDocument) => {
    setPast((items) => [...items.slice(-(HISTORY_LIMIT - 1)), cloneCanvasDocumentForEditing(origin)]);
    setFuture([]);
  }, []);

  const commit = useCallback((mutate: (draft: CanvasDocument) => void) => {
    const origin = documentRef.current;
    const next = cloneCanvasDocumentForEditing(documentRef.current);
    mutate(next);
    next.updatedAt = new Date().toISOString();
    pushOriginToHistory(origin);
    setRemoteInkPreviews([]);
    setCurrentDocument(next);
    return next;
  }, [pushOriginToHistory, setCurrentDocument]);

  const replaceTransient = useCallback((mutate: (draft: CanvasDocument) => void, notify = false) => {
    const next = cloneCanvasDocumentForEditing(documentRef.current);
    mutate(next);
    if (notify) next.updatedAt = new Date().toISOString();
    setCurrentDocument(next, notify);
    setRemoteInkPreviews([]);
  }, [setCurrentDocument]);

  const finalizeTransient = useCallback((origin: CanvasDocument) => {
    const current = documentRef.current;
    if (lightweightDocumentSignature(origin) === lightweightDocumentSignature(current)) return;
    pushOriginToHistory(origin);
    const next = cloneCanvasDocumentForEditing(current);
    next.updatedAt = new Date().toISOString();
    setCurrentDocument(next);
  }, [pushOriginToHistory, setCurrentDocument]);

  const setActiveGesture = useCallback((next: Gesture | null) => {
    gestureRef.current = next;
    if (next === null) {
      if (gestureRenderFrameRef.current !== null) cancelAnimationFrame(gestureRenderFrameRef.current);
      gestureRenderFrameRef.current = null;
      setGestureState(null);
      return;
    }
    if (gestureRenderFrameRef.current !== null) return;
    gestureRenderFrameRef.current = requestAnimationFrame(() => {
      gestureRenderFrameRef.current = null;
      setGestureState(gestureRef.current);
    });
  }, []);

  const cancelActiveGesture = useCallback((message = '已取消当前拖动。') => {
    const active = gestureRef.current;
    if (!active) return false;
    setActiveGesture(null);
    if ('originDocument' in active) {
      setCurrentDocument(cloneCanvasDocumentForEditing(active.originDocument), false);
    } else if (active.type === 'marquee') {
      setSelection(active.baseSelection);
    }
    setStatus(message);
    return true;
  }, [setActiveGesture, setCurrentDocument]);

  const setZoom = useCallback((nextZoom: number) => {
    if (wheelZoomFrameRef.current !== null) {
      cancelAnimationFrame(wheelZoomFrameRef.current);
      wheelZoomFrameRef.current = null;
    }
    if (wheelZoomSettleTimerRef.current !== null) {
      window.clearTimeout(wheelZoomSettleTimerRef.current);
      wheelZoomSettleTimerRef.current = null;
    }
    pendingWheelZoomRef.current = null;
    const next = applyZoomToDom(nextZoom);
    setZoomState(next);
    scheduleViewportPersistence();
  }, [applyZoomToDom, scheduleViewportPersistence]);

  const toggleFocusMode = useCallback(() => {
    setFocusMode((active) => !active);
  }, []);

  const getWorldPoint = useCallback((clientX: number, clientY: number): CanvasPoint => {
    const rect = worldRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const currentZoom = Math.max(MIN_ZOOM, zoomRef.current);
    return {
      x: clamp((clientX - rect.left) / currentZoom, 0, WORLD_WIDTH),
      y: clamp((clientY - rect.top) / currentZoom, 0, WORLD_HEIGHT),
    };
  }, []);

  const getInkWorldPoint = useCallback((clientX: number, clientY: number): CanvasPoint | null => {
    const rect = worldRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const safeMargin = 28;
    if (
      clientX < rect.left - safeMargin
      || clientX > rect.right + safeMargin
      || clientY < rect.top - safeMargin
      || clientY > rect.bottom + safeMargin
    ) return null;
    const currentZoom = Math.max(MIN_ZOOM, zoomRef.current);
    return {
      x: clamp((clientX - rect.left) / currentZoom, 0, WORLD_WIDTH),
      y: clamp((clientY - rect.top) / currentZoom, 0, WORLD_HEIGHT),
    };
  }, []);

  const getViewportCenterWorld = useCallback((): CanvasPoint => {
    const viewport = viewportRef.current;
    if (!viewport) return { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 };
    const currentZoom = Math.max(MIN_ZOOM, zoomRef.current);
    return {
      x: clamp((viewport.scrollLeft + viewport.clientWidth / 2) / currentZoom, 0, WORLD_WIDTH),
      y: clamp((viewport.scrollTop + viewport.clientHeight / 2) / currentZoom, 0, WORLD_HEIGHT),
    };
  }, []);

  const fitToContent = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (!hasDocumentContent(documentRef.current)) {
      const nextZoom = 0.9;
      setZoom(nextZoom);
      requestAnimationFrame(() => {
        viewport.scrollTo({
          left: Math.max(0, WORLD_WIDTH * nextZoom / 2 - viewport.clientWidth / 2),
          top: Math.max(0, WORLD_HEIGHT * nextZoom / 2 - viewport.clientHeight / 2),
          behavior: 'smooth',
        });
      });
      return;
    }
    const bounds = getContentBounds(documentRef.current);
    const screenPadding = clamp(Math.min(viewport.clientWidth, viewport.clientHeight) * 0.09, 44, 88);
    const usableWidth = Math.max(240, viewport.clientWidth - screenPadding * 2);
    const usableHeight = Math.max(220, viewport.clientHeight - screenPadding * 2);
    const nextZoom = clamp(Math.min(usableWidth / bounds.width, usableHeight / bounds.height, 1.08), MIN_ZOOM, MAX_ZOOM);
    setZoom(nextZoom);
    requestAnimationFrame(() => {
      const maxLeft = Math.max(0, WORLD_WIDTH * nextZoom - viewport.clientWidth);
      const maxTop = Math.max(0, WORLD_HEIGHT * nextZoom - viewport.clientHeight);
      viewport.scrollTo({
        left: clamp((bounds.left + bounds.width / 2) * nextZoom - viewport.clientWidth / 2, 0, maxLeft),
        top: clamp((bounds.top + bounds.height / 2) * nextZoom - viewport.clientHeight / 2, 0, maxTop),
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
    } else if (node.kind === 'relation') {
      const relation = documentRef.current.relations.find((entry) => entry.id === node.id);
      const geometry = relation ? getArrowGeometry(documentRef.current, relation) : null;
      if (!geometry) return;
      x = (geometry.start.x + geometry.end.x) / 2;
      y = (geometry.start.y + geometry.end.y) / 2;
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
    const files = Array.from(filesInput).filter(isSupportedImageFile);
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
      const visibleCenter = at ?? getViewportCenterWorld();
      const prepared: Array<{ node: CanvasImageNode; bytes: number; compressed: boolean }> = [];
      let newBytes = 0;
      for (const [index, file] of files.entries()) {
        const convertedFromHeic = isHeicFile(file);
        const src = convertedFromHeic
          ? await readBlobAsDataUrl(await convertHeicToJpeg(file))
          : await readFileAsDataUrl(file);
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
        const base = at ?? {
          x: visibleCenter.x - width / 2,
          y: visibleCenter.y - height / 2,
        };
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
        prepared.push({ node, bytes: optimized.bytes, compressed: optimized.compressed || convertedFromHeic });
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
  }, [commit, getViewportCenterWorld, reportError]);

  const beginEditing = useCallback((next: EditingNode) => {
    editOriginRef.current = cloneCanvasDocumentForEditing(documentRef.current);
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
        fontSize: textFontSize,
        color: '#403329',
        z: nextZ(draft),
      } as CanvasDocument['texts'][number] & { height: number });
    });
    setSelected({ kind: 'text', id });
    beginEditing({ kind: 'text', id });
    setStatus('自由文字已放置。拖动卡片可以继续调整位置。');
  }, [beginEditing, commit, textFontSize]);

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
        ...(relationType === CUSTOM_RELATION_TYPE && customRelationLabel.trim()
          ? { relationLabel: customRelationLabel.trim().slice(0, 80) }
          : {}),
        color: '#eca76d',
        z: nextZ(draft),
      } as CanvasDocument['annotations'][number] & { height: number });
    });
    setSelected({ kind: 'annotation', id });
    setLinkingAnnotationId(id);
    beginEditing({ kind: 'annotation', id });
    setStatus('关系卡已放置。填写文字后，在图片上点击或框选多个位置。');
  }, [beginEditing, commit, customRelationLabel, relationType]);

  const deleteSelected = useCallback(() => {
    if (selection.length === 0) return;
    const deleting = [...selection];
    const imageIds = new Set(deleting.filter((node) => node.kind === 'image').map((node) => node.id));
    const textIds = new Set(deleting.filter((node) => node.kind === 'text').map((node) => node.id));
    const annotationIds = new Set(deleting.filter((node) => node.kind === 'annotation').map((node) => node.id));
    const selectedRelationIds = new Set(deleting.filter((node) => node.kind === 'relation').map((node) => node.id));
    commit((draft) => {
      const deletedAnnotationAnchorIds = new Set(
        draft.annotations
          .filter((item) => annotationIds.has(item.id))
          .flatMap((item) => item.anchorIds),
      );
      const deletedNodeAnchorIds = new Set(
        draft.anchors.filter((anchor) => (
          (typeof anchor.imageId === 'string' && imageIds.has(anchor.imageId))
          || (anchor.nodeKind === 'image' && typeof anchor.nodeId === 'string' && imageIds.has(anchor.nodeId))
          || (anchor.nodeKind === 'text' && typeof anchor.nodeId === 'string' && textIds.has(anchor.nodeId))
          || (anchor.nodeKind === 'annotation' && typeof anchor.nodeId === 'string' && annotationIds.has(anchor.nodeId))
        )).map((anchor) => anchor.id),
      );
      const relationIds = new Set(selectedRelationIds);
      draft.relations.forEach((relation) => {
        if (deletedNodeAnchorIds.has(relation.fromAnchorId) || deletedNodeAnchorIds.has(relation.toAnchorId)) {
          relationIds.add(relation.id);
        }
      });
      const deletedRelationAnchorIds = new Set(
        draft.relations
          .filter((item) => relationIds.has(item.id))
          .flatMap((item) => [item.fromAnchorId, item.toAnchorId]),
      );
      draft.images = draft.images.filter((item) => !imageIds.has(item.id));
      draft.texts = draft.texts.filter((item) => !textIds.has(item.id));
      draft.annotations = draft.annotations.filter((item) => !annotationIds.has(item.id));
      draft.relations = draft.relations.filter((item) => !relationIds.has(item.id));

      const anchorsStillReferenced = new Set([
        ...draft.annotations.flatMap((item) => item.anchorIds),
        ...draft.relations.flatMap((item) => [item.fromAnchorId, item.toAnchorId]),
      ]);
      const removedAnchorIds = new Set([
        ...deletedNodeAnchorIds,
        ...[...deletedAnnotationAnchorIds].filter((id) => !anchorsStillReferenced.has(id)),
        ...[...deletedRelationAnchorIds].filter((id) => !anchorsStillReferenced.has(id)),
      ]);
      draft.anchors = draft.anchors.filter((anchor) => !removedAnchorIds.has(anchor.id));
      draft.annotations.forEach((item) => {
        item.anchorIds = item.anchorIds.filter((id) => !removedAnchorIds.has(id));
      });
      draft.relations = draft.relations.filter((item) => (
        !removedAnchorIds.has(item.fromAnchorId) && !removedAnchorIds.has(item.toAnchorId)
      ));
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
    setFuture([cloneCanvasDocumentForEditing(documentRef.current), ...future].slice(0, HISTORY_LIMIT));
    setCurrentDocument(cloneCanvasDocumentForEditing(previous));
    setSelected(null);
    setEditing(null);
  }, [future, past, setCurrentDocument, setSelected]);

  const redo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture(future.slice(1));
    setPast([...past.slice(-(HISTORY_LIMIT - 1)), cloneCanvasDocumentForEditing(documentRef.current)]);
    setCurrentDocument(cloneCanvasDocumentForEditing(next));
    setSelected(null);
    setEditing(null);
  }, [future, past, setCurrentDocument, setSelected]);

  const importDocument = useCallback((input: string | CanvasDocument) => {
    try {
      const parsed = parseCanvasDocument(input);
      pushOriginToHistory(documentRef.current);
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

  const applyRemoteDocument = useCallback((remoteDocument: CanvasDocument): boolean => {
    if (
      gestureRef.current
      || editOriginRef.current
      || touchPointersRef.current.size > 0
      || savingRef.current
    ) return false;

    const viewport = viewportRef.current;
    const localViewport = {
      zoom: zoomRef.current,
      scrollLeft: viewport?.scrollLeft ?? documentRef.current.viewport.scrollLeft,
      scrollTop: viewport?.scrollTop ?? documentRef.current.viewport.scrollTop,
    };
    const next = cloneCanvasDocument(remoteDocument);
    const localStrokes = new Map(documentRef.current.strokes.map((stroke) => [stroke.id, stroke]));
    next.strokes = next.strokes.map((stroke) => localStrokes.get(stroke.id) ?? stroke);
    next.viewport = localViewport;
    initialIdRef.current = next.id;
    setCurrentDocument(next, false);
    setRemoteInkPreviews([]);
    setZoomState(clamp(localViewport.zoom, MIN_ZOOM, MAX_ZOOM));
    setPast([]);
    setFuture([]);
    setSelected(null);
    setEditing(null);
    setLinkingAnnotationId(null);
    setStatus('已同步另一台设备上的最新修改。');
    return true;
  }, [setCurrentDocument, setSelected]);

  const applyRemoteInkStroke = useCallback((remoteStroke: CanvasInkStroke): boolean => {
    if (
      gestureRef.current
      || editOriginRef.current
      || touchPointersRef.current.size > 0
      || savingRef.current
    ) return false;
    const stroke = { ...remoteStroke, points: remoteStroke.points.map((point) => ({ ...point })) };
    if (documentRef.current.strokes.some((item) => item.id === stroke.id)) return true;
    setRemoteInkPreviews((items) => {
      const existingIndex = items.findIndex((item) => item.id === stroke.id);
      if (existingIndex >= 0 && items[existingIndex].points.length >= stroke.points.length) return items;
      if (existingIndex < 0) return [...items, stroke];
      const next = [...items];
      next[existingIndex] = stroke;
      return next;
    });
    setStatus('正在实时接收另一台设备的笔迹…');
    return true;
  }, []);

  const acknowledgeSyncRevision = useCallback((revision: number) => {
    if (!Number.isInteger(revision) || revision < documentRef.current.syncRevision) return;
    if (revision === documentRef.current.syncRevision) return;
    const next = cloneCanvasDocumentForEditing(documentRef.current);
    next.syncRevision = revision;
    setCurrentDocument(next, false);
  }, [setCurrentDocument]);

  useImperativeHandle(ref, () => ({
    getDocument: () => cloneCanvasDocument(documentRef.current),
    applyRemoteDocument,
    applyRemoteInkStroke,
    acknowledgeSyncRevision,
    isInteractionActive: () => Boolean(
      gestureRef.current
      || editOriginRef.current
      || touchPointersRef.current.size > 0
      || savingRef.current
    ),
    importDocument,
    exportDocument: () => serializeCanvasDocument(documentRef.current),
    addImages,
    exportPreview,
    fitToContent,
  }), [acknowledgeSyncRevision, addImages, applyRemoteDocument, applyRemoteInkStroke, exportPreview, fitToContent, importDocument]);

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

  useEffect(() => {
    const candidates = documentState.images.filter((image) => (
      HEIC_DATA_URL_PATTERN.test(image.src)
      && !compatibilityRepairInFlightRef.current.has(image.id)
    ));
    if (candidates.length === 0) return undefined;
    candidates.forEach((image) => compatibilityRepairInFlightRef.current.add(image.id));
    let cancelled = false;
    void Promise.all(candidates.map(async (image) => {
      try {
        const jpegBlob = await convertHeicToJpeg(await dataUrlToBlob(image.src));
        const jpegSrc = await readBlobAsDataUrl(jpegBlob);
        const browserImage = await loadBrowserImage(jpegSrc);
        const optimized = await optimizeEmbeddedImage(jpegSrc, browserImage);
        return { image, optimized };
      } catch (error) {
        reportError(new Error(`“${image.name || 'HEIC 图片'}”转换失败：${error instanceof Error ? error.message : String(error)}`));
        return null;
      }
    })).then((repairs) => {
      if (cancelled) return;
      const completed = repairs.filter((repair): repair is NonNullable<typeof repair> => Boolean(repair));
      if (completed.length === 0) return;
      const byId = new Map(completed.map((repair) => [repair.image.id, repair.optimized]));
      commit((draft) => {
        draft.images.forEach((image) => {
          const replacement = byId.get(image.id);
          if (!replacement || !HEIC_DATA_URL_PATTERN.test(image.src)) return;
          image.src = replacement.src;
          image.naturalWidth = replacement.naturalWidth;
          image.naturalHeight = replacement.naturalHeight;
          image.name = image.name.replace(HEIC_FILE_NAME_PATTERN, '.jpg');
        });
      });
      setStatus(`已把 ${completed.length} 张 HEIC 图片转成 Windows、iPad 都能显示的格式，正在同步工程。`);
    }).finally(() => {
      candidates.forEach((image) => compatibilityRepairInFlightRef.current.delete(image.id));
    });
    return () => { cancelled = true; };
  }, [commit, documentState.images, reportError]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => () => {
    if (gestureRenderFrameRef.current !== null) cancelAnimationFrame(gestureRenderFrameRef.current);
    if (touchNavigationFrameRef.current !== null) cancelAnimationFrame(touchNavigationFrameRef.current);
    if (touchMomentumFrameRef.current !== null) cancelAnimationFrame(touchMomentumFrameRef.current);
    if (wheelZoomFrameRef.current !== null) cancelAnimationFrame(wheelZoomFrameRef.current);
    if (wheelZoomSettleTimerRef.current !== null) window.clearTimeout(wheelZoomSettleTimerRef.current);
    if (viewportPersistTimerRef.current !== null) window.clearTimeout(viewportPersistTimerRef.current);
    pendingWheelZoomRef.current = null;
    writeViewportSnapshot();
  }, [writeViewportSnapshot]);

  useEffect(() => {
    try {
      localStorage.setItem('kaoyan.canvas.penWidth.v1', String(penWidth));
      localStorage.setItem('kaoyan.canvas.highlighterWidth.v1', String(highlighterWidth));
      localStorage.setItem('kaoyan.canvas.textFontSize.v1', String(textFontSize));
    } catch {
      // Tool settings remain usable when private storage is unavailable.
    }
  }, [highlighterWidth, penWidth, textFontSize]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const preventNativeGesture = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.cancelable) event.preventDefault();
    };
    viewport.addEventListener('touchmove', preventNativeGesture, { passive: false });
    viewport.addEventListener('gesturestart', preventNativeGesture, { passive: false });
    viewport.addEventListener('gesturechange', preventNativeGesture, { passive: false });
    viewport.addEventListener('gestureend', preventNativeGesture, { passive: false });
    return () => {
      viewport.removeEventListener('touchmove', preventNativeGesture);
      viewport.removeEventListener('gesturestart', preventNativeGesture);
      viewport.removeEventListener('gesturechange', preventNativeGesture);
      viewport.removeEventListener('gestureend', preventNativeGesture);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('kaoyan.canvas.focusMode.v1', focusMode ? '1' : '0');
    } catch {
      // Focus mode remains available even when storage is unavailable.
    }
    if (!focusMode) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    rootRef.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = previousOverflow; };
  }, [focusMode]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const frame = requestAnimationFrame(() => {
      const savedViewport = documentRef.current.viewport;
      const shouldCenterBlank = !hasDocumentContent(documentRef.current)
        && Math.abs(savedViewport.scrollLeft) < 1
        && Math.abs(savedViewport.scrollTop) < 1;
      viewport.scrollTo({
        left: shouldCenterBlank
          ? Math.max(0, WORLD_WIDTH * savedViewport.zoom / 2 - viewport.clientWidth / 2)
          : savedViewport.scrollLeft || 0,
        top: shouldCenterBlank
          ? Math.max(0, WORLD_HEIGHT * savedViewport.zoom / 2 - viewport.clientHeight / 2)
          : savedViewport.scrollTop || 0,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [documentState.id]);

  const flushDraft = useCallback((notify = true) => {
    if (!storageKey) return;
    if (persistedDraftRevisionRef.current === draftRevisionRef.current) {
      if (notify) onDraftStatus?.('saved');
      return;
    }
    try {
      localStorage.setItem(storageKey, serializeCanvasDocument(documentRef.current));
      persistedDraftRevisionRef.current = draftRevisionRef.current;
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
    const handleBeforeUnload = () => {
      writeViewportSnapshot();
      flushDraft(false);
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      // React unmount is the last chance to persist edits that have not reached
      // the debounce timer yet. localStorage is synchronous by design here.
      writeViewportSnapshot();
      flushDraft(false);
    };
  }, [flushDraft, storageKey, writeViewportSnapshot]);

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const current = gestureRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (current.type === 'ink') {
        if (event.cancelable) event.preventDefault();
        lastPenInputAtRef.current = performance.now();
        const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
        const samples = coalesced.length > 0 ? coalesced : [event];
        const points = current.stroke.points;
        let changed = false;
        samples.forEach((sample) => {
          const point = getInkWorldPoint(sample.clientX, sample.clientY);
          if (!point) return;
          changed = appendSmoothedInkPoint(points, {
            ...point,
            pressure: normalizedPressure(sample.pressure, sample.pointerType || event.pointerType),
          }, zoom) || changed;
        });
        if (changed) {
          const nextStroke = { ...current.stroke, points };
          setActiveGesture({ ...current, stroke: nextStroke });
          const now = performance.now();
          if (onInkStrokePreview && now - lastLiveInkSentAtRef.current >= 95) {
            lastLiveInkSentAtRef.current = now;
            onInkStrokePreview({
              ...nextStroke,
              points: nextStroke.points.map((point) => ({ ...point })),
            });
          }
        }
        return;
      }
      if (current.type === 'erase') {
        if (event.cancelable) event.preventDefault();
        lastPenInputAtRef.current = performance.now();
        const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
        const samples = coalesced.length > 0 ? coalesced : [event];
        const eraserPoints = samples.map((sample) => getWorldPoint(sample.clientX, sample.clientY));
        replaceTransient((draft) => {
          draft.strokes = draft.strokes.filter((stroke) => !eraserPoints.some((point) => strokeTouchesEraser(stroke, point)));
        });
        setActiveGesture({ ...current, current: eraserPoints[eraserPoints.length - 1] ?? current.current });
        return;
      }
      if (current.type === 'viewport-pan') {
        const viewport = viewportRef.current;
        if (!viewport) return;
        if (event.cancelable) event.preventDefault();
        viewport.scrollTo({
          left: current.scrollLeft - (event.clientX - current.startClient.x),
          top: current.scrollTop - (event.clientY - current.startClient.y),
        });
        return;
      }
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
      } else if (current.type === 'arrow') {
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
      if (current.type === 'ink') {
        if (event.cancelable) event.preventDefault();
        lastPenInputAtRef.current = performance.now();
        const points = [...current.stroke.points];
        const finalPoint = getInkWorldPoint(event.clientX, event.clientY);
        if (finalPoint) {
          appendSmoothedInkPoint(points, {
            ...finalPoint,
            pressure: normalizedPressure(event.pressure, event.pointerType),
          }, zoom, true);
        }
        const stroke = { ...current.stroke, points };
        if (stroke.points.length > 0) {
          commit((draft) => { draft.strokes.push(stroke); });
          onInkStrokeCommit?.({ ...stroke, points: stroke.points.map((point) => ({ ...point })) });
          setStatus(`${stroke.tool === 'highlighter' ? '荧光笔' : '钢笔'}笔迹已保存 · ${stroke.points.length} 个压感采样点`);
        }
        return;
      }
      if (current.type === 'erase') {
        if (event.cancelable) event.preventDefault();
        lastPenInputAtRef.current = performance.now();
        finalizeTransient(current.originDocument);
        setStatus('已擦除触碰到的整条笔迹。');
        return;
      }
      if (current.type === 'viewport-pan') {
        const viewport = viewportRef.current;
        if (viewport) commitTouchViewport(viewport);
        setStatus('画布位置已调整。');
        return;
      }
      if (current.type === 'arrow') {
        const sourceRect = getConnectableNodeRect(documentRef.current, current.sourceNode.kind, current.sourceNode.id);
        if (!sourceRect) return;
        const releasePoint = getWorldPoint(event.clientX, event.clientY);
        const sourcePoint = {
          x: sourceRect.x + current.source.x * sourceRect.width,
          y: sourceRect.y + current.source.y * sourceRect.height,
        };
        const screenDistance = Math.hypot(releasePoint.x - sourcePoint.x, releasePoint.y - sourcePoint.y) * zoom;
        const targetNode = getConnectableNodeAtPoint(documentRef.current, releasePoint);
        if (
          !targetNode
          || screenDistance < 10
          || (targetNode.kind === current.sourceNode.kind && targetNode.id === current.sourceNode.id)
        ) {
          setStatus('箭头已取消。请拖到另一个图片、普通文字或批注卡。');
          return;
        }
        const targetRect = getConnectableNodeRect(documentRef.current, targetNode.kind, targetNode.id);
        if (!targetRect) return;
        const targetPoint = normalizedPointInRect(releasePoint, targetRect);
        const sourceAnchorId = createCanvasId('anchor');
        const targetAnchorId = createCanvasId('anchor');
        const relationId = createCanvasId('relation');
        const labelFor = (node: { kind: ConnectableNodeKind; id: string }): string => {
          if (node.kind === 'image') {
            const index = documentRef.current.images.findIndex((item) => item.id === node.id);
            return index >= 0 ? `图 ${imageLetter(index)}` : '图片';
          }
          if (node.kind === 'text') return '文字';
          const annotation = documentRef.current.annotations.find((item) => item.id === node.id);
          return annotation?.kind === 'relation' ? '关系卡' : '批注';
        };
        const makeAnchor = (
          id: string,
          node: { kind: ConnectableNodeKind; id: string },
          point: CanvasPoint,
        ): CanvasAnchor => ({
          id,
          ...(node.kind === 'image' ? { imageId: node.id } : { nodeId: node.id, nodeKind: node.kind }),
          shape: 'point',
          x: point.x,
          y: point.y,
          width: 0,
          height: 0,
          label: labelFor(node),
        });
        commit((draft) => {
          draft.anchors.push(
            makeAnchor(sourceAnchorId, current.sourceNode, current.source),
            makeAnchor(targetAnchorId, targetNode, targetPoint),
          );
          draft.relations.push({
            id: relationId,
            kind: 'arrow',
            fromAnchorId: sourceAnchorId,
            toAnchorId: targetAnchorId,
            relationType: current.relationType,
            ...(current.relationType === CUSTOM_RELATION_TYPE && current.relationLabel?.trim()
              ? { relationLabel: current.relationLabel.trim().slice(0, 80) }
              : {}),
            color: '#a35d30',
            z: nextZ(draft),
          });
        });
        setSelected({ kind: 'relation', id: relationId });
        setStatus(`已创建“${labelFor(current.sourceNode)} → ${labelFor(targetNode)}”箭头。`);
        return;
      }
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
          height: current.annotationKind === 'relation' ? 120 : 96,
          anchorIds: [anchorId],
          relationType,
          ...(relationType === CUSTOM_RELATION_TYPE && customRelationLabel.trim()
            ? { relationLabel: customRelationLabel.trim().slice(0, 80) }
            : {}),
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
      if (current.type === 'ink' || current.type === 'erase') lastPenInputAtRef.current = performance.now();
      cancelActiveGesture('拖动已中止，内容已恢复到操作前。');
    };
    const handleWindowBlur = () => {
      cancelActiveGesture('窗口失去焦点，未完成的拖动已撤销。');
    };
    window.addEventListener('pointermove', handleMove, { passive: false });
    window.addEventListener('pointerup', handleUp, { passive: false });
    window.addEventListener('pointercancel', handleCancel, { passive: false });
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [beginEditing, cancelActiveGesture, commit, customRelationLabel, finalizeTransient, getInkWorldPoint, getWorldPoint, onInkStrokeCommit, onInkStrokePreview, relationType, replaceTransient, setActiveGesture, zoom]);

  const cancelTouchMomentum = () => {
    if (touchMomentumFrameRef.current !== null) {
      cancelAnimationFrame(touchMomentumFrameRef.current);
      touchMomentumFrameRef.current = null;
    }
  };

  const commitTouchViewport = (viewport: HTMLDivElement) => {
    const nextZoom = applyZoomToDom(zoomRef.current);
    documentRef.current.viewport = {
      zoom: nextZoom,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
    setZoomState(nextZoom);
    writeViewportSnapshot();
  };

  const startTouchMomentum = (viewport: HTMLDivElement, velocityX: number, velocityY: number) => {
    cancelTouchMomentum();
    if (Math.hypot(velocityX, velocityY) < 0.035) return;
    let currentVelocityX = clamp(velocityX, -3.2, 3.2);
    let currentVelocityY = clamp(velocityY, -3.2, 3.2);
    let previousAt = performance.now();
    const step = (now: number) => {
      const elapsed = Math.min(34, Math.max(1, now - previousAt));
      previousAt = now;
      const beforeLeft = viewport.scrollLeft;
      const beforeTop = viewport.scrollTop;
      viewport.scrollTo({
        left: beforeLeft + currentVelocityX * elapsed,
        top: beforeTop + currentVelocityY * elapsed,
      });
      const movedX = viewport.scrollLeft - beforeLeft;
      const movedY = viewport.scrollTop - beforeTop;
      if (Math.abs(movedX) < 0.1) currentVelocityX = 0;
      if (Math.abs(movedY) < 0.1) currentVelocityY = 0;
      const decay = Math.pow(0.9, elapsed / 16.67);
      currentVelocityX *= decay;
      currentVelocityY *= decay;
      if (Math.hypot(currentVelocityX, currentVelocityY) < 0.018) {
        touchMomentumFrameRef.current = null;
        commitTouchViewport(viewport);
        return;
      }
      touchMomentumFrameRef.current = requestAnimationFrame(step);
    };
    touchMomentumFrameRef.current = requestAnimationFrame(step);
  };

  const resetTouchNavigation = (viewport: HTMLDivElement, allowInkSingle = false) => {
    const touches = [...touchPointersRef.current.entries()];
    if (touches.length === 0) {
      touchNavigationRef.current = null;
      return;
    }
    if (touches.length === 1) {
      if (!allowInkSingle && (tool === 'pen' || tool === 'highlighter' || tool === 'eraser')) {
        // A single contact while drawing is far more likely to be the palm.
        // Navigation remains available with two fingers, like note apps.
        touchNavigationRef.current = null;
        return;
      }
      const [pointerId, sample] = touches[0];
      touchNavigationRef.current = {
        type: 'pan',
        pointerId,
        start: sample,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
        lastAppliedAt: performance.now(),
        velocityX: 0,
        velocityY: 0,
      };
      return;
    }
    const first = touches[0][1];
    const second = touches[1][1];
    const center = {
      clientX: (first.clientX + second.clientX) / 2,
      clientY: (first.clientY + second.clientY) / 2,
    };
    const rect = viewport.getBoundingClientRect();
    const currentZoom = clamp(zoomRef.current, MIN_ZOOM, MAX_ZOOM);
    touchNavigationRef.current = {
      type: 'pinch',
      startDistance: Math.max(1, Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY)),
      startZoom: currentZoom,
      anchorWorld: {
        x: (viewport.scrollLeft + center.clientX - rect.left) / currentZoom,
        y: (viewport.scrollTop + center.clientY - rect.top) / currentZoom,
      },
      lastAppliedAt: performance.now(),
      velocityX: 0,
      velocityY: 0,
    };
  };

  const applyTouchNavigationFrame = () => {
    touchNavigationFrameRef.current = null;
    const viewport = viewportRef.current;
    const navigation = touchNavigationRef.current;
    if (!viewport || !navigation) return;
    const now = performance.now();
    const beforeLeft = viewport.scrollLeft;
    const beforeTop = viewport.scrollTop;

    if (navigation.type === 'pan') {
      const sample = touchPointersRef.current.get(navigation.pointerId);
      if (!sample) return;
      viewport.scrollTo({
        left: navigation.scrollLeft - (sample.clientX - navigation.start.clientX),
        top: navigation.scrollTop - (sample.clientY - navigation.start.clientY),
      });
    } else {
      const touches = [...touchPointersRef.current.values()];
      if (touches.length < 2) return;
      const first = touches[0];
      const second = touches[1];
      const distance = Math.max(1, Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY));
      const nextZoom = clamp(navigation.startZoom * distance / navigation.startDistance, MIN_ZOOM, MAX_ZOOM);
      const center = {
        clientX: (first.clientX + second.clientX) / 2,
        clientY: (first.clientY + second.clientY) / 2,
      };
      const viewportRect = viewport.getBoundingClientRect();
      applyZoomToDom(nextZoom);
      viewport.scrollTo({
        left: navigation.anchorWorld.x * nextZoom - (center.clientX - viewportRect.left),
        top: navigation.anchorWorld.y * nextZoom - (center.clientY - viewportRect.top),
      });
    }

    const elapsed = Math.max(1, now - navigation.lastAppliedAt);
    const measuredVelocityX = (viewport.scrollLeft - beforeLeft) / elapsed;
    const measuredVelocityY = (viewport.scrollTop - beforeTop) / elapsed;
    navigation.velocityX = navigation.velocityX * 0.58 + measuredVelocityX * 0.42;
    navigation.velocityY = navigation.velocityY * 0.58 + measuredVelocityY * 0.42;
    navigation.lastAppliedAt = now;
  };

  const scheduleTouchNavigationFrame = () => {
    if (touchNavigationFrameRef.current !== null) return;
    touchNavigationFrameRef.current = requestAnimationFrame(applyTouchNavigationFrame);
  };

  const flushTouchNavigationFrame = () => {
    if (touchNavigationFrameRef.current !== null) cancelAnimationFrame(touchNavigationFrameRef.current);
    touchNavigationFrameRef.current = null;
    applyTouchNavigationFrame();
  };

  const handleCanvasPointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const insideViewport = event.clientX >= rect.left
      && event.clientX <= rect.right
      && event.clientY >= rect.top
      && event.clientY <= rect.bottom;
    if (!insideViewport) return;

    if (
      event.pointerType !== 'touch'
      && (event.button === 1 || (event.button === 0 && spacePressedRef.current))
      && !gestureRef.current
    ) {
      event.preventDefault();
      event.stopPropagation();
      cancelTouchMomentum();
      rootRef.current?.focus({ preventScroll: true });
      setActiveGesture({
        type: 'viewport-pan',
        pointerId: event.pointerId,
        startClient: { x: event.clientX, y: event.clientY },
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
      });
      setStatus('正在拖动画布…');
      return;
    }

    if (event.pointerType === 'touch') {
      cancelTouchMomentum();
      const penActive = gestureRef.current?.type === 'ink' || gestureRef.current?.type === 'erase';
      const recentPenInput = performance.now() - lastPenInputAtRef.current < PALM_REJECTION_MS;
      const target = event.target instanceof Element ? event.target : null;
      if (!penActive && !recentPenInput && target?.closest('button, input, textarea, select, [contenteditable="true"], .cw-node-actions, .cw-directory, .cw-resize-handle')) return;
      event.preventDefault();
      event.stopPropagation();
      suppressedTouchIdsRef.current.add(event.pointerId);
      try { viewport.setPointerCapture(event.pointerId); } catch { /* Safari may already own capture. */ }
      if (penActive) return;
      touchPointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      resetTouchNavigation(viewport);
      return;
    }

    const isStylus = event.pointerType === 'pen';
    const selectedInkTool = tool === 'pen' || tool === 'highlighter' || tool === 'eraser';
    if (isStylus) lastPenInputAtRef.current = performance.now();
    if (!selectedInkTool || event.button !== 0 || gestureRef.current) return;

    event.preventDefault();
    event.stopPropagation();
    cancelTouchMomentum();
    rootRef.current?.focus({ preventScroll: true });
    try { viewport.setPointerCapture(event.pointerId); } catch { /* Window listeners keep the stroke alive. */ }
    touchPointersRef.current.clear();
    touchNavigationRef.current = null;
    lastPenInputAtRef.current = performance.now();
    const point = getWorldPoint(event.clientX, event.clientY);
    const originDocument = cloneCanvasDocumentForEditing(documentRef.current);
    if (tool === 'eraser') {
      setActiveGesture({ type: 'erase', pointerId: event.pointerId, current: point, originDocument });
      replaceTransient((draft) => {
        draft.strokes = draft.strokes.filter((stroke) => !strokeTouchesEraser(stroke, point));
      });
      setStatus('笔划橡皮擦：触碰一条笔迹即可整条擦除。');
      return;
    }

    const inkTool: CanvasInkTool = tool === 'pen' || tool === 'highlighter' ? tool : lastInkTool;
    const stroke: CanvasInkStroke = {
      id: createCanvasId('stroke'),
      kind: 'ink',
      tool: inkTool,
      points: [{ ...point, pressure: normalizedPressure(event.pressure, event.pointerType) }],
      color: inkTool === 'highlighter' ? highlighterColor : penColor,
      width: inkTool === 'highlighter' ? highlighterWidth : penWidth,
      opacity: inkTool === 'highlighter' ? 0.34 : 0.98,
      z: nextZ(documentRef.current),
    };
    lastLiveInkSentAtRef.current = 0;
    setActiveGesture({ type: 'ink', pointerId: event.pointerId, stroke, originDocument });
    setStatus(isStylus ? 'Apple Pencil 书写中 · 已启用压感与掌触抑制' : `${inkTool === 'highlighter' ? '荧光笔' : '钢笔'}书写中`);
  };

  const handleCanvasPointerMoveCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' || !suppressedTouchIdsRef.current.has(event.pointerId)) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    event.preventDefault();
    event.stopPropagation();
    if (!touchPointersRef.current.has(event.pointerId)) return;
    touchPointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    const touches = [...touchPointersRef.current.values()];
    if (touches.length >= 2) {
      if (touchNavigationRef.current?.type !== 'pinch') {
        resetTouchNavigation(viewport);
      }
      scheduleTouchNavigationFrame();
      return;
    }
    if (touchNavigationRef.current?.type === 'pan') {
      scheduleTouchNavigationFrame();
    }
  };

  const finishTouchPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' || !suppressedTouchIdsRef.current.has(event.pointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    const wasNavigationPointer = touchPointersRef.current.has(event.pointerId);
    if (wasNavigationPointer) {
      touchPointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      flushTouchNavigationFrame();
    }
    const completedNavigation = touchNavigationRef.current;
    suppressedTouchIdsRef.current.delete(event.pointerId);
    touchPointersRef.current.delete(event.pointerId);
    if (!wasNavigationPointer) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (touchPointersRef.current.size === 0) {
      touchNavigationRef.current = null;
      commitTouchViewport(viewport);
      if (completedNavigation?.type === 'pan') {
        startTouchMomentum(viewport, completedNavigation.velocityX, completedNavigation.velocityY);
      }
      return;
    }
    resetTouchNavigation(viewport, completedNavigation?.type === 'pinch');
  };

  const handleLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') {
      if (!suppressedTouchIdsRef.current.has(event.pointerId) && !touchPointersRef.current.has(event.pointerId)) return;
      suppressedTouchIdsRef.current.delete(event.pointerId);
      touchPointersRef.current.delete(event.pointerId);
      const viewport = viewportRef.current;
      if (viewport) {
        if (touchPointersRef.current.size === 0) {
          touchNavigationRef.current = null;
          commitTouchViewport(viewport);
        } else {
          resetTouchNavigation(viewport, true);
        }
      }
      return;
    }
    if (gestureRef.current?.pointerId === event.pointerId) {
      cancelActiveGesture('输入中断，未完成的笔迹已撤销。');
    }
  };

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
      originDocument: cloneCanvasDocumentForEditing(documentRef.current),
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
      originDocument: cloneCanvasDocumentForEditing(documentRef.current),
    });
  };

  const beginArrowFromNode = (
    event: ReactPointerEvent,
    sourceNode: { kind: ConnectableNodeKind; id: string },
  ): boolean => {
    if (tool !== 'arrow' || event.button !== 0) return false;
    const sourceRect = getConnectableNodeRect(documentRef.current, sourceNode.kind, sourceNode.id);
    if (!sourceRect) return false;
    event.preventDefault();
    event.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    const point = getWorldPoint(event.clientX, event.clientY);
    setActiveGesture({
      type: 'arrow',
      pointerId: event.pointerId,
      sourceNode,
      source: normalizedPointInRect(point, sourceRect),
      current: point,
      relationType,
      ...(relationType === CUSTOM_RELATION_TYPE && customRelationLabel.trim()
        ? { relationLabel: customRelationLabel.trim().slice(0, 80) }
        : {}),
    });
    setStatus('继续拖到图片、普通文字或批注卡，松开后生成箭头。');
    return true;
  };

  const beginImageInteraction = (event: ReactPointerEvent, image: CanvasImageNode) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    if (beginArrowFromNode(event, { kind: 'image', id: image.id })) return;
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
    else if (tool === 'arrow') setStatus('请从图片、普通文字或批注卡上按住，再拖到另一对象。');
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

  const applyPendingWheelZoom = useCallback(() => {
  wheelZoomFrameRef.current = null;
  const pending = pendingWheelZoomRef.current;
  pendingWheelZoomRef.current = null;
  const viewport = viewportRef.current;
  if (!pending || !viewport) return;
  const nextZoom = applyZoomToDom(pending.zoom);
  const maxLeft = Math.max(0, WORLD_WIDTH * nextZoom - viewport.clientWidth);
  const maxTop = Math.max(0, WORLD_HEIGHT * nextZoom - viewport.clientHeight);
  viewport.scrollTo({
    left: clamp(pending.anchorWorld.x * nextZoom - pending.pointerX, 0, maxLeft),
    top: clamp(pending.anchorWorld.y * nextZoom - pending.pointerY, 0, maxTop),
  });
  documentRef.current.viewport.scrollLeft = viewport.scrollLeft;
  documentRef.current.viewport.scrollTop = viewport.scrollTop;
}, [applyZoomToDom]);

const settleWheelZoom = useCallback(() => {
  if (wheelZoomFrameRef.current !== null) {
    cancelAnimationFrame(wheelZoomFrameRef.current);
    wheelZoomFrameRef.current = null;
  }
  if (pendingWheelZoomRef.current) applyPendingWheelZoom();
  const viewport = viewportRef.current;
  if (!viewport) return;
  const settledZoom = clamp(zoomRef.current, MIN_ZOOM, MAX_ZOOM);
  setZoomState(settledZoom);
  writeViewportSnapshot();
  setStatus(`画布缩放 ${Math.round(settledZoom * 100)}% · 已阻止浏览器页面缩放`);
}, [applyPendingWheelZoom, writeViewportSnapshot]);

const handleViewportWheel = useCallback((event: WheelEvent) => {
  const viewport = viewportRef.current;
  if (!viewport) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('textarea, input, select, .cw-directory')) return;
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    event.stopPropagation();
    const rect = viewport.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const renderedZoom = clamp(zoomRef.current, MIN_ZOOM, MAX_ZOOM);
    const baseZoom = pendingWheelZoomRef.current?.zoom ?? renderedZoom;
    const nextZoom = clamp(baseZoom * Math.exp(-event.deltaY * 0.0018), MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(nextZoom - baseZoom) < 0.0001) return;
    pendingWheelZoomRef.current = {
      zoom: nextZoom,
      anchorWorld: {
        x: (viewport.scrollLeft + pointerX) / renderedZoom,
        y: (viewport.scrollTop + pointerY) / renderedZoom,
      },
      pointerX,
      pointerY,
    };
    if (wheelZoomFrameRef.current === null) {
      wheelZoomFrameRef.current = requestAnimationFrame(applyPendingWheelZoom);
    }
    if (wheelZoomSettleTimerRef.current !== null) {
      window.clearTimeout(wheelZoomSettleTimerRef.current);
    }
    wheelZoomSettleTimerRef.current = window.setTimeout(() => {
      wheelZoomSettleTimerRef.current = null;
      settleWheelZoom();
    }, WHEEL_ZOOM_SETTLE_MS);
    return;
  }
  if (pendingWheelZoomRef.current || wheelZoomFrameRef.current !== null) {
    if (wheelZoomSettleTimerRef.current !== null) {
      window.clearTimeout(wheelZoomSettleTimerRef.current);
      wheelZoomSettleTimerRef.current = null;
    }
    settleWheelZoom();
  }
  event.preventDefault();
  const horizontal = event.shiftKey ? event.deltaY : event.deltaX;
  const vertical = event.shiftKey ? 0 : event.deltaY;
  viewport.scrollBy({ left: horizontal, top: vertical });
  documentRef.current.viewport.scrollLeft = viewport.scrollLeft;
  documentRef.current.viewport.scrollTop = viewport.scrollTop;
  scheduleViewportPersistence();
}, [applyPendingWheelZoom, scheduleViewportPersistence, settleWheelZoom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    viewport.addEventListener('wheel', handleViewportWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleViewportWheel);
  }, [handleViewportWheel]);

  useEffect(() => {
    const releaseSpace = (event: globalThis.KeyboardEvent) => {
      if (event.code === 'Space') spacePressedRef.current = false;
    };
    const releaseAll = () => { spacePressedRef.current = false; };
    window.addEventListener('keyup', releaseSpace);
    window.addEventListener('blur', releaseAll);
    return () => {
      window.removeEventListener('keyup', releaseSpace);
      window.removeEventListener('blur', releaseAll);
    };
  }, []);

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
    if (next === 'pen' || next === 'highlighter') setLastInkTool(next);
    setTool(next);
    const messages: Record<CanvasTool, string> = {
      select: '选择模式：空白处拖框可多选；拖动所选内容可整组移动，右下角可调大小。',
      pen: '钢笔：Apple Pencil 与鼠标可书写；书写时双指移动或缩放。',
      highlighter: '荧光笔：半透明标记会保留纸面与图片细节。',
      eraser: '笔划橡皮擦：触碰一条笔迹即可整条擦除。',
      text: '自由文字：点击画布任意位置放置文字卡。',
      annotation: '批注模式：在图片上点击定位，或拖框圈出区域。',
      relation: '关系模式：先放关系卡或指向图片，再连续关联多个位置。',
      arrow: '箭头模式：从图片、普通文字或批注卡按住，拖到任意另一对象。',
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
    if (event.code === 'Space') {
      event.preventDefault();
      spacePressedRef.current = true;
      setStatus('按住空格拖动画布；松开后恢复当前工具。');
      return;
    }
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
    else if (key === 'p') chooseTool('pen');
    else if (key === 'h') chooseTool('highlighter');
    else if (key === 'e') chooseTool('eraser');
    else if (key === 't') chooseTool('text');
    else if (key === 'a') chooseTool('annotation');
    else if (key === 'r') chooseTool('relation');
    else if (key === 'd') chooseTool('arrow');
    else if (key === 'i') imageInputRef.current?.click();
    else if (key === '0') fitToContent();
    else if (event.key === '?') setHelpOpen(true);
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.code !== 'Space') return;
    spacePressedRef.current = false;
    if (gestureRef.current?.type !== 'viewport-pan') setStatus('已退出画布拖动。');
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
  const plainAnnotationNumberById = useMemo(() => {
    const numbers = new Map<string, number>();
    let count = 0;
    documentState.annotations.forEach((annotation) => {
      if (annotation.kind !== 'annotation') return;
      count += 1;
      numbers.set(annotation.id, count);
    });
    return numbers;
  }, [documentState.annotations]);
  const plainAnnotationsByAnchorId = useMemo(() => {
    const links = new Map<string, Array<{ id: string; number: number; text: string }>>();
    documentState.annotations.forEach((annotation) => {
      if (annotation.kind !== 'annotation') return;
      const number = plainAnnotationNumberById.get(annotation.id) ?? 1;
      annotation.anchorIds.forEach((anchorId) => {
        const entries = links.get(anchorId) ?? [];
        entries.push({ id: annotation.id, number, text: annotation.text });
        links.set(anchorId, entries);
      });
    });
    return links;
  }, [documentState.annotations, plainAnnotationNumberById]);
  const selectionKeys = useMemo(() => new Set(selection.map(selectionNodeKey)), [selection]);
  const selectedAnnotation = selected?.kind === 'annotation'
    ? documentState.annotations.find((item) => item.id === selected.id)
    : null;
  const selectedRelationCard = selectedAnnotation?.kind === 'relation' ? selectedAnnotation : null;
  const selectedArrow = selected?.kind === 'relation'
    ? documentState.relations.find((item) => item.id === selected.id)
    : null;
  const activeRelation = selectedArrow ?? selectedRelationCard;
  const activeRelationType = activeRelation?.relationType ?? relationType;
  const activeRelationSelectValue = isPresetRelationType(activeRelationType)
    ? activeRelationType
    : CUSTOM_RELATION_TYPE;
  const activeCustomRelationLabel = activeRelation
    ? relationEditorValue(activeRelation)
    : customRelationLabel;
  const selectedText = selected?.kind === 'text'
    ? documentState.texts.find((item) => item.id === selected.id)
    : null;
  const activeTextSize = selectedText?.fontSize ?? textFontSize;
  const updateTextSize = (requested: number) => {
    const next = TEXT_SIZES.reduce((closest, size) => (
      Math.abs(size - requested) < Math.abs(closest - requested) ? size : closest
    ), TEXT_SIZES[0]);
    setTextFontSize(next);
    if (!selectedText) return;
    commit((draft) => {
      const item = draft.texts.find((entry) => entry.id === selectedText.id);
      if (!item) return;
      item.fontSize = next;
      item.height = Math.max(item.height ?? 56, Math.round(next * 2.8));
    });
  };
  const stepTextSize = (direction: -1 | 1) => {
    const index = TEXT_SIZES.findIndex((size) => size === activeTextSize);
    updateTextSize(TEXT_SIZES[clamp(index + direction, 0, TEXT_SIZES.length - 1)]);
  };

  const connectionPaths = useMemo(() => documentState.annotations.flatMap((annotation) => {
    const cardHeight = getCardHeight(annotation);
    const annotationRect = { x: annotation.x, y: annotation.y, width: annotation.width, height: cardHeight };
    return annotation.anchorIds.flatMap((anchorId) => {
      const anchor = documentState.anchors.find((item) => item.id === anchorId);
      if (!anchor) return [];
      const rect = getAnchorBoardRect(documentState, anchor);
      if (!rect) return [];
      const endX = rect.x + rect.width / 2;
      const endY = rect.y + rect.height / 2;
      const origin = annotation.kind === 'annotation'
        ? rectEdgeToward(annotationRect, { x: endX, y: endY })
        : rectCenter(annotationRect);
      const startX = origin.x;
      const startY = origin.y;
      const middleX = (startX + endX) / 2;
      return [{
        id: `${annotation.id}:${anchor.id}`,
        annotationId: annotation.id,
        d: `M ${startX} ${startY} C ${middleX} ${startY}, ${middleX} ${endY}, ${endX} ${endY}`,
        relation: annotation.kind === 'relation',
        startX,
        startY,
      }];
    });
  }), [documentState]);

  const arrowPaths = useMemo(() => documentState.relations.flatMap((relation) => {
    const geometry = getArrowGeometry(documentState, relation);
    return geometry ? [{ relation, geometry }] : [];
  }), [documentState]);

  const draftArrowGeometry = useMemo(() => {
    if (gesture?.type !== 'arrow') return null;
    const sourceRect = getConnectableNodeRect(documentState, gesture.sourceNode.kind, gesture.sourceNode.id);
    if (!sourceRect) return null;
    const start = {
      x: sourceRect.x + gesture.source.x * sourceRect.width,
      y: sourceRect.y + gesture.source.y * sourceRect.height,
    };
    return makeArrowGeometry(
      { ...start, width: 0, height: 0 },
      { ...gesture.current, width: 0, height: 0 },
    );
  }, [documentState, gesture]);

  const visibleInkStrokes = useMemo(() => {
    const strokes = new Map(documentState.strokes.map((stroke) => [stroke.id, stroke]));
    remoteInkPreviews.forEach((stroke) => {
      if (!strokes.has(stroke.id)) strokes.set(stroke.id, stroke);
    });
    if (gesture?.type === 'ink') strokes.set(gesture.stroke.id, gesture.stroke);
    return [...strokes.values()].sort((left, right) => left.z - right.z);
  }, [documentState.strokes, gesture, remoteInkPreviews]);

  const selectArrow = (event: ReactPointerEvent<SVGPathElement>, id: string) => {
    if (event.button !== 0 || tool !== 'select') return;
    event.preventDefault();
    event.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    const node = { kind: 'relation' as const, id };
    if (!event.shiftKey) {
      setSelection([node]);
      setStatus('已选中箭头；可修改关系类型，或按 Delete 删除。');
      return;
    }
    const key = selectionNodeKey(node);
    const alreadySelected = selection.some((item) => selectionNodeKey(item) === key);
    const nextSelection = alreadySelected
      ? selection.filter((item) => selectionNodeKey(item) !== key)
      : [...selection, node];
    setSelection(nextSelection);
    setStatus(nextSelection.length > 0 ? `已选择 ${nextSelection.length} 项。` : '已取消选择。');
  };

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
      className={`canvas-workspace ${linkingAnnotationId ? 'has-linking-banner' : ''} ${focusMode ? 'is-focus-mode' : ''} ${gesture?.type === 'viewport-pan' ? 'is-panning' : ''} ${tool === 'pen' || tool === 'highlighter' || tool === 'eraser' ? 'is-inking' : ''} ${className}`.trim()}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onPaste={handlePaste}
      onPointerDownCapture={handleCanvasPointerDownCapture}
      onPointerMoveCapture={handleCanvasPointerMoveCapture}
      onPointerUpCapture={finishTouchPointer}
      onPointerCancelCapture={finishTouchPointer}
      onLostPointerCapture={handleLostPointerCapture}
      onContextMenu={(event) => {
        if (event.target instanceof Element && event.target.closest('.cw-viewport')) event.preventDefault();
      }}
      aria-label="图片关联笔记画布"
    >
      <input
        ref={imageInputRef}
        className="cw-hidden-input"
        type="file"
        accept="image/*,.heic,.heif"
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
          <button className={tool === 'pen' ? 'active' : ''} onClick={() => chooseTool('pen')} title="钢笔（P）"><PenLine size={18} /><span>钢笔</span></button>
          <button className={tool === 'eraser' ? 'active' : ''} onClick={() => chooseTool('eraser')} title="笔划橡皮擦（E）"><Eraser size={18} /><span>橡皮</span></button>
          <button className={tool === 'highlighter' ? 'active' : ''} onClick={() => chooseTool('highlighter')} title="荧光笔（H）"><Highlighter size={18} /><span>荧光笔</span></button>
          <button className={tool === 'text' ? 'active' : ''} onClick={() => chooseTool('text')} title="自由文字（T）"><Type size={17} /><span>文字</span></button>
          <button className={tool === 'annotation' ? 'active' : ''} onClick={() => chooseTool('annotation')} title="精确批注（A）"><MessageSquareText size={17} /><span>批注</span></button>
          <button className={tool === 'relation' ? 'active' : ''} onClick={() => chooseTool('relation')} title="多图关系（R）"><Link2 size={17} /><span>关系</span></button>
          <button className={tool === 'arrow' ? 'active' : ''} onClick={() => chooseTool('arrow')} title="在图片、文字、批注之间画箭头（D）"><ArrowRight size={17} /><span>箭头</span></button>
          {(tool === 'relation' || tool === 'arrow' || selectedRelationCard || selectedArrow) && (
            <>
            <select
              className="cw-relation-type-select"
              value={activeRelationSelectValue}
              aria-label="关系类型"
              onChange={(event) => {
                const next = event.target.value as CanvasRelationType;
                setRelationType(next);
                if (next !== CUSTOM_RELATION_TYPE) setCustomRelationLabel('');
                if (selectedRelationCard) {
                  commit((draft) => {
                    const item = draft.annotations.find((entry) => entry.id === selectedRelationCard.id);
                    if (item?.kind === 'relation') {
                      item.relationType = next;
                      if (next !== CUSTOM_RELATION_TYPE) delete item.relationLabel;
                    }
                  });
                } else if (selectedArrow) {
                  commit((draft) => {
                    const item = draft.relations.find((entry) => entry.id === selectedArrow.id);
                    if (item) {
                      item.relationType = next;
                      if (next !== CUSTOM_RELATION_TYPE) delete item.relationLabel;
                    }
                  });
                }
              }}
            >
              {CANVAS_RELATION_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            {activeRelationSelectValue === CUSTOM_RELATION_TYPE && (
              <input
                className="cw-relation-type-input"
                maxLength={80}
                value={activeCustomRelationLabel}
                aria-label="自定义关系描述"
                placeholder="输入箭头说明"
                onChange={(event) => {
                  const next = event.target.value.slice(0, 80);
                  setCustomRelationLabel(next);
                  if (selectedRelationCard) {
                    replaceTransient((draft) => {
                      const item = draft.annotations.find((entry) => entry.id === selectedRelationCard.id);
                      if (item?.kind === 'relation') {
                        item.relationType = CUSTOM_RELATION_TYPE;
                        item.relationLabel = next;
                      }
                    }, true);
                  } else if (selectedArrow) {
                    replaceTransient((draft) => {
                      const item = draft.relations.find((entry) => entry.id === selectedArrow.id);
                      if (item) {
                        item.relationType = CUSTOM_RELATION_TYPE;
                        item.relationLabel = next;
                      }
                    }, true);
                  }
                }}
              />
            )}
            </>
          )}
        </div>

        {(tool === 'pen' || tool === 'highlighter') && (
          <div className="cw-ink-settings" aria-label={`${tool === 'pen' ? '钢笔' : '荧光笔'}设置`}>
            <div className="cw-ink-colors" role="group" aria-label="颜色">
              {(tool === 'pen' ? INK_COLORS : HIGHLIGHTER_COLORS).map((color) => {
                const selectedColor = tool === 'pen' ? penColor : highlighterColor;
                return (
                  <button
                    key={color}
                    type="button"
                    className={`cw-ink-color ${selectedColor === color ? 'active' : ''}`}
                    style={{ '--cw-ink-color': color } as CSSProperties}
                    aria-label={`选择颜色 ${color}`}
                    aria-pressed={selectedColor === color}
                    onClick={() => tool === 'pen' ? setPenColor(color) : setHighlighterColor(color)}
                  />
                );
              })}
            </div>
            <div className="cw-ink-widths" role="group" aria-label="笔迹粗细">
              {(tool === 'pen' ? PEN_WIDTHS : HIGHLIGHTER_WIDTHS).map((width) => {
                const selectedWidth = tool === 'pen' ? penWidth : highlighterWidth;
                return (
                  <button
                    key={width}
                    type="button"
                    className={selectedWidth === width ? 'active' : ''}
                    aria-label={`笔宽 ${width}`}
                    aria-pressed={selectedWidth === width}
                    onClick={() => tool === 'pen' ? setPenWidth(width) : setHighlighterWidth(width)}
                  >
                    <span style={{ width: Math.min(18, 5 + width * 0.32), height: Math.min(18, 5 + width * 0.32) }} />
                    <b>{width}</b>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {(tool === 'text' || selectedText) && (
          <div className="cw-text-settings" role="group" aria-label="文字字号">
            <button type="button" aria-label="减小字号" onClick={() => stepTextSize(-1)}>A−</button>
            <select
              aria-label="文字字号"
              value={activeTextSize}
              onChange={(event) => updateTextSize(Number(event.target.value))}
            >
              {TEXT_SIZES.map((size) => <option key={size} value={size}>{size} pt</option>)}
            </select>
            <button type="button" aria-label="增大字号" onClick={() => stepTextSize(1)}>A+</button>
          </div>
        )}

        <div className="cw-tool-group cw-tool-group-secondary">
          <button className="cw-focus-button" onClick={toggleFocusMode} title={focusMode ? '退出专注画布' : '放大为专注画布'}>
            {focusMode ? <Minimize2 size={17} /> : <Maximize2 size={17} />}<span>{focusMode ? '退出专注' : '专注'}</span>
          </button>
          <button onClick={() => imageInputRef.current?.click()} title="添加图片（I）"><ImagePlus size={17} /><span>图片</span></button>
          <button onClick={undo} disabled={past.length === 0} title="撤销（Ctrl+Z）"><Undo2 size={17} /></button>
          <button onClick={redo} disabled={future.length === 0} title="重做（Ctrl+Shift+Z）"><Redo2 size={17} /></button>
          <button className="cw-delete-selection" onClick={deleteSelected} disabled={selection.length === 0} title="删除所选内容"><Trash2 size={17} /><span>删除</span></button>
          <button onClick={() => setZoom(zoom - 0.1)} title="缩小"><ZoomOut size={17} /></button>
          <span ref={zoomValueRef} className="cw-zoom-value">{Math.round(zoom * 100)}%</span>
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
            scheduleViewportPersistence();
          }}
        >
          <div ref={worldSpacerRef} className="cw-world-spacer" style={{ width: WORLD_WIDTH * zoom, height: WORLD_HEIGHT * zoom }}>
            <div
              ref={worldRef}
              className="cw-world"
              style={{ width: WORLD_WIDTH, height: WORLD_HEIGHT, transform: `scale(${zoom})` }}
              onPointerDown={handleWorldPointerDown}
            >
              <svg className="cw-connections" width={WORLD_WIDTH} height={WORLD_HEIGHT} aria-hidden="true">
                {connectionPaths.map((path) => {
                  const active = selectionKeys.has(`annotation:${path.annotationId}`);
                  return (
                    <g key={path.id}>
                      <path
                        d={path.d}
                        className={`${path.relation ? 'relation' : ''} ${active ? 'active' : ''}`.trim()}
                      />
                      {!path.relation && (
                        <circle
                          className={`cw-connection-origin ${active ? 'active' : ''}`.trim()}
                          cx={path.startX}
                          cy={path.startY}
                          r={3.5}
                        />
                      )}
                    </g>
                  );
                })}
              </svg>

              <svg className="cw-arrow-connections" width={WORLD_WIDTH} height={WORLD_HEIGHT} aria-hidden="true">
                <defs>
                  <marker id={arrowMarkerId} viewBox="0 0 12 12" refX="10.5" refY="6" markerWidth="4" markerHeight="4" orient="auto" markerUnits="strokeWidth">
                    <path d="M 0 1 L 11 6 L 0 11 L 3.5 6 Z" />
                  </marker>
                </defs>
                {arrowPaths.map(({ relation, geometry }) => {
                  const active = selectionKeys.has(`relation:${relation.id}`);
                  return (
                    <g
                      key={relation.id}
                      className={active ? 'active' : ''}
                      style={{ '--arrow-color': relation.color || '#a35d30' } as CSSProperties}
                    >
                      <path className="cw-arrow-outline" d={geometry.d} />
                      <path className="cw-arrow-line" d={geometry.d} markerEnd={`url(#${arrowMarkerId})`} />
                      <text className="cw-arrow-label" x={geometry.label.x} y={geometry.label.y - 8} textAnchor="middle">{relationDisplayLabel(relation)}</text>
                      {tool === 'select' && (
                        <path
                          className="cw-arrow-hit"
                          d={geometry.d}
                          onPointerDown={(event) => selectArrow(event, relation.id)}
                        />
                      )}
                    </g>
                  );
                })}
                {draftArrowGeometry && (
                  <path
                    className="cw-arrow-line draft"
                    d={draftArrowGeometry.d}
                    markerEnd={`url(#${arrowMarkerId})`}
                  />
                )}
              </svg>

              <svg className="cw-ink-layer" width={WORLD_WIDTH} height={WORLD_HEIGHT} aria-hidden="true">
                {visibleInkStrokes.map((stroke) => <InkStrokeShape key={stroke.id} stroke={stroke} />)}
                {gesture?.type === 'erase' && (
                  <circle className="cw-eraser-cursor" cx={gesture.current.x} cy={gesture.current.y} r={ERASER_RADIUS} />
                )}
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
                    {documentState.anchors.filter((anchor) => anchor.imageId === image.id).map((anchor) => {
                      const linkedAnnotations = plainAnnotationsByAnchorId.get(anchor.id) ?? [];
                      const selectedLinkedAnnotation = linkedAnnotations.some((item) => selectionKeys.has(`annotation:${item.id}`));
                      const markerLabel = linkedAnnotations.length > 0
                        ? linkedAnnotations.map((item) => item.number).join('/')
                        : anchor.label;
                      const markerTitle = linkedAnnotations.length > 0
                        ? linkedAnnotations.map((item) => `批注 ${item.number}${item.text ? `：${item.text}` : ''}`).join('\n')
                        : anchor.label;
                      return (
                        <span
                          key={anchor.id}
                          className={`cw-anchor cw-anchor-${anchor.shape} ${linkedAnnotations.length > 0 ? 'cw-anchor-linked' : ''} ${selectedLinkedAnnotation ? 'active' : ''}`.trim()}
                          style={anchor.shape === 'rect'
                            ? { left: anchor.x * image.width, top: anchor.y * image.height, width: anchor.width * image.width, height: anchor.height * image.height }
                            : { left: anchor.x * image.width, top: anchor.y * image.height }}
                          title={markerTitle}
                          onPointerDown={(event) => {
                            if (tool !== 'select' || linkedAnnotations.length === 0) return;
                            event.preventDefault();
                            event.stopPropagation();
                            setSelected({ kind: 'annotation', id: linkedAnnotations[0].id });
                            setStatus(`已定位到批注 ${linkedAnnotations[0].number}。`);
                          }}
                        >
                          <b>{markerLabel}</b>
                        </span>
                      );
                    })}
                    {draftStyle && <span className="cw-anchor-draft" style={draftStyle} />}
                    {isPrimary && tool === 'select' && (
                      <div className="cw-node-actions cw-image-actions">
                        <button
                          type="button"
                          aria-label="删除这张图片"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={deleteSelected}
                          title="删除图片"
                        ><Trash2 size={14} /></button>
                      </div>
                    )}
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
                            originDocument: cloneCanvasDocumentForEditing(documentRef.current),
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
                    onPointerDown={(event) => {
                      if (!beginArrowFromNode(event, { kind: 'text', id: textNode.id })) {
                        beginNodeMove(event, 'text', textNode.id, textNode.x, textNode.y);
                      }
                    }}
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
                        }, true)}
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
                const annotationNumber = plainAnnotationNumberById.get(annotation.id) ?? 1;
                return (
                  <div
                    key={annotation.id}
                    className={`cw-annotation-node ${annotation.kind === 'relation' ? 'relation' : 'plain'} ${isSelected ? 'selected' : ''} ${linked ? 'linking' : ''}`.trim()}
                    style={{ left: annotation.x, top: annotation.y, width: annotation.width, height: annotationHeight, zIndex: annotation.z, '--annotation-color': annotation.color } as CSSProperties}
                    onPointerDown={(event) => {
                      if (!beginArrowFromNode(event, { kind: 'annotation', id: annotation.id })) {
                        beginNodeMove(event, 'annotation', annotation.id, annotation.x, annotation.y);
                      }
                    }}
                    onDoubleClick={(event) => { event.stopPropagation(); setSelected({ kind: 'annotation', id: annotation.id }); beginEditing({ kind: 'annotation', id: annotation.id }); }}
                  >
                    <header>
                      <span>{annotation.kind === 'relation' ? relationDisplayLabel(annotation) : `批注 ${annotationNumber}`}</span>
                      {annotation.kind === 'relation' && <small>{annotation.anchorIds.length} 个指向</small>}
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
                        }, true)}
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
                        aria-label={annotation.kind === 'relation' ? '自由缩放关系卡' : '调整批注文字范围'}
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
              {documentState.annotations.length === 0 && documentState.relations.length === 0 ? (
                <div className="cw-directory-empty">还没有批注。按 A 后点击图片试试。</div>
              ) : (
                <>
                  {documentState.annotations.map((annotation) => (
                    <button
                      key={annotation.id}
                      className={selectionKeys.has(`annotation:${annotation.id}`) ? 'active' : ''}
                      onClick={() => focusNode({ kind: 'annotation', id: annotation.id })}
                    >
                      <b>{annotation.kind === 'relation' ? relationDisplayLabel(annotation) : `批注 ${plainAnnotationNumberById.get(annotation.id) ?? 1}`}</b>
                      <span>{annotation.text || '未填写说明'}</span>
                      <small>{annotation.anchorIds.map((id) => documentState.anchors.find((item) => item.id === id)?.label).filter(Boolean).join('、') || '尚未指向'}</small>
                    </button>
                  ))}
                  {documentState.relations.map((relation) => {
                    const sourceLabel = documentState.anchors.find((item) => item.id === relation.fromAnchorId)?.label ?? '起点';
                    const targetLabel = documentState.anchors.find((item) => item.id === relation.toAnchorId)?.label ?? '终点';
                    return (
                      <button
                        key={relation.id}
                        className={selectionKeys.has(`relation:${relation.id}`) ? 'active' : ''}
                        onClick={() => focusNode({ kind: 'relation', id: relation.id })}
                      >
                        <b>{relationDisplayLabel(relation)}</b>
                        <span>{sourceLabel} → {targetLabel}</span>
                        <small>箭头</small>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </aside>
      </div>

      <footer className="cw-statusbar">
        <span>{status}</span>
        <span>{selection.length > 1 ? `已选 ${selection.length} 项 · ` : ''}{visibleInkStrokes.length} 笔迹 · {documentState.images.length} 图 · {documentState.annotations.length} 批注/关系 · {documentState.relations.length} 箭头 · {documentState.texts.length} 文字</span>
      </footer>

      {documentState.images.length === 0 && documentState.texts.length === 0 && documentState.annotations.length === 0 && documentState.relations.length === 0 && visibleInkStrokes.length === 0 && (
        <button className="cw-empty-state" onClick={() => imageInputRef.current?.click()}>
          <PenLine size={38} />
          <strong>Apple Pencil 直接落笔</strong>
          <span>钢笔模式下双指移动/缩放；切换文字、批注等工具可精确操作</span>
        </button>
      )}

      {helpOpen && (
        <div className="cw-help-backdrop" onPointerDown={() => setHelpOpen(false)}>
          <section className="cw-help" onPointerDown={(event) => event.stopPropagation()}>
            <header><div><strong>画布快捷键</strong><span>输入文字时，单字母快捷键自动停用</span></div><button onClick={() => setHelpOpen(false)}><X size={18} /></button></header>
            <dl>
              <div><dt>V</dt><dd>选择；空白处拖框多选，拖动可整组移动</dd></div>
              <div><dt>P / H / E</dt><dd>钢笔 / 荧光笔 / 笔划橡皮擦</dd></div>
              <div><dt>Apple Pencil</dt><dd>执行当前工具：钢笔可书写，文字/批注可精确放置</dd></div>
              <div><dt>单指 / 双指</dt><dd>平移画布 / 以双指中心缩放</dd></div>
              <div><dt>T</dt><dd>在任意位置放自由文字</dd></div>
              <div><dt>A</dt><dd>点锚或拖框精确批注</dd></div>
              <div><dt>R</dt><dd>关联多个位置并描述关系</dd></div>
              <div><dt>D</dt><dd>在图片、文字、批注之间任意拖出箭头</dd></div>
              <div><dt>Ctrl + 滚轮</dt><dd>围绕鼠标位置缩放画布，不触发浏览器缩放</dd></div>
              <div><dt>滚轮 / 触控板</dt><dd>直接平移画布；Shift + 滚轮横向移动</dd></div>
              <div><dt>空格 + 拖动</dt><dd>临时抓手移动画布；鼠标中键拖动也可用</dd></div>
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
