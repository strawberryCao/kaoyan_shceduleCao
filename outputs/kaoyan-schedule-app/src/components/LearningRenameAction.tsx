import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, LoaderCircle, RotateCcw, Sparkles } from 'lucide-react';
import { readLearningDataCache, saveLearningDataCache, type LearningAutoNote, type LearningDataSnapshot } from '../utils/learningData';
import {
  enqueueLearningNoteRename,
  getAiBackgroundJob,
  NOTE_SERVER_URL,
  type AiBackgroundJob,
} from '../utils/notes';
import '../learning-rename-action.css';

interface SelectedImageNote {
  noteUid: string;
  title: string;
  target: HTMLElement;
}

const isAiMultiQuestionNote = (note: LearningAutoNote): boolean => {
  const sourceType = (note as LearningAutoNote & { sourceType?: string }).sourceType;
  return sourceType === 'ai-multi-question'
    || /^multi_[A-Za-z0-9_-]+/i.test(note.noteUid)
    || note.tags.includes('AI多题拆分');
};

const findSelectedImageNote = (): SelectedImageNote | null => {
  const detail = document.querySelector<HTMLElement>('.lc-note-detail');
  const image = detail?.querySelector<HTMLImageElement>('.lc-source-preview img');
  const target = detail?.querySelector<HTMLElement>('.lc-source-row');
  if (!detail || !image?.src || !target) return null;
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
    if (note && isAiMultiQuestionNote(note)) {
      return { noteUid: note.noteUid, title: note.title, target };
    }
  }
  return null;
};

const refreshLearningData = async (): Promise<void> => {
  const response = await fetch(`${NOTE_SERVER_URL}/learning-data`, { cache: 'no-store' });
  const snapshot = await response.json().catch(() => null) as LearningDataSnapshot | null;
  if (response.ok && snapshot?.days) saveLearningDataCache(snapshot);
};

export function LearningRenameAction() {
  const [selected, setSelected] = useState<SelectedImageNote | null>(null);
  const [job, setJob] = useState<AiBackgroundJob | null>(null);
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    if (typeof MutationObserver !== 'function') return undefined;
    let frame = 0;
    const refresh = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const next = findSelectedImageNote();
        setSelected((current) => (
          current?.noteUid === next?.noteUid && current?.target === next?.target ? current : next
        ));
      });
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
    setJob(null);
    setFeedback('');
  }, [selected?.noteUid]);

  useEffect(() => {
    if (!job || !['queued', 'processing'].includes(job.status)) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const latest = await getAiBackgroundJob(job.id);
        if (cancelled) return;
        setJob(latest);
        if (latest.status === 'completed' || latest.status === 'skipped') {
          await refreshLearningData();
          setFeedback(latest.message || 'AI 命名完成');
        } else if (latest.status === 'failed') {
          setFeedback(latest.error || latest.message || 'AI 命名失败，可重试');
        }
      } catch (error) {
        if (!cancelled) setFeedback(error instanceof Error ? error.message : '后台状态读取失败');
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 2400);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status]);

  if (!selected) return null;

  const enqueue = async () => {
    if (job && ['queued', 'processing'].includes(job.status)) return;
    try {
      setFeedback('');
      const result = await enqueueLearningNoteRename(selected.noteUid);
      setJob(result.job);
      setFeedback('已加入后台命名，可直接离开本页');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'AI 自动命名任务创建失败。');
    }
  };

  const running = job && ['queued', 'processing'].includes(job.status);
  const completed = job && ['completed', 'skipped'].includes(job.status);
  const failed = job?.status === 'failed';

  return createPortal(
    <div className="learning-ai-rename-action" aria-live="polite">
      {feedback && <span>{feedback}</span>}
      <button
        type="button"
        onClick={() => void enqueue()}
        disabled={Boolean(running)}
        title={`根据当前备注重新命名：${selected.title || '未命名笔记'}`}
      >
        {running ? <LoaderCircle size={16} /> : completed ? <CheckCircle2 size={16} /> : failed ? <RotateCcw size={16} /> : <Sparkles size={16} />}
        {running ? '后台命名中' : failed ? '命名失败 · 重试' : completed ? '重新 AI 命名' : '根据备注重新 AI 命名'}
      </button>
    </div>,
    selected.target,
  );
}
