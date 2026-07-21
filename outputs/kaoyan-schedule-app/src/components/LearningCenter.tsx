import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  BookOpenText,
  Brain,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Copy,
  FileImage,
  FileDown,
  FileText,
  FolderOpen,
  Inbox,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  Star,
  Tag,
  Trash2,
  TriangleAlert,
  X,
  ZoomIn,
} from 'lucide-react';
import type { ScheduleDay } from '../types';
import type {
  LearningAutoNote,
  LearningCard,
  LearningDataSnapshot,
  LearningNoteCreateInput,
  LearningNotePatch,
} from '../utils/learningData';
import { NOTE_SERVER_URL } from '../utils/notes';
import { fuzzySearchScore, type WeightedSearchField } from '../utils/fuzzySearch';
import {
  addDays,
  buildWeeklyReviewPackage,
  getWeekStart,
  shiftWeek,
  weeklyReviewFilename,
} from '../utils/weeklyReview';
import '../learning-center.css';

export type LearningCardPatch = Partial<Pick<LearningCard, 'front' | 'back' | 'status' | 'dueDate' | 'userEdited'>> & {
  reviewResult?: 'remembered' | 'forgotten';
  reviewThought?: string;
};

export interface LearningCenterProps {
  snapshot: LearningDataSnapshot;
  scheduleDays: ScheduleDay[];
  onPatchCard: (cardId: string, patch: LearningCardPatch) => Promise<unknown> | unknown;
  onDeleteCard: (cardId: string) => Promise<unknown> | unknown;
  onCreateNote: (input: LearningNoteCreateInput) => Promise<unknown> | unknown;
  onPatchNote: (noteUid: string, patch: LearningNotePatch) => Promise<unknown> | unknown;
  onDeleteNote: (noteUid: string) => Promise<unknown> | unknown;
  onOpenDate: (date: string) => void;
}

type CenterView = 'review' | 'mistakes' | 'good' | 'memory' | 'library' | 'uncategorized' | 'inbox' | 'weekly';
type MistakeStatus = 'all' | 'confirm' | 'due' | 'reviewing' | 'mastered' | 'untracked';

interface IndexedNote {
  date: string;
  note: LearningAutoNote;
}

interface MistakeFilters {
  subject: string;
  knowledgePoint: string;
  questionType: string;
  wrongReason: string;
  status: MistakeStatus;
}

interface ClassificationDraft {
  subject: string;
  knowledgePoint: string;
  questionType: string;
  wrongReason: string;
}

type LearningItemKind = 'knowledge' | 'mistake' | 'memory';

interface NoteEditorState {
  mode: 'create' | 'edit';
  noteUid: string | null;
  originalSubject: string;
  kind: LearningItemKind;
  title: string;
  remark: string;
  subject: string;
  knowledgePoint: string;
  questionType: string;
  wrongReason: string;
  tags: string;
  isGood: boolean;
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

type InboxEntry = { key: string; kind: 'note'; timestamp: string; entry: IndexedNote };

const DEFAULT_FOLDER_NAMES = new Set(['默认文件夹', '未分类', '默认']);
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
  questionType: '',
  wrongReason: '',
  status: 'all',
};

