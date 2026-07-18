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
  FolderOpen,
  Inbox,
  RotateCcw,
  Search,
  Tag,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { LearningAutoNote, LearningCard, LearningDataSnapshot } from '../utils/learningData';
import { NOTE_SERVER_URL } from '../utils/notes';
import '../learning-center.css';

export type LearningCardPatch = Partial<Pick<LearningCard, 'front' | 'back' | 'status' | 'dueDate' | 'userEdited'>> & {
  reviewResult?: 'remembered' | 'forgotten';
};

export interface LearningCenterProps {
  snapshot: LearningDataSnapshot;
  onPatchCard: (cardId: string, patch: LearningCardPatch) => Promise<unknown> | unknown;
  onPatchNote: (noteUid: string, organizationStatus: 'confirmed' | 'ignored') => Promise<unknown> | unknown;
  onOpenDate: (date: string) => void;
}

type CenterView = 'review' | 'mistakes' | 'memory' | 'library' | 'inbox';
type MistakeStatus = 'all' | 'confirm' | 'due' | 'reviewing' | 'mastered' | 'untracked';

interface IndexedNote {
  date: string;
  note: LearningAutoNote;
  searchText: string;
}

interface MistakeFilters {
  subject: string;
  knowledgePoint: string;
  questionType: string;
  wrongReason: string;
  status: MistakeStatus;
}

type InboxEntry =
  | { key: string; kind: 'note'; timestamp: string; entry: IndexedNote }
  | { key: string; kind: 'card'; timestamp: string; card: LearningCard };

type NativeFileBridge = {
  showItemInFolder?: (filePath: string) => Promise<unknown> | unknown;
  openPath?: (filePath: string) => Promise<unknown> | unknown;
};

const DEFAULT_FOLDER_NAMES = new Set(['默认文件夹', '未分类', '默认']);
const MISTAKE_WORDS = ['错题', '易错'];
const MEMORY_WORDS = ['背诵', '记忆', '要背', '记住'];
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

const noteSearchText = (date: string, note: LearningAutoNote): string => [
  date,
  note.capturedDate,
  note.title,
  note.subject,
  displaySubject(note.subject),
  note.remark,
  note.noteType,
  note.questionType,
  note.wrongReason,
  pageRefText(note),
  ...note.tags,
  ...note.knowledgePath,
  ...note.items.flatMap((item) => [
    item.title,
    item.knowledgePoint,
    item.questionType,
    item.summary,
    item.wrongReason,
    ...item.tags,
  ]),
].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');

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
  ...note.items.map((item) => item.knowledgePoint),
]);

const noteQuestionTypes = (note: LearningAutoNote): string[] => uniqueText([
  note.questionType,
  ...note.items.map((item) => item.questionType),
  ...note.tags
    .filter((tag) => /^题型[:：]/.test(tag))
    .map((tag) => tag.replace(/^题型[:：]\s*/, '')),
]);

