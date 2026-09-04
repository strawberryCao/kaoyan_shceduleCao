import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  Archive,
  BookOpenText,
  Brain,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Columns2,
  Copy,
  FileImage,
  FileDown,
  FileText,
  FolderOpen,
  Inbox,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Rows3,
  Save,
  Search,
  Sparkles,
  Star,
  Tag,
  Trash2,
  TriangleAlert,
  X,
  Zap,
  ZoomIn,
} from 'lucide-react';
import type { ScheduleDay } from '../types';
import type {
  LearningAttachment,
  LearningAutoNote,
  LearningCard,
  LearningDataSnapshot,
  LearningNoteCreateInput,
  LearningNotePatch,
  LearningNoteReviewAction,
  LearningRecordFacet,
  LearningReviewRating,
} from '../utils/learningData';
import { fetchLearningData } from '../utils/learningData';
import { analyzeLearningNoteWrongReason } from '../utils/aiConfig';
import { createActivityTask, patchActivityTask, upsertActivityTask } from '../utils/activityTasks';
import {
  appendLearningMaterials,
  enqueueLearningNoteRename,
  getAiBackgroundJob,
  IS_CLOUD_RUNTIME,
  NOTE_SERVER_URL,
  searchLearningRecords,
  updateCloudEntryAssets,
  type LearningSearchResult,
} from '../utils/notes';
import { beginCrossBrowserRelayDrag } from '../utils/crossBrowserRelay';
import { fuzzySearchScore, type WeightedSearchField } from '../utils/fuzzySearch';
import { learningNoteTarget } from '../utils/learningNavigation';
import { ImageViewer, type ImageViewerItem } from './ImageViewer';
import {
  LearningInlineDetachLayer,
  type LearningInlineDetachLayerHandle,
} from './LearningInlineDetachLayer';
import { WorkspaceAssetPreview, type WorkspaceAssetPreviewItem } from './WorkspaceAssetPreview';
import {
  isDefaultNoteBucket,
  isExplicitMistakeOnly,
  isIgnoredNote,
  isKnowledgeEligibleNote,
  isPendingNoteReview,
} from '../utils/noteReview';
import {
  buildWeeklyReviewPackage,
  getWeekStart,
  shiftWeek,
  weeklyReviewFilename,
} from '../utils/weeklyReview';
import { QuickNoteWatcher } from './QuickNoteWatcher';
import { QuickHtmlStudio, type QuickHtmlAttachOutcome } from './QuickHtmlStudio';
import {
  LEARNING_TYPE_PATHS,
  GOOD_QUESTION_TYPES,
  WRONG_REASON_PATHS,
  classificationOptionsAtLevel,
  classificationPathLabel,
  classificationPathMatches,
  goodQuestionTypeForNote,
  learningTypePathForNote,
  normalizeLearningPath,
  questionTypePathForNote,
  wrongReasonPathForNote,
  type LearningClassificationPath,
} from '../utils/learningTaxonomy';
import '../learning-center.css';

