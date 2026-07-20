export const CANVAS_DOCUMENT_VERSION = 1 as const;

export const CANVAS_RELATION_TYPES = [
  '解释',
  '推导',
  '对比',
  '纠错',
  '题目→答案',
  '错因→改法',
  '前后步骤',
  '自定义',
] as const;

export type CanvasRelationType = (typeof CANVAS_RELATION_TYPES)[number];

export interface CanvasPoint {
  x: number;
  y: number;
}

export type CanvasInkTool = 'pen' | 'highlighter';

export interface CanvasInkPoint extends CanvasPoint {
  /** Normalized Pointer Events pressure (0..1). */
  pressure: number;
}

export interface CanvasInkStroke {
  id: string;
  kind: 'ink';
  tool: CanvasInkTool;
  points: CanvasInkPoint[];
  color: string;
  width: number;
  opacity: number;
  z: number;
}

export interface CanvasViewport {
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
}

export interface CanvasImageNode {
  id: string;
  kind: 'image';
  src: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  z: number;
}

export interface CanvasTextNode {
  id: string;
  kind: 'text';
  text: string;
  x: number;
  y: number;
  width: number;
  height?: number;
  fontSize: number;
  color: string;
  z: number;
}

export type CanvasAnchorShape = 'point' | 'rect';

/**
 * Anchor geometry is normalized to its image (0..1), so an anchor keeps
 * pointing at the same image detail after the image moves or is resized.
 */
export interface CanvasAnchor {
  id: string;
  imageId: string;
  shape: CanvasAnchorShape;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

export interface CanvasAnnotationNode {
  id: string;
  kind: 'annotation' | 'relation';
  text: string;
  x: number;
  y: number;
  width: number;
  height?: number;
  anchorIds: string[];
  relationType: CanvasRelationType;
  color: string;
  z: number;
}

export interface CanvasArrowRelation {
  id: string;
  kind: 'arrow';
  fromAnchorId: string;
  toAnchorId: string;
  relationType: CanvasRelationType;
  color: string;
  z: number;
}

export interface CanvasDocument {
  version: typeof CANVAS_DOCUMENT_VERSION;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Monotonic server revision used to synchronize the same canvas across devices. */
  syncRevision: number;
  /** Remark used only when the user explicitly publishes this canvas as a note. */
  publishRemark?: string;
  images: CanvasImageNode[];
  texts: CanvasTextNode[];
  anchors: CanvasAnchor[];
  annotations: CanvasAnnotationNode[];
  /** Older stored v1 documents may omit this; parsing normalizes it to an empty array. */
  relations: CanvasArrowRelation[];
  /** Older stored v1 documents may omit this; parsing normalizes it to an empty array. */
  strokes: CanvasInkStroke[];
  viewport: CanvasViewport;
}

type StoredCanvasDocument = Omit<CanvasDocument, 'relations' | 'strokes' | 'syncRevision'> & {
  relations?: CanvasArrowRelation[];
  strokes?: CanvasInkStroke[];
  syncRevision?: number;
};

export function createCanvasId(prefix = 'canvas'): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${random}`;
}

export function createEmptyCanvasDocument(title = '未命名画布'): CanvasDocument {
  const now = new Date().toISOString();
  return {
    version: CANVAS_DOCUMENT_VERSION,
    id: createCanvasId('document'),
    title,
    createdAt: now,
    updatedAt: now,
    syncRevision: 0,
    publishRemark: '',
    images: [],
    texts: [],
    anchors: [],
    annotations: [],
    relations: [],
    strokes: [],
    viewport: { zoom: 0.9, scrollLeft: 0, scrollTop: 0 },
  };
}

export function cloneCanvasDocument(document: StoredCanvasDocument): CanvasDocument {
  // Keep immutable image data strings shared between undo snapshots. JSON
  // round-tripping duplicated every embedded image for every history entry and
  // could consume hundreds of megabytes on an otherwise modest multi-image canvas.
  return {
    ...document,
    syncRevision: Number.isInteger(document.syncRevision) && Number(document.syncRevision) >= 0
      ? Number(document.syncRevision)
      : 0,
    images: document.images.map((item) => ({ ...item })),
    texts: document.texts.map((item) => ({ ...item })),
    anchors: document.anchors.map((item) => ({ ...item })),
    annotations: document.annotations.map((item) => ({ ...item, anchorIds: [...item.anchorIds] })),
    relations: Array.isArray(document.relations) ? document.relations.map((item) => ({ ...item })) : [],
    strokes: Array.isArray(document.strokes)
      ? document.strokes.map((item) => ({ ...item, points: item.points.map((point) => ({ ...point })) }))
      : [],
    viewport: { ...document.viewport },
  };
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Lightweight runtime guard for local drafts and imported JSON files. */
export function isCanvasDocument(value: unknown): value is StoredCanvasDocument {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CanvasDocument>;
  return item.version === CANVAS_DOCUMENT_VERSION
    && typeof item.id === 'string'
    && typeof item.title === 'string'
    && typeof item.createdAt === 'string'
    && typeof item.updatedAt === 'string'
    && (item.syncRevision === undefined
      || (Number.isInteger(item.syncRevision) && Number(item.syncRevision) >= 0))
    && Array.isArray(item.images)
    && Array.isArray(item.texts)
    && Array.isArray(item.anchors)
    && Array.isArray(item.annotations)
    && (item.relations === undefined || Array.isArray(item.relations))
    && (item.strokes === undefined || Array.isArray(item.strokes))
    && !!item.viewport
    && isFiniteNumber(item.viewport.zoom)
    && isFiniteNumber(item.viewport.scrollLeft)
    && isFiniteNumber(item.viewport.scrollTop);
}

export function parseCanvasDocument(input: string | StoredCanvasDocument): CanvasDocument {
  const parsed: unknown = typeof input === 'string' ? JSON.parse(input) : input;
  if (!isCanvasDocument(parsed)) {
    throw new Error('无法识别这个画布文件，或文件版本不受支持。');
  }
  return cloneCanvasDocument(parsed);
}

export function serializeCanvasDocument(document: CanvasDocument): string {
  return JSON.stringify(document, null, 2);
}

export function getCanvasCompletionIssues(document: CanvasDocument): string[] {
  const issues: string[] = [];
  const incompleteAnnotations = document.annotations.filter((item) => item.kind === 'annotation' && item.anchorIds.length < 1);
  const incompleteRelations = document.annotations.filter((item) => item.kind === 'relation' && item.anchorIds.length < 2);
  if (incompleteAnnotations.length > 0) {
    issues.push(`${incompleteAnnotations.length} 条批注还没有指向图片位置`);
  }
  if (incompleteRelations.length > 0) {
    issues.push(`${incompleteRelations.length} 条关系还不足两个指向`);
  }
  return issues;
}