const noteWrongReasons = (note: LearningAutoNote): string[] => uniqueText([
  note.wrongReason,
  ...note.items.map((item) => item.wrongReason),
  ...note.tags
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

const isPendingNote = (note: LearningAutoNote): boolean => (
  note.organizationStatus === 'pending'
  && (
    DEFAULT_FOLDER_NAMES.has(note.subject.trim())
    || note.confidence === null
    || (typeof note.confidence === 'number' && note.confidence < 0.82)
  )
);

const matchesQuery = (entry: IndexedNote, query: string): boolean => {
  const terms = query.trim().toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean);
  return terms.length === 0 || terms.every((term) => entry.searchText.includes(term));
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
  confirm: '待确认',
  due: '待重做',
  reviewing: '复习中',
  mastered: '已掌握',
  untracked: '未加入复习',
};

const initialView = (): CenterView => {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('view');
  if (requested === 'mistakes' || requested === 'memory' || requested === 'inbox') return requested;
  if (requested === 'knowledge' || params.has('q')) return 'library';
  if (params.get('filter') === 'draft') return 'inbox';
  return 'review';
};

export function LearningCenter({ snapshot, onPatchCard, onPatchNote, onOpenDate }: LearningCenterProps) {
  const today = localDate();
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
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  const [mistakeFilters, setMistakeFilters] = useState<MistakeFilters>(EMPTY_FILTERS);

  const activeCards = useMemo(() => snapshot.cards.filter((card) => card.status === 'active'), [snapshot.cards]);
  const dueCards = useMemo(() => activeCards
    .filter((card) => !card.dueDate || card.dueDate <= today)
    .sort((left, right) => {
      const dueOrder = (left.dueDate || today).localeCompare(right.dueDate || today);
      return dueOrder || right.updatedAt.localeCompare(left.updatedAt);
    }), [activeCards, today]);
  const draftCards = useMemo(() => snapshot.cards
    .filter((card) => card.status === 'draft')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [snapshot.cards]);

  const currentCard = dueCards.find((card) => card.id === selectedCardId) ?? dueCards[0] ?? null;
  const currentCardIndex = currentCard ? dueCards.findIndex((card) => card.id === currentCard.id) : -1;

  const indexedNotes = useMemo<IndexedNote[]>(() => Object.entries(snapshot.days)
    .flatMap(([date, day]) => day.autoNotes.map((note) => {
      const capturedDate = /^\d{4}-\d{2}-\d{2}$/.test(note.capturedDate) ? note.capturedDate : date;
      return {
        date: capturedDate,
        note,
        searchText: noteSearchText(capturedDate, note),
      };
    }))
    .sort((left, right) => right.date.localeCompare(left.date) || right.note.updatedAt.localeCompare(left.note.updatedAt)), [snapshot.days]);

  const mistakeNotes = useMemo(() => indexedNotes.filter(({ note }) => isMistakeNote(note)), [indexedNotes]);
  const memoryNotes = useMemo(() => indexedNotes.filter(({ note }) => isMemoryNote(note)), [indexedNotes]);
  const pendingNotes = useMemo(() => indexedNotes.filter(({ note }) => isPendingNote(note)), [indexedNotes]);

  const mistakeFacets = useMemo(() => ({
    subjects: uniqueText(mistakeNotes.map(({ note }) => note.subject)).sort((left, right) => left.localeCompare(right, 'zh-CN')),
    knowledgePoints: uniqueText(mistakeNotes.flatMap(({ note }) => noteKnowledgePoints(note))).sort((left, right) => left.localeCompare(right, 'zh-CN')),
    questionTypes: uniqueText(mistakeNotes.flatMap(({ note }) => noteQuestionTypes(note))).sort((left, right) => left.localeCompare(right, 'zh-CN')),
    wrongReasons: uniqueText(mistakeNotes.flatMap(({ note }) => noteWrongReasons(note))).sort((left, right) => left.localeCompare(right, 'zh-CN')),
  }), [mistakeNotes]);

  const visibleMistakes = useMemo(() => mistakeNotes.filter((entry) => {
    const { note } = entry;
    if (!matchesQuery(entry, query)) return false;
    if (mistakeFilters.subject && note.subject !== mistakeFilters.subject) return false;
    if (mistakeFilters.knowledgePoint && !noteKnowledgePoints(note).includes(mistakeFilters.knowledgePoint)) return false;
    if (mistakeFilters.questionType && !noteQuestionTypes(note).includes(mistakeFilters.questionType)) return false;
    if (mistakeFilters.wrongReason && !noteWrongReasons(note).includes(mistakeFilters.wrongReason)) return false;
    return mistakeFilters.status === 'all' || mistakeStatus(note, snapshot.cards, today) === mistakeFilters.status;
  }), [mistakeFilters, mistakeNotes, query, snapshot.cards, today]);

  const visibleMemory = useMemo(() => memoryNotes.filter((entry) => matchesQuery(entry, query)), [memoryNotes, query]);
  const visibleLibrary = useMemo(() => indexedNotes.filter((entry) => matchesQuery(entry, query)), [indexedNotes, query]);

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
    ...draftCards.map((card): InboxEntry => ({
      key: `card:${card.id}`,
      kind: 'card',
      timestamp: card.updatedAt,
      card,
    })),
  ].sort((left, right) => right.timestamp.localeCompare(left.timestamp)), [draftCards, pendingNotes]);

  const noteListForView = view === 'mistakes'
    ? visibleMistakes
    : view === 'memory'
      ? visibleMemory
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
  }, [selectedNoteUid, selectedInboxKey, selectedCardId, view]);

  const stepCard = (direction: -1 | 1) => {
    if (dueCards.length < 2 || currentCardIndex < 0) return;
    const nextIndex = (currentCardIndex + direction + dueCards.length) % dueCards.length;
    setSelectedCardId(dueCards[nextIndex].id);
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
    const nextCard = dueCards.find((card) => card.id !== currentCard.id) ?? null;
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
      } else if (event.key === '1') {
        event.preventDefault();
        patchCurrentCard({ reviewResult: 'forgotten' }, '已标记为忘记，明天再复习。');
      } else if (event.key === '2') {
        event.preventDefault();
        patchCurrentCard({ reviewResult: 'remembered' }, '已记住，复习间隔已延长。');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentCard, pendingCardId, revealed, view]);

  const handleSourcePath = async (filePath: string) => {
    if (!filePath) {
      setSourceFeedback('这条记录还没有原图路径。');
      return;
    }
    const bridge = window.kaoyanDesktop as (typeof window.kaoyanDesktop & NativeFileBridge) | undefined;
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
      throw new Error(`Reveal failed: ${response.status}`);
    } catch {
      try {
        await navigator.clipboard.writeText(filePath);
        setSourceFeedback('资源管理器暂时不可用，原图路径已复制。');
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

  const updateNoteOrganization = async (noteUid: string, organizationStatus: 'confirmed' | 'ignored') => {
    if (pendingNoteUid) return;
    try {
      setPendingNoteUid(noteUid);
      setFeedback('');
      await onPatchNote(noteUid, organizationStatus);
      setSelectedInboxKey(null);
      setFeedback(organizationStatus === 'confirmed' ? '已确认当前分类。' : '已从待确认中移除。');
    } catch {
      setFeedback('暂时无法更新，笔记仍保留在待确认中。');
    } finally {
      setPendingNoteUid(null);
    }
  };

  const renderSearch = (count: number, placeholder: string) => (
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
    </div>
  );

  const renderNoteButton = (entry: IndexedNote, context: 'mistake' | 'memory' | 'library' | 'inbox') => {
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

  const renderNoteDetail = (entry: IndexedNote | null, context: 'mistake' | 'memory' | 'library' | 'inbox') => {
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
    const contextLabel = context === 'mistake' ? '错题' : context === 'memory' ? '背诵' : context === 'inbox' ? '待确认' : '知识笔记';
    const imageUrl = note.filePath ? `${NOTE_SERVER_URL}/note-file?path=${encodeURIComponent(note.filePath)}` : '';
    return (
      <article className="lc-note-detail">
        <header className="lc-detail-heading">
          <div>
            <span className={`lc-detail-kind is-${context}`}>{contextLabel}</span>
            <h2>{note.title || '未命名笔记'}</h2>
          </div>
          <time>{formatRecordDate(date)}</time>
        </header>

        <div className="lc-detail-facts">
          <div><span>科目</span><strong>{displaySubject(note.subject)}</strong></div>
          <div><span>页码 / 题号</span><strong>{pages || '—'}</strong></div>
          <div><span>知识点</span><strong>{knowledgePoints.join('、') || '—'}</strong></div>
          <div><span>题型</span><strong>{questionTypes.join('、') || '—'}</strong></div>
          {context === 'mistake' && <div className="lc-fact-wide"><span>错因</span><strong>{wrongReasons.join('；') || '待确认'}</strong></div>}
        </div>

        {note.remark && (
          <section className="lc-detail-section">
            <h3>我的备注</h3>
            <p>{note.remark}</p>
          </section>
        )}

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

        <figure className="lc-source-preview">
          {imageUrl && failedImagePath !== note.filePath ? (
            <img src={imageUrl} alt={`${note.title || '笔记'}原图`} onError={() => setFailedImagePath(note.filePath)} />
          ) : (
            <div><FileImage size={28} /><strong>{note.filePath ? '原图暂时无法预览' : '原图路径尚未同步'}</strong></div>
          )}
        </figure>

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
            <button
              className="primary"
              type="button"
              disabled={pendingNoteUid === note.noteUid}
              onClick={() => void updateNoteOrganization(note.noteUid, 'confirmed')}
            ><Check size={16} />确认当前分类</button>
            <button
              type="button"
              disabled={pendingNoteUid === note.noteUid}
              onClick={() => void updateNoteOrganization(note.noteUid, 'ignored')}
            ><Archive size={16} />不再提醒</button>
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
              <span className="lc-card-count">{currentCardIndex + 1} / {dueCards.length}</span>
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
              <button type="button" onClick={() => stepCard(-1)} disabled={dueCards.length < 2} aria-label="上一张"><ChevronLeft size={18} /></button>
              <button className="lc-action-forgot" type="button" disabled={Boolean(pendingCardId)} onClick={() => patchCurrentCard({ reviewResult: 'forgotten' }, '明天再复习。')}><RotateCcw size={16} />忘记 <kbd>1</kbd></button>
              <button className="lc-action-primary" type="button" disabled={Boolean(pendingCardId)} onClick={() => patchCurrentCard({ reviewResult: 'remembered' }, '复习间隔已延长。')}><Check size={16} />记住 <kbd>2</kbd></button>
              {currentCard.sourceFilePath && <button type="button" onClick={() => void handleSourcePath(currentCard.sourceFilePath)}><FolderOpen size={16} />原图</button>}
              <button type="button" onClick={() => stepCard(1)} disabled={dueCards.length < 2} aria-label="下一张"><ChevronRight size={18} /></button>
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
        {renderSearch(visibleMistakes.length, '搜索错题、页码或备注')}
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
            <option value="confirm">待确认</option>
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
        {renderSearch(visibleMemory.length, '搜索背诵内容、页码或知识点')}
        <div className="lc-master-list">
          {visibleMemory.map((entry) => renderNoteButton(entry, 'memory'))}
          {visibleMemory.length === 0 && <div className="lc-list-empty"><Brain size={23} /><strong>还没有背诵内容</strong></div>}
        </div>
      </aside>
      <section className="lc-detail-pane">{renderNoteDetail(selectedNote, 'memory')}</section>
    </div>
  );

  const renderLibrary = () => (
    <div className="lc-workspace">
      <aside className="lc-master-pane">
        {renderSearch(visibleLibrary.length, '搜索页码、题号、知识点或备注')}
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

  const renderInboxCardDetail = (card: LearningCard, nextKey: string | null) => (
    <article className="lc-inbox-card-detail">
      <header className="lc-detail-heading">
        <div><span className="lc-detail-kind is-inbox">卡片草稿</span><h2>{card.sourceTitle || card.front || '未命名卡片'}</h2></div>
        <span>{card.kind === 'mistake' ? '错题卡' : '背诵卡'}</span>
      </header>
      <div className="lc-card-draft-copy">
        <section><span>问题</span><p>{card.front || '等待补充问题'}</p></section>
        <section><span>答案</span><p>{card.back || '等待补充答案'}</p></section>
      </div>
      <div className="lc-detail-facts">
        <div><span>科目</span><strong>{displaySubject(card.subject)}</strong></div>
        <div><span>页码 / 题号</span><strong>{cardPageText(card) || '—'}</strong></div>
        <div className="lc-fact-wide"><span>知识点</span><strong>{card.knowledgePath.join(' / ') || '—'}</strong></div>
      </div>
      <div className="lc-inbox-actions">
        <button
          className="primary"
          type="button"
          disabled={Boolean(pendingCardId)}
          onClick={() => void updateCard(card, { status: 'active', dueDate: today }, '卡片已启用。', () => setSelectedInboxKey(nextKey))}
        ><Check size={16} />启用卡片</button>
        <button
          type="button"
          disabled={Boolean(pendingCardId)}
          onClick={() => void updateCard(card, { status: 'archived' }, '卡片已归档。', () => setSelectedInboxKey(nextKey))}
        ><Archive size={16} />暂不使用</button>
        {card.sourceFilePath && <button type="button" onClick={() => void handleSourcePath(card.sourceFilePath)}><FolderOpen size={16} />原图</button>}
      </div>
      <div className={`lc-feedback ${feedback || sourceFeedback ? 'visible' : ''}`}>{pendingCardId ? '正在保存…' : feedback || sourceFeedback || ' '}</div>
    </article>
  );

  const renderInbox = () => {
    const nextEntry = selectedInbox ? inboxEntries.find((entry) => entry.key !== selectedInbox.key) ?? null : null;
    return (
      <div className="lc-workspace">
        <aside className="lc-master-pane">
          <div className="lc-inbox-summary">
            <span>分类待确认 <strong>{pendingNotes.length}</strong></span>
            <span>卡片草稿 <strong>{draftCards.length}</strong></span>
          </div>
          <div className="lc-master-list">
            {inboxEntries.map((entry) => entry.kind === 'note' ? renderNoteButton(entry.entry, 'inbox') : (
              <button
                className={`lc-note-button ${selectedInboxKey === entry.key ? 'active' : ''}`}
                key={entry.key}
                type="button"
                onClick={() => setSelectedInboxKey(entry.key)}
              >
                <span className="lc-note-button-title">{entry.card.front || entry.card.sourceTitle || '未命名卡片'}</span>
                <span className="lc-note-button-meta"><span>{displaySubject(entry.card.subject)}</span><span>{entry.card.kind === 'mistake' ? '错题卡' : '背诵卡'}</span></span>
                <span className="lc-note-button-foot"><em>卡片草稿</em></span>
              </button>
            ))}
            {inboxEntries.length === 0 && <div className="lc-list-empty"><ClipboardCheck size={23} /><strong>待确认内容已处理完</strong></div>}
          </div>
        </aside>
        <section className="lc-detail-pane">
          {selectedInbox?.kind === 'note'
            ? renderNoteDetail(selectedInbox.entry, 'inbox')
            : selectedInbox?.kind === 'card'
              ? renderInboxCardDetail(selectedInbox.card, nextEntry?.key ?? null)
              : <div className="lc-detail-empty"><Check size={28} /><h3>没有待确认内容</h3></div>}
        </section>
      </div>
    );
  };

  const views: Array<{ id: CenterView; label: string; icon: typeof CalendarClock; count: number }> = [
    { id: 'review', label: '今日复习', icon: CalendarClock, count: dueCards.length },
    { id: 'mistakes', label: '错题', icon: TriangleAlert, count: mistakeNotes.length },
    { id: 'memory', label: '背诵', icon: Brain, count: memoryNotes.length },
    { id: 'library', label: '知识库', icon: BookOpenText, count: indexedNotes.length },
    { id: 'inbox', label: '待确认', icon: Inbox, count: inboxEntries.length },
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
        {view === 'memory' && renderMemory()}
        {view === 'library' && renderLibrary()}
        {view === 'inbox' && renderInbox()}
      </div>
    </section>
  );
}