function HierarchyPathFilter({
  label,
  paths,
  value,
  onChange,
}: {
  label: string;
  paths: LearningClassificationPath[];
  value: LearningClassificationPath;
  onChange: (value: LearningClassificationPath) => void;
}) {
  const selected = normalizeLearningPath(value);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<LearningClassificationPath>(selected);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const memoryLabels: Record<string, string> = {
    基础知识: '知识背诵',
    题型方法: '题型背诵',
    结论规律: '结论背诵',
    易错警示: '易错背诵',
    英语积累: '英语背诵',
    政治材料: '政治背诵',
  };
  const displaySegment = (segment: string, level: number) => (
    level === 0 && label.includes('背诵') ? memoryLabels[segment] || segment : segment
  );

  useEffect(() => setCursor(selected), [classificationPathLabel(selected)]);
  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [open]);

  const cancelScheduledClose = () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const openMenu = () => {
    cancelScheduledClose();
    setCursor(selected);
    setOpen(true);
  };
  const scheduleClose = () => {
    cancelScheduledClose();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 180);
  };

  return (
    <div
      ref={rootRef}
      className={`lc-path-filter${open ? ' is-open' : ''}`}
      aria-label={`${label}分级筛选`}
      onMouseEnter={openMenu}
      onMouseLeave={scheduleClose}
    >
      <button
        className="lc-path-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onFocus={openMenu}
        onClick={() => {
          cancelScheduledClose();
          setCursor(selected);
          setOpen((current) => !current);
        }}
      >
        <span>{selected.length > 0 ? selected.map(displaySegment).join(' / ') : `全部${label}`}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="lc-path-popover" role="listbox" aria-label={`${label}级联选项`} onMouseEnter={cancelScheduledClose}>
          <div className="lc-path-column">
            <button className={selected.length === 0 ? 'active' : ''} type="button" onClick={() => { onChange([]); setOpen(false); }}>全部{label}</button>
            {classificationOptionsAtLevel(paths, [], 0).map((option) => {
              const nextPath = [option];
              return <button key={option} className={selected[0] === option ? 'active' : ''} type="button" onMouseEnter={() => setCursor(nextPath)} onFocus={() => setCursor(nextPath)} onClick={() => { onChange(nextPath); setCursor(nextPath); if (classificationOptionsAtLevel(paths, nextPath, 1).length === 0) setOpen(false); }}>{displaySegment(option, 0)}</button>;
            })}
          </div>
          {[1, 2].map((level) => {
            const options = classificationOptionsAtLevel(paths, cursor, level);
            if (cursor.length < level || options.length === 0) return null;
            return (
              <div className="lc-path-column" key={level}>
                {options.map((option) => {
                  const nextPath = [...cursor.slice(0, level), option];
                  const hasChildren = level < 2 && classificationOptionsAtLevel(paths, nextPath, level + 1).length > 0;
                  return <button key={option} className={selected[level] === option && selected.slice(0, level).every((segment, index) => segment === nextPath[index]) ? 'active' : ''} type="button" onMouseEnter={() => setCursor(nextPath)} onFocus={() => setCursor(nextPath)} onClick={() => { onChange(nextPath); setCursor(nextPath); if (!hasChildren) setOpen(false); }}>{displaySegment(option, level)}{hasChildren && <ChevronRight size={13} aria-hidden="true" />}</button>;
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HierarchyPathInputs({
  label,
  value,
  onChange,
}: {
  label: string;
  value: LearningClassificationPath;
  onChange: (value: LearningClassificationPath) => void;
}) {
  const selected = normalizeLearningPath(value);
  return (
    <div className="lc-path-inputs" aria-label={`${label}，最多三级`}>
      {[0, 1, 2].map((level) => (
        <input
          key={level}
          value={selected[level] ?? ''}
          maxLength={60}
          placeholder={`${level + 1}级${label}`}
          onChange={(event) => {
            const next = [...selected];
            const segment = event.target.value;
            if (segment) next[level] = segment;
            else next.splice(level);
            onChange(normalizeLearningPath(next));
          }}
        />
      ))}
    </div>
  );
}

function AssetScroller({
  children,
  layout,
}: {
  children: ReactNode;
  layout: QuickAssetLayout;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const vertical = layout === 'vertical';
      const scrollSize = vertical ? element.scrollHeight : element.scrollWidth;
      const clientSize = vertical ? element.clientHeight : element.clientWidth;
      if (scrollSize <= clientSize) return;
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (!delta) return;
      const position = vertical ? element.scrollTop : element.scrollLeft;
      const maxScroll = Math.max(0, scrollSize - clientSize);
      const canConsume = delta < 0 ? position > 0 : position < maxScroll - 1;
      if (!canConsume) return;
      event.preventDefault();
      event.stopPropagation();
      if (vertical) element.scrollTop = Math.max(0, Math.min(maxScroll, position + delta));
      else element.scrollLeft = Math.max(0, Math.min(maxScroll, position + delta));
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [layout]);
  return <div ref={ref} className="lc-quick-asset-list">{children}</div>;
}

export type LearningCardPatch = Partial<Pick<LearningCard, 'front' | 'back' | 'status' | 'dueDate' | 'userEdited'>> & {
  reviewResult?: 'remembered' | 'forgotten';
  reviewRating?: LearningReviewRating;
  reviewThought?: string;
};

export interface LearningCenterProps {
  snapshot: LearningDataSnapshot;
  hydrationComplete?: boolean;
  scheduleDays: ScheduleDay[];
  onPatchCard: (cardId: string, patch: LearningCardPatch) => Promise<unknown> | unknown;
  onDeleteCard: (cardId: string) => Promise<unknown> | unknown;
  onCreateNote: (input: LearningNoteCreateInput) => Promise<unknown> | unknown;
  onPatchNote: (noteUid: string, patch: LearningNotePatch) => Promise<unknown> | unknown;
  onApplySnapshot: (snapshot: LearningDataSnapshot) => void;
  onReviewNotes: (actions: LearningNoteReviewAction[]) => Promise<unknown> | unknown;
  onDeleteNote: (noteUid: string) => Promise<unknown> | unknown;
  onOpenDate: (date: string) => void;
}

type CenterView = 'review' | 'mistakes' | 'good' | 'memory' | 'quick' | 'library' | 'uncategorized' | 'inbox' | 'weekly';
type MistakeStatus = 'all' | 'confirm' | 'due' | 'reviewing' | 'mastered' | 'untracked';
type QuickAssetLayout = 'vertical' | 'horizontal';
type QuickReaderMode = 'single' | 'overview';
type QuickAppendStatus = {
  noteUid: string;
  tone: 'info' | 'success' | 'error';
  message: string;
  operationId: string;
};
type QuickAppendRetry = { note: LearningAutoNote; files: File[]; operationId: string };

const QUICK_ASSET_LAYOUT_STORAGE_KEY = 'kaoyan:quick-asset-layout';
const QUICK_ASSET_RAIL_WIDTH_STORAGE_KEY = 'kaoyan:quick-asset-rail-width';
const REVIEW_SESSION_SIZE = 30;
const REVIEW_CONTINUE_SIZE = 10;
const LIBRARY_PAGE_SIZE = 60;
const QUICK_ASSET_RAIL_DEFAULT_WIDTH = 196;
const QUICK_ASSET_RAIL_MIN_WIDTH = 132;
const QUICK_ASSET_RAIL_MAX_WIDTH = 360;

const clampQuickAssetRailWidth = (value: number, workspaceWidth = Number.POSITIVE_INFINITY): number => {
  const responsiveMaximum = Number.isFinite(workspaceWidth)
    ? Math.max(QUICK_ASSET_RAIL_MIN_WIDTH, Math.min(QUICK_ASSET_RAIL_MAX_WIDTH, workspaceWidth * .46))
    : QUICK_ASSET_RAIL_MAX_WIDTH;
  return Math.round(Math.max(QUICK_ASSET_RAIL_MIN_WIDTH, Math.min(responsiveMaximum, value)));
};

interface IndexedNote {
  date: string;
  note: LearningAutoNote;
}

interface MistakeFilters {
  subject: string;
  knowledgePoint: string;
  questionTypePath: LearningClassificationPath;
  wrongReasonPath: LearningClassificationPath;
  status: MistakeStatus;
}

interface ContentFilters {
  subject: string;
  knowledgePoint: string;
  learningTypePath: LearningClassificationPath;
}

interface GoodQuestionFilters {
  subject: string;
  knowledgePoint: string;
  goodQuestionType: string;
}

interface ClassificationDraft {
  subject: string;
  knowledgePoint: string;
  questionTypePath: LearningClassificationPath;
  wrongReason: string;
  wrongReasonPath: LearningClassificationPath;
  learningTypePath: LearningClassificationPath;
  goodQuestionType: string;
}

type LearningItemKind = 'quick' | 'knowledge' | 'mistake' | 'memory';

const QUICK_FACET_OPTIONS: Array<{
  facet: Exclude<LearningRecordFacet, 'quick'>;
  label: string;
}> = [
  { facet: 'mistake', label: '错题' },
  { facet: 'good', label: '好题' },
  { facet: 'memory', label: '背诵' },
  { facet: 'knowledge', label: '知识库' },
  { facet: 'method', label: '方法' },
];

interface NoteEditorState {
  mode: 'create' | 'edit';
  noteUid: string | null;
  originalSubject: string;
  kind: LearningItemKind;
  title: string;
  remark: string;
  subject: string;
  knowledgePoint: string;
  questionTypePath: LearningClassificationPath;
  wrongReason: string;
  wrongReasonPath: LearningClassificationPath;
  learningTypePath: LearningClassificationPath;
  tags: string;
  isGood: boolean;
  goodQuestionType: string;
  createCard: boolean;
}

interface CardEditorState {
  cardId: string;
  front: string;
  back: string;
}

interface ThoughtEditorState {
  noteUid: string;
  thoughtId: string;
  text: string;
}

interface ImageViewerState {
  items: ImageViewerItem[];
  index: number;
}

type InboxEntry = { key: string; kind: 'note'; timestamp: string; entry: IndexedNote };

const STANDARD_EXAM_SUBJECTS = [
  '高等数学',
  '线性代数',
  '概率论',
  '英语',
  '政治',
  '数据结构',
  '计算机组成',
  '操作系统',
  '计算机网络',
] as const;
const MISTAKE_WORDS = ['错题', '易错'];
const MEMORY_WORDS = ['背诵', '记忆', '要背', '记住'];
const GOOD_QUESTION_WORDS = ['好题', '经典题', '典型题', '精品题'];
const EMPTY_FILTERS: MistakeFilters = {
  subject: '',
  knowledgePoint: '',
  questionTypePath: [],
  wrongReasonPath: [],
  status: 'all',
};

const EMPTY_CONTENT_FILTERS: ContentFilters = {
  subject: '',
  knowledgePoint: '',
  learningTypePath: [],
};

const EMPTY_GOOD_FILTERS: GoodQuestionFilters = {
  subject: '',
  knowledgePoint: '',
  goodQuestionType: '',
};

const makeReviewOperationId = (): string => typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `review_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;

const displaySubject = (subject: string | null | undefined): string => {
  const value = String(subject ?? '').trim();
  return isDefaultNoteBucket(value) ? '待确认' : value;
};

const localDate = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest(
    'button, a, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]',
  ));
};

const uniqueText = (items: Array<string | null | undefined>): string[] => [...new Set(
  items.map((item) => String(item ?? '').trim()).filter(Boolean),
)];

const uniquePaths = (items: unknown[]): LearningClassificationPath[] => {
  const paths = new Map<string, LearningClassificationPath>();
  items.forEach((item) => {
    const path = normalizeLearningPath(item);
    if (path.length > 0) paths.set(JSON.stringify(path), path);
  });
  return [...paths.values()].sort((left, right) => (
    classificationPathLabel(left).localeCompare(classificationPathLabel(right), 'zh-CN')
  ));
};

const pageRefText = (note: LearningAutoNote): string => note.pageRefs
  .map((ref) => ref.raw || [ref.page ? `p${ref.page}` : '', ref.question ?? ''].filter(Boolean).join(' '))
  .filter(Boolean)
  .join(' · ');

const inferredAttachmentKind = (
  value: Pick<LearningAttachment, 'kind' | 'mimeType' | 'name' | 'filePath'>,
): LearningAttachment['kind'] => {
  const source = `${value.name} ${value.filePath}`.toLowerCase();
  const mime = String(value.mimeType || '').toLowerCase();
  if (mime.startsWith('image/') || /\.(?:png|jpe?g|webp|gif|bmp|avif|heic|heif|svg)(?:$|[?#])/i.test(source)) return 'image';
  if (mime === 'application/pdf' || /\.pdf(?:$|[?#])/i.test(source)) return 'pdf';
  if (/word|officedocument/.test(mime) || /\.docx?(?:$|[?#])/i.test(source)) return 'word';
  if (mime === 'text/html' || /\.html?(?:$|[?#])/i.test(source)) return 'html';
  return value.kind || 'file';
};

const noteAttachments = (note: LearningAutoNote) => note.attachments.length > 0
  ? note.attachments
  : note.filePath ? [{
    id: 'legacy-primary',
    assetId: '',
    kind: inferredAttachmentKind({
      kind: 'file',
      mimeType: '',
      name: note.title || '',
      filePath: note.filePath,
    }),
    name: '原图',
    mimeType: 'image/jpeg',
    size: null,
    filePath: note.filePath,
    cloudPath: '',
    localPathKey: '',
    previewPath: '',
    posterPath: '',
    createdAt: note.createdAt,
  }] : [];
const noteImageAttachment = (note: LearningAutoNote) => {
  const images = noteAttachments(note).filter((attachment) => attachment.kind === 'image');
  return images.find((attachment) => Boolean(attachment.assetId))
    || images.find((attachment) => /^(?:github:\/\/data\/assets\/|data\/assets\/|r2:\/\/note-assets\/)/i.test(attachment.cloudPath || attachment.filePath))
    || images[0];
};
const noteFileUrl = (filePath: string): string => {
  const assetId = /^asset:\/\/([a-f0-9]{64})$/i.exec(filePath.trim())?.[1]?.toLowerCase();
  if (assetId && IS_CLOUD_RUNTIME) return `${NOTE_SERVER_URL}/assets/${assetId}`;
  return `${NOTE_SERVER_URL}/note-file?path=${encodeURIComponent(filePath)}`;
};

const normalizeLearningAssetPath = (value: string): string => value.trim().split('\\').join('/');
const isStableLearningAssetPath = (value: string): boolean => {
  const normalized = normalizeLearningAssetPath(value).toLowerCase();
  return normalized.startsWith('github://data/assets/')
    || normalized.startsWith('data/assets/')
    || normalized.startsWith('r2://note-assets/');
};

const learningAttachmentExtension = (attachment: LearningAttachment): string => {
  const nameExtension = attachment.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const pathExtension = normalizeLearningAssetPath(attachment.filePath).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (nameExtension || pathExtension) return nameExtension || pathExtension || 'jpg';
  if (attachment.mimeType === 'image/png') return 'png';
  if (attachment.mimeType === 'image/webp') return 'webp';
  if (attachment.mimeType === 'image/gif') return 'gif';
  if (attachment.mimeType === 'image/avif') return 'avif';
  if (attachment.mimeType === 'image/heic') return 'heic';
  if (attachment.mimeType === 'image/heif') return 'heif';
  return 'jpg';
};

const stableLearningAttachmentPath = (note: LearningAutoNote, attachment: LearningAttachment): string => {
  if (attachment.assetId) return `asset://${attachment.assetId}`;
  const declaredCloudPath = normalizeLearningAssetPath(attachment.cloudPath || '');
  if (isStableLearningAssetPath(declaredCloudPath)) return declaredCloudPath;
  const current = normalizeLearningAssetPath(attachment.filePath);
  if (isStableLearningAssetPath(current)) return current;
  const materialIndex = /^material-(\d+)$/.exec(attachment.id)?.[1];
  if (materialIndex) {
    return `github://data/assets/${note.noteUid}/${materialIndex.padStart(2, '0')}-${attachment.name}`;
  }
  if (attachment.kind === 'image') {
    return `github://data/assets/${note.noteUid}.${learningAttachmentExtension(attachment)}`;
  }
  const pathParts = current.split('/').filter(Boolean);
  const baseName = pathParts[pathParts.length - 1] || attachment.name;
  return baseName ? `github://data/assets/${baseName}` : '';
};

const noteAttachmentPaths = (note: LearningAutoNote, attachment: LearningAttachment): string[] => {
  const assetPath = attachment.assetId ? `asset://${attachment.assetId}` : '';
  const cloudPath = attachment.cloudPath?.trim() || '';
  const current = attachment.filePath.trim();
  const stable = stableLearningAttachmentPath(note, attachment);
  const currentPrimary = attachment.kind === 'image' ? note.filePath.trim() : '';
  return uniqueText(IS_CLOUD_RUNTIME
    ? [assetPath, cloudPath, stable, current, currentPrimary]
    : [current, assetPath, cloudPath, currentPrimary, stable]);
};

const noteAttachmentPrimaryPath = (note: LearningAutoNote, attachment: LearningAttachment): string => (
  noteAttachmentPaths(note, attachment)[0] || attachment.filePath
);

const quickAssetLabel = (attachment: LearningAttachment): string => {
  if (attachment.kind === 'image') return '图片';
  if (attachment.kind === 'pdf') return 'PDF';
  if (attachment.kind === 'word') return 'Word';
  if (attachment.kind === 'html') return 'HTML';
  return '文件';
};

const quickPreviewAssets = (note: LearningAutoNote): WorkspaceAssetPreviewItem[] => noteAttachments(note).map((attachment) => {
  const paths = noteAttachmentPaths(note, attachment);
  const filePath = paths[0] || attachment.filePath;
  const fallbackPath = paths.find((path) => path !== filePath) || '';
  return {
    id: attachment.id,
    kind: inferredAttachmentKind(attachment),
    name: attachment.name,
    mimeType: attachment.mimeType,
    filePath,
    fallbackPath,
    url: noteFileUrl(filePath),
    fallbackUrl: fallbackPath ? noteFileUrl(fallbackPath) : '',
    posterUrl: attachment.posterPath
      ? noteFileUrl(attachment.posterPath)
      : attachment.previewPath ? noteFileUrl(attachment.previewPath) : '',
    label: quickAssetLabel(attachment),
    sizeLabel: attachment.size ? `${Math.max(1, Math.round(attachment.size / 1024))} KB` : '大小未知',
  };
});

interface ResilientNoteImageProps {
  paths: string[];
  alt: string;
  loading?: 'eager' | 'lazy';
  onUnavailable?: () => void;
}

function ResilientNoteImage({ paths, alt, loading = 'lazy', onUnavailable }: ResilientNoteImageProps) {
  const usablePaths = uniqueText(paths);
  const pathKey = usablePaths.join('\n');
  const [pathIndex, setPathIndex] = useState(0);
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    setPathIndex(0);
    setExhausted(false);
  }, [pathKey]);

  const filePath = usablePaths[pathIndex] || '';
  if (!filePath || exhausted) return null;
  return (
    <img
      src={noteFileUrl(filePath)}
      alt={alt}
      loading={loading}
      decoding="async"
      onError={() => {
        if (pathIndex + 1 < usablePaths.length) {
          setPathIndex((current) => current + 1);
          return;
        }
        setExhausted(true);
        onUnavailable?.();
      }}
    />
  );
}

const noteSearchFields = (date: string, note: LearningAutoNote): WeightedSearchField[] => [
  { text: note.title, weight: 10 },
  { text: note.knowledgePath.join(' '), weight: 8 },
  { text: note.wrongReason, weight: 8 },
  { text: note.remark, weight: 7 },
  { text: note.studyNotes.map((thought) => thought.text).join(' '), weight: 7 },
  { text: note.items.map((item) => [item.title, item.knowledgePoint, item.summary, item.wrongReason, ...item.tags].join(' ')).join(' '), weight: 6 },
  { text: note.tags.join(' '), weight: 5 },
  { text: `${note.subject} ${displaySubject(note.subject)} ${note.questionType}`, weight: 4 },
  { text: `${date} ${note.capturedDate} ${pageRefText(note)}`, weight: 3 },
];

const formatShortDate = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value || '日期未知';
  const [, month, day] = value.split('-');
  return `${Number(month)}月${Number(day)}日`;
};

const formatRecordDate = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value || '日期未知';
  const [year, month, day] = value.split('-').map(Number);
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(year, month - 1, day).getDay()];
  return `${year}年${month}月${day}日 · ${weekday}`;
};

const isUsefulTaxonomyLabel = (value: string): boolean => {
  const normalized = value.trim();
  return normalized.length > 0
    && normalized.length <= 32
    && !/[。！？；\n]/u.test(normalized)
    && (normalized.match(/[,，、]/gu)?.length ?? 0) <= 1;
};

const noteKnowledgePoints = (note: LearningAutoNote): string[] => {
  const canonical = uniqueText(note.knowledgePath.filter((item) => (
    item !== note.subject && isUsefulTaxonomyLabel(item)
  )));
  if (canonical.length > 0 || note.classificationSource === 'manual') return canonical;
  return uniqueText(note.items.map((item) => item.knowledgePoint))
    .filter(isUsefulTaxonomyLabel)
    .slice(0, 1);
};

const noteQuestionTypes = (note: LearningAutoNote): string[] => uniqueText([
  note.questionType,
  ...(note.classificationSource === 'manual' ? [] : note.items.map((item) => item.questionType)),
  ...(note.classificationSource === 'manual' ? [] : note.tags)
    .filter((tag) => /^题型[:：]/.test(tag))
    .map((tag) => tag.replace(/^题型[:：]\s*/, '')),
]);

const noteWrongReasons = (note: LearningAutoNote): string[] => uniqueText([
  note.wrongReason,
  ...(note.classificationSource === 'manual' ? [] : note.items.map((item) => item.wrongReason)),
  ...(note.classificationSource === 'manual' ? [] : note.tags)
    .filter((tag) => /^错因[:：]/.test(tag))
    .map((tag) => tag.replace(/^错因[:：]\s*/, '')),
]);

const noteHasTag = (note: LearningAutoNote, words: string[]): boolean => note.tags.some((tag) => (
  words.some((word) => tag === word || tag.includes(word))
));

const remarkSignalsMistake = (remark: string): boolean => /(?:错题|易错|错因|错在|做错|算错|(?:计算|概念|审题|步骤|方法|符号|抄写|记忆|理解|判断|公式)(?:错误|错|失误|混淆)|漏看|漏掉|漏条件|粗心)/u.test(remark.normalize('NFKC'));

const remarkSignalsMemory = (remark: string): boolean => {
  const normalized = remark.normalize('NFKC');
  return /(?:^|[\s#【\[，,。；;：:])(?:记|记住|记忆|背|背诵|要背)(?=$|[\s#】\]，,。；;：:])/u.test(normalized)
    || /(?:要记住|需要记|必须记|背下来|需要背|必须背|重点背|熟记)/u.test(normalized);
};

const remarkSignalsGood = (remark: string): boolean => /(?:^|[\s#【\[，,。；;：:])(?:好题|经典题|典型题|精品题)(?=$|[\s#】\]，,。；;：:])/u.test(remark.normalize('NFKC'));

const isMistakeNote = (note: LearningAutoNote): boolean => (
  note.noteType === 'mistake'
  || note.facets.includes('mistake')
  || noteHasTag(note, MISTAKE_WORDS)
  || remarkSignalsMistake(note.remark)
  || noteWrongReasons(note).length > 0
  || note.items.some((item) => item.intent.isMistake)
);

const isMemoryNote = (note: LearningAutoNote): boolean => {
  if (isExplicitMistakeOnly(note)) return false;
  return note.noteType === 'memory'
    || note.facets.includes('memory')
    || noteHasTag(note, MEMORY_WORDS)
    || remarkSignalsMemory(note.remark)
    || note.items.some((item) => item.intent.shouldMemorize);
};

const isGoodNote = (note: LearningAutoNote): boolean => {
  if (note.facets.includes('good')) return true;
  if (note.goodQuestion !== null) return note.goodQuestion;
  const hasUserOwnedGoodTag = (note.manualCreated || note.userEditedFields.includes('tags'))
    && noteHasTag(note, GOOD_QUESTION_WORDS);
  return note.noteType === 'good' || hasUserOwnedGoodTag || remarkSignalsGood(note.remark);
};

const isQuickNote = (note: LearningAutoNote): boolean => (
  note.noteType === 'quick'
  || note.facets.includes('quick')
  || note.tags.some((tag) => tag.includes('速记'))
  || note.sourceType === 'material-note'
  || note.sourceType === 'quick-material'
);

const rankNotesForQuery = (
  entries: IndexedNote[],
  query: string,
  semanticScores?: ReadonlyMap<string, number>,
): IndexedNote[] => {
  if (!query.trim()) return entries;
  if (semanticScores) {
    return entries
      .map((entry, index) => ({ entry, index, score: semanticScores.get(entry.note.noteUid) }))
      .filter((item): item is { entry: IndexedNote; index: number; score: number } => item.score !== undefined)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map(({ entry }) => entry);
  }
  return entries.map((entry, index) => ({
    entry,
    index,
    score: fuzzySearchScore(query, noteSearchFields(entry.date, entry.note)),
  }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ entry }) => entry);
};

const mistakeStatus = (note: LearningAutoNote, cards: LearningCard[], today: string): Exclude<MistakeStatus, 'all'> => {
  const related = cards.filter((card) => card.noteUid === note.noteUid && card.kind === 'mistake');
  if (related.some((card) => card.status === 'draft')) return 'confirm';
  if (related.some((card) => card.status === 'active' && (!card.dueDate || card.dueDate <= today))) return 'due';
  if (related.some((card) => card.status === 'active')) return 'reviewing';
  if (related.some((card) => card.status === 'archived')) return 'mastered';
  return 'untracked';
};

const statusLabel: Record<Exclude<MistakeStatus, 'all'>, string> = {
  confirm: '待完善',
  due: '待重做',
  reviewing: '复习中',
  mastered: '已掌握',
  untracked: '未加入复习',
};

const initialView = (): CenterView => {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('view');
  if (requested === 'mistakes' || requested === 'good' || requested === 'memory' || requested === 'quick' || requested === 'library' || requested === 'uncategorized' || requested === 'inbox' || requested === 'weekly') return requested;
  if (requested === 'knowledge' || params.has('q')) return 'library';
  if (params.get('filter') === 'draft') return 'inbox';
  return 'review';
};

const learningTypePathsForSubject = (
  subject: string | null | undefined,
  paths: LearningClassificationPath[],
): LearningClassificationPath[] => {
  const normalizedSubject = String(subject ?? '').trim();
  return paths.filter((path) => {
    const root = path[0];
    if (root === '英语积累') return normalizedSubject === '英语';
    if (root === '政治材料') return normalizedSubject === '政治';
    return true;
  });
};

export function LearningCenter({
  snapshot,
  hydrationComplete = true,
  scheduleDays,
  onPatchCard,
  onDeleteCard,
  onCreateNote,
  onPatchNote,
  onApplySnapshot,
  onReviewNotes,
  onDeleteNote,
  onOpenDate,
}: LearningCenterProps) {
  const today = localDate();
  const currentWeekStart = getWeekStart(today);
  const requestedNoteUidRef = useRef(new URLSearchParams(window.location.search).get('noteUid'));
  const [view, setView] = useState<CenterView>(initialView);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(() => (
    new URLSearchParams(window.location.search).get('cardId')
  ));
  const [selectedNoteUid, setSelectedNoteUid] = useState<string | null>(() => requestedNoteUidRef.current);
  const [selectedInboxKey, setSelectedInboxKey] = useState<string | null>(null);
  const [mobileListOpen, setMobileListOpen] = useState(() => (
    !(new URLSearchParams(window.location.search).get('view') === 'quick'
      && new URLSearchParams(window.location.search).get('quickMode') === 'overview')
  ));
  const [revealed, setRevealed] = useState(false);
  const [pendingCardId, setPendingCardId] = useState<string | null>(null);
  const [pendingNoteUid, setPendingNoteUid] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [quickAppendStatus, setQuickAppendStatus] = useState<QuickAppendStatus | null>(null);
  const [quickAppendRetry, setQuickAppendRetry] = useState<QuickAppendRetry | null>(null);
  const [quickHtmlStudioNoteUid, setQuickHtmlStudioNoteUid] = useState<string | null>(null);
  const [reviewNotice, setReviewNotice] = useState('');
  const [reviewSessionTarget, setReviewSessionTarget] = useState(REVIEW_SESSION_SIZE);
  const [reviewCompleted, setReviewCompleted] = useState(0);
  const reviewOperationIdsRef = useRef(new Map<string, string>());
  const [sourceFeedback, setSourceFeedback] = useState('');
  const [failedImagePath, setFailedImagePath] = useState('');
  const [editingClassificationUid, setEditingClassificationUid] = useState<string | null>(null);
  const [classificationDraft, setClassificationDraft] = useState<ClassificationDraft | null>(null);
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  // A stale URL must never spend API quota after a reload. AI search is
  // enabled only by a click in the current page session.
  const [searchMode, setSearchMode] = useState<'normal' | 'ai'>('normal');
  const [semanticSearch, setSemanticSearch] = useState<{
    query: string;
    loading: boolean;
    degraded: boolean;
    error: string;
    results: LearningSearchResult[];
  }>({ query: '', loading: false, degraded: false, error: '', results: [] });
  const semanticSearchRequestRef = useRef(0);
  const [mistakeFilters, setMistakeFilters] = useState<MistakeFilters>(EMPTY_FILTERS);
  const [memoryFilters, setMemoryFilters] = useState<ContentFilters>(EMPTY_CONTENT_FILTERS);
  const [goodFilters, setGoodFilters] = useState<GoodQuestionFilters>(EMPTY_GOOD_FILTERS);
  const [libraryFilters, setLibraryFilters] = useState<ContentFilters>(EMPTY_CONTENT_FILTERS);
  const [libraryVisibleLimit, setLibraryVisibleLimit] = useState(LIBRARY_PAGE_SIZE);
  const [selectedWeekStart, setSelectedWeekStart] = useState(currentWeekStart);
  const [weeklyFeedback, setWeeklyFeedback] = useState('');
  const [noteEditor, setNoteEditor] = useState<NoteEditorState | null>(null);
  const [cardEditor, setCardEditor] = useState<CardEditorState | null>(null);
  const [goodImportOpen, setGoodImportOpen] = useState(false);
  const [goodImportQuery, setGoodImportQuery] = useState('');
  const [goodImportSelection, setGoodImportSelection] = useState<string[]>([]);
  const [imageViewer, setImageViewer] = useState<ImageViewerState | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [thoughtDraft, setThoughtDraft] = useState('');
  const [thoughtEditor, setThoughtEditor] = useState<ThoughtEditorState | null>(null);
  const [thoughtSaving, setThoughtSaving] = useState(false);
  const [wrongReasonEditor, setWrongReasonEditor] = useState<{ noteUid: string; text: string } | null>(null);
  const [wrongReasonSaving, setWrongReasonSaving] = useState(false);
  const [aiRenameNoteUid, setAiRenameNoteUid] = useState<string | null>(null);
  const [activeQuickAssets, setActiveQuickAssets] = useState<Record<string, string>>({});
  const [quickReaderMode, setQuickReaderMode] = useState<QuickReaderMode>(() => (
    new URLSearchParams(window.location.search).get('quickMode') === 'overview' ? 'overview' : 'single'
  ));
  const [quickAssetLayout, setQuickAssetLayout] = useState<QuickAssetLayout>(() => {
    try {
      return window.localStorage.getItem(QUICK_ASSET_LAYOUT_STORAGE_KEY) === 'horizontal'
        ? 'horizontal'
        : 'vertical';
    } catch {
      return 'vertical';
    }
  });
  const [quickAssetRailWidth, setQuickAssetRailWidth] = useState(() => {
    try {
      return clampQuickAssetRailWidth(Number(window.localStorage.getItem(QUICK_ASSET_RAIL_WIDTH_STORAGE_KEY))
        || QUICK_ASSET_RAIL_DEFAULT_WIDTH);
    } catch {
      return QUICK_ASSET_RAIL_DEFAULT_WIDTH;
    }
  });
  const [quickAssetIntrinsicSizes, setQuickAssetIntrinsicSizes] = useState<Record<string, {
    width: number;
    height: number;
  }>>({});
  const [quickExporting, setQuickExporting] = useState(false);
  const [quickFacetMenuNoteUid, setQuickFacetMenuNoteUid] = useState<string | null>(null);
  const detachLayerRef = useRef<LearningInlineDetachLayerHandle | null>(null);
  const quickDragCleanupRef = useRef<(() => void) | null>(null);
  const quickRailResizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(QUICK_ASSET_LAYOUT_STORAGE_KEY, quickAssetLayout);
    } catch {
      // The layout still works for the current session when storage is unavailable.
    }
  }, [quickAssetLayout]);

  useEffect(() => {
    try {
      window.localStorage.setItem(QUICK_ASSET_RAIL_WIDTH_STORAGE_KEY, String(quickAssetRailWidth));
    } catch {
      // Resizing still works for the current session when storage is unavailable.
    }
  }, [quickAssetRailWidth]);

  useEffect(() => () => {
    quickDragCleanupRef.current?.();
    quickRailResizeCleanupRef.current?.();
  }, []);

  useEffect(() => {
    if (view !== 'quick') return;
    const url = new URL(window.location.href);
    if (quickReaderMode === 'overview') url.searchParams.set('quickMode', 'overview');
    else url.searchParams.delete('quickMode');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [quickReaderMode, view]);

  const knowledgeEligibleNoteUids = useMemo(() => new Set(
    Object.values(snapshot.days)
      .flatMap((day) => day.autoNotes)
      .filter(isKnowledgeEligibleNote)
      .map((note) => note.noteUid),
  ), [snapshot.days]);
  const activeCards = useMemo(() => snapshot.cards.filter((card) => (
    card.status === 'active' && knowledgeEligibleNoteUids.has(card.noteUid)
  )), [knowledgeEligibleNoteUids, snapshot.cards]);
  const dueCards = useMemo(() => activeCards
    .filter((card) => !card.dueDate || card.dueDate <= today)
    .sort((left, right) => {
      const dueOrder = (left.dueDate || today).localeCompare(right.dueDate || today);
      return dueOrder || right.updatedAt.localeCompare(left.updatedAt);
    }), [activeCards, today]);
  const upcomingCards = useMemo(() => activeCards
    .filter((card) => card.dueDate && card.dueDate > today)
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate) || right.updatedAt.localeCompare(left.updatedAt)), [activeCards, today]);
  const reviewSessionTotal = Math.min(reviewSessionTarget, reviewCompleted + dueCards.length);
  const reviewSessionSlots = Math.max(0, reviewSessionTotal - reviewCompleted);
  const reviewCards = useMemo(() => dueCards.slice(0, reviewSessionSlots), [dueCards, reviewSessionSlots]);
  const deferredDueCount = Math.max(0, dueCards.length - reviewCards.length);
  const currentCard = reviewCards.find((card) => card.id === selectedCardId) ?? reviewCards[0] ?? null;
  const currentCardIndex = currentCard ? reviewCards.findIndex((card) => card.id === currentCard.id) : -1;
  const currentCardIsDue = Boolean(currentCard && (!currentCard.dueDate || currentCard.dueDate <= today));

  const allNotes = useMemo<IndexedNote[]>(() => Object.entries(snapshot.days)
    .flatMap(([date, day]) => day.autoNotes.filter((note) => !isIgnoredNote(note)).map((note) => {
      const capturedDate = /^\d{4}-\d{2}-\d{2}$/.test(note.capturedDate) ? note.capturedDate : date;
      return {
        date: capturedDate,
        note,
      };
    }))
    .sort((left, right) => right.date.localeCompare(left.date) || right.note.updatedAt.localeCompare(left.note.updatedAt)), [snapshot.days]);
  const notesByUid = useMemo(() => new Map(allNotes.map(({ note }) => [note.noteUid, note])), [allNotes]);
  const resolveCardImagePath = (card: LearningCard): string => {
    const note = notesByUid.get(card.noteUid);
    const attachment = note ? noteImageAttachment(note) : null;
    if (note && attachment) return noteAttachmentPrimaryPath(note, attachment);
    return card.sourceFilePath || '';
  };
  const currentCardResolvedPath = currentCard ? resolveCardImagePath(currentCard) : '';
  const indexedNotes = useMemo(() => allNotes.filter(({ note }) => isKnowledgeEligibleNote(note)), [allNotes]);

  const subjectOptions = useMemo(() => {
    const standardOrder = new Map<string, number>(STANDARD_EXAM_SUBJECTS.map((subject, index) => [subject, index]));
    return uniqueText([
      ...STANDARD_EXAM_SUBJECTS,
      ...allNotes.map(({ note }) => note.subject).filter((subject) => !isDefaultNoteBucket(subject)),
    ]).sort((left, right) => {
      const leftOrder = standardOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = standardOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.localeCompare(right, 'zh-CN');
    });
  }, [allNotes]);
  const knowledgePointsForSubject = useCallback((subject: string) => uniqueText(
    indexedNotes
      .filter(({ note }) => !subject || note.subject === subject)
      .flatMap(({ note }) => noteKnowledgePoints(note)),
  ).sort((left, right) => left.localeCompare(right, 'zh-CN')), [indexedNotes]);
  const classificationKnowledgePointOptions = useMemo(
    () => knowledgePointsForSubject(classificationDraft?.subject ?? ''),
    [classificationDraft?.subject, knowledgePointsForSubject],
  );
  const editorKnowledgePointOptions = useMemo(
    () => knowledgePointsForSubject(noteEditor?.subject ?? ''),
    [knowledgePointsForSubject, noteEditor?.subject],
  );
  const classificationLearningTypePaths = useMemo(() => learningTypePathsForSubject(
    classificationDraft?.subject,
    LEARNING_TYPE_PATHS,
  ), [classificationDraft?.subject]);
  const editorLearningTypePaths = useMemo(() => learningTypePathsForSubject(
    noteEditor?.subject,
    LEARNING_TYPE_PATHS,
  ), [noteEditor?.subject]);

  const mistakeNotes = useMemo(() => allNotes.filter(({ note }) => isMistakeNote(note)), [allNotes]);
  const goodNotes = useMemo(() => allNotes.filter(({ note }) => isGoodNote(note)), [allNotes]);
  const importableMistakes = useMemo(() => mistakeNotes.filter(({ note }) => !isGoodNote(note)), [mistakeNotes]);
  const visibleGoodImport = useMemo(
    () => rankNotesForQuery(importableMistakes, goodImportQuery),
    [goodImportQuery, importableMistakes],
  );
  const visibleGoodImportIds = useMemo(
    () => visibleGoodImport.map(({ note }) => note.noteUid),
    [visibleGoodImport],
  );
  const allVisibleGoodImportSelected = visibleGoodImportIds.length > 0
    && visibleGoodImportIds.every((noteUid) => goodImportSelection.includes(noteUid));
  const memoryNotes = useMemo(() => allNotes.filter(({ note }) => isMemoryNote(note)), [allNotes]);
  const quickNotes = useMemo(() => allNotes.filter(({ note }) => isQuickNote(note)), [allNotes]);
  const uncategorizedNotes = useMemo(() => indexedNotes.filter(({ note }) => (
    !isQuickNote(note) && !isMistakeNote(note) && !isGoodNote(note) && !isMemoryNote(note)
  )), [indexedNotes]);
  const pendingNotes = useMemo(() => allNotes.filter(({ note }) => isPendingNoteReview(note)), [allNotes]);
  const semanticScores = useMemo(() => {
    if (
      searchMode !== 'ai'
      || !query.trim()
      || semanticSearch.loading
      || semanticSearch.query !== query.trim()
      || semanticSearch.error
    ) return undefined;
    return new Map(semanticSearch.results.map((result) => [result.noteUid, result.score]));
  }, [query, searchMode, semanticSearch]);
  const weeklyPackage = useMemo(
    () => buildWeeklyReviewPackage(snapshot, scheduleDays, selectedWeekStart, today),
    [scheduleDays, selectedWeekStart, snapshot, today],
  );

  const mistakeFacets = useMemo(() => {
    const subjectScope = mistakeFilters.subject
      ? mistakeNotes.filter(({ note }) => note.subject === mistakeFilters.subject)
      : mistakeNotes;
    const knowledgeScope = mistakeFilters.knowledgePoint
      ? subjectScope.filter(({ note }) => noteKnowledgePoints(note).includes(mistakeFilters.knowledgePoint))
      : subjectScope;
    return {
      subjects: uniqueText(mistakeNotes.map(({ note }) => note.subject)).sort((left, right) => left.localeCompare(right, 'zh-CN')),
      knowledgePoints: uniqueText(subjectScope.flatMap(({ note }) => noteKnowledgePoints(note))).sort((left, right) => left.localeCompare(right, 'zh-CN')),
      questionTypePaths: uniquePaths(knowledgeScope.map(({ note }) => questionTypePathForNote(note))),
      wrongReasonPaths: uniquePaths(knowledgeScope.map(({ note }) => wrongReasonPathForNote(note))),
    };
  }, [mistakeFilters.knowledgePoint, mistakeFilters.subject, mistakeNotes]);

  const wrongReasonEditorPaths = useMemo(() => uniquePaths([
    ...WRONG_REASON_PATHS,
    ...indexedNotes.map(({ note }) => wrongReasonPathForNote(note)),
  ]), [indexedNotes]);

  const memoryFacets = useMemo(() => {
    const subjectScope = memoryFilters.subject
      ? memoryNotes.filter(({ note }) => note.subject === memoryFilters.subject)
      : memoryNotes;
    const knowledgeScope = memoryFilters.knowledgePoint
      ? subjectScope.filter(({ note }) => noteKnowledgePoints(note).includes(memoryFilters.knowledgePoint))
      : subjectScope;
    return {
      subjects: uniqueText(memoryNotes.map(({ note }) => note.subject)).sort((left, right) => left.localeCompare(right, 'zh-CN')),
      knowledgePoints: uniqueText(subjectScope.flatMap(({ note }) => noteKnowledgePoints(note))).sort((left, right) => left.localeCompare(right, 'zh-CN')),
      learningTypePaths: uniquePaths(knowledgeScope.map(({ note }) => learningTypePathForNote(note))),
    };
  }, [memoryFilters.knowledgePoint, memoryFilters.subject, memoryNotes]);

  const goodFacets = useMemo(() => {
    const subjectScope = goodFilters.subject
      ? goodNotes.filter(({ note }) => note.subject === goodFilters.subject)
      : goodNotes;
    const knowledgeScope = goodFilters.knowledgePoint
      ? subjectScope.filter(({ note }) => noteKnowledgePoints(note).includes(goodFilters.knowledgePoint))
      : subjectScope;
    return {
      subjects: uniqueText(goodNotes.map(({ note }) => note.subject)).sort((left, right) => left.localeCompare(right, 'zh-CN')),
      knowledgePoints: uniqueText(subjectScope.flatMap(({ note }) => noteKnowledgePoints(note))).sort((left, right) => left.localeCompare(right, 'zh-CN')),
      goodQuestionTypes: GOOD_QUESTION_TYPES.filter((type) => (
        knowledgeScope.some(({ note }) => goodQuestionTypeForNote(note) === type)
      )),
    };
  }, [goodFilters.knowledgePoint, goodFilters.subject, goodNotes]);

  const libraryFacets = useMemo(() => {
    const subjectScope = libraryFilters.subject
      ? indexedNotes.filter(({ note }) => note.subject === libraryFilters.subject)
      : indexedNotes;
    const knowledgeScope = libraryFilters.knowledgePoint
      ? subjectScope.filter(({ note }) => noteKnowledgePoints(note).includes(libraryFilters.knowledgePoint))
      : subjectScope;
    return {
      subjects: uniqueText(indexedNotes.map(({ note }) => note.subject)).sort((left, right) => left.localeCompare(right, 'zh-CN')),
      knowledgePoints: uniqueText(subjectScope.flatMap(({ note }) => noteKnowledgePoints(note))).sort((left, right) => left.localeCompare(right, 'zh-CN')),
      learningTypePaths: uniquePaths(knowledgeScope.map(({ note }) => learningTypePathForNote(note))),
    };
  }, [indexedNotes, libraryFilters.knowledgePoint, libraryFilters.subject]);

  const visibleMistakes = useMemo(() => rankNotesForQuery(mistakeNotes.filter((entry) => {
    const { note } = entry;
    if (mistakeFilters.subject && note.subject !== mistakeFilters.subject) return false;
    if (mistakeFilters.knowledgePoint && !noteKnowledgePoints(note).includes(mistakeFilters.knowledgePoint)) return false;
    if (!classificationPathMatches(questionTypePathForNote(note), mistakeFilters.questionTypePath)) return false;
    if (!classificationPathMatches(wrongReasonPathForNote(note), mistakeFilters.wrongReasonPath)) return false;
    return mistakeFilters.status === 'all' || mistakeStatus(note, snapshot.cards, today) === mistakeFilters.status;
  }), query, semanticScores), [mistakeFilters, mistakeNotes, query, semanticScores, snapshot.cards, today]);

  const visibleMemory = useMemo(() => rankNotesForQuery(memoryNotes.filter(({ note }) => (
    (!memoryFilters.subject || note.subject === memoryFilters.subject)
    && (!memoryFilters.knowledgePoint || noteKnowledgePoints(note).includes(memoryFilters.knowledgePoint))
    && classificationPathMatches(learningTypePathForNote(note), memoryFilters.learningTypePath)
  )), query, semanticScores), [memoryFilters, memoryNotes, query, semanticScores]);
  const visibleGood = useMemo(() => rankNotesForQuery(goodNotes.filter(({ note }) => (
    (!goodFilters.subject || note.subject === goodFilters.subject)
    && (!goodFilters.knowledgePoint || noteKnowledgePoints(note).includes(goodFilters.knowledgePoint))
    && (!goodFilters.goodQuestionType || goodQuestionTypeForNote(note) === goodFilters.goodQuestionType)
  )), query, semanticScores), [goodFilters, goodNotes, query, semanticScores]);
  const visibleQuick = useMemo(() => rankNotesForQuery(quickNotes, query, semanticScores), [query, quickNotes, semanticScores]);
  const visibleLibrary = useMemo(() => rankNotesForQuery(indexedNotes.filter(({ note }) => (
    (!libraryFilters.subject || note.subject === libraryFilters.subject)
    && (!libraryFilters.knowledgePoint || noteKnowledgePoints(note).includes(libraryFilters.knowledgePoint))
    && classificationPathMatches(learningTypePathForNote(note), libraryFilters.learningTypePath)
  )), query, semanticScores), [indexedNotes, libraryFilters, query, semanticScores]);
  const visibleUncategorized = useMemo(() => rankNotesForQuery(uncategorizedNotes, query, semanticScores), [query, semanticScores, uncategorizedNotes]);
  const libraryPathKey = libraryFilters.learningTypePath.join('\u001f');
  const visibleLibraryPage = useMemo(
    () => visibleLibrary.slice(0, libraryVisibleLimit),
    [libraryVisibleLimit, visibleLibrary],
  );

  useEffect(() => {
    setLibraryVisibleLimit(LIBRARY_PAGE_SIZE);
  }, [libraryFilters.knowledgePoint, libraryFilters.subject, libraryPathKey, query, searchMode]);

  const groupedLibrary = useMemo(() => {
    const groups = new Map<string, IndexedNote[]>();
    visibleLibraryPage.forEach((entry) => {
      const group = groups.get(entry.date) ?? [];
      group.push(entry);
      groups.set(entry.date, group);
    });
    return [...groups.entries()];
  }, [visibleLibraryPage]);

  const inboxEntries = useMemo<InboxEntry[]>(() => [
    ...pendingNotes.map((entry): InboxEntry => ({
      key: `note:${entry.note.noteUid}`,
      kind: 'note',
      timestamp: entry.note.updatedAt || entry.date,
      entry,
    })),
  ].sort((left, right) => right.timestamp.localeCompare(left.timestamp)), [pendingNotes]);

  const noteListForView = view === 'mistakes'
    ? visibleMistakes
    : view === 'good'
      ? visibleGood
    : view === 'memory'
      ? visibleMemory
      : view === 'quick'
        ? visibleQuick
        : view === 'uncategorized'
          ? visibleUncategorized
        : visibleLibrary;
  const requestedNotePending = Boolean(
    requestedNoteUidRef.current
    && !noteListForView.some(({ note }) => note.noteUid === requestedNoteUidRef.current),
  );
  const requestedNoteMissing = requestedNotePending && hydrationComplete;
  const selectedNote = noteListForView.find(({ note }) => note.noteUid === selectedNoteUid)
    ?? (requestedNotePending ? null : noteListForView[0] ?? null);
  const selectedInbox = inboxEntries.find((entry) => entry.key === selectedInboxKey) ?? inboxEntries[0] ?? null;

  useEffect(() => {
    if (!currentCard) {
      setSelectedCardId(null);
      setRevealed(false);
      return;
    }
    if (selectedCardId !== currentCard.id) {
      setSelectedCardId(currentCard.id);
      setRevealed(false);
    }
  }, [currentCard, selectedCardId]);

  useEffect(() => {
    if (view === 'review' || view === 'inbox') return;
    if (!selectedNote) {
      // The app can render a cached snapshot before the latest local/cloud
      // snapshot arrives. Keep the requested UID alive so the fresh snapshot
      // can resolve it instead of silently opening the first card.
      if (requestedNoteUidRef.current) return;
      const requestedNoteIsLoading = Boolean(
        requestedNoteUidRef.current
        && requestedNoteUidRef.current === selectedNoteUid
        && searchMode === 'ai'
        && query.trim()
        && (semanticSearch.query !== query.trim() || semanticSearch.loading),
      );
      if (requestedNoteIsLoading) return;
      setSelectedNoteUid(null);
      return;
    }
    if (selectedNote.note.noteUid !== selectedNoteUid) setSelectedNoteUid(selectedNote.note.noteUid);
    if (selectedNote.note.noteUid === requestedNoteUidRef.current) requestedNoteUidRef.current = null;
  }, [query, searchMode, selectedNote, selectedNoteUid, semanticSearch.loading, semanticSearch.query, view]);

  useEffect(() => {
    if (view !== 'inbox') return;
    if (!selectedInbox) {
      setSelectedInboxKey(null);
      return;
    }
    if (selectedInbox.key !== selectedInboxKey) setSelectedInboxKey(selectedInbox.key);
  }, [selectedInbox, selectedInboxKey, view]);

  useEffect(() => {
    setSourceFeedback('');
    setFailedImagePath('');
    setThoughtDraft('');
    setThoughtEditor(null);
    setWrongReasonEditor(null);
  }, [selectedNoteUid, selectedInboxKey, selectedCardId, view]);

  useEffect(() => {
    if (!reviewNotice) return undefined;
    const timer = window.setTimeout(() => setReviewNotice(''), 2200);
    return () => window.clearTimeout(timer);
  }, [reviewNotice]);

  const stepCard = (direction: -1 | 1) => {
    if (reviewCards.length < 2 || currentCardIndex < 0) return;
    const nextIndex = (currentCardIndex + direction + reviewCards.length) % reviewCards.length;
    setSelectedCardId(reviewCards[nextIndex].id);
    setRevealed(false);
    setFeedback('');
  };

  const updateCard = async (
    card: LearningCard,
    patch: LearningCardPatch,
    successText: string,
    onSuccess?: () => void,
  ) => {
    if (pendingCardId) return;
    setPendingCardId(card.id);
    setFeedback('');
    try {
      await onPatchCard(card.id, patch);
      setFeedback(successText);
      onSuccess?.();
      setRevealed(false);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '操作没有保存，请稍后重试。');
    } finally {
      setPendingCardId(null);
    }
  };

  const patchCurrentCard = (patch: LearningCardPatch, successText: string) => {
    if (!currentCard) return;
    const nextCard = reviewCards.find((card) => card.id !== currentCard.id) ?? null;
    const recordsReview = Boolean(patch.reviewRating || patch.reviewResult);
    void updateCard(currentCard, patch, successText, () => {
      if (recordsReview) setReviewCompleted((value) => value + 1);
      setSelectedCardId(nextCard?.id ?? null);
    });
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (view !== 'review' || isEditableTarget(event.target) || !currentCard || pendingCardId) return;
      if (event.code === 'Space') {
        event.preventDefault();
        setRevealed((value) => !value);
      } else if (event.key === 'Escape') {
        if (revealed) setRevealed(false);
        else setFeedback('');
      } else if (event.key === '1' && currentCardIsDue) {
        event.preventDefault();
        patchCurrentCard({ reviewRating: 'again' }, '已放回短期复习队列。');
      } else if (event.key === '2' && currentCardIsDue) {
        event.preventDefault();
        patchCurrentCard({ reviewRating: 'hard' }, '已按“困难”安排下次复习。');
      } else if (event.key === '3' && currentCardIsDue) {
        event.preventDefault();
        patchCurrentCard({ reviewRating: 'good' }, '已按“良好”延长复习间隔。');
      } else if (event.key === '4' && currentCardIsDue) {
        event.preventDefault();
        patchCurrentCard({ reviewRating: 'easy' }, '已按“轻松”安排更长间隔。');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentCard, currentCardIsDue, pendingCardId, revealed, view]);

  const handleSourcePath = async (filePath: string) => {
    if (!filePath) {
      setSourceFeedback('这条记录还没有原图路径。');
      return;
    }
    const bridge = window.kaoyanDesktop;
    try {
      if (typeof bridge?.showItemInFolder === 'function') {
        await bridge.showItemInFolder(filePath);
        setSourceFeedback('已定位原图');
        return;
      }
      if (typeof bridge?.openPath === 'function') {
        await bridge.openPath(filePath);
        setSourceFeedback('已打开原图');
        return;
      }
      const response = await fetch(`${NOTE_SERVER_URL}/notes/reveal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      if (response.ok) {
        setSourceFeedback('已定位原图');
        return;
      }
      const payload = await response.json().catch(() => null);
      throw new Error(payload && typeof payload.error === 'string' ? payload.error : `资源管理器返回 ${response.status}`);
    } catch (error) {
      try {
        await navigator.clipboard.writeText(filePath);
        const serviceOffline = error instanceof TypeError || /fetch|network|连接|断开/i.test(error instanceof Error ? error.message : '');
        setSourceFeedback(serviceOffline
          ? '本地笔记服务已断开，原图路径已复制。'
          : '资源管理器暂时不可用，原图路径已复制。');
      } catch {
        setSourceFeedback('定位失败；可复制路径后重试');
      }
    }
  };

  const renameNoteWithAi = async (note: LearningAutoNote) => {
    if (aiRenameNoteUid) return;
    try {
      setAiRenameNoteUid(note.noteUid);
      setFeedback('');
      const queued = await enqueueLearningNoteRename(note.noteUid);
      let job = queued.job;
      // Retrying a note updates one stable activity instead of creating a new
      // failed card for every server-side job id.
      const activityId = `ai-rename:${note.noteUid}`;
      await upsertActivityTask(createActivityTask({
        id: activityId,
        sourceId: note.noteUid,
        kind: 'ai_rename',
        status: job.status === 'failed' ? 'failed_retryable' : 'queued',
        title: `AI 命名：${note.title || '未命名笔记'}`,
        message: job.message || '已加入后台队列',
        progress: job.progress,
        targetUrl: learningNoteTarget(note.noteUid, note),
        canRetry: false,
        canCancel: false,
      }));
      setFeedback(job.message || 'AI 重命名已加入后台队列；可以继续浏览。');
      for (let attempt = 0; attempt < 120 && ['queued', 'processing'].includes(job.status); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        job = await getAiBackgroundJob(job.id);
        await patchActivityTask(activityId, {
          status: job.status === 'processing'
            ? 'processing'
            : job.status === 'failed'
              ? 'failed_retryable'
              : ['completed', 'skipped'].includes(job.status)
                ? 'completed'
                : 'queued',
          progress: job.progress,
          message: job.message,
          error: job.error,
          errorCode: (job as typeof job & { errorCode?: string }).errorCode || '',
          provider: job.result?.provider || '',
          model: job.result?.model || '',
          resultNoteUids: job.status === 'completed' ? [note.noteUid] : [],
          canRetry: job.status === 'failed',
          canCancel: ['queued', 'processing'].includes(job.status),
          completedAt: job.completedAt,
        });
        setFeedback(job.message || `AI 重命名处理中（${Math.round(job.progress)}%）`);
      }
      if (job.status === 'failed') throw new Error(job.error || 'AI 重命名失败，请稍后重试。');
      if (job.status === 'completed') {
        // The cloud runtime has no EventSource. Refresh immediately so a
        // completed rename is visible without waiting for the 15-second poll.
        // This GET only reads the saved result; it never starts another AI call.
        try {
          onApplySnapshot(await fetchLearningData());
        } catch {
          // The normal polling fallback will reconcile the saved result later.
        }
        setFeedback(job.result?.title ? `已重命名为“${job.result.title}”` : 'AI 重命名与分类已完成。');
      } else if (job.status === 'skipped') {
        try {
          onApplySnapshot(await fetchLearningData());
        } catch {
          // Keep the user's current snapshot while offline.
        }
        setFeedback(job.message || '记录已变化，AI 没有覆盖你的修改。');
      } else {
        setFeedback('AI 仍在后台处理；完成后标题会自动刷新。');
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'AI 重命名任务提交失败，请重试。');
    } finally {
      setAiRenameNoteUid(null);
    }
  };

  const copySourcePath = async (filePath: string) => {
    if (!filePath) return;
    try {
      await navigator.clipboard.writeText(filePath);
      setSourceFeedback('路径已复制');
    } catch {
      setSourceFeedback('复制失败');
    }
  };

  const copyWeeklyPackage = async () => {
    try {
      await navigator.clipboard.writeText(weeklyPackage.markdown);
      setWeeklyFeedback('已复制');
    } catch {
      setWeeklyFeedback('复制失败，请在下方内容框中全选复制。');
    }
  };

  const downloadWeeklyPackage = () => {
    const blob = new Blob([weeklyPackage.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = weeklyReviewFilename(weeklyPackage.weekStart);
    link.click();
    URL.revokeObjectURL(url);
    setWeeklyFeedback('已导出');
  };

  const advancePendingQueue = (noteUid: string) => {
    const currentIndex = inboxEntries.findIndex((entry) => entry.entry.note.noteUid === noteUid);
    const remaining = inboxEntries.filter((entry) => entry.entry.note.noteUid !== noteUid);
    const next = remaining[Math.min(Math.max(currentIndex, 0), Math.max(remaining.length - 1, 0))] ?? null;
    setSelectedInboxKey(next?.key ?? null);
    if (!next) setMobileListOpen(true);
  };

  const reviewPendingNote = async (
    note: LearningAutoNote,
    action: LearningNoteReviewAction['action'],
    patch?: LearningNoteReviewAction['patch'],
  ) => {
    if (pendingNoteUid) return;
    const requestKey = `${note.noteUid}:${action}:${note.proposalId}:${JSON.stringify(patch ?? {})}`;
    const operationId = reviewOperationIdsRef.current.get(requestKey) ?? makeReviewOperationId();
    reviewOperationIdsRef.current.set(requestKey, operationId);
    try {
      setPendingNoteUid(note.noteUid);
      setFeedback('');
      await onReviewNotes([{
        noteUid: note.noteUid,
        action,
        operationId,
        expectedDecisionRevision: note.decisionRevision,
        ...(note.proposalId ? { proposalId: note.proposalId } : {}),
        ...(patch ? { patch } : {}),
      }]);
      reviewOperationIdsRef.current.delete(requestKey);
      setEditingClassificationUid(null);
      setClassificationDraft(null);
      advancePendingQueue(note.noteUid);
      setReviewNotice(action === 'accept' ? '已确认' : action === 'ignore' ? '已忽略' : '已改分类');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '保存失败，请重试');
    } finally {
      setPendingNoteUid(null);
    }
  };

  const ignorePendingNote = (note: LearningAutoNote) => reviewPendingNote(note, 'ignore');

  const beginClassificationEdit = (note: LearningAutoNote) => {
    setEditingClassificationUid(note.noteUid);
    setClassificationDraft({
      subject: isDefaultNoteBucket(note.subject) ? '' : note.subject,
      knowledgePoint: noteKnowledgePoints(note)[0] ?? '',
      questionTypePath: questionTypePathForNote(note),
      wrongReason: noteWrongReasons(note)[0] ?? '',
      wrongReasonPath: wrongReasonPathForNote(note),
      learningTypePath: learningTypePathForNote(note),
      goodQuestionType: isGoodNote(note) ? goodQuestionTypeForNote(note) : '',
    });
    setFeedback('');
  };

  const saveClassification = async (note: LearningAutoNote) => {
    if (!classificationDraft || pendingNoteUid) return;
    const subject = classificationDraft.subject.trim();
    if (!subjectOptions.includes(subject)) {
      setFeedback('请选择已有的一级科目。');
      return;
    }
    const knowledgePoint = classificationDraft.knowledgePoint.trim();
    const questionTypePath = normalizeLearningPath(classificationDraft.questionTypePath);
    await reviewPendingNote(note, 'correct', {
        subject,
        knowledgePath: [subject, knowledgePoint].filter(Boolean),
        questionType: questionTypePath[questionTypePath.length - 1] ?? '',
        questionTypePath,
        wrongReason: classificationDraft.wrongReason.trim(),
        wrongReasonPath: normalizeLearningPath(classificationDraft.wrongReasonPath),
        learningTypePath: normalizeLearningPath(classificationDraft.learningTypePath),
        ...(isGoodNote(note) ? {
          goodQuestion: true,
          goodQuestionType: classificationDraft.goodQuestionType || '经典母题',
        } : {}),
    });
  };

  const wrongReasonSourceLabel = (note: LearningAutoNote): string => ({
    manual: '手动填写',
    manual_deleted: '已手动删除',
    explicit_remark: '从备注明确提取',
    explicit_image: '从图片明确提取',
    ai_inferred: 'AI 根据过程推断',
    none: '尚未识别',
  }[note.wrongReasonSource] || (note.wrongReason ? '已有记录' : '尚未识别'));

  const saveWrongReason = async (note: LearningAutoNote) => {
    if (!wrongReasonEditor || wrongReasonSaving) return;
    try {
      setWrongReasonSaving(true);
      setFeedback('');
      const wrongReason = wrongReasonEditor.text.trim();
      await onPatchNote(note.noteUid, {
        wrongReason,
        wrongReasonPath: wrongReason
          ? wrongReasonPathForNote({ ...note, wrongReason, wrongReasonPath: [] })
          : [],
      });
      setWrongReasonEditor(null);
      setFeedback(wrongReasonEditor.text.trim() ? '错因已保存，后续 AI 不会覆盖。' : '错因已删除，后续 AI 不会自动补回。');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '错因没有保存，请稍后重试。');
    } finally {
      setWrongReasonSaving(false);
    }
  };

  const deleteWrongReason = async (note: LearningAutoNote) => {
    if (wrongReasonSaving || !window.confirm('确定删除这条错因吗？删除后 AI 不会自动补回，除非你主动重新分析。')) return;
    try {
      setWrongReasonSaving(true);
      setFeedback('');
      await onPatchNote(note.noteUid, { wrongReason: '', wrongReasonPath: [] });
      setWrongReasonEditor(null);
      setFeedback('错因已删除。');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '错因删除失败，请稍后重试。');
    } finally {
      setWrongReasonSaving(false);
    }
  };

  const analyzeWrongReason = async (note: LearningAutoNote) => {
    if (wrongReasonSaving) return;
    try {
      setWrongReasonSaving(true);
      setFeedback('');
      const result = await analyzeLearningNoteWrongReason(note.noteUid);
      setFeedback(result.queued ? '已转入后台分析；完成后错因会自动更新。' : '这条笔记的分析任务已在队列中。');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '无法启动错因分析。');
    } finally {
      setWrongReasonSaving(false);
    }
  };

  const splitEditorTags = (value: string): string[] => uniqueText(
    value.split(/[#，,；;\n]+/u),
  ).slice(0, 20);

  const beginCreateNote = (kind: LearningItemKind, isGood = false) => {
    setNoteEditor({
      mode: 'create',
      noteUid: null,
      originalSubject: '',
      kind,
      title: '',
      remark: '',
      subject: STANDARD_EXAM_SUBJECTS[0],
      knowledgePoint: '',
      questionTypePath: [],
      wrongReason: '',
      wrongReasonPath: [],
      learningTypePath: kind === 'memory' ? ['基础知识', '定义概念'] : [],
      tags: [kind === 'mistake' ? '错题' : kind === 'memory' ? '背诵' : '', isGood ? '好题' : ''].filter(Boolean).join('，'),
      isGood,
      goodQuestionType: isGood ? '经典母题' : '',
      createCard: kind !== 'knowledge',
    });
    setFeedback('');
  };

  const beginEditNote = (note: LearningAutoNote) => {
    const kind: LearningItemKind = isQuickNote(note)
      ? 'quick'
      : isMistakeNote(note)
        ? 'mistake'
        : isMemoryNote(note)
          ? 'memory'
          : 'knowledge';
    setNoteEditor({
      mode: 'edit',
      noteUid: note.noteUid,
      originalSubject: note.subject,
      kind,
      title: note.title,
      remark: note.remark,
      subject: note.subject,
      knowledgePoint: noteKnowledgePoints(note)[0] ?? '',
      questionTypePath: questionTypePathForNote(note),
      wrongReason: noteWrongReasons(note)[0] ?? '',
      wrongReasonPath: wrongReasonPathForNote(note),
      learningTypePath: learningTypePathForNote(note),
      tags: note.tags.join('，'),
      isGood: isGoodNote(note),
      goodQuestionType: isGoodNote(note) ? goodQuestionTypeForNote(note) : '',
      createCard: false,
    });
    setFeedback('');
  };

  const saveNoteEditor = async () => {
    if (!noteEditor || editorSaving) return;
    const title = noteEditor.title.trim()
      || (noteEditor.kind === 'quick' ? noteEditor.remark.split(/\r?\n/u).map((line) => line.trim()).find(Boolean)?.slice(0, 36) || '' : '');
    const subject = noteEditor.subject.trim();
    if (!title) {
      setFeedback('请填写标题。');
      return;
    }
    const keepsExistingSubject = noteEditor.mode === 'edit' && subject === noteEditor.originalSubject;
    if (!keepsExistingSubject && !subjectOptions.includes(subject)) {
      setFeedback('请选择已有的一级科目。');
      return;
    }
    const knowledgePoint = noteEditor.knowledgePoint.trim();
    const tags = splitEditorTags(noteEditor.tags).filter((tag) => tag !== '好题');
    if (noteEditor.kind === 'mistake' && !tags.includes('错题')) tags.push('错题');
    if (noteEditor.kind === 'memory' && !tags.includes('背诵')) tags.push('背诵');
    if (noteEditor.isGood) tags.push('好题');
    const noteType = noteEditor.kind;
    const questionTypePath = normalizeLearningPath(noteEditor.questionTypePath);
    const common = {
      title,
      remark: noteEditor.remark.trim(),
      subject,
      knowledgePath: [subject, knowledgePoint].filter(Boolean),
      questionType: questionTypePath[questionTypePath.length - 1] ?? '',
      questionTypePath,
      wrongReason: noteEditor.wrongReason.trim(),
      wrongReasonPath: noteEditor.kind === 'mistake' ? normalizeLearningPath(noteEditor.wrongReasonPath) : [],
      learningTypePath: noteEditor.kind === 'quick' ? [] : normalizeLearningPath(noteEditor.learningTypePath),
      noteType,
      tags,
      goodQuestion: noteEditor.isGood,
      goodQuestionType: noteEditor.isGood ? noteEditor.goodQuestionType || '经典母题' : '',
    };
    try {
      setEditorSaving(true);
      setFeedback('');
      if (noteEditor.mode === 'create') {
        await onCreateNote({
          ...common,
          capturedDate: today,
          createCard: noteEditor.createCard,
        });
        setFeedback('已新增');
      } else if (noteEditor.noteUid) {
        const existing = Object.values(snapshot.days)
          .flatMap((day) => day.autoNotes)
          .find((note) => note.noteUid === noteEditor.noteUid);
        const patch: LearningNotePatch = { ...common };
        if (existing) {
          const sameList = (left: string[], right: string[]) => (
            JSON.stringify(left) === JSON.stringify(right)
          );
          if (patch.title === existing.title) delete patch.title;
          if (patch.remark === existing.remark) delete patch.remark;
          if (patch.subject === existing.subject) delete patch.subject;
          if (sameList(patch.knowledgePath ?? [], existing.knowledgePath ?? [])) delete patch.knowledgePath;
          if (patch.questionType === existing.questionType) delete patch.questionType;
          if (sameList(patch.questionTypePath ?? [], existing.questionTypePath ?? [])) delete patch.questionTypePath;
          if (patch.wrongReason === existing.wrongReason) delete patch.wrongReason;
          if (sameList(patch.wrongReasonPath ?? [], existing.wrongReasonPath ?? [])) delete patch.wrongReasonPath;
          if (sameList(patch.learningTypePath ?? [], existing.learningTypePath ?? [])) delete patch.learningTypePath;
          if (patch.noteType === existing.noteType) delete patch.noteType;
          if (sameList(patch.tags ?? [], existing.tags ?? [])) delete patch.tags;
          if (patch.goodQuestion === existing.goodQuestion) delete patch.goodQuestion;
          if (patch.goodQuestionType === existing.goodQuestionType) delete patch.goodQuestionType;
        }
        if (Object.keys(patch).length > 0) await onPatchNote(noteEditor.noteUid, patch);
        setFeedback('已保存');
      }
      setNoteEditor(null);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '内容没有保存，请稍后重试。');
    } finally {
      setEditorSaving(false);
    }
  };

  const deleteNote = async (note: LearningAutoNote) => {
    if (editorSaving || !window.confirm(`确定从学习中心删除“${note.title || '未命名笔记'}”吗？原始图片不会被删除。`)) return;
    try {
      setEditorSaving(true);
      await onDeleteNote(note.noteUid);
      setSelectedNoteUid(null);
      setSelectedInboxKey(null);
      setFeedback('已删除（原图保留）');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '删除失败，请稍后重试。');
    } finally {
      setEditorSaving(false);
    }
  };

  const beginEditCard = (card: LearningCard) => {
    setCardEditor({ cardId: card.id, front: card.front, back: card.back });
    setFeedback('');
  };

  const saveCardEditor = async () => {
    if (!cardEditor || editorSaving) return;
    if (!cardEditor.front.trim() || !cardEditor.back.trim()) {
      setFeedback('卡片的正面和答案都要填写。');
      return;
    }
    try {
      setEditorSaving(true);
      await onPatchCard(cardEditor.cardId, {
        front: cardEditor.front.trim(),
        back: cardEditor.back.trim(),
        userEdited: true,
      });
      setCardEditor(null);
      setFeedback('已保存');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '卡片没有保存，请稍后重试。');
    } finally {
      setEditorSaving(false);
    }
  };

  const deleteCard = async (card: LearningCard) => {
    if (editorSaving || !window.confirm(`确定删除卡片“${card.front || card.sourceTitle || '未命名卡片'}”吗？`)) return;
    try {
      setEditorSaving(true);
      await onDeleteCard(card.id);
      setSelectedCardId(null);
      setSelectedInboxKey(null);
      setCardEditor(null);
      setFeedback('已删除');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '卡片删除失败，请稍后重试。');
    } finally {
      setEditorSaving(false);
    }
  };

  const toggleGoodImportSelection = (noteUid: string) => {
    setGoodImportSelection((current) => current.includes(noteUid)
      ? current.filter((item) => item !== noteUid)
      : [...current, noteUid]);
  };

  const toggleAllVisibleGoodImport = () => {
    setGoodImportSelection((current) => allVisibleGoodImportSelected
      ? current.filter((noteUid) => !visibleGoodImportIds.includes(noteUid))
      : uniqueText([...current, ...visibleGoodImportIds]));
  };

  const importSelectedMistakes = async () => {
    if (editorSaving) return;
    const selected = importableMistakes.filter(({ note }) => goodImportSelection.includes(note.noteUid));
    if (selected.length === 0) {
      setFeedback('请至少选择一道错题。');
      return;
    }
    try {
      setEditorSaving(true);
      for (const { note } of selected) {
        await onPatchNote(note.noteUid, {
          goodQuestion: true,
          tags: uniqueText([...note.tags, '好题']),
        });
      }
      setGoodImportOpen(false);
      setGoodImportQuery('');
      setGoodImportSelection([]);
      setFeedback(`已导入 ${selected.length} 道`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '导入失败，请稍后重试。');
    } finally {
      setEditorSaving(false);
    }
  };

  const removeFromGoodQuestions = async (note: LearningAutoNote) => {
    if (pendingNoteUid || editorSaving) return;
    try {
      setPendingNoteUid(note.noteUid);
      await onPatchNote(note.noteUid, { goodQuestion: false });
      setSelectedNoteUid(null);
      setFeedback('已移出好题');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '移出好题失败，请稍后重试。');
    } finally {
      setPendingNoteUid(null);
    }
  };

  const recoverQuickAsset = useCallback((note: LearningAutoNote, item: WorkspaceAssetPreviewItem) => {
    if (!item.fallbackPath || note.attachments.length === 0) return;
    const attachments = note.attachments.map((attachment) => attachment.id === item.id
      ? { ...attachment, filePath: item.fallbackPath }
      : attachment);
    void Promise.resolve(onPatchNote(note.noteUid, { attachments })).catch(() => undefined);
  }, [onPatchNote]);

  const appendQuickAttachments = async (
    note: LearningAutoNote,
    files: File[],
    requestedOperationId?: string,
  ): Promise<QuickHtmlAttachOutcome> => {
    if (files.length === 0) return { status: 'rejected', message: '没有可加入的资料。' };
    if (pendingNoteUid) return { status: 'retryable', message: '当前速记还有保存任务，请稍后重试。' };
    const existingCount = note.attachments.length;
    const existingBytes = note.attachments.reduce((sum, attachment) => sum + Math.max(0, Number(attachment.size) || 0), 0);
    const addedBytes = files.reduce((sum, file) => sum + file.size, 0);
    const operationId = requestedOperationId || `material-${crypto.randomUUID()}`;
    const sizeLabel = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes >= 1024 * 1024 ? 1 : 2)} MB`;
    if (files.some((file) => file.size > 8 * 1024 * 1024) || existingBytes + addedBytes > 16 * 1024 * 1024) {
      setQuickAppendStatus({
        noteUid: note.noteUid,
        tone: 'error',
        operationId,
        message: `已有 ${sizeLabel(existingBytes)}，本次 ${sizeLabel(addedBytes)}；单份最多 8 MB，合计最多 16 MB。`,
      });
      return { status: 'rejected', message: '资料超过当前 8 MB 单文件或 16 MB 总量保护限制。' };
    }
    try {
      setPendingNoteUid(note.noteUid);
      setFeedback('正在加入资料…');
      setQuickAppendRetry(null);
      setQuickAppendStatus({
        noteUid: note.noteUid,
        tone: 'info',
        operationId,
        message: `正在保存：已有 ${existingCount} 份 + 本次 ${files.length} 份，共 ${sizeLabel(existingBytes + addedBytes)}。`,
      });
      await upsertActivityTask(createActivityTask({
        id: `material:${operationId}`,
        sourceId: operationId,
        kind: 'material_append',
        status: 'uploading',
        title: `添加资料：${note.title || '未命名速记'}`,
        message: `正在保存 ${files.length} 份资料`,
        progress: 35,
        targetUrl: `?panel=learning&view=quick&noteUid=${encodeURIComponent(note.noteUid)}`,
        canRetry: false,
        canCancel: false,
      }));
      const result = await appendLearningMaterials({
        operationId,
        noteUid: note.noteUid,
        title: note.title,
        remark: note.remark,
        subject: note.subject,
        tags: note.tags,
        facets: note.facets,
        files,
      });
      if (result.learningData) onApplySnapshot(result.learningData);
      await patchActivityTask(`material:${operationId}`, {
        status: 'completed',
        progress: 100,
        message: result.idempotentReplay ? '资料已存在，没有重复创建' : `已安全保存 ${files.length} 份资料`,
        completedAt: new Date().toISOString(),
      });
      setFeedback('');
      setQuickAppendStatus({
        noteUid: note.noteUid,
        tone: 'success',
        operationId: result.operationId || operationId,
        message: result.idempotentReplay
          ? '这些资料已经保存过，没有重复创建附件。'
          : `已安全加入 ${files.length} 份资料；需要时可点击“AI命名资料”单次整理。`,
      });
      return {
        status: result.idempotentReplay ? 'replayed' : 'saved',
        message: result.idempotentReplay ? '这份资料已经安全保存，没有重复创建。' : '已加入本条速记。',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '资料没有加入，请稍后重试';
      try {
        const refreshed = await fetchLearningData();
        const refreshedNote = Object.values(refreshed.days)
          .flatMap((day) => day.autoNotes)
          .find((candidate) => candidate.noteUid === note.noteUid);
        if (refreshedNote && refreshedNote.attachments.length > existingCount) {
          onApplySnapshot(refreshed);
          setFeedback('');
          setQuickAppendStatus({
            noteUid: note.noteUid,
            tone: 'success',
            operationId,
            message: '资料实际已经保存，刚才只是网络响应丢失；已主动刷新为最新记录。',
          });
          setQuickAppendRetry(null);
          await patchActivityTask(`material:${operationId}`, {
            status: 'completed',
            progress: 100,
            message: '资料已保存，网络回执曾中断',
            completedAt: new Date().toISOString(),
          });
          return { status: 'saved', message: '资料已经保存；刚才只是网络回执中断。' };
        }
      } catch {
        // Keep the original error and allow an idempotent retry with the same operation ID.
      }
      setFeedback('');
      setQuickAppendRetry({ note, files, operationId });
      await patchActivityTask(`material:${operationId}`, {
        status: 'failed_retryable',
        progress: 35,
        message: '保存尚未确认，可从当前速记安全重试',
        error: message,
        canRetry: true,
      });
      setQuickAppendStatus({
        noteUid: note.noteUid,
        tone: 'error',
        operationId,
        message: `${message} 未确认保存，可使用同一操作安全重试。`,
      });
      return { status: 'retryable', message };
    } finally {
      setPendingNoteUid(null);
    }
  };

  const removeQuickAttachment = async (note: LearningAutoNote, attachmentId: string) => {
    const attachments = note.attachments.filter((attachment) => attachment.id !== attachmentId);
    if (attachments.length === note.attachments.length || pendingNoteUid) return;
    if (!window.confirm('从这条速记中移除这份资料吗？原文件会保留，避免误删。')) return;
    try {
      setPendingNoteUid(note.noteUid);
      setFeedback('');
      if (IS_CLOUD_RUNTIME) {
        await updateCloudEntryAssets(
          note.noteUid,
          attachments.map((attachment) => attachment.assetId || attachment.id),
        );
      }
      await onPatchNote(note.noteUid, { attachments });
      setActiveQuickAssets((current) => {
        if (current[note.noteUid] !== attachmentId) return current;
        const { [note.noteUid]: _removed, ...rest } = current;
        return rest;
      });
      setFeedback('资料已从这条速记移除，原文件仍保留');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '资料没有移除，请稍后重试');
    } finally {
      setPendingNoteUid(null);
    }
  };

  const setPrimaryAttachment = async (note: LearningAutoNote, attachmentId: string) => {
    const sourceAttachments = note.attachments.length > 0 ? note.attachments : noteAttachments(note);
    const selectedIndex = sourceAttachments.findIndex((attachment) => attachment.id === attachmentId);
    if (selectedIndex <= 0 || pendingNoteUid) return;
    const selected = sourceAttachments[selectedIndex];
    const attachments = [
      selected,
      ...sourceAttachments.filter((attachment) => attachment.id !== attachmentId),
    ];
    try {
      setPendingNoteUid(note.noteUid);
      setFeedback('正在更新首个展示资料…');
      if (IS_CLOUD_RUNTIME && attachments.every((attachment) => attachment.assetId)) {
        const orderedAssetIds = attachments.map((attachment) => attachment.assetId).filter((assetId): assetId is string => Boolean(assetId));
        const result = await updateCloudEntryAssets(
          note.noteUid,
          orderedAssetIds,
        );
        if (result?.learningData) onApplySnapshot(result.learningData);
        else onApplySnapshot(await fetchLearningData());
      } else {
        await onPatchNote(note.noteUid, { attachments });
      }
      setActiveQuickAssets((current) => ({ ...current, [note.noteUid]: attachmentId }));
      setFeedback(`已将“${selected.name}”设为首个展示资料`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '首个展示资料没有更新，请重试');
    } finally {
      setPendingNoteUid(null);
    }
  };

  const beginInlineDetach = (
    event: ReactPointerEvent<HTMLElement>,
    note: LearningAutoNote,
    attachmentId: string,
    onSelect?: () => void,
  ) => {
    const assets = quickPreviewAssets(note);
    const asset = assets.find((item) => item.id === attachmentId);
    if (!asset) return;
    detachLayerRef.current?.begin(event, asset, assets, {
      onSelect,
      onRecovered: (item) => recoverQuickAsset(note, item),
    });
  };

  const beginQuickAssetDrag = (
    event: ReactDragEvent<HTMLButtonElement>,
    note: LearningAutoNote,
    asset: WorkspaceAssetPreviewItem,
    assets: WorkspaceAssetPreviewItem[],
  ) => {
    quickDragCleanupRef.current?.();
    setActiveQuickAssets((current) => ({ ...current, [note.noteUid]: asset.id }));
    beginCrossBrowserRelayDrag(event.dataTransfer, asset);

    const recognizesCurrentDrag = (dataTransfer: DataTransfer | null) => (
      Array.from(dataTransfer?.types || [], (type) => String(type).toLowerCase())
        .includes('application/x-kaoyan-material-v1')
    );
    const cleanup = () => {
      document.removeEventListener('dragover', handleSourceDragOver, true);
      document.removeEventListener('drop', handleSourceDrop, true);
      if (quickDragCleanupRef.current === cleanup) quickDragCleanupRef.current = null;
    };
    const handleSourceDragOver = (next: DragEvent) => {
      if (!recognizesCurrentDrag(next.dataTransfer)) return;
      next.preventDefault();
      if (next.dataTransfer) next.dataTransfer.dropEffect = 'copy';
    };
    const handleSourceDrop = (next: DragEvent) => {
      if (!recognizesCurrentDrag(next.dataTransfer)) return;
      next.preventDefault();
      next.stopPropagation();
      cleanup();
      detachLayerRef.current?.spawnAt(asset, assets, next.clientX, next.clientY, {
        onRecovered: (item) => recoverQuickAsset(note, item),
      });
    };
    document.addEventListener('dragover', handleSourceDragOver, true);
    document.addEventListener('drop', handleSourceDrop, true);
    quickDragCleanupRef.current = cleanup;
  };

  const finishQuickAssetDrag = () => {
    quickDragCleanupRef.current?.();
  };

  const beginQuickAssetRailResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const divider = event.currentTarget;
    const workspace = divider.closest<HTMLElement>('.lc-quick-material-workspace');
    if (!workspace) return;
    quickRailResizeCleanupRef.current?.();
    const startX = event.clientX;
    const startWidth = quickAssetRailWidth;
    const workspaceWidth = workspace.getBoundingClientRect().width;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    workspace.classList.add('is-resizing-rail');
    divider.setPointerCapture?.(event.pointerId);

    const move = (next: PointerEvent) => {
      setQuickAssetRailWidth(clampQuickAssetRailWidth(startWidth + next.clientX - startX, workspaceWidth));
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      workspace.classList.remove('is-resizing-rail');
      if (quickRailResizeCleanupRef.current === cleanup) quickRailResizeCleanupRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', cleanup, { once: true });
    window.addEventListener('pointercancel', cleanup, { once: true });
    quickRailResizeCleanupRef.current = cleanup;
  };

  const resizeQuickAssetRailFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let nextWidth: number | null = null;
    if (event.key === 'ArrowLeft') nextWidth = quickAssetRailWidth - (event.shiftKey ? 32 : 12);
    if (event.key === 'ArrowRight') nextWidth = quickAssetRailWidth + (event.shiftKey ? 32 : 12);
    if (event.key === 'Home') nextWidth = QUICK_ASSET_RAIL_MIN_WIDTH;
    if (event.key === 'End') nextWidth = QUICK_ASSET_RAIL_MAX_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    const workspaceWidth = event.currentTarget.closest<HTMLElement>('.lc-quick-material-workspace')
      ?.getBoundingClientRect().width;
    setQuickAssetRailWidth(clampQuickAssetRailWidth(nextWidth, workspaceWidth));
  };

  const exportQuickJournal = async () => {
    if (quickExporting || visibleQuick.length === 0) return;
    try {
      setQuickExporting(true);
      setFeedback('');
      const { exportQuickJournalPackage } = await import('../utils/quickJournalExport');
      await exportQuickJournalPackage(visibleQuick.map((entry) => ({
        date: entry.date,
        note: entry.note,
        assets: quickPreviewAssets(entry.note),
      })));
      setFeedback('速记日记包已生成');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '速记日记导出失败');
    } finally {
      setQuickExporting(false);
    }
  };

  const addQuickFacet = async (note: LearningAutoNote, facet: Exclude<LearningRecordFacet, 'quick'>) => {
    if (pendingNoteUid || note.facets.includes(facet)) return;
    const label = QUICK_FACET_OPTIONS.find((item) => item.facet === facet)?.label || '分栏';
    try {
      setPendingNoteUid(note.noteUid);
      setFeedback('');
      await onPatchNote(note.noteUid, { facets: uniqueText([...note.facets, 'quick', facet]) as LearningRecordFacet[] });
      setQuickFacetMenuNoteUid(null);
      setFeedback(`已加入${label}，仍保留在速记中`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : `加入${label}失败，请稍后重试。`);
    } finally {
      setPendingNoteUid(null);
    }
  };

  const addStudyThought = async (note: LearningAutoNote) => {
    const text = thoughtDraft.trim();
    if (!text || thoughtSaving) return;
    try {
      setThoughtSaving(true);
      setFeedback('');
      await onPatchNote(note.noteUid, { thoughtAction: { action: 'add', text } });
      setThoughtDraft('');
      setFeedback('已记录');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '想法没有保存，请稍后重试。');
    } finally {
      setThoughtSaving(false);
    }
  };

  const saveStudyThought = async () => {
    if (!thoughtEditor || thoughtSaving) return;
    const text = thoughtEditor.text.trim();
    if (!text) {
      setFeedback('想法内容不能为空。');
      return;
    }
    try {
      setThoughtSaving(true);
      setFeedback('');
      await onPatchNote(thoughtEditor.noteUid, {
        thoughtAction: { action: 'update', id: thoughtEditor.thoughtId, text },
      });
      setThoughtEditor(null);
      setFeedback('已保存');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '修改没有保存，请稍后重试。');
    } finally {
      setThoughtSaving(false);
    }
  };

  const deleteStudyThought = async (note: LearningAutoNote, thoughtId: string) => {
    if (thoughtSaving || !window.confirm('确定删除这条想法吗？')) return;
    try {
      setThoughtSaving(true);
      setFeedback('');
      await onPatchNote(note.noteUid, { thoughtAction: { action: 'delete', id: thoughtId } });
      if (thoughtEditor?.thoughtId === thoughtId) setThoughtEditor(null);
      setFeedback('已删除');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '删除失败，请稍后重试。');
    } finally {
      setThoughtSaving(false);
    }
  };

  const renderSearch = (count: number, placeholder: string, addLabel?: string, onAdd?: () => void) => (
    <div className="lc-searchbar">
      <Search size={17} aria-hidden="true" />
      <input
        value={query}
        onChange={(event) => {
          semanticSearchRequestRef.current += 1;
          setQuery(event.target.value);
          setSearchMode('normal');
          setSemanticSearch({ query: '', loading: false, degraded: false, error: '', results: [] });
        }}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {query && <button type="button" onClick={() => {
        semanticSearchRequestRef.current += 1;
        setQuery('');
        setSearchMode('normal');
        setSemanticSearch({ query: '', loading: false, degraded: false, error: '', results: [] });
      }} aria-label="清空搜索"><X size={15} /></button>}
      <button
        className={`lc-search-mode${searchMode === 'ai' ? ' is-active' : ''}`}
        type="button"
        onClick={() => {
          const normalizedQuery = query.trim();
          if (!normalizedQuery || semanticSearch.loading) return;
          const requestId = semanticSearchRequestRef.current + 1;
          semanticSearchRequestRef.current = requestId;
          setSearchMode('ai');
          setSemanticSearch({ query: normalizedQuery, loading: true, degraded: false, error: '', results: [] });
          void searchLearningRecords(normalizedQuery, 'ai').then((response) => {
            if (semanticSearchRequestRef.current !== requestId) return;
            setSemanticSearch({
              query: normalizedQuery,
              loading: false,
              degraded: response.degraded === true,
              error: '',
              results: response.results || [],
            });
          }).catch((error) => {
            if (semanticSearchRequestRef.current !== requestId) return;
            setSemanticSearch({
              query: normalizedQuery,
              loading: false,
              degraded: true,
              error: error instanceof Error ? error.message : 'AI 搜索暂时不可用',
              results: [],
            });
          });
        }}
        title="按语义查找忘记关键词的资料；每次点击只请求一次"
        aria-pressed={searchMode === 'ai'}
        disabled={!query.trim() || semanticSearch.loading}
      >
        <Brain size={14} />{semanticSearch.loading ? 'AI搜索中' : 'AI搜索'}
      </button>
      <strong>{count}</strong>
      {addLabel && onAdd && <button className="lc-add-button" type="button" onClick={onAdd}><Plus size={15} />{addLabel}</button>}
    </div>
  );

  const noteViewerItems = (entries: IndexedNote[]): ImageViewerItem[] => entries.flatMap(({ note }) => noteAttachments(note)
    .filter((attachment) => attachment.kind === 'image' && attachment.filePath)
    .map((attachment) => ({
      id: `note:${note.noteUid}:${attachment.id}`,
      src: noteFileUrl(noteAttachmentPrimaryPath(note, attachment)),
      alt: `${note.title || '笔记'} · ${attachment.name}`,
    })));

  const openNoteViewer = (
    note: LearningAutoNote,
    context: 'mistake' | 'good' | 'memory' | 'library' | 'inbox',
  ) => {
    const items = noteViewerItems(context === 'inbox' ? pendingNotes : noteListForView);
    const index = items.findIndex((item) => item.id.startsWith(`note:${note.noteUid}:`));
    if (index >= 0) setImageViewer({ items, index });
  };

  const openCardViewer = (card: LearningCard) => {
    if (!card.sourceFilePath) return;
    const items: ImageViewerItem[] = [];
    reviewCards.forEach((item) => {
      const filePath = resolveCardImagePath(item);
      if (!filePath) return;
      items.push({
        id: `card:${item.id}`,
        src: noteFileUrl(filePath),
        alt: `${item.sourceTitle || item.front || '复习卡'}原图`,
      });
    });
    const index = items.findIndex((item) => item.id === `card:${card.id}`);
    if (index >= 0) setImageViewer({ items, index });
  };

  const changeImageViewerIndex = (index: number) => {
    if (!imageViewer || index < 0 || index >= imageViewer.items.length) return;
    const item = imageViewer.items[index];
    setImageViewer({ ...imageViewer, index });
    if (item.id.startsWith('card:')) {
      setSelectedCardId(item.id.slice(5));
      setRevealed(false);
    } else if (item.id.startsWith('note:')) {
      const noteUid = item.id.slice(5).split(':')[0];
      if (view === 'inbox') setSelectedInboxKey(`note:${noteUid}`);
      else setSelectedNoteUid(noteUid);
    }
  };

  const renderNoteButton = (entry: IndexedNote, context: 'mistake' | 'good' | 'memory' | 'quick' | 'library' | 'inbox') => {
    const { date, note } = entry;
    const knowledge = noteKnowledgePoints(note)[0];
    const pages = pageRefText(note);
    const wrongReason = noteWrongReasons(note)[0];
    const active = context === 'inbox'
      ? selectedInboxKey === `note:${note.noteUid}`
      : selectedNoteUid === note.noteUid;
    const thumbnailAttachment = noteImageAttachment(note);
    const thumbnailPaths = thumbnailAttachment ? noteAttachmentPaths(note, thumbnailAttachment) : [];
    return (
      <button
        className={`lc-note-button ${active ? 'active' : ''}`}
        key={`${context}:${note.noteUid}`}
        type="button"
        onClick={() => {
          if (context === 'inbox') setSelectedInboxKey(`note:${note.noteUid}`);
          else {
            setSelectedNoteUid(note.noteUid);
            if (context === 'quick') setQuickReaderMode('single');
          }
          setMobileListOpen(false);
        }}
      >
        <span className="lc-note-button-thumb" aria-hidden="true">
          {context === 'quick' ? <QuickNoteWatcher noteUid={note.noteUid} /> : <FileImage size={18} />}
          {thumbnailPaths.length > 0 && <ResilientNoteImage paths={thumbnailPaths} alt="" />}
        </span>
        <span className="lc-note-button-copy">
          <span className="lc-note-button-title">{note.title || note.remark || '未命名笔记'}</span>
          <span className="lc-note-button-meta">
            {(context === 'quick' || (context === 'library' && view !== 'library')) && <time>{formatShortDate(date)}</time>}
            {!isDefaultNoteBucket(note.subject) && <span>{displaySubject(note.subject)}</span>}
            {(pages || knowledge) && <span>{pages || knowledge}</span>}
          </span>
          {context === 'mistake' && (
            <span className="lc-note-button-foot">
              <em>{statusLabel[mistakeStatus(note, snapshot.cards, today)]}</em>
              {wrongReason && <span>{wrongReason}</span>}
            </span>
          )}
        </span>
      </button>
    );
  };

  const renderNoteDetail = (entry: IndexedNote | null, context: 'mistake' | 'good' | 'memory' | 'library' | 'inbox') => {
    if (!entry) {
      const requestedUid = requestedNoteUidRef.current;
      return (
        <div className="lc-detail-empty">
          <BookOpenText size={28} />
          <h3>{requestedUid ? (requestedNoteMissing ? '没有找到这条记录' : '正在定位指定记录') : '这里还没有记录'}</h3>
          {requestedUid && (
            <>
              <p>{requestedNoteMissing
                ? '同步已完成；这条记录可能已迁移、被删除，或不在当前分栏。'
                : '正在等待最新数据；不会打开其他无关记录。'}</p>
              <button type="button" onClick={() => {
                requestedNoteUidRef.current = null;
                setSelectedNoteUid(noteListForView[0]?.note.noteUid ?? null);
              }}>查看当前分栏</button>
            </>
          )}
        </div>
      );
    }
    const { date, note } = entry;
    const pages = pageRefText(note);
    const knowledgePoints = noteKnowledgePoints(note);
    const questionTypePath = questionTypePathForNote(note);
    const wrongReasonPath = wrongReasonPathForNote(note);
    const learningTypePath = learningTypePathForNote(note);
    const wrongReasons = noteWrongReasons(note);
    const itemSummary = note.items.slice(0, 8);
    const isEditingClassification = editingClassificationUid === note.noteUid && classificationDraft;
    const attachments = noteAttachments(note);
    const previewAssets = quickPreviewAssets(note);
    const activePreviewAsset = previewAssets.find((asset) => asset.id === activeQuickAssets[note.noteUid])
      || previewAssets[0]
      || null;
    const imageAttachment = noteImageAttachment(note);
    const imagePaths = imageAttachment ? noteAttachmentPaths(note, imageAttachment) : [];
    const imagePath = imagePaths[0] || '';
    const detailFacts = [
      !isDefaultNoteBucket(note.subject) ? { label: '科目', value: displaySubject(note.subject) } : null,
      pages ? { label: '页码 / 题号', value: pages } : null,
      knowledgePoints.length > 0 ? { label: '知识点', value: knowledgePoints.join('、') } : null,
      questionTypePath.length > 0 ? { label: '题型分类', value: classificationPathLabel(questionTypePath) } : null,
      learningTypePath.length > 0 ? { label: context === 'memory' ? '背诵类型' : '学习类型', value: classificationPathLabel(learningTypePath) } : null,
      context === 'good' ? { label: '好题类型', value: goodQuestionTypeForNote(note) } : null,
      context === 'mistake' && wrongReasonPath.length > 0
        ? { label: '错因分类', value: classificationPathLabel(wrongReasonPath) }
        : null,
      context === 'mistake' && wrongReasons.length > 0
        ? { label: '具体错因', value: wrongReasons.join('；'), wide: true }
        : null,
    ].filter((fact): fact is { label: string; value: string; wide?: boolean } => fact !== null);
    const sourcePreview = activePreviewAsset ? (
      <section className={`lc-detail-asset-preview is-${activePreviewAsset.kind}`} aria-label={`正在查看 ${activePreviewAsset.name}`}>
        <WorkspaceAssetPreview
          item={activePreviewAsset}
          assets={previewAssets}
          onRecovered={(item) => recoverQuickAsset(note, item)}
        />
      </section>
    ) : null;
    return (
      <article className="lc-note-detail">
        <button className="lc-mobile-back" type="button" onClick={() => setMobileListOpen(true)} aria-label="返回列表">
          <ChevronLeft size={20} />
        </button>
        {sourcePreview}
        {attachments.length > 0 && (
          <section className="lc-attachments" aria-label="资料附件">
            <div><h3>资料附件</h3><span>{attachments.length}</span></div>
            <ul>{attachments.map((attachment, index) => (
              <li className={activePreviewAsset?.id === attachment.id ? 'is-active' : ''} key={attachment.id}>
                <button
                  className="lc-attachment-open"
                  type="button"
                  aria-pressed={activePreviewAsset?.id === attachment.id}
                  title="点击查看；按住可拖出显示"
                  onClick={() => setActiveQuickAssets((current) => ({ ...current, [note.noteUid]: attachment.id }))}
                  onPointerDown={(event) => beginInlineDetach(event, note, attachment.id, () => {
                    setActiveQuickAssets((current) => ({ ...current, [note.noteUid]: attachment.id }));
                  })}
                >
                  <FileText size={17} aria-hidden="true" />
                  <span><strong>{attachment.name}</strong><small>{attachment.kind === 'image' ? '图片' : attachment.kind === 'pdf' ? 'PDF' : attachment.kind === 'word' ? 'Word' : attachment.kind === 'html' ? 'HTML' : '文件'}{attachment.size ? ` · ${Math.max(1, Math.round(attachment.size / 1024))} KB` : ''}</small></span>
                </button>
                {index === 0 ? <em className="lc-attachment-primary">首个展示</em> : (
                  <button
                    className="lc-attachment-make-primary"
                    type="button"
                    disabled={pendingNoteUid === note.noteUid}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => void setPrimaryAttachment(note, attachment.id)}
                  >设为首个</button>
                )}
              </li>
            ))}</ul>
          </section>
        )}

        <header className="lc-detail-heading">
          <h2>{note.title || '未命名笔记'}</h2>
          <div className="lc-heading-actions">
            {(imagePath || (note.sourceType === 'material-note' && attachments.length > 0)) && <button type="button" disabled={Boolean(aiRenameNoteUid)} onClick={() => void renameNoteWithAi(note)}><Zap size={15} />{aiRenameNoteUid === note.noteUid ? 'AI处理中…' : note.sourceType === 'material-note' ? 'AI命名资料' : 'AI重命名'}</button>}
            <button type="button" onClick={() => beginEditNote(note)}><Pencil size={15} />编辑</button>
            {context === 'good' && (
              <button type="button" disabled={pendingNoteUid === note.noteUid || editorSaving} onClick={() => void removeFromGoodQuestions(note)}><X size={15} />移出好题</button>
            )}
            <button className="danger" type="button" disabled={editorSaving} onClick={() => void deleteNote(note)}><Trash2 size={15} />删除</button>
            <time>{formatRecordDate(date)}</time>
          </div>
        </header>

        {note.remark && (
          <section className="lc-detail-section lc-note-remark">
            <h3>备注</h3>
            <p>{note.remark}</p>
          </section>
        )}

        {context === 'inbox' && !isEditingClassification && (
          <div className="lc-inbox-actions lc-inbox-note-actions">
            {!isDefaultNoteBucket(note.subject) && (
              <button
                className="primary"
                type="button"
                disabled={pendingNoteUid === note.noteUid}
                onClick={() => void reviewPendingNote(note, 'accept')}
              ><Check size={16} />确认</button>
            )}
            <button
              className={isDefaultNoteBucket(note.subject) ? 'primary' : ''}
              type="button"
              disabled={pendingNoteUid === note.noteUid}
              onClick={() => beginClassificationEdit(note)}
            ><Pencil size={16} />改分类</button>
            <button
              type="button"
              disabled={pendingNoteUid === note.noteUid}
              onClick={() => void ignorePendingNote(note)}
            ><Archive size={16} />忽略</button>
          </div>
        )}

        {isEditingClassification && (
          <form className="lc-classification-editor" onSubmit={(event) => { event.preventDefault(); void saveClassification(note); }}>
            <label>一级科目<select value={classificationDraft.subject} onChange={(event) => setClassificationDraft((current) => current ? {
              ...current,
              subject: event.target.value,
              knowledgePoint: '',
              questionTypePath: [],
              learningTypePath: [],
            } : current)} autoFocus>
              <option value="">请选择</option>
              {subjectOptions.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
            </select></label>
            <label>知识点<input list="lc-classification-knowledge-options" value={classificationDraft.knowledgePoint} onChange={(event) => setClassificationDraft((current) => current ? { ...current, knowledgePoint: event.target.value, questionTypePath: [], learningTypePath: [] } : current)} /></label>
            <div className="lc-classification-field wide"><span>题型分类（最多三级）</span><HierarchyPathInputs label="题型" value={classificationDraft.questionTypePath} onChange={(questionTypePath) => setClassificationDraft((current) => current ? { ...current, questionTypePath } : current)} /></div>
            <div className="lc-classification-field wide"><span>错因分类</span><HierarchyPathFilter label="错因" paths={wrongReasonEditorPaths} value={classificationDraft.wrongReasonPath} onChange={(wrongReasonPath) => setClassificationDraft((current) => current ? { ...current, wrongReasonPath } : current)} /></div>
            <label className="wide">具体错因<input value={classificationDraft.wrongReason} onChange={(event) => setClassificationDraft((current) => current ? { ...current, wrongReason: event.target.value } : current)} /></label>
            <div className="lc-classification-field wide"><span>学习内容类型</span><HierarchyPathFilter label="学习类型" paths={classificationLearningTypePaths} value={classificationDraft.learningTypePath} onChange={(learningTypePath) => setClassificationDraft((current) => current ? { ...current, learningTypePath } : current)} /></div>
            {isGoodNote(note) && <label>好题类型<select value={classificationDraft.goodQuestionType} onChange={(event) => setClassificationDraft((current) => current ? { ...current, goodQuestionType: event.target.value } : current)}>{GOOD_QUESTION_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>}
            <div className="lc-classification-actions">
              <button className="primary" type="submit" disabled={pendingNoteUid === note.noteUid}><Check size={15} />保存</button>
              <button type="button" onClick={() => { setEditingClassificationUid(null); setClassificationDraft(null); }}>取消</button>
            </div>
            <datalist id="lc-classification-knowledge-options">{classificationKnowledgePointOptions.map((point) => <option key={point} value={point} />)}</datalist>
          </form>
        )}

        {detailFacts.length > 0 && (
          <div className="lc-detail-facts">
            {detailFacts.map((fact) => (
              <div className={fact.wide ? 'lc-fact-wide' : ''} key={fact.label}>
                <span>{fact.label}</span><strong>{fact.value}</strong>
              </div>
            ))}
          </div>
        )}

        {itemSummary.length > 0 && (
          <section className="lc-detail-section">
            <h3>{itemSummary.length > 1 ? '识别内容' : '内容摘要'}</h3>
            <ol className="lc-detail-items">
              {itemSummary.map((item, index) => (
                <li key={`${note.noteUid}:detail:${index}`}>
                  <strong>{item.title || item.knowledgePoint || `内容 ${index + 1}`}</strong>
                  {item.summary && <p>{item.summary}</p>}
                  {itemSummary.length > 1 && [
                    item.knowledgePoint,
                    item.questionType,
                    item.wrongReason ? `错因：${item.wrongReason}` : '',
                  ].some(Boolean) && (
                    <span>{[
                      item.knowledgePoint,
                      item.questionType,
                      item.wrongReason ? `错因：${item.wrongReason}` : '',
                    ].filter(Boolean).join(' · ')}</span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}

        {note.tags.length > 0 && (
          <div className="lc-detail-tags"><Tag size={15} />{note.tags.slice(0, 10).map((tag) => <span key={tag}>#{tag}</span>)}</div>
        )}

        <section className="lc-thoughts" aria-labelledby={`thoughts-${note.noteUid}`}>
          <div className="lc-thoughts-heading">
            <h3 id={`thoughts-${note.noteUid}`}>学习想法</h3>
          </div>
          <form className="lc-thought-composer" onSubmit={(event) => { event.preventDefault(); void addStudyThought(note); }}>
            <textarea
              value={thoughtDraft}
              maxLength={4000}
              rows={3}
              onChange={(event) => setThoughtDraft(event.target.value)}
              placeholder="记录新想法"
              aria-label="记录新的学习想法"
            />
            <div>
              {thoughtDraft.length >= 3600 && <span>{thoughtDraft.length}/4000</span>}
              <button type="submit" disabled={!thoughtDraft.trim() || thoughtSaving}><Plus size={15} />记录</button>
            </div>
          </form>
          {note.studyNotes.length > 0 && (
            <ol className="lc-thought-list">
              {[...note.studyNotes].reverse().map((thought) => {
                const isEditing = thoughtEditor?.noteUid === note.noteUid && thoughtEditor.thoughtId === thought.id;
                return (
                  <li key={thought.id}>
                    {isEditing ? (
                      <form onSubmit={(event) => { event.preventDefault(); void saveStudyThought(); }}>
                        <textarea
                          value={thoughtEditor.text}
                          maxLength={4000}
                          rows={3}
                          autoFocus
                          onChange={(event) => setThoughtEditor({ ...thoughtEditor, text: event.target.value })}
                          aria-label="修改学习想法"
                        />
                        <div className="lc-thought-actions">
                          <button className="primary" type="submit" disabled={!thoughtEditor.text.trim() || thoughtSaving}><Save size={14} />保存</button>
                          <button type="button" disabled={thoughtSaving} onClick={() => setThoughtEditor(null)}>取消</button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <p>{thought.text}</p>
                        <footer>
                          <time>{new Date(thought.createdAt).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })}</time>
                          <div className="lc-thought-actions">
                            <button type="button" disabled={thoughtSaving} onClick={() => setThoughtEditor({ noteUid: note.noteUid, thoughtId: thought.id, text: thought.text })}><Pencil size={14} />修改</button>
                            <button className="danger" type="button" disabled={thoughtSaving} onClick={() => void deleteStudyThought(note, thought.id)}><Trash2 size={14} />删除</button>
                          </div>
                        </footer>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {note.filePath && (
          <section className="lc-source-row" aria-label="原图操作">
            {!IS_CLOUD_RUNTIME && (
              <>
                <button type="button" onClick={() => void handleSourcePath(note.filePath)}><FolderOpen size={16} />定位原图</button>
                <button type="button" onClick={() => void copySourcePath(note.filePath)} aria-label="复制原图路径" title="复制原图路径"><Copy size={16} /></button>
              </>
            )}
            <button type="button" onClick={() => onOpenDate(date)}>当天记录</button>
          </section>
        )}
        {(pendingNoteUid === note.noteUid || feedback || sourceFeedback) && (
          <div className="lc-source-feedback visible" role="status">
            {pendingNoteUid === note.noteUid ? '保存中…' : feedback || sourceFeedback}
          </div>
        )}
      </article>
    );
  };

  const renderReview = () => (
    <div className="lc-review-layout">
      <aside className="lc-review-queue" aria-label="今日复习队列">
        <div className="lc-review-summary">
          <div><strong>本轮复习</strong><span>{reviewCompleted} / {reviewSessionTotal}</span></div>
          <div className="lc-review-progress" aria-label={`本轮已完成 ${reviewCompleted} 张`}>
            <span style={{ width: `${reviewSessionTotal > 0 ? Math.min(100, reviewCompleted / reviewSessionTotal * 100) : 100}%` }} />
          </div>
          <p>总待复习 {dueCards.length + reviewCompleted} 张，先完成一轮，不被历史欠债淹没。</p>
        </div>
        <div className="lc-queue-list">
          {reviewCards.map((card) => (
            <button
              className={currentCard?.id === card.id ? 'active' : ''}
              key={card.id}
              type="button"
              onClick={() => { setSelectedCardId(card.id); setRevealed(false); setFeedback(''); }}
            >
              <span>{card.front || card.sourceTitle || '未命名卡片'}</span>
              <span className="lc-queue-meta"><em>{card.kind === 'mistake' ? '错题' : '背诵'}</em>{displaySubject(card.subject)}</span>
            </button>
          ))}
          {deferredDueCount > 0 && <div className="lc-queue-footnote">另有 {deferredDueCount} 张欠债留待下一轮</div>}
          {upcomingCards.length > 0 && <div className="lc-queue-footnote">未来已排期 {upcomingCards.length} 张</div>}
        </div>
      </aside>

      <section className="lc-card-stage" aria-live="polite">
        {currentCard ? (
          <>
            {currentCardResolvedPath && (
              <figure className="lc-source-preview lc-review-source-preview">
                {failedImagePath !== currentCardResolvedPath ? (
                  <button
                    className="lc-source-preview-open"
                    type="button"
                    onClick={() => openCardViewer(currentCard)}
                    aria-label="打开原图"
                  >
                    <img
                      src={noteFileUrl(currentCardResolvedPath)}
                      alt={`${currentCard.sourceTitle || currentCard.front || '复习卡'}原图`}
                      decoding="async"
                      onError={() => setFailedImagePath(currentCardResolvedPath)}
                    />
                    <span aria-hidden="true"><ZoomIn size={16} /></span>
                  </button>
                ) : (
                  <div>
                    <FileImage size={28} />
                    <strong>原图加载失败</strong>
                    <button type="button" onClick={() => setFailedImagePath('')}>重试</button>
                  </div>
                )}
              </figure>
            )}

            <header className="lc-card-heading">
              <div>
                <span className={`lc-kind lc-kind-${currentCard.kind}`}>{currentCard.kind === 'mistake' ? '错题卡' : '背诵卡'}</span>
                <strong>{currentCard.subject || '未分类'}</strong>
              </div>
              <span className="lc-card-count">{currentCardIndex + 1} / {reviewCards.length}</span>
            </header>

            <button
              className={`lc-flip-card ${revealed ? 'is-revealed' : ''}`}
              type="button"
              title={revealed ? '隐藏答案' : '显示答案 (Space)'}
              onClick={() => setRevealed((value) => !value)}
            >
              <span className="lc-card-side-label">{revealed ? '答案' : '问题'}</span>
              <p>{revealed
                ? currentCard.back || '这张卡片还没有答案。'
                : currentCard.front || currentCard.sourceTitle || '请回忆这条笔记的核心内容。'}</p>
            </button>

            {currentCard.tags.length > 0 && <div className="lc-card-meta">
              {currentCard.tags.slice(0, 4).map((tag) => <em key={tag}>#{tag}</em>)}
            </div>}

            <div className="lc-card-controls">
              <button type="button" onClick={() => stepCard(-1)} disabled={reviewCards.length < 2} aria-label="上一张"><ChevronLeft size={18} /></button>
              <button type="button" disabled={Boolean(pendingCardId) || editorSaving} onClick={() => beginEditCard(currentCard)}><Pencil size={16} />编辑</button>
              {currentCardIsDue ? (
                <>
                  <button className="lc-action-forgot" type="button" disabled={Boolean(pendingCardId)} onClick={() => patchCurrentCard({ reviewRating: 'again' }, '已放回短期复习队列。')}><RotateCcw size={16} />重来 <kbd>1</kbd></button>
                  <button type="button" disabled={Boolean(pendingCardId)} onClick={() => patchCurrentCard({ reviewRating: 'hard' }, '已按“困难”安排下次复习。')}>困难 <kbd>2</kbd></button>
                  <button className="lc-action-primary" type="button" disabled={Boolean(pendingCardId)} onClick={() => patchCurrentCard({ reviewRating: 'good' }, '已按“良好”延长复习间隔。')}><Check size={16} />良好 <kbd>3</kbd></button>
                  <button type="button" disabled={Boolean(pendingCardId)} onClick={() => patchCurrentCard({ reviewRating: 'easy' }, '已按“轻松”安排更长间隔。')}>轻松 <kbd>4</kbd></button>
                </>
              ) : <span className="lc-card-count">计划 {currentCard.dueDate} 复习</span>}
              {currentCardResolvedPath && <button type="button" onClick={() => void handleSourcePath(currentCardResolvedPath)}><FolderOpen size={16} />定位</button>}
              <button className="danger" type="button" disabled={Boolean(pendingCardId) || editorSaving} onClick={() => void deleteCard(currentCard)}><Trash2 size={16} />删除</button>
              <button type="button" onClick={() => stepCard(1)} disabled={reviewCards.length < 2} aria-label="下一张"><ChevronRight size={18} /></button>
            </div>
            {(pendingCardId || feedback || sourceFeedback) && (
              <div className="lc-feedback visible" role="status">{pendingCardId ? '保存中…' : feedback || sourceFeedback}</div>
            )}
          </>
        ) : (
          <div className="lc-detail-empty">
            <Check size={28} />
            <h3>{dueCards.length > 0 ? '本轮复习已完成' : '今天的复习已完成'}</h3>
            {dueCards.length > 0 && (
              <>
                <p>剩余 {dueCards.length} 张仍会保留，不会丢失。</p>
                <button className="primary" type="button" onClick={() => setReviewSessionTarget((value) => value + REVIEW_CONTINUE_SIZE)}>状态不错，再来 {REVIEW_CONTINUE_SIZE} 张</button>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );

  const renderMistakes = () => (
    <div className={`lc-workspace ${mobileListOpen ? 'is-list-open' : 'is-detail-open'}`}>
      <aside className="lc-master-pane">
        {renderSearch(visibleMistakes.length, '搜索错题、页码或备注', '新增错题', () => beginCreateNote('mistake'))}
        <div className="lc-filters" aria-label="错题筛选">
          <select value={mistakeFilters.subject} onChange={(event) => setMistakeFilters((current) => ({ ...current, subject: event.target.value, knowledgePoint: '', questionTypePath: [], wrongReasonPath: [] }))} aria-label="按科目筛选">
            <option value="">全部科目</option>
            {mistakeFacets.subjects.map((value) => <option key={value} value={value}>{displaySubject(value)}</option>)}
          </select>
          <select value={mistakeFilters.knowledgePoint} onChange={(event) => setMistakeFilters((current) => ({ ...current, knowledgePoint: event.target.value, questionTypePath: [], wrongReasonPath: [] }))} aria-label="按知识点筛选">
            <option value="">全部知识点</option>
            {mistakeFacets.knowledgePoints.map((value) => <option key={value}>{value}</option>)}
          </select>
          <HierarchyPathFilter label="题型" paths={mistakeFacets.questionTypePaths} value={mistakeFilters.questionTypePath} onChange={(questionTypePath) => setMistakeFilters((current) => ({ ...current, questionTypePath }))} />
          <HierarchyPathFilter label="错因" paths={mistakeFacets.wrongReasonPaths} value={mistakeFilters.wrongReasonPath} onChange={(wrongReasonPath) => setMistakeFilters((current) => ({ ...current, wrongReasonPath }))} />
          <select value={mistakeFilters.status} onChange={(event) => setMistakeFilters((current) => ({ ...current, status: event.target.value as MistakeStatus }))} aria-label="按复习状态筛选">
            <option value="all">全部状态</option>
            <option value="due">待重做</option>
            <option value="reviewing">复习中</option>
            <option value="mastered">已掌握</option>
            <option value="untracked">未加入复习</option>
          </select>
          {(mistakeFilters.subject
            || mistakeFilters.knowledgePoint
            || mistakeFilters.questionTypePath.length > 0
            || mistakeFilters.wrongReasonPath.length > 0
            || mistakeFilters.status !== 'all') && (
            <button type="button" onClick={() => setMistakeFilters(EMPTY_FILTERS)}>清除筛选</button>
          )}
        </div>
        <div className="lc-master-list">
          {visibleMistakes.map((entry) => renderNoteButton(entry, 'mistake'))}
          {visibleMistakes.length === 0 && <div className="lc-list-empty"><TriangleAlert size={23} /><strong>没有匹配的错题</strong></div>}
        </div>
      </aside>
      <section className="lc-detail-pane">{renderNoteDetail(selectedNote, 'mistake')}</section>
    </div>
  );

  const renderMemory = () => (
    <div className={`lc-workspace ${mobileListOpen ? 'is-list-open' : 'is-detail-open'}`}>
      <aside className="lc-master-pane">
        {renderSearch(visibleMemory.length, '搜索背诵内容、页码或知识点', '新增背诵', () => beginCreateNote('memory'))}
        <div className="lc-filters" aria-label="背诵内容筛选">
          <select value={memoryFilters.subject} onChange={(event) => setMemoryFilters({ subject: event.target.value, knowledgePoint: '', learningTypePath: [] })} aria-label="按科目筛选背诵内容">
            <option value="">全部科目</option>
            {memoryFacets.subjects.map((value) => <option key={value} value={value}>{displaySubject(value)}</option>)}
          </select>
          <select value={memoryFilters.knowledgePoint} onChange={(event) => setMemoryFilters((current) => ({ ...current, knowledgePoint: event.target.value, learningTypePath: [] }))} aria-label="按知识点筛选背诵内容">
            <option value="">全部知识点</option>
            {memoryFacets.knowledgePoints.map((value) => <option key={value}>{value}</option>)}
          </select>
          <HierarchyPathFilter label="背诵类型" paths={memoryFacets.learningTypePaths} value={memoryFilters.learningTypePath} onChange={(learningTypePath) => setMemoryFilters((current) => ({ ...current, learningTypePath }))} />
          {(memoryFilters.subject || memoryFilters.knowledgePoint || memoryFilters.learningTypePath.length > 0) && (
            <button type="button" onClick={() => setMemoryFilters(EMPTY_CONTENT_FILTERS)}>清除筛选</button>
          )}
        </div>
        <div className="lc-master-list">
          {visibleMemory.map((entry) => renderNoteButton(entry, 'memory'))}
          {visibleMemory.length === 0 && <div className="lc-list-empty"><Brain size={23} /><strong>还没有背诵内容</strong></div>}
        </div>
      </aside>
      <section className="lc-detail-pane">{renderNoteDetail(selectedNote, 'memory')}</section>
    </div>
  );

  const renderGoodQuestions = () => (
    <div className={`lc-workspace ${mobileListOpen ? 'is-list-open' : 'is-detail-open'}`}>
      <aside className="lc-master-pane">
        {renderSearch(visibleGood.length, '搜索好题、页码或知识点', '新增好题', () => beginCreateNote('knowledge', true))}
        <div className="lc-filters" aria-label="好题筛选">
          <select value={goodFilters.subject} onChange={(event) => setGoodFilters({ subject: event.target.value, knowledgePoint: '', goodQuestionType: '' })} aria-label="按科目筛选好题">
            <option value="">全部科目</option>
            {goodFacets.subjects.map((value) => <option key={value} value={value}>{displaySubject(value)}</option>)}
          </select>
          <select value={goodFilters.knowledgePoint} onChange={(event) => setGoodFilters((current) => ({ ...current, knowledgePoint: event.target.value, goodQuestionType: '' }))} aria-label="按知识点筛选好题">
            <option value="">全部知识点</option>
            {goodFacets.knowledgePoints.map((value) => <option key={value}>{value}</option>)}
          </select>
          <select value={goodFilters.goodQuestionType} onChange={(event) => setGoodFilters((current) => ({ ...current, goodQuestionType: event.target.value }))} aria-label="按好题类型筛选">
            <option value="">全部好题类型</option>
            {goodFacets.goodQuestionTypes.map((value) => <option key={value}>{value}</option>)}
          </select>
          {(goodFilters.subject || goodFilters.knowledgePoint || goodFilters.goodQuestionType) && <button type="button" onClick={() => setGoodFilters(EMPTY_GOOD_FILTERS)}>清除筛选</button>}
        </div>
        <div className="lc-good-import-bar">
          <button
            type="button"
            disabled={importableMistakes.length === 0}
            onClick={() => {
              setGoodImportQuery('');
              setGoodImportSelection([]);
              setGoodImportOpen(true);
              setFeedback('');
            }}
          ><Plus size={15} />从错题导入{importableMistakes.length > 0 ? ` (${importableMistakes.length})` : ''}</button>
        </div>
        <div className="lc-master-list">
          {visibleGood.map((entry) => renderNoteButton(entry, 'good'))}
          {visibleGood.length === 0 && <div className="lc-list-empty"><Star size={23} /><strong>还没有收藏好题</strong></div>}
        </div>
      </aside>
      <section className="lc-detail-pane">{renderNoteDetail(selectedNote, 'good')}</section>
    </div>
  );

  const renderLibrary = () => (
    <div className={`lc-workspace ${mobileListOpen ? 'is-list-open' : 'is-detail-open'}`}>
      <aside className="lc-master-pane">
        {renderSearch(visibleLibrary.length, '搜索页码、题号、知识点或备注', '新增知识', () => beginCreateNote('knowledge'))}
        <div className="lc-filters" aria-label="知识内容筛选">
          <select value={libraryFilters.subject} onChange={(event) => setLibraryFilters({ subject: event.target.value, knowledgePoint: '', learningTypePath: [] })} aria-label="按科目筛选知识内容">
            <option value="">全部科目</option>
            {libraryFacets.subjects.map((value) => <option key={value} value={value}>{displaySubject(value)}</option>)}
          </select>
          <select value={libraryFilters.knowledgePoint} onChange={(event) => setLibraryFilters((current) => ({ ...current, knowledgePoint: event.target.value, learningTypePath: [] }))} aria-label="按知识点筛选知识内容">
            <option value="">全部知识点</option>
            {libraryFacets.knowledgePoints.map((value) => <option key={value}>{value}</option>)}
          </select>
          <HierarchyPathFilter label="内容类型" paths={libraryFacets.learningTypePaths} value={libraryFilters.learningTypePath} onChange={(learningTypePath) => setLibraryFilters((current) => ({ ...current, learningTypePath }))} />
          {(libraryFilters.subject || libraryFilters.knowledgePoint || libraryFilters.learningTypePath.length > 0) && (
            <button type="button" onClick={() => setLibraryFilters(EMPTY_CONTENT_FILTERS)}>清除筛选</button>
          )}
        </div>
        <div className="lc-master-list lc-grouped-list">
          {groupedLibrary.map(([date, entries]) => (
            <section className="lc-date-group" key={date}>
              <header><time>{formatRecordDate(date)}</time><span>{entries.length}</span></header>
              {entries.map((entry) => renderNoteButton(entry, 'library'))}
            </section>
          ))}
          {libraryVisibleLimit < visibleLibrary.length && (
            <button className="lc-load-more" type="button" onClick={() => setLibraryVisibleLimit((value) => value + LIBRARY_PAGE_SIZE)}>
              再显示 {Math.min(LIBRARY_PAGE_SIZE, visibleLibrary.length - libraryVisibleLimit)} 条
            </button>
          )}
          {visibleLibrary.length === 0 && <div className="lc-list-empty"><BookOpenText size={23} /><strong>没有匹配的笔记</strong></div>}
        </div>
      </aside>
      <section className="lc-detail-pane">{renderNoteDetail(selectedNote, 'library')}</section>
      {searchMode === 'ai' && query.trim() && (
        <span className={`lc-semantic-state${semanticSearch.error ? ' is-error' : ''}`}>
          {semanticSearch.loading
            ? '理解语义…'
            : semanticSearch.error
              ? '已回退关键词'
              : semanticSearch.degraded
                ? '语义降级'
                : ''}
        </span>
      )}
    </div>
  );

  const renderQuickEntry = (entry: IndexedNote) => {
    const { date, note } = entry;
    const assets = quickPreviewAssets(note);
    const activeAsset = assets.find((asset) => asset.id === activeQuickAssets[note.noteUid]) || assets[0] || null;
    const activeAssetSizeKey = activeAsset ? `${note.noteUid}:${activeAsset.id}` : '';
    const activeAssetSize = activeAssetSizeKey ? quickAssetIntrinsicSizes[activeAssetSizeKey] : null;
    const activeImageNeedsScroll = activeAsset?.kind === 'image'
      && activeAssetSize
      && activeAssetSize.height / activeAssetSize.width > .8;
    const paragraphs = note.remark.split(/\r?\n\s*\r?\n/u).map((item) => item.trim()).filter(Boolean);
    return (
      <article className="lc-quick-record" key={note.noteUid}>
        <header className="lc-quick-record-heading">
          <div className="lc-quick-record-meta">
            <time>{formatRecordDate(date)}</time>
            {!isDefaultNoteBucket(note.subject) && <span>{displaySubject(note.subject)}</span>}
          </div>
          <div className="lc-quick-record-title-row">
            <h1>{note.title || '未命名速记'}</h1>
            <div className="lc-quick-record-actions">
              <div className={`lc-quick-facet-picker${quickFacetMenuNoteUid === note.noteUid ? ' is-open' : ''}`}>
                <button
                  className="lc-quick-facet-trigger"
                  type="button"
                  aria-expanded={quickFacetMenuNoteUid === note.noteUid}
                  onClick={() => setQuickFacetMenuNoteUid((current) => current === note.noteUid ? null : note.noteUid)}
                >
                  <Plus size={14} />加入分栏
                </button>
                {quickFacetMenuNoteUid === note.noteUid && (
                  <div className="lc-quick-facet-menu" role="menu" aria-label="选择要加入的分栏">
                    {QUICK_FACET_OPTIONS.map((option) => {
                      const included = note.facets.includes(option.facet);
                      return (
                        <button
                          type="button"
                          role="menuitem"
                          key={option.facet}
                          disabled={included || pendingNoteUid === note.noteUid}
                          onClick={() => void addQuickFacet(note, option.facet)}
                        >
                          {included ? <Check size={13} /> : <Plus size={13} />}
                          <span>{option.label}</span>
                          {included && <small>已加入</small>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={editorSaving || pendingNoteUid === note.noteUid}
                onClick={() => beginEditNote(note)}
              >
                <Pencil size={14} />编辑
              </button>
              <button
                className="lc-quick-ai-studio-trigger"
                type="button"
                aria-expanded={quickHtmlStudioNoteUid === note.noteUid}
                aria-controls={`quick-html-studio-${note.noteUid}`}
                disabled={pendingNoteUid === note.noteUid}
                onClick={() => setQuickHtmlStudioNoteUid((current) => current === note.noteUid ? null : note.noteUid)}
              >
                <Sparkles size={14} />AI 交互笔记
              </button>
              {(assets.length > 0 || note.noteType === 'quick' || note.facets.includes('quick')) && (
                <button
                  type="button"
                  disabled={Boolean(aiRenameNoteUid)}
                  title="仅在你点击后调用一次 AI；不会自动批量运行"
                  onClick={() => void renameNoteWithAi(note)}
                >
                  <Zap size={14} />{aiRenameNoteUid === note.noteUid ? 'AI处理中…' : 'AI重新命名'}
                </button>
              )}
              <label className={`lc-quick-attach${pendingNoteUid === note.noteUid ? ' is-busy' : ''}`}>
                <Paperclip size={14} />添加资料 {note.attachments.length} 个
                <input
                  type="file"
                  multiple
                  accept="image/*,.pdf,.doc,.docx,.html,.htm,.css,.js,.mjs,.json,.svg,.txt,.md"
                  disabled={pendingNoteUid === note.noteUid}
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files || []);
                    event.currentTarget.value = '';
                    void appendQuickAttachments(note, files);
                  }}
                />
              </label>
              {!IS_CLOUD_RUNTIME && (
                <button
                  className="lc-quick-delete"
                  type="button"
                  disabled={editorSaving}
                  onClick={() => void deleteNote(note)}
                >
                  <Trash2 size={14} />删除
                </button>
              )}
            </div>
          </div>
        </header>

        {quickHtmlStudioNoteUid === note.noteUid && (
          <QuickHtmlStudio
            key={note.noteUid}
            noteUid={note.noteUid}
            contextTitle={note.title}
            contextRemark={note.remark}
            disabled={pendingNoteUid === note.noteUid}
            onClose={() => setQuickHtmlStudioNoteUid(null)}
            onAttach={(file, operationId) => appendQuickAttachments(note, [file], operationId)}
          />
        )}

        {quickAppendStatus?.noteUid === note.noteUid && (
          <div className={`lc-quick-append-status is-${quickAppendStatus.tone}`} role="status" aria-live="polite">
            <span>{quickAppendStatus.message}</span>
            {quickAppendRetry?.note.noteUid === note.noteUid && quickAppendRetry.operationId === quickAppendStatus.operationId && (
              <button
                type="button"
                disabled={pendingNoteUid === note.noteUid}
                onClick={() => void appendQuickAttachments(
                  quickAppendRetry.note,
                  quickAppendRetry.files,
                  quickAppendRetry.operationId,
                )}
              >
                <RotateCcw size={13} />安全重试
              </button>
            )}
          </div>
        )}

        {paragraphs.length > 0 && (
          <div className="lc-quick-record-copy" aria-label="速记正文">
            {paragraphs.map((paragraph, index) => <p key={`${note.noteUid}:paragraph:${index}`}>{paragraph}</p>)}
          </div>
        )}

        {assets.length > 0 && (
          <div className="lc-quick-entry-assets" aria-label="速记相关资料">
            <div
              className={`lc-quick-material-workspace is-${quickAssetLayout}`}
              style={{ '--lc-quick-asset-rail-width': `${quickAssetRailWidth}px` } as CSSProperties}
            >
              <aside className="lc-quick-asset-rail" aria-label="资料标签">
                <header>
                  <strong>资料</strong>
                  <span>{assets.length}</span>
                  <button
                    className="lc-quick-asset-layout-toggle"
                    type="button"
                    aria-label={quickAssetLayout === 'vertical' ? '切换为横向资料标签' : '切换为纵向资料标签'}
                    title={quickAssetLayout === 'vertical' ? '切换为横向排列' : '切换为纵向排列'}
                    onClick={() => setQuickAssetLayout((current) => current === 'vertical' ? 'horizontal' : 'vertical')}
                  >
                    {quickAssetLayout === 'vertical' ? <Rows3 size={12} /> : <Columns2 size={12} />}
                  </button>
                </header>
                <AssetScroller layout={quickAssetLayout}>
                  {assets.map((asset) => (
                    <span className="lc-quick-asset-chip-wrap" key={asset.id}>
                      <button
                        className={`lc-quick-asset-chip${activeAsset?.id === asset.id ? ' active' : ''}`}
                        type="button"
                        role="tab"
                        aria-selected={activeAsset?.id === asset.id}
                        title="点击查看；拖到本页空白处浮动，或拖入另一个 Edge 窗口接力"
                        draggable
                        onClick={() => {
                          setActiveQuickAssets((current) => ({ ...current, [note.noteUid]: asset.id }));
                        }}
                        onPointerDown={(event) => {
                          if (event.pointerType !== 'mouse') {
                            beginInlineDetach(event, note, asset.id, () => {
                              setActiveQuickAssets((current) => ({ ...current, [note.noteUid]: asset.id }));
                            });
                          }
                        }}
                        onDragStart={(event) => beginQuickAssetDrag(event, note, asset, assets)}
                        onDragEnd={finishQuickAssetDrag}
                      ><b>{asset.kind === 'image' ? 'IMG' : asset.kind === 'word' ? 'DOC' : asset.kind.toUpperCase()}</b><span>{asset.name}</span></button>
                      {assets[0]?.id === asset.id ? (
                        <span className="lc-quick-asset-primary" title="打开这条速记时默认显示">首个</span>
                      ) : (
                        <button
                          className="lc-quick-asset-make-primary"
                          type="button"
                          aria-label={`将 ${asset.name} 设为首个展示资料`}
                          title="设为首个展示资料"
                          disabled={pendingNoteUid === note.noteUid}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => void setPrimaryAttachment(note, asset.id)}
                        ><Star size={11} /></button>
                      )}
                      <button
                        className="lc-quick-asset-remove"
                        type="button"
                        aria-label="移除附件"
                        title={`从速记移除 ${asset.name}`}
                        disabled={pendingNoteUid === note.noteUid}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => void removeQuickAttachment(note, asset.id)}
                      ><X size={12} /></button>
                    </span>
                  ))}
                </AssetScroller>
              </aside>
              <button
                className="lc-quick-asset-divider"
                type="button"
                role="separator"
                aria-label="调整资料分栏宽度"
                aria-orientation="vertical"
                aria-valuemin={QUICK_ASSET_RAIL_MIN_WIDTH}
                aria-valuemax={QUICK_ASSET_RAIL_MAX_WIDTH}
                aria-valuenow={quickAssetRailWidth}
                title="拖动调整分栏宽度；双击恢复默认"
                onPointerDown={beginQuickAssetRailResize}
                onKeyDown={resizeQuickAssetRailFromKeyboard}
                onDoubleClick={() => setQuickAssetRailWidth(QUICK_ASSET_RAIL_DEFAULT_WIDTH)}
              ><span /></button>
              {activeAsset && (
                <div className={`lc-quick-active-preview is-${activeAsset.kind}${activeAssetSize ? ' has-intrinsic-size' : ''}${activeImageNeedsScroll ? ' is-scroll-image' : ''}`}>
                  <WorkspaceAssetPreview
                    item={activeAsset}
                    assets={assets}
                    onRecovered={(item) => recoverQuickAsset(note, item)}
                    onIntrinsicSize={(width, height) => {
                      if (width <= 0 || height <= 0 || !activeAssetSizeKey) return;
                      setQuickAssetIntrinsicSizes((current) => {
                        const existing = current[activeAssetSizeKey];
                        if (existing?.width === width && existing.height === height) return current;
                        return { ...current, [activeAssetSizeKey]: { width, height } };
                      });
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </article>
    );
  };

  const renderQuickJournal = () => {
    if (quickReaderMode === 'overview') {
      return (
        <section className="lc-quick-reader lc-quick-ledger" aria-label="总览速记">
          <button className="lc-mobile-back" type="button" onClick={() => setMobileListOpen(true)} aria-label="返回速记列表">
            <ChevronLeft size={20} />
          </button>
          <header className="lc-quick-journal-heading">
            <div>
              <span>QUICK NOTE OVERVIEW</span>
              <strong>总览速记</strong>
            </div>
            <p>当前筛选共 {visibleQuick.length} 条；点击记录或资料，进入对应速记继续阅读。</p>
          </header>
          <div className="lc-quick-journal-stream">
            {visibleQuick.map((entry) => {
              const { note, date } = entry;
              const assets = quickPreviewAssets(note);
              const paragraphs = note.remark.split(/\r?\n\s*\r?\n/u).map((item) => item.trim()).filter(Boolean);
              return (
                <article className={`lc-quick-log-entry${selectedNoteUid === note.noteUid ? ' is-selected' : ''}`} key={`overview:${note.noteUid}`}>
                  <div className="lc-quick-log-heading">
                    <time>{formatRecordDate(date)}</time>
                    {!isDefaultNoteBucket(note.subject) && <span>{displaySubject(note.subject)}</span>}
                    <button type="button" onClick={() => {
                      setSelectedNoteUid(note.noteUid);
                      setQuickReaderMode('single');
                    }} aria-label={`打开速记：${note.title || '未命名速记'}`}>打开这条</button>
                  </div>
                  <button className="lc-quick-overview-title" type="button" onClick={() => {
                    setSelectedNoteUid(note.noteUid);
                    setQuickReaderMode('single');
                  }}>{note.title || '未命名速记'}</button>
                  <div className="lc-quick-log-copy">
                    {paragraphs.length > 0
                      ? paragraphs.map((paragraph, index) => <p key={`${note.noteUid}:overview:${index}`}>{paragraph}</p>)
                      : <p className="is-empty">这条速记没有文字备注。</p>}
                  </div>
                  {assets.length > 0 && (
                    <div className="lc-quick-overview-assets" aria-label={`${note.title || '速记'}的资料`}>
                      {assets.map((asset, index) => (
                        <button type="button" key={asset.id} onClick={() => {
                          setSelectedNoteUid(note.noteUid);
                          setActiveQuickAssets((current) => ({ ...current, [note.noteUid]: asset.id }));
                          setQuickReaderMode('single');
                        }} aria-label={`打开资料：${asset.name}`}>
                          <b>{asset.kind === 'image' ? 'IMG' : asset.kind === 'word' ? 'DOC' : asset.kind.toUpperCase()}</b>
                          <span>{asset.name}</span>
                          {index === 0 && <em>首个</em>}
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
            {visibleQuick.length === 0 && <div className="lc-detail-empty"><Zap size={28} /><h3>当前筛选没有速记</h3></div>}
          </div>
        </section>
      );
    }
    if (!selectedNote) {
      return <div className="lc-detail-empty"><Zap size={28} /><h3>这里还没有速记</h3></div>;
    }
    return (
      <section className="lc-quick-reader lc-quick-single-reader">
        <button className="lc-mobile-back" type="button" onClick={() => setMobileListOpen(true)} aria-label="返回速记列表">
          <ChevronLeft size={20} />
        </button>
        {renderQuickEntry(selectedNote)}
      </section>
    );
  };

  const renderQuick = () => (
    <div className={`lc-workspace ${mobileListOpen ? 'is-list-open' : 'is-detail-open'}`}>
      <aside className="lc-master-pane">
        {renderSearch(visibleQuick.length, '搜索速记内容、附件名或备注')}
        <div className="lc-quick-list-tools">
          {feedback && <span role="status">{feedback}</span>}
          <button
            className={quickReaderMode === 'overview' ? 'active' : ''}
            type="button"
            disabled={quickReaderMode === 'single' && visibleQuick.length === 0}
            aria-label="总览模式"
            aria-pressed={quickReaderMode === 'overview'}
            onClick={() => {
              setQuickReaderMode((current) => current === 'overview' ? 'single' : 'overview');
              setMobileListOpen(false);
            }}
          >
            <BookOpenText size={14} />{quickReaderMode === 'overview' ? '单条速记' : '总览速记'}
          </button>
          <button type="button" disabled={quickExporting || visibleQuick.length === 0} onClick={() => void exportQuickJournal()}>
            <FileDown size={14} />{quickExporting ? '正在打包…' : '导出日记'}
          </button>
        </div>
        <div className="lc-master-list">
          {visibleQuick.map((entry) => renderNoteButton(entry, 'quick'))}
          {visibleQuick.length === 0 && <div className="lc-list-empty"><Zap size={23} /><strong>还没有速记</strong></div>}
        </div>
      </aside>
      <section className="lc-detail-pane lc-quick-detail-pane">{renderQuickJournal()}</section>
    </div>
  );

  const renderUncategorized = () => (
    <div className={`lc-workspace ${mobileListOpen ? 'is-list-open' : 'is-detail-open'}`}>
      <aside className="lc-master-pane">
        {renderSearch(visibleUncategorized.length, '搜索尚未归入错题、好题或背诵的笔记')}
        <div className="lc-master-list">
          {visibleUncategorized.map((entry) => renderNoteButton(entry, 'library'))}
          {visibleUncategorized.length === 0 && <div className="lc-list-empty"><ClipboardCheck size={23} /><strong>暂无笔记</strong></div>}
        </div>
      </aside>
      <section className="lc-detail-pane">{renderNoteDetail(selectedNote, 'library')}</section>
    </div>
  );

  const renderInbox = () => (
      <div className={`lc-workspace ${mobileListOpen ? 'is-list-open' : 'is-detail-open'}`}>
        <aside className="lc-master-pane">
          <div className="lc-master-list">
            {inboxEntries.map((entry) => renderNoteButton(entry.entry, 'inbox'))}
            {inboxEntries.length === 0 && <div className="lc-list-empty"><ClipboardCheck size={23} /><strong>已处理完</strong></div>}
          </div>
        </aside>
        <section className="lc-detail-pane">
          {selectedInbox
            ? renderNoteDetail(selectedInbox.entry, 'inbox')
            : <div className="lc-detail-empty" aria-hidden="true"><Check size={28} /></div>}
        </section>
      </div>
  );

  const renderWeeklyReview = () => (
    <section className="lc-weekly-review">
      <header className="lc-weekly-heading">
        <div>
          <h2>GPT 周复盘资料包</h2>
          <strong>{weeklyPackage.rangeLabel}</strong>
        </div>
        <div className="lc-weekly-controls">
          <div className="lc-week-stepper" aria-label="选择复盘周">
            <button type="button" onClick={() => { setSelectedWeekStart((value) => shiftWeek(value, -1)); setWeeklyFeedback(''); }} aria-label="上一周"><ChevronLeft size={17} /></button>
            <button type="button" onClick={() => { setSelectedWeekStart(currentWeekStart); setWeeklyFeedback(''); }} disabled={selectedWeekStart === currentWeekStart}>本周</button>
            <button type="button" onClick={() => { setSelectedWeekStart((value) => shiftWeek(value, 1)); setWeeklyFeedback(''); }} disabled={selectedWeekStart >= currentWeekStart} aria-label="下一周"><ChevronRight size={17} /></button>
          </div>
          <button className="primary" type="button" onClick={() => void copyWeeklyPackage()}><Copy size={16} />复制给 GPT</button>
          <button type="button" onClick={downloadWeeklyPackage}><FileDown size={16} />导出 Markdown</button>
        </div>
      </header>

      <div className="lc-weekly-stats">
        <div><span>已记录完成</span><strong>{weeklyPackage.stats.completedTasks}/{weeklyPackage.stats.plannedTasks}</strong><em>{weeklyPackage.stats.completionRate}%</em></div>
        <div><span>新增笔记</span><strong>{weeklyPackage.stats.noteCount}</strong></div>
        <div><span>错题</span><strong>{weeklyPackage.stats.mistakeCount}</strong></div>
        <div><span>需记忆</span><strong>{weeklyPackage.stats.memoryCount}</strong></div>
        <div><span>未分类笔记</span><strong>{weeklyPackage.stats.uncategorizedCount}</strong></div>
        <div><span>复习卡片</span><strong>{weeklyPackage.stats.reviewedCards}</strong></div>
        <div><span>当前到期</span><strong>{weeklyPackage.stats.dueCards}</strong></div>
      </div>

      <div className="lc-weekly-document">
        <header><FileText size={18} /><strong>提示词与学习资料</strong></header>
        <textarea aria-label="周复盘资料包内容" readOnly spellCheck={false} value={weeklyPackage.markdown} />
      </div>
      {weeklyFeedback && <div className="lc-weekly-feedback visible" role="status">{weeklyFeedback}</div>}
    </section>
  );

  const views: Array<{ id: CenterView; label: string; icon: typeof CalendarClock; count: number }> = [
    { id: 'review', label: '今日复习', icon: CalendarClock, count: dueCards.length },
    { id: 'mistakes', label: '错题', icon: TriangleAlert, count: mistakeNotes.length },
    { id: 'good', label: '好题', icon: Star, count: goodNotes.length },
    { id: 'memory', label: '背诵', icon: Brain, count: memoryNotes.length },
    { id: 'quick', label: '速记', icon: Zap, count: quickNotes.length },
    { id: 'uncategorized', label: '普通笔记', icon: ClipboardCheck, count: uncategorizedNotes.length },
    { id: 'library', label: '知识库', icon: BookOpenText, count: indexedNotes.length },
    { id: 'weekly', label: '周复盘', icon: FileText, count: weeklyPackage.stats.noteCount },
    { id: 'inbox', label: '待确认', icon: Inbox, count: inboxEntries.length },
  ];

  return (
    <section className="learning-center" aria-label="学习中心">
      <header className="lc-header">
        <nav className="lc-tabs" aria-label="学习中心视图" role="tablist">
          {views.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={view === item.id ? 'active' : ''}
                key={item.id}
                type="button"
                role="tab"
                aria-selected={view === item.id}
                onClick={() => {
                  setView(item.id);
                  setMobileListOpen(true);
                  setFeedback('');
                  setSourceFeedback('');
                }}
              ><Icon size={16} />{item.label}<span>{item.count}</span></button>
            );
          })}
        </nav>
      </header>
      <div className="lc-body">
        {view === 'review' && renderReview()}
        {view === 'mistakes' && renderMistakes()}
        {view === 'good' && renderGoodQuestions()}
        {view === 'memory' && renderMemory()}
        {view === 'quick' && renderQuick()}
        {view === 'uncategorized' && renderUncategorized()}
        {view === 'library' && renderLibrary()}
        {view === 'weekly' && renderWeeklyReview()}
        {view === 'inbox' && renderInbox()}
      </div>

      <LearningInlineDetachLayer ref={detachLayerRef} />

      {reviewNotice && <div className="lc-review-notice" role="status">{reviewNotice}</div>}

      {imageViewer && (
        <ImageViewer
          items={imageViewer.items}
          index={imageViewer.index}
          onIndexChange={changeImageViewerIndex}
          onClose={() => setImageViewer(null)}
          ariaLabel="原图查看器"
        />
      )}

      {goodImportOpen && (
        <div className="lc-editor-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !editorSaving) setGoodImportOpen(false);
        }}>
          <section className="lc-content-editor lc-good-import-dialog" role="dialog" aria-modal="true" aria-label="从错题导入好题">
            <header>
              <h2>从错题导入好题</h2>
              <button type="button" aria-label="关闭" disabled={editorSaving} onClick={() => setGoodImportOpen(false)}><X size={18} /></button>
            </header>
            <div className="lc-good-import-body">
              <label className="lc-good-import-search">
                <Search size={17} />
                <input value={goodImportQuery} autoFocus onChange={(event) => setGoodImportQuery(event.target.value)} placeholder="搜索错题、页码、知识点或错因" />
              </label>
              <div className="lc-good-import-tools">
                <button type="button" disabled={visibleGoodImportIds.length === 0} onClick={toggleAllVisibleGoodImport}>
                  {allVisibleGoodImportSelected ? '取消全选' : '全选当前结果'}
                </button>
                <span>已选择 {goodImportSelection.length} 道</span>
              </div>
              <div className="lc-good-import-list">
                {visibleGoodImport.map(({ note }) => (
                  <label key={note.noteUid}>
                    <input type="checkbox" checked={goodImportSelection.includes(note.noteUid)} onChange={() => toggleGoodImportSelection(note.noteUid)} />
                    <span>
                      <strong>{note.title || '未命名错题'}</strong>
                      {[displaySubject(note.subject), noteKnowledgePoints(note)[0], noteWrongReasons(note)[0]].filter(Boolean).length > 0 && (
                        <small>{[displaySubject(note.subject), noteKnowledgePoints(note)[0], noteWrongReasons(note)[0]].filter(Boolean).join(' · ')}</small>
                      )}
                    </span>
                  </label>
                ))}
                {visibleGoodImport.length === 0 && (
                  <div className="lc-list-empty"><Search size={22} /><strong>没有匹配的错题</strong></div>
                )}
              </div>
            </div>
            <footer>
              <button type="button" disabled={editorSaving} onClick={() => setGoodImportOpen(false)}>取消</button>
              <button className="primary" type="button" disabled={editorSaving || goodImportSelection.length === 0} onClick={() => void importSelectedMistakes()}><Check size={16} />导入选中</button>
            </footer>
          </section>
        </div>
      )}

      {noteEditor && (
        <div className="lc-editor-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !editorSaving) setNoteEditor(null);
        }}>
          <form className={`lc-content-editor${noteEditor.kind === 'quick' ? ' is-quick-editor' : ''}`} role="dialog" aria-modal="true" aria-label={noteEditor.mode === 'create' ? '新增学习内容' : '编辑学习内容'} onSubmit={(event) => { event.preventDefault(); void saveNoteEditor(); }}>
            <header>
              <h2>{noteEditor.mode === 'create' ? '新增学习内容' : '编辑学习内容'}</h2>
              <button type="button" aria-label="关闭编辑器" disabled={editorSaving} onClick={() => setNoteEditor(null)}><X size={18} /></button>
            </header>
            <div className="lc-editor-grid">
              <label>类型<select value={noteEditor.kind} onChange={(event) => setNoteEditor((current) => current ? {
                ...current,
                kind: event.target.value as LearningItemKind,
                createCard: event.target.value !== 'knowledge' && current.createCard,
                learningTypePath: event.target.value === 'quick'
                  ? []
                  : current.learningTypePath.length > 0
                    ? current.learningTypePath
                    : ['基础知识', '定义概念'],
              } : current)}>
                <option value="quick">速记</option>
                <option value="knowledge">知识</option>
                <option value="mistake">错题</option>
                <option value="memory">背诵</option>
              </select></label>
              <label>一级科目<select value={noteEditor.subject} onChange={(event) => setNoteEditor((current) => current ? {
                ...current,
                subject: event.target.value,
                knowledgePoint: '',
                questionTypePath: [],
                learningTypePath: [],
              } : current)}>
                <option value="">请选择</option>
                {subjectOptions.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
              </select></label>
              <label className="wide">标题<input value={noteEditor.title} maxLength={120} autoFocus onChange={(event) => setNoteEditor((current) => current ? { ...current, title: event.target.value } : current)} placeholder={noteEditor.kind === 'quick' ? '留空时会从正文自动生成短标题' : '例如：进程与线程的区别'} /></label>
              {noteEditor.kind !== 'quick' && <label>知识点<input list="lc-editor-knowledge-options" value={noteEditor.knowledgePoint} maxLength={60} onChange={(event) => setNoteEditor((current) => current ? { ...current, knowledgePoint: event.target.value, questionTypePath: [], learningTypePath: [] } : current)} /></label>}
              {noteEditor.kind !== 'quick' && <div className="lc-editor-classification wide"><span>题型分类（最多三级）</span><HierarchyPathInputs label="题型" value={noteEditor.questionTypePath} onChange={(questionTypePath) => setNoteEditor((current) => current ? { ...current, questionTypePath } : current)} /></div>}
              {noteEditor.kind !== 'quick' && <div className="lc-editor-classification wide"><span>{noteEditor.kind === 'memory' ? '背诵类型' : '学习内容类型'}</span><HierarchyPathFilter label={noteEditor.kind === 'memory' ? '背诵类型' : '学习类型'} paths={editorLearningTypePaths} value={noteEditor.learningTypePath} onChange={(learningTypePath) => setNoteEditor((current) => current ? { ...current, learningTypePath } : current)} /></div>}
              {noteEditor.kind === 'mistake' && <div className="lc-editor-classification wide"><span>错因分类</span><HierarchyPathFilter label="错因" paths={wrongReasonEditorPaths} value={noteEditor.wrongReasonPath} onChange={(wrongReasonPath) => setNoteEditor((current) => current ? { ...current, wrongReasonPath } : current)} /></div>}
              {noteEditor.kind === 'mistake' && <label className="wide">具体错因<input value={noteEditor.wrongReason} maxLength={500} onChange={(event) => setNoteEditor((current) => current ? { ...current, wrongReason: event.target.value } : current)} placeholder="例如：看漏了定义域条件，导致后续计算范围错误" /></label>}
              <label className="wide">内容<textarea value={noteEditor.remark} maxLength={8000} onChange={(event) => setNoteEditor((current) => current ? { ...current, remark: event.target.value } : current)} placeholder={noteEditor.kind === 'quick' ? '直接修改这条速记；空行会保留为自然分段' : '写下题目、结论、易错点或需要记住的内容'} /></label>
              {noteEditor.kind !== 'quick' && <label className="wide">标签<input value={noteEditor.tags} onChange={(event) => setNoteEditor((current) => current ? { ...current, tags: event.target.value } : current)} placeholder="用逗号分隔" /></label>}
              {noteEditor.kind !== 'quick' && <label className="lc-editor-check wide"><input type="checkbox" checked={noteEditor.isGood} onChange={(event) => setNoteEditor((current) => current ? { ...current, isGood: event.target.checked, goodQuestionType: event.target.checked ? current.goodQuestionType || '经典母题' : '' } : current)} />收藏到“好题”（可同时保留为错题）</label>}
              {noteEditor.kind !== 'quick' && noteEditor.isGood && <label>好题类型<select value={noteEditor.goodQuestionType} onChange={(event) => setNoteEditor((current) => current ? { ...current, goodQuestionType: event.target.value } : current)}>{GOOD_QUESTION_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>}
              {noteEditor.mode === 'create' && noteEditor.kind !== 'knowledge' && (
                <label className="lc-editor-check wide"><input type="checkbox" checked={noteEditor.createCard} onChange={(event) => setNoteEditor((current) => current ? { ...current, createCard: event.target.checked } : current)} />同时建立一张今日复习卡</label>
              )}
            </div>
            <datalist id="lc-editor-knowledge-options">{editorKnowledgePointOptions.map((point) => <option key={point} value={point} />)}</datalist>
            <footer>
              {feedback && <span role="status">{feedback}</span>}
              <button type="button" disabled={editorSaving} onClick={() => setNoteEditor(null)}>取消</button>
              <button className="primary" type="submit" disabled={editorSaving}><Save size={16} />{editorSaving ? '保存中' : '保存'}</button>
            </footer>
          </form>
        </div>
      )}

      {cardEditor && (
        <div className="lc-editor-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !editorSaving) setCardEditor(null);
        }}>
          <form className="lc-content-editor lc-card-editor" role="dialog" aria-modal="true" aria-label="编辑复习卡片" onSubmit={(event) => { event.preventDefault(); void saveCardEditor(); }}>
            <header>
              <h2>编辑复习卡片</h2>
              <button type="button" aria-label="关闭编辑器" disabled={editorSaving} onClick={() => setCardEditor(null)}><X size={18} /></button>
            </header>
            <div className="lc-editor-grid single">
              <label className="wide">正面<textarea value={cardEditor.front} maxLength={500} autoFocus onChange={(event) => setCardEditor((current) => current ? { ...current, front: event.target.value } : current)} /></label>
              <label className="wide">答案<textarea value={cardEditor.back} maxLength={2000} onChange={(event) => setCardEditor((current) => current ? { ...current, back: event.target.value } : current)} /></label>
            </div>
            <footer>
              {feedback && <span role="status">{feedback}</span>}
              <button type="button" disabled={editorSaving} onClick={() => setCardEditor(null)}>取消</button>
              <button className="primary" type="submit" disabled={editorSaving}><Save size={16} />{editorSaving ? '保存中' : '保存'}</button>
            </footer>
          </form>
        </div>
      )}
    </section>
  );
}
