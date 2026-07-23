import { useEffect, useState } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { readLearningDataCache, saveLearningDataCache } from '../utils/learningData';
import { renameLearningNoteWithAi } from '../utils/notes';
import '../learning-rename-action.css';

interface SelectedImageNote {
  noteUid: string;
  title: string;
}

const findSelectedImageNote = (): SelectedImageNote | null => {
  const detail = document.querySelector<HTMLElement>('.lc-note-detail');
  const image = detail?.querySelector<HTMLImageElement>('.lc-source-preview img');
  if (!detail || !image?.src) return null;
  let filePath = '';
  try {
    filePath = new URL(image.src, window.location.href).searchParams.get('path') || '';
  } catch {
    return null;
  }
  if (!filePath) return null;
  const snapshot = readLearningDataCache();
  for (const day of Object.values(snapshot.days)) {
    const note = day.autoNotes.find((item) => item.filePath === filePath);
    if (note) return { noteUid: note.noteUid, title: note.title };
  }
  return null;
};

export function LearningRenameAction() {
  const [selected, setSelected] = useState<SelectedImageNote | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    if (typeof MutationObserver !== 'function') return undefined;
    let frame = 0;
    const refresh = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setSelected(findSelectedImageNote()));
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src'] });
    window.addEventListener('popstate', refresh);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener('popstate', refresh);
    };
  }, []);

  useEffect(() => {
    if (!feedback) return undefined;
    const timer = window.setTimeout(() => setFeedback(''), 2600);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  if (!selected) return null;

  const rename = async () => {
    if (renaming) return;
    try {
      setRenaming(true);
      setFeedback('');
      const snapshot = await renameLearningNoteWithAi(selected.noteUid);
      saveLearningDataCache(snapshot);
      setFeedback('已按最新图片和备注重新命名');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'AI 自动命名失败，请稍后重试。');
    } finally {
      setRenaming(false);
    }
  };

  return (
    <aside className="learning-ai-rename-action" aria-live="polite">
      {feedback && <span>{feedback}</span>}
      <button type="button" onClick={() => void rename()} disabled={renaming} title={`重新命名：${selected.title || '未命名笔记'}`}>
        {renaming ? <LoaderCircle size={16} /> : <Sparkles size={16} />}
        {renaming ? 'AI 命名中…' : '重新 AI 命名'}
      </button>
    </aside>
  );
}
