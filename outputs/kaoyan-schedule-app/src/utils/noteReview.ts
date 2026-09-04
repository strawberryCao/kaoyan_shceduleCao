export const DEFAULT_NOTE_BUCKET = '默认文件夹';

export const DEFAULT_NOTE_BUCKET_ALIASES = [
  DEFAULT_NOTE_BUCKET,
  '未分类',
  '默认',
  '收件箱',
] as const;

export type NoteReviewState = 'pending' | 'auto_applied' | 'accepted' | 'corrected' | 'ignored';

export interface NoteReviewFields {
  subject?: string | null;
  remark?: string | null;
  facets?: readonly string[] | null;
  noteType?: string | null;
  reviewStatus?: string | null;
  reviewState?: string | null;
  organizationStatus?: string | null;
}

const normalizedRemark = (note: NoteReviewFields): string => (
  typeof note.remark === 'string' ? note.remark.normalize('NFKC') : ''
);

export const hasExplicitMistakeIntent = (note: NoteReviewFields): boolean => {
  if (Array.isArray(note.facets) && note.facets.includes('mistake')) return true;
  return /(?:错题|易错|错因|错在|做错|算错|(?:计算|概念|审题|步骤|方法|符号|抄写|记忆|理解|判断|公式)(?:错误|错|失误|混淆)|漏看|漏掉|漏条件|粗心)/u.test(normalizedRemark(note));
};

export const hasExplicitMemoryIntent = (note: NoteReviewFields): boolean => {
  if (Array.isArray(note.facets) && note.facets.includes('memory')) return true;
  const remark = normalizedRemark(note);
  return /(?:^|[\s#【\[，,。；;：:])(?:记|记住|记忆|背|背诵|要背)(?=$|[\s#】\]，,。；;：:])/u.test(remark)
    || /(?:要记住|记下来|需要记|必须记|背下来|需要背|必须背|重点背|熟记)/u.test(remark);
};

export const isExplicitMistakeOnly = (note: NoteReviewFields): boolean => (
  hasExplicitMistakeIntent(note) && !hasExplicitMemoryIntent(note)
);

const hasExplicitUserCategory = (note: NoteReviewFields): boolean => {
  const noteType = typeof note.noteType === 'string' ? note.noteType.trim().toLowerCase() : '';
  if (!['mistake', 'memory', 'good'].includes(noteType)) return false;
  if (noteType === 'mistake') return hasExplicitMistakeIntent(note);
  if (noteType === 'memory') return hasExplicitMemoryIntent(note);
  return /(?:^|[\s#【\[，,。；;：:])(?:好题|经典题|典型题|精品题)(?=$|[\s#】\]，,。；;：:])/u.test(normalizedRemark(note));
};

const DEFAULT_NOTE_BUCKET_NAMES = new Set<string>(DEFAULT_NOTE_BUCKET_ALIASES);
const REVIEW_STATES = new Set<NoteReviewState>([
  'pending',
  'auto_applied',
  'accepted',
  'corrected',
  'ignored',
]);

const normalizeState = (value: unknown): NoteReviewState | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'confirmed') return 'accepted';
  return REVIEW_STATES.has(normalized as NoteReviewState) ? normalized as NoteReviewState : null;
};

export const normalizeNoteBucket = (value: unknown): string => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return !normalized || DEFAULT_NOTE_BUCKET_NAMES.has(normalized) ? DEFAULT_NOTE_BUCKET : normalized;
};

export const isDefaultNoteBucket = (value: unknown): boolean => (
  normalizeNoteBucket(value) === DEFAULT_NOTE_BUCKET
);

export const resolveNoteReviewState = (note: NoteReviewFields): NoteReviewState => {
  const reviewStatus = normalizeState(note.reviewStatus);
  if (reviewStatus) return reviewStatus;

  const reviewState = normalizeState(note.reviewState);
  if (reviewState) return reviewState;

  const organizationStatus = normalizeState(note.organizationStatus);
  if (organizationStatus) return organizationStatus;

  return isDefaultNoteBucket(note.subject) ? 'pending' : 'auto_applied';
};

export const isPendingNoteReview = (note: NoteReviewFields): boolean => (
  resolveNoteReviewState(note) === 'pending' && !hasExplicitUserCategory(note)
);

export const isIgnoredNote = (note: NoteReviewFields): boolean => (
  resolveNoteReviewState(note) === 'ignored'
);

export const isKnowledgeEligibleNote = (note: NoteReviewFields): boolean => (
  !isIgnoredNote(note) && !isDefaultNoteBucket(note.subject)
);

export const selectPendingNoteReviews = <T extends NoteReviewFields>(notes: readonly T[]): T[] => (
  notes.filter(isPendingNoteReview)
);

export const selectKnowledgeEligibleNotes = <T extends NoteReviewFields>(notes: readonly T[]): T[] => (
  notes.filter(isKnowledgeEligibleNote)
);
