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
  reviewStatus?: string | null;
  reviewState?: string | null;
  organizationStatus?: string | null;
}

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
  resolveNoteReviewState(note) === 'pending'
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
