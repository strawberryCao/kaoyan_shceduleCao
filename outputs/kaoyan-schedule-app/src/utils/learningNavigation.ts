import type { LearningAutoNote } from './learningData';

export type LearningTargetView = 'mistakes' | 'good' | 'memory' | 'quick' | 'library';

export const isLearningTargetView = (value: string | null | undefined): value is LearningTargetView => (
  value === 'mistakes' || value === 'good' || value === 'memory' || value === 'quick' || value === 'library'
);

export const learningTargetViewFromUrl = (targetUrl: string): LearningTargetView | undefined => {
  try {
    const url = new URL(targetUrl, window.location.origin);
    const view = url.searchParams.get('view');
    return isLearningTargetView(view) ? view : undefined;
  } catch {
    return undefined;
  }
};

const noteMatchesView = (note: LearningAutoNote, view: LearningTargetView): boolean => {
  if (view === 'good') return note.facets.includes('good') || note.goodQuestion === true || note.noteType === 'good';
  if (view === 'mistakes') return note.facets.includes('mistake') || note.noteType === 'mistake';
  if (view === 'memory') return note.facets.includes('memory') || note.noteType === 'memory';
  if (view === 'quick') return note.facets.includes('quick') || note.noteType === 'quick';
  return true;
};

export const learningViewForNote = (
  note: LearningAutoNote | undefined,
  preferredView?: LearningTargetView,
): LearningTargetView => {
  if (!note) return preferredView || 'library';
  if (preferredView && noteMatchesView(note, preferredView)) return preferredView;
  if (note.facets.includes('good') || note.goodQuestion === true || note.noteType === 'good') return 'good';
  if (note.facets.includes('mistake') || note.noteType === 'mistake') return 'mistakes';
  if (note.facets.includes('memory') || note.noteType === 'memory') return 'memory';
  if (note.facets.includes('quick') || note.noteType === 'quick') return 'quick';
  return 'library';
};

export const learningNoteTarget = (
  noteUid: string,
  note?: LearningAutoNote,
  preferredView?: LearningTargetView,
): string => {
  const params = new URLSearchParams({
    panel: 'learning',
    view: learningViewForNote(note, preferredView),
    noteUid,
  });
  return `?${params.toString()}`;
};