const displaySubject = (subject: string | null | undefined): string => {
  const value = String(subject ?? '').trim();
  return !value || DEFAULT_FOLDER_NAMES.has(value) ? '收件箱' : value;
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

const pageRefText = (note: LearningAutoNote): string => note.pageRefs
  .map((ref) => ref.raw || [ref.page ? `p${ref.page}` : '', ref.question ?? ''].filter(Boolean).join(' '))
  .filter(Boolean)
  .join(' · ');

const cardPageText = (card: LearningCard): string => card.pageRefs
  .map((ref) => ref.raw || [ref.page ? `p${ref.page}` : '', ref.question ?? ''].filter(Boolean).join(' '))
  .filter(Boolean)
  .join(' · ');

const cardSubtitle = (card: LearningCard): string => [
  displaySubject(card.subject),
  card.knowledgePath.join(' / '),
  cardPageText(card),
].filter(Boolean).join(' · ');

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

const fileNameFromPath = (filePath: string): string => filePath.split(/[\\/]/).pop() || '原图';

const noteKnowledgePoints = (note: LearningAutoNote): string[] => uniqueText([
  ...note.knowledgePath.filter((item) => item !== note.subject),
  ...(note.classificationSource === 'manual' ? [] : note.items.map((item) => item.knowledgePoint)),
]);

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
  return /(?:^|[\s#【\[，,。；;：:])(?:记|记住|背|要背)(?=$|[\s#】\]，,。；;：:])/u.test(normalized)
    || /(?:要记住|需要记|必须记|背下来|需要背|必须背|重点背|熟记)/u.test(normalized);
};

const remarkSignalsGood = (remark: string): boolean => /(?:^|[\s#【\[，,。；;：:])(?:好题|经典题|典型题|精品题)(?=$|[\s#】\]，,。；;：:])/u.test(remark.normalize('NFKC'));

const isMistakeNote = (note: LearningAutoNote): boolean => (
  note.noteType === 'mistake'
  || noteHasTag(note, MISTAKE_WORDS)
  || remarkSignalsMistake(note.remark)
  || noteWrongReasons(note).length > 0
  || note.items.some((item) => item.intent.isMistake)
);

const isMemoryNote = (note: LearningAutoNote): boolean => (
  note.noteType === 'memory'
  || noteHasTag(note, MEMORY_WORDS)
  || remarkSignalsMemory(note.remark)
  || note.items.some((item) => item.intent.shouldMemorize)
);

const isGoodNote = (note: LearningAutoNote): boolean => {
  if (note.goodQuestion !== null) return note.goodQuestion;
  const hasUserOwnedGoodTag = (note.manualCreated || note.userEditedFields.includes('tags'))
    && noteHasTag(note, GOOD_QUESTION_WORDS);
  return note.noteType === 'good' || hasUserOwnedGoodTag || remarkSignalsGood(note.remark);
};

const isPendingNote = (note: LearningAutoNote): boolean => (
  note.organizationStatus === 'pending'
  && DEFAULT_FOLDER_NAMES.has(note.subject.trim())
);

const isKnowledgeEligibleNote = (note: LearningAutoNote): boolean => (
  note.organizationStatus !== 'ignored'
  && !DEFAULT_FOLDER_NAMES.has(note.subject.trim())
);

const rankNotesForQuery = (entries: IndexedNote[], query: string): IndexedNote[] => {
  if (!query.trim()) return entries;
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
  if (requested === 'mistakes' || requested === 'good' || requested === 'memory' || requested === 'uncategorized' || requested === 'inbox' || requested === 'weekly') return requested;
  if (requested === 'knowledge' || params.has('q')) return 'library';
  if (params.get('filter') === 'draft') return 'inbox';
  return 'review';
};

export function LearningCenter({
  snapshot,
  scheduleDays,
  onPatchCard,
  onDeleteCard,
  onCreateNote,
  onPatchNote,
  onDeleteNote,
  onOpenDate,
}: LearningCenterProps) {
  const today = localDate();
  const currentWeekStart = getWeekStart(today);
  const [view, setView] = useState<CenterView>(initialView);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedNoteUid, setSelectedNoteUid] = useState<string | null>(null);
  const [selectedInboxKey, setSelectedInboxKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [pendingCardId, setPendingCardId] = useState<string | null>(null);
  const [pendingNoteUid, setPendingNoteUid] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [sourceFeedback, setSourceFeedback] = useState('');
  const [failedImagePath, setFailedImagePath] = useState('');
  const [editingClassificationUid, setEditingClassificationUid] = useState<string | null>(null);
  const [classificationDraft, setClassificationDraft] = useState<ClassificationDraft | null>(null);
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  const [mistakeFilters, setMistakeFilters] = useState<MistakeFilters>(EMPTY_FILTERS);
  const [selectedWeekStart, setSelectedWeekStart] = useState(currentWeekStart);
  const [weeklyFeedback, setWeeklyFeedback] = useState('');
  const [noteEditor, setNoteEditor] = useState<NoteEditorState | null>(null);
  const [cardEditor, setCardEditor] = useState<CardEditorState | null>(null);
  const [goodImportOpen, setGoodImportOpen] = useState(false);
  const [goodImportQuery, setGoodImportQuery] = useState('');
  const [goodImportSelection, setGoodImportSelection] = useState<string[]>([]);
  const [imageLightbox, setImageLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [thoughtDraft, setThoughtDraft] = useState('');
  const [thoughtEditor, setThoughtEditor] = useState<ThoughtEditorState | null>(null);
  const [thoughtSaving, setThoughtSaving] = useState(false);

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
  const reviewCards = useMemo(() => [...dueCards, ...upcomingCards], [dueCards, upcomingCards]);
  const currentCard = reviewCards.find((card) => card.id === selectedCardId) ?? reviewCards[0] ?? null;
  const currentCardIndex = currentCard ? reviewCards.findIndex((card) => card.id === currentCard.id) : -1;
  const currentCardIsDue = Boolean(currentCard && (!currentCard.dueDate || currentCard.dueDate <= today));

  const allNotes = useMemo<IndexedNote[]>(() => Object.entries(snapshot.days)
    .flatMap(([date, day]) => day.autoNotes.filter((note) => note.organizationStatus !== 'ignored').map((note) => {
      const capturedDate = /^\d{4}-\d{2}-\d{2}$/.test(note.capturedDate) ? note.capturedDate : date;
      return {
        date: capturedDate,
        note,
      };
    }))
    .sort((left, right) => right.date.localeCompare(left.date) || right.note.updatedAt.localeCompare(left.note.updatedAt)), [snapshot.days]);
  const indexedNotes = useMemo(() => allNotes.filter(({ note }) => isKnowledgeEligibleNote(note)), [allNotes]);

  const subjectOptions = useMemo(() => {
    const standardOrder = new Map<string, number>(STANDARD_EXAM_SUBJECTS.map((subject, index) => [subject, index]));
    return uniqueText([
      ...STANDARD_EXAM_SUBJECTS,
      ...allNotes.map(({ note }) => note.subject).filter((subject) => !DEFAULT_FOLDER_NAMES.has(subject.trim())),
    ]).sort((left, right) => {
      const leftOrder = standardOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = standardOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.localeCompare(right, 'zh-CN');
    });
  }, [allNotes]);
  const knowledgePointOptions = useMemo(() => uniqueText(
    indexedNotes.flatMap(({ note }) => noteKnowledgePoints(note)),
  ).sort((left, right) => left.localeCompare(right, 'zh-CN')), [indexedNotes]);

  const mistakeNotes = useMemo(() => indexedNotes.filter(({ note }) => isMistakeNote(note)), [indexedNotes]);
  const goodNotes = useMemo(() => indexedNotes.filter(({ note }) => isGoodNote(note)), [indexedNotes]);
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
  const memoryNotes = useMemo(() => indexedNotes.filter(({ note }) => isMemoryNote(note)), [indexedNotes]);
  const uncategorizedNotes = useMemo(() => indexedNotes.filter(({ note }) => (
    !isMistakeNote(note) && !isGoodNote(note) && !isMemoryNote(note)
  )), [indexedNotes]);
  const currentWeekUncategorizedCount = useMemo(() => {
    const weekEnd = addDays(currentWeekStart, 6);
    return uncategorizedNotes.filter((entry) => entry.date >= currentWeekStart && entry.date <= weekEnd).length;
  }, [currentWeekStart, uncategorizedNotes]);
  const pendingNotes = useMemo(() => allNotes.filter(({ note }) => isPendingNote(note)), [allNotes]);
  const weeklyPackage = useMemo(
    () => buildWeeklyReviewPackage(snapshot, scheduleDays, selectedWeekStart, today),
    [scheduleDays, selectedWeekStart, snapshot, today],
  );

  const mistakeFacets = useMemo(() => ({
    subjects: uniqueText(mistakeNotes.map(({ note }) => note.subject)).sort((left, right) => left.localeCompare(right, 'zh-CN')),
    knowledgePoints: uniqueText(mistakeNotes.flatMap(({ note }) => noteKnowledgePoints(note))).sort((left, right) => left.localeCompare(right, 'zh-CN')),
    questionTypes: uniqueText(mistakeNotes.flatMap(({ note }) => noteQuestionTypes(note))).sort((left, right) => left.localeCompare(right, 'zh-CN')),
    wrongReasons: uniqueText(mistakeNotes.flatMap(({ note }) => noteWrongReasons(note))).sort((left, right) => left.localeCompare(right, 'zh-CN')),
  }), [mistakeNotes]);

  const visibleMistakes = useMemo(() => rankNotesForQuery(mistakeNotes.filter((entry) => {
    const { note } = entry;
    if (mistakeFilters.subject && note.subject !== mistakeFilters.subject) return false;
    if (mistakeFilters.knowledgePoint && !noteKnowledgePoints(note).includes(mistakeFilters.knowledgePoint)) return false;
    if (mistakeFilters.questionType && !noteQuestionTypes(note).includes(mistakeFilters.questionType)) return false;
    if (mistakeFilters.wrongReason && !noteWrongReasons(note).includes(mistakeFilters.wrongReason)) return false;
    return mistakeFilters.status === 'all' || mistakeStatus(note, snapshot.cards, today) === mistakeFilters.status;
  }), query), [mistakeFilters, mistakeNotes, query, snapshot.cards, today]);

  const visibleMemory = useMemo(() => rankNotesForQuery(memoryNotes, query), [memoryNotes, query]);
  const visibleGood = useMemo(() => rankNotesForQuery(goodNotes, query), [goodNotes, query]);
  const visibleLibrary = useMemo(() => rankNotesForQuery(indexedNotes, query), [indexedNotes, query]);
  const visibleUncategorized = useMemo(() => rankNotesForQuery(uncategorizedNotes, query), [query, uncategorizedNotes]);

  const groupedLibrary = useMemo(() => {
    const groups = new Map<string, IndexedNote[]>();
    visibleLibrary.forEach((entry) => {
      const group = groups.get(entry.date) ?? [];
      group.push(entry);
      groups.set(entry.date, group);
    });
    return [...groups.entries()];
  }, [visibleLibrary]);

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
      : view === 'uncategorized'
        ? visibleUncategorized
      : visibleLibrary;
  const selectedNote = noteListForView.find(({ note }) => note.noteUid === selectedNoteUid) ?? noteListForView[0] ?? null;
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
      setSelectedNoteUid(null);
      return;
    }
    if (selectedNote.note.noteUid !== selectedNoteUid) setSelectedNoteUid(selectedNote.note.noteUid);
  }, [selectedNote, selectedNoteUid, view]);

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
    setImageLightbox(null);
    setThoughtDraft('');
    setThoughtEditor(null);
  }, [selectedNoteUid, selectedInboxKey, selectedCardId, view]);

  useEffect(() => {
    if (!imageLightbox) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setImageLightbox(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [imageLightbox]);

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
    void updateCard(currentCard, patch, successText, () => setSelectedCardId(nextCard?.id ?? null));
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
        patchCurrentCard({ reviewResult: 'forgotten' }, '已标记为忘记，明天再复习。');
      } else if (event.key === '2' && currentCardIsDue) {
        event.preventDefault();
        patchCurrentCard({ reviewResult: 'remembered' }, '已记住，复习间隔已延长。');
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
        setSourceFeedback('已在资源管理器中定位原图。');
        return;
      }
      if (typeof bridge?.openPath === 'function') {
        await bridge.openPath(filePath);
        setSourceFeedback('已打开原图。');
        return;
      }
      const response = await fetch(`${NOTE_SERVER_URL}/notes/reveal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      if (response.ok) {
        setSourceFeedback('已在资源管理器中定位原图。');
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
        setSourceFeedback('无法调用资源管理器，请复制上方原图路径。');
      }
    }
  };

  const copySourcePath = async (filePath: string) => {
    if (!filePath) return;
    try {
      await navigator.clipboard.writeText(filePath);
      setSourceFeedback('原图路径已复制，可粘贴到资源管理器地址栏。');
    } catch {
      setSourceFeedback('复制失败，请手动复制上方路径。');
    }
  };

  const copyWeeklyPackage = async () => {
    try {
      await navigator.clipboard.writeText(weeklyPackage.markdown);
      setWeeklyFeedback('资料包已复制，可以直接粘贴给 GPT。');
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
    setWeeklyFeedback('周复盘 Markdown 已导出。');
  };

  const ignorePendingNote = async (noteUid: string) => {
    if (pendingNoteUid) return;
    try {
      setPendingNoteUid(noteUid);
      setFeedback('');
      await onPatchNote(noteUid, { organizationStatus: 'ignored' });
      setSelectedInboxKey(null);
      setFeedback('已从收件箱移除。');
    } catch {
      setFeedback('暂时无法更新，笔记仍保留在收件箱中。');
    } finally {
      setPendingNoteUid(null);
    }
  };

  const beginClassificationEdit = (note: LearningAutoNote) => {
    setEditingClassificationUid(note.noteUid);
    setClassificationDraft({
      subject: DEFAULT_FOLDER_NAMES.has(note.subject) ? '' : note.subject,
      knowledgePoint: noteKnowledgePoints(note)[0] ?? '',
      questionType: noteQuestionTypes(note)[0] ?? '',
      wrongReason: noteWrongReasons(note)[0] ?? '',
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
    try {
      setPendingNoteUid(note.noteUid);
      setFeedback('');
      await onPatchNote(note.noteUid, {
        subject,
        knowledgePath: [subject, knowledgePoint].filter(Boolean),
        questionType: classificationDraft.questionType.trim(),
        wrongReason: classificationDraft.wrongReason.trim(),
        organizationStatus: 'confirmed',
      });
      setEditingClassificationUid(null);
      setClassificationDraft(null);
      setSelectedInboxKey(null);
      setFeedback('分类已修改，后续 AI 整理会保留你的更正。');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '分类没有保存，请稍后重试。');
    } finally {
      setPendingNoteUid(null);
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
      questionType: '',
      wrongReason: '',
      tags: [kind === 'mistake' ? '错题' : kind === 'memory' ? '背诵' : '', isGood ? '好题' : ''].filter(Boolean).join('，'),
      isGood,
      createCard: kind !== 'knowledge',
    });
    setFeedback('');
  };

  const beginEditNote = (note: LearningAutoNote) => {
    const kind: LearningItemKind = isMistakeNote(note) ? 'mistake' : isMemoryNote(note) ? 'memory' : 'knowledge';
    setNoteEditor({
      mode: 'edit',
      noteUid: note.noteUid,
      originalSubject: note.subject,
      kind,
      title: note.title,
      remark: note.remark,
      subject: note.subject,
      knowledgePoint: noteKnowledgePoints(note)[0] ?? '',
      questionType: noteQuestionTypes(note)[0] ?? '',
      wrongReason: noteWrongReasons(note)[0] ?? '',
      tags: note.tags.join('，'),
      isGood: isGoodNote(note),
      createCard: false,
    });
    setFeedback('');
  };

  const saveNoteEditor = async () => {
    if (!noteEditor || editorSaving) return;
    const title = noteEditor.title.trim();
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
    const noteType = noteEditor.kind === 'knowledge' ? 'knowledge' : noteEditor.kind;
    const common = {
      title,
      remark: noteEditor.remark.trim(),
      subject,
      knowledgePath: [subject, knowledgePoint].filter(Boolean),
      questionType: noteEditor.questionType.trim(),
      wrongReason: noteEditor.wrongReason.trim(),
      noteType,
      tags,
      goodQuestion: noteEditor.isGood,
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
        setFeedback('新内容已加入学习中心。');
      } else if (noteEditor.noteUid) {
        await onPatchNote(noteEditor.noteUid, common);
        setFeedback('内容修改已保存。');
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
      setFeedback('已从学习中心移除；原始图片仍然保留。');
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
      setFeedback('卡片内容已保存。');
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
      setFeedback('卡片已删除。');
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
      setFeedback(`已从错题导入 ${selected.length} 道好题，错题记录仍然保留。`);
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
      setFeedback('已移出好题；如果它同时是错题，错题记录仍然保留。');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '移出好题失败，请稍后重试。');
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
      setFeedback('想法已记录，并会纳入后续 AI 复盘。');
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
      setFeedback('想法修改已保存。');
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
      setFeedback('想法已删除。');
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
        onChange={(event) => setQuery(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {query && <button type="button" onClick={() => setQuery('')} aria-label="清空搜索"><X size={15} /></button>}
      <strong>{count}</strong>
      {addLabel && onAdd && <button className="lc-add-button" type="button" onClick={onAdd}><Plus size={15} />{addLabel}</button>}
    </div>
  );

  const renderNoteButton = (entry: IndexedNote, context: 'mistake' | 'good' | 'memory' | 'library' | 'inbox') => {
    const { date, note } = entry;
    const knowledge = noteKnowledgePoints(note)[0];
    const pages = pageRefText(note);
    const wrongReason = noteWrongReasons(note)[0];
    const active = context === 'inbox'
      ? selectedInboxKey === `note:${note.noteUid}`
      : selectedNoteUid === note.noteUid;
    return (
      <button
        className={`lc-note-button ${active ? 'active' : ''}`}
        key={`${context}:${note.noteUid}`}
        type="button"
        onClick={() => {
          if (context === 'inbox') setSelectedInboxKey(`note:${note.noteUid}`);
          else setSelectedNoteUid(note.noteUid);
        }}
      >
        <span className="lc-note-button-title">{note.title || note.remark || '未命名笔记'}</span>
        <span className="lc-note-button-meta">
          {context === 'library' && <time>{formatShortDate(date)}</time>}
          <span>{displaySubject(note.subject)}</span>
          {(pages || knowledge) && <span>{pages || knowledge}</span>}
        </span>
        {context === 'mistake' && (
          <span className="lc-note-button-foot">
            <em>{statusLabel[mistakeStatus(note, snapshot.cards, today)]}</em>
            {wrongReason && <span>{wrongReason}</span>}
          </span>
        )}
      </button>
    );
  };

  const renderNoteDetail = (entry: IndexedNote | null, context: 'mistake' | 'good' | 'memory' | 'library' | 'inbox') => {
    if (!entry) {
      return (
        <div className="lc-detail-empty">
          <BookOpenText size={28} />
          <h3>这里还没有记录</h3>
        </div>
      );
    }
    const { date, note } = entry;
    const pages = pageRefText(note);
    const knowledgePoints = noteKnowledgePoints(note);
    const questionTypes = noteQuestionTypes(note);
    const wrongReasons = noteWrongReasons(note);
    const itemSummary = note.items.slice(0, 8);
    const contextLabel = context === 'mistake' ? '错题' : context === 'good' ? '好题' : context === 'memory' ? '背诵' : context === 'inbox' ? '未识别' : '知识笔记';
    const isEditingClassification = editingClassificationUid === note.noteUid && classificationDraft;
    const imageUrl = note.filePath ? `${NOTE_SERVER_URL}/note-file?path=${encodeURIComponent(note.filePath)}` : '';
    const showQuestionFirst = context === 'mistake' || context === 'good';
    const sourcePreview = (
      <figure className={`lc-source-preview ${showQuestionFirst ? 'is-question-first' : ''}`}>
        {imageUrl && failedImagePath !== note.filePath ? (
          <button
            className="lc-source-preview-open"
            type="button"
            onClick={() => setImageLightbox({ src: imageUrl, alt: `${note.title || '题目'}原图` })}
            aria-label="放大查看题目原图"
          >
            <img src={imageUrl} alt={`${note.title || '笔记'}原图`} onError={() => setFailedImagePath(note.filePath)} />
            <span><ZoomIn size={16} />点开放大</span>
          </button>
        ) : (
          <div>
            <FileImage size={28} />
            <strong>{note.filePath ? '原图暂时无法预览' : '原图路径尚未同步'}</strong>
            {note.filePath && failedImagePath === note.filePath && (
              <button type="button" onClick={() => {
                setSourceFeedback('正在重新连接原图服务…');
                setFailedImagePath('');
              }}>重新加载</button>
            )}
          </div>
        )}
      </figure>
    );
    return (
      <article className="lc-note-detail">
        <header className="lc-detail-heading">
          <div>
            <span className={`lc-detail-kind is-${context}`}>{contextLabel}</span>
            <h2>{note.title || '未命名笔记'}</h2>
          </div>
          <div className="lc-heading-actions">
            <button type="button" onClick={() => beginEditNote(note)}><Pencil size={15} />编辑</button>
            {context === 'good' && (
              <button type="button" disabled={pendingNoteUid === note.noteUid || editorSaving} onClick={() => void removeFromGoodQuestions(note)}><X size={15} />移出好题</button>
            )}
            <button className="danger" type="button" disabled={editorSaving} onClick={() => void deleteNote(note)}><Trash2 size={15} />删除</button>
            <time>{formatRecordDate(date)}</time>
          </div>
        </header>

        {showQuestionFirst && sourcePreview}

        <div className="lc-detail-facts">
          <div><span>科目</span><strong>{displaySubject(note.subject)}</strong></div>
          <div><span>页码 / 题号</span><strong>{pages || '—'}</strong></div>
          <div><span>知识点</span><strong>{knowledgePoints.join('、') || '—'}</strong></div>
          <div><span>题型</span><strong>{questionTypes.join('、') || '—'}</strong></div>
          {context === 'mistake' && <div className="lc-fact-wide"><span>错因</span><strong>{wrongReasons.join('；') || '—'}</strong></div>}
        </div>

        {isEditingClassification && (
          <form className="lc-classification-editor" onSubmit={(event) => { event.preventDefault(); void saveClassification(note); }}>
            <label>一级科目<select value={classificationDraft.subject} onChange={(event) => setClassificationDraft((current) => current ? { ...current, subject: event.target.value } : current)} autoFocus>
              <option value="">请选择</option>
              {subjectOptions.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
            </select></label>
            <label>知识点<input list="lc-knowledge-options" value={classificationDraft.knowledgePoint} onChange={(event) => setClassificationDraft((current) => current ? { ...current, knowledgePoint: event.target.value } : current)} /></label>
            <label>题型<input value={classificationDraft.questionType} onChange={(event) => setClassificationDraft((current) => current ? { ...current, questionType: event.target.value } : current)} /></label>
            <label>错因<input value={classificationDraft.wrongReason} onChange={(event) => setClassificationDraft((current) => current ? { ...current, wrongReason: event.target.value } : current)} /></label>
            <div className="lc-classification-actions">
              <button className="primary" type="submit" disabled={pendingNoteUid === note.noteUid}><Check size={15} />保存</button>
              <button type="button" onClick={() => { setEditingClassificationUid(null); setClassificationDraft(null); }}>取消</button>
            </div>
            <datalist id="lc-knowledge-options">{knowledgePointOptions.map((point) => <option key={point} value={point} />)}</datalist>
          </form>
        )}

        {note.remark && (
          <section className="lc-detail-section">
            <h3>我的备注</h3>
            <p>{note.remark}</p>
          </section>
        )}

        <section className="lc-thoughts" aria-labelledby={`thoughts-${note.noteUid}`}>
          <div className="lc-thoughts-heading">
            <div>
              <h3 id={`thoughts-${note.noteUid}`}>我的学习想法</h3>
              <p>每次回看都可以补充；这些记录会按时间保留，并交给后续 AI 综合分析。</p>
            </div>
            <span>{note.studyNotes.length} 条</span>
          </div>
          <form className="lc-thought-composer" onSubmit={(event) => { event.preventDefault(); void addStudyThought(note); }}>
            <textarea
              value={thoughtDraft}
              maxLength={4000}
              rows={3}
              onChange={(event) => setThoughtDraft(event.target.value)}
              placeholder="这次重做或回看，有什么新的理解、易错点、解题思路？"
              aria-label="记录新的学习想法"
            />
            <div>
              <span>{thoughtDraft.length}/4000</span>
              <button type="submit" disabled={!thoughtDraft.trim() || thoughtSaving}><Plus size={15} />记录想法</button>
            </div>
          </form>
          {note.studyNotes.length > 0 ? (
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
          ) : <p className="lc-thought-empty">还没有记录。第一次重做时，把新思路留在这里。</p>}
        </section>

        {itemSummary.length > 0 && (
          <section className="lc-detail-section">
            <h3>{itemSummary.length > 1 ? '识别内容' : '内容摘要'}</h3>
            <ol className="lc-detail-items">
              {itemSummary.map((item, index) => (
                <li key={`${note.noteUid}:detail:${index}`}>
                  <strong>{item.title || item.knowledgePoint || `内容 ${index + 1}`}</strong>
                  {item.summary && <p>{item.summary}</p>}
                  <span>{[
                    item.knowledgePoint,
                    item.questionType,
                    item.wrongReason ? `错因：${item.wrongReason}` : '',
                  ].filter(Boolean).join(' · ')}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {note.tags.length > 0 && (
          <div className="lc-detail-tags"><Tag size={15} />{note.tags.slice(0, 10).map((tag) => <span key={tag}>#{tag}</span>)}</div>
        )}

        {!showQuestionFirst && sourcePreview}

        <section className="lc-source-row">
          <FileImage size={19} aria-hidden="true" />
          <div>
            <strong>{fileNameFromPath(note.filePath)}</strong>
            <span title={note.filePath}>{note.filePath || '原图路径尚未同步'}</span>
          </div>
          <button type="button" onClick={() => void handleSourcePath(note.filePath)} disabled={!note.filePath}><FolderOpen size={16} />资源管理器</button>
          <button type="button" onClick={() => void copySourcePath(note.filePath)} disabled={!note.filePath} aria-label="复制原图路径"><Copy size={16} /></button>
          <button type="button" onClick={() => onOpenDate(date)}>当天记录</button>
        </section>
        {context === 'inbox' && (
          <div className="lc-inbox-actions lc-inbox-note-actions">
            <button className="primary" type="button" disabled={pendingNoteUid === note.noteUid} onClick={() => beginClassificationEdit(note)}><Pencil size={16} />修改分类</button>
            <button
              type="button"
              disabled={pendingNoteUid === note.noteUid}
              onClick={() => void ignorePendingNote(note.noteUid)}
            ><Archive size={16} />忽略这条</button>
          </div>
        )}
        <div className={`lc-source-feedback ${feedback || sourceFeedback ? 'visible' : ''}`} role="status">
          {pendingNoteUid === note.noteUid ? '正在保存…' : feedback || sourceFeedback || ' '}
        </div>
      </article>
    );
  };

  const renderReview = () => (
    <div className="lc-review-layout">
      <aside className="lc-review-queue" aria-label="今日复习队列">
        <div className="lc-queue-heading">
          <strong>今日到期</strong>
          <span>{dueCards.length}</span>
        </div>
        <div className="lc-queue-list">
          {dueCards.map((card) => (
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
          {upcomingCards.length > 0 && <div className="lc-queue-heading"><strong>遗忘曲线计划中</strong><span>{upcomingCards.length}</span></div>}
          {upcomingCards.map((card) => (
            <button
              className={currentCard?.id === card.id ? 'active' : ''}
              key={card.id}
              type="button"
              onClick={() => { setSelectedCardId(card.id); setRevealed(false); setFeedback(''); }}
            >
              <span>{card.front || card.sourceTitle || '未命名卡片'}</span>
              <span className="lc-queue-meta"><em>{card.dueDate} 复习</em>{displaySubject(card.subject)}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="lc-card-stage" aria-live="polite">
        {currentCard ? (
          <>
            <header className="lc-card-heading">
              <div>
                <span className={`lc-kind lc-kind-${currentCard.kind}`}>{currentCard.kind === 'mistake' ? '错题卡' : '背诵卡'}</span>
                <strong>{currentCard.subject || '未分类'}</strong>
              </div>
              <span className="lc-card-count">{currentCardIndex + 1} / {reviewCards.length}</span>
            </header>

            <button className={`lc-flip-card ${revealed ? 'is-revealed' : ''}`} type="button" onClick={() => setRevealed((value) => !value)}>
              <span className="lc-card-side-label">{revealed ? '答案' : '问题'}</span>
              <p>{revealed
                ? currentCard.back || '这张卡片还没有答案。'
                : currentCard.front || currentCard.sourceTitle || '请回忆这条笔记的核心内容。'}</p>
              <span className="lc-flip-hint">{revealed ? '再次点击隐藏答案' : '点击或按 Space 翻卡'}</span>
            </button>

            <div className="lc-card-meta">
              <span>{cardSubtitle(currentCard)}</span>
              {currentCard.tags.slice(0, 4).map((tag) => <em key={tag}>#{tag}</em>)}
            </div>

            <div className="lc-card-controls">
              <button type="button" onClick={() => stepCard(-1)} disabled={reviewCards.length < 2} aria-label="上一张"><ChevronLeft size={18} /></button>
              <button type="button" disabled={Boolean(pendingCardId) || editorSaving} onClick={() => beginEditCard(currentCard)}><Pencil size={16} />编辑</button>
              {currentCardIsDue ? (
                <>
                  <button className="lc-action-forgot" type="button" disabled={Boolean(pendingCardId)} onClick={() => patchCurrentCard({ reviewResult: 'forgotten' }, '明天再复习。')}><RotateCcw size={16} />忘记 <kbd>1</kbd></button>
                  <button className="lc-action-primary" type="button" disabled={Boolean(pendingCardId)} onClick={() => patchCurrentCard({ reviewResult: 'remembered' }, '复习间隔已延长。')}><Check size={16} />记住 <kbd>2</kbd></button>
                </>
              ) : <span className="lc-card-count">计划 {currentCard.dueDate} 复习</span>}
              {currentCard.sourceFilePath && <button type="button" onClick={() => void handleSourcePath(currentCard.sourceFilePath)}><FolderOpen size={16} />原图</button>}
              <button className="danger" type="button" disabled={Boolean(pendingCardId) || editorSaving} onClick={() => void deleteCard(currentCard)}><Trash2 size={16} />删除</button>
              <button type="button" onClick={() => stepCard(1)} disabled={reviewCards.length < 2} aria-label="下一张"><ChevronRight size={18} /></button>
            </div>
            <div className={`lc-feedback ${feedback || sourceFeedback ? 'visible' : ''}`}>{pendingCardId ? '正在保存…' : feedback || sourceFeedback || ' '}</div>
          </>
        ) : (
          <div className="lc-detail-empty">
            <Check size={28} />
            <h3>今天的复习已完成</h3>
          </div>
        )}
      </section>
    </div>
  );

  const renderMistakes = () => (
    <div className="lc-workspace">
      <aside className="lc-master-pane">
        {renderSearch(visibleMistakes.length, '搜索错题、页码或备注', '新增错题', () => beginCreateNote('mistake'))}
        <div className="lc-filters" aria-label="错题筛选">
          <select value={mistakeFilters.subject} onChange={(event) => setMistakeFilters((current) => ({ ...current, subject: event.target.value }))} aria-label="按科目筛选">
            <option value="">全部科目</option>
            {mistakeFacets.subjects.map((value) => <option key={value} value={value}>{displaySubject(value)}</option>)}
          </select>
          <select value={mistakeFilters.knowledgePoint} onChange={(event) => setMistakeFilters((current) => ({ ...current, knowledgePoint: event.target.value }))} aria-label="按知识点筛选">
            <option value="">全部知识点</option>
            {mistakeFacets.knowledgePoints.map((value) => <option key={value}>{value}</option>)}
          </select>
          <select value={mistakeFilters.questionType} onChange={(event) => setMistakeFilters((current) => ({ ...current, questionType: event.target.value }))} aria-label="按题型筛选">
            <option value="">全部题型</option>
            {mistakeFacets.questionTypes.map((value) => <option key={value}>{value}</option>)}
          </select>
          <select value={mistakeFilters.wrongReason} onChange={(event) => setMistakeFilters((current) => ({ ...current, wrongReason: event.target.value }))} aria-label="按错因筛选">
            <option value="">全部错因</option>
            {mistakeFacets.wrongReasons.map((value) => <option key={value}>{value}</option>)}
          </select>
          <select value={mistakeFilters.status} onChange={(event) => setMistakeFilters((current) => ({ ...current, status: event.target.value as MistakeStatus }))} aria-label="按复习状态筛选">
            <option value="all">全部状态</option>
            <option value="due">待重做</option>
            <option value="reviewing">复习中</option>
            <option value="mastered">已掌握</option>
            <option value="untracked">未加入复习</option>
          </select>
          {(mistakeFilters.subject
            || mistakeFilters.knowledgePoint
            || mistakeFilters.questionType
            || mistakeFilters.wrongReason
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
    <div className="lc-workspace">
      <aside className="lc-master-pane">
        {renderSearch(visibleMemory.length, '搜索背诵内容、页码或知识点', '新增背诵', () => beginCreateNote('memory'))}
        <div className="lc-master-list">
          {visibleMemory.map((entry) => renderNoteButton(entry, 'memory'))}
          {visibleMemory.length === 0 && <div className="lc-list-empty"><Brain size={23} /><strong>还没有背诵内容</strong></div>}
        </div>
      </aside>
      <section className="lc-detail-pane">{renderNoteDetail(selectedNote, 'memory')}</section>
    </div>
  );

  const renderGoodQuestions = () => (
    <div className="lc-workspace">
      <aside className="lc-master-pane">
        {renderSearch(visibleGood.length, '搜索好题、页码或知识点', '新增好题', () => beginCreateNote('knowledge', true))}
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
          ><Plus size={15} />从错题导入</button>
          <span>{importableMistakes.length > 0 ? `${importableMistakes.length} 道可选` : '错题已全部收录'}</span>
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
    <div className="lc-workspace">
      <aside className="lc-master-pane">
        {renderSearch(visibleLibrary.length, '搜索页码、题号、知识点或备注', '新增知识', () => beginCreateNote('knowledge'))}
        <div className="lc-master-list lc-grouped-list">
          {groupedLibrary.map(([date, entries]) => (
            <section className="lc-date-group" key={date}>
              <header><time>{formatRecordDate(date)}</time><span>{entries.length}</span></header>
              {entries.map((entry) => renderNoteButton(entry, 'library'))}
            </section>
          ))}
          {visibleLibrary.length === 0 && <div className="lc-list-empty"><BookOpenText size={23} /><strong>没有匹配的笔记</strong></div>}
        </div>
      </aside>
      <section className="lc-detail-pane">{renderNoteDetail(selectedNote, 'library')}</section>
    </div>
  );

  const renderUncategorized = () => (
    <div className="lc-workspace">
      <aside className="lc-master-pane">
        {renderSearch(visibleUncategorized.length, '搜索尚未归入错题、好题或背诵的笔记')}
        <div className="lc-inbox-summary">
          <span>本周自动审查发现 <strong>{currentWeekUncategorizedCount}</strong></span>
          <span>仅含非默认文件夹</span>
        </div>
        <div className="lc-master-list">
          {visibleUncategorized.map((entry) => renderNoteButton(entry, 'library'))}
          {visibleUncategorized.length === 0 && <div className="lc-list-empty"><ClipboardCheck size={23} /><strong>本周分类审查已通过</strong></div>}
        </div>
      </aside>
      <section className="lc-detail-pane">{renderNoteDetail(selectedNote, 'library')}</section>
    </div>
  );

  const renderInbox = () => (
      <div className="lc-workspace">
        <aside className="lc-master-pane">
          <div className="lc-inbox-summary">
            <span>分类确实不确定 <strong>{pendingNotes.length}</strong></span>
            <span>已分类内容会自动归档</span>
          </div>
          <div className="lc-master-list">
            {inboxEntries.map((entry) => renderNoteButton(entry.entry, 'inbox'))}
            {inboxEntries.length === 0 && <div className="lc-list-empty"><ClipboardCheck size={23} /><strong>收件箱已清空</strong></div>}
          </div>
        </aside>
        <section className="lc-detail-pane">
          {selectedInbox
            ? renderNoteDetail(selectedInbox.entry, 'inbox')
            : <div className="lc-detail-empty"><Check size={28} /><h3>收件箱里没有内容</h3></div>}
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
      <div className={`lc-weekly-feedback ${weeklyFeedback ? 'visible' : ''}`} role="status">{weeklyFeedback || ' '}</div>
    </section>
  );

  const views: Array<{ id: CenterView; label: string; icon: typeof CalendarClock; count: number }> = [
    { id: 'review', label: '今日复习', icon: CalendarClock, count: dueCards.length },
    { id: 'mistakes', label: '错题', icon: TriangleAlert, count: mistakeNotes.length },
    { id: 'good', label: '好题', icon: Star, count: goodNotes.length },
    { id: 'memory', label: '背诵', icon: Brain, count: memoryNotes.length },
    { id: 'uncategorized', label: '未分类笔记', icon: ClipboardCheck, count: uncategorizedNotes.length },
    { id: 'library', label: '知识库', icon: BookOpenText, count: indexedNotes.length },
    { id: 'weekly', label: '周复盘', icon: FileText, count: weeklyPackage.stats.noteCount },
    { id: 'inbox', label: '收件箱', icon: Inbox, count: inboxEntries.length },
  ];

  return (
    <section className="learning-center" aria-label="学习中心">
      <header className="lc-header">
        <nav className="lc-tabs" aria-label="学习中心视图">
          {views.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={view === item.id ? 'active' : ''}
                key={item.id}
                type="button"
                onClick={() => {
                  setView(item.id);
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
        {view === 'uncategorized' && renderUncategorized()}
        {view === 'library' && renderLibrary()}
        {view === 'weekly' && renderWeeklyReview()}
        {view === 'inbox' && renderInbox()}
      </div>

      {imageLightbox && (
        <div className="lc-image-lightbox" role="presentation" onPointerDown={(event) => {
          if (event.target === event.currentTarget) setImageLightbox(null);
        }}>
          <div className="lc-image-lightbox-dialog" role="dialog" aria-modal="true" aria-label="题目原图大图">
            <button type="button" onClick={() => setImageLightbox(null)} aria-label="关闭大图"><X size={22} /></button>
            <img src={imageLightbox.src} alt={imageLightbox.alt} />
          </div>
        </div>
      )}

      {goodImportOpen && (
        <div className="lc-editor-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !editorSaving) setGoodImportOpen(false);
        }}>
          <section className="lc-content-editor lc-good-import-dialog" role="dialog" aria-modal="true" aria-label="从错题导入好题">
            <header>
              <div><span>人工收录</span><h2>从错题导入好题</h2></div>
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
                      <small>{[displaySubject(note.subject), noteKnowledgePoints(note)[0], noteWrongReasons(note)[0]].filter(Boolean).join(' · ') || '暂无分类信息'}</small>
                    </span>
                  </label>
                ))}
                {visibleGoodImport.length === 0 && (
                  <div className="lc-list-empty"><Search size={22} /><strong>没有匹配的错题</strong></div>
                )}
              </div>
            </div>
            <footer>
              <span>导入后仍保留在错题中，不会改变复习记录。</span>
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
          <form className="lc-content-editor" role="dialog" aria-modal="true" aria-label={noteEditor.mode === 'create' ? '新增学习内容' : '编辑学习内容'} onSubmit={(event) => { event.preventDefault(); void saveNoteEditor(); }}>
            <header>
              <div><span>{noteEditor.mode === 'create' ? '新增' : '编辑'}</span><h2>学习内容</h2></div>
              <button type="button" aria-label="关闭编辑器" disabled={editorSaving} onClick={() => setNoteEditor(null)}><X size={18} /></button>
            </header>
            <div className="lc-editor-grid">
              <label>类型<select value={noteEditor.kind} onChange={(event) => setNoteEditor((current) => current ? { ...current, kind: event.target.value as LearningItemKind, createCard: event.target.value !== 'knowledge' && current.createCard } : current)}>
                <option value="knowledge">知识</option>
                <option value="mistake">错题</option>
                <option value="memory">背诵</option>
              </select></label>
              <label>一级科目<select value={noteEditor.subject} onChange={(event) => setNoteEditor((current) => current ? { ...current, subject: event.target.value } : current)}>
                <option value="">请选择</option>
                {subjectOptions.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
              </select></label>
              <label className="wide">标题<input value={noteEditor.title} maxLength={120} autoFocus onChange={(event) => setNoteEditor((current) => current ? { ...current, title: event.target.value } : current)} placeholder="例如：进程与线程的区别" /></label>
              <label>知识点<input list="lc-knowledge-options" value={noteEditor.knowledgePoint} maxLength={60} onChange={(event) => setNoteEditor((current) => current ? { ...current, knowledgePoint: event.target.value } : current)} /></label>
              <label>题型<input value={noteEditor.questionType} maxLength={60} onChange={(event) => setNoteEditor((current) => current ? { ...current, questionType: event.target.value } : current)} /></label>
              {noteEditor.kind === 'mistake' && <label className="wide">错因<input value={noteEditor.wrongReason} maxLength={500} onChange={(event) => setNoteEditor((current) => current ? { ...current, wrongReason: event.target.value } : current)} placeholder="例如：混淆阻塞与就绪状态" /></label>}
              <label className="wide">内容<textarea value={noteEditor.remark} maxLength={4000} onChange={(event) => setNoteEditor((current) => current ? { ...current, remark: event.target.value } : current)} placeholder="写下题目、结论、易错点或需要记住的内容" /></label>
              <label className="wide">标签<input value={noteEditor.tags} onChange={(event) => setNoteEditor((current) => current ? { ...current, tags: event.target.value } : current)} placeholder="用逗号分隔" /></label>
              <label className="lc-editor-check wide"><input type="checkbox" checked={noteEditor.isGood} onChange={(event) => setNoteEditor((current) => current ? { ...current, isGood: event.target.checked } : current)} />收藏到“好题”（可同时保留为错题）</label>
              {noteEditor.mode === 'create' && noteEditor.kind !== 'knowledge' && (
                <label className="lc-editor-check wide"><input type="checkbox" checked={noteEditor.createCard} onChange={(event) => setNoteEditor((current) => current ? { ...current, createCard: event.target.checked } : current)} />同时建立一张今日复习卡</label>
              )}
            </div>
            <datalist id="lc-knowledge-options">{knowledgePointOptions.map((point) => <option key={point} value={point} />)}</datalist>
            <footer>
              <span>{feedback}</span>
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
              <div><span>编辑</span><h2>复习卡片</h2></div>
              <button type="button" aria-label="关闭编辑器" disabled={editorSaving} onClick={() => setCardEditor(null)}><X size={18} /></button>
            </header>
            <div className="lc-editor-grid single">
              <label className="wide">正面<textarea value={cardEditor.front} maxLength={500} autoFocus onChange={(event) => setCardEditor((current) => current ? { ...current, front: event.target.value } : current)} /></label>
              <label className="wide">答案<textarea value={cardEditor.back} maxLength={2000} onChange={(event) => setCardEditor((current) => current ? { ...current, back: event.target.value } : current)} /></label>
            </div>
            <footer>
              <span>{feedback}</span>
              <button type="button" disabled={editorSaving} onClick={() => setCardEditor(null)}>取消</button>
              <button className="primary" type="submit" disabled={editorSaving}><Save size={16} />{editorSaving ? '保存中' : '保存'}</button>
            </footer>
          </form>
        </div>
      )}
    </section>
  );
}
