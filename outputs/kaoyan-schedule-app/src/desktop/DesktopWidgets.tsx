import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpenCheck, Check, ChevronLeft, ChevronRight, ExternalLink, Eye, EyeOff, ImagePlus, Pause, Pencil, Play, RotateCcw, Save, Sparkles, X } from 'lucide-react';
import { openNoteCaptureApp } from '../components/NoteDock';
import type { DayRecord, RecordsByDate, ScheduleDay, ScheduleTask } from '../types';
import {
  calculateStats,
  generateSchedule,
  getCurrentScheduleDay,
  getDayProgress,
  getDefaultRecord,
} from '../utils/schedule';
import { fileToDataUrl } from '../utils/notes';
import {
  clearPendingLearningRecord,
  getManualRecords,
  patchLearningCard,
  patchLearningDay,
  putLearningManualRecords,
  queuePendingLearningRecord,
  readLearningDataCache,
  readPendingLearningRecords,
  readPendingLearningReplacement,
  recordsMissingFromSnapshot,
  subscribeLearningDataCache,
  subscribeLearningDataFromServer,
  subscribeLearningDataPolling,
  type LearningDataSnapshot,
} from '../utils/learningData';
import {
  mergeScheduleRecords,
  readScheduleRecords,
  sameScheduleRecords,
  saveScheduleRecords,
  subscribeScheduleRecords,
} from '../utils/scheduleRecords';
import type { WidgetLayout } from './types';

const recordFor = (records: RecordsByDate, day: ScheduleDay): DayRecord => records[day.date] ?? getDefaultRecord();

const widgetStoreKey = (name: string) => `kaoyan-widget-${name}`;

const usePersistentText = (key: string, fallback: string) => {
  const [value, setValue] = useState(() => window.localStorage.getItem(key) ?? fallback);
  useEffect(() => {
    window.localStorage.setItem(key, value);
  }, [key, value]);
  return [value, setValue] as const;
};

const getFirstImageFile = (files: FileList | null): File | null => {
  if (!files) {
    return null;
  }
  return Array.from(files).find((file) => file.type.startsWith('image/')) ?? null;
};

const withPendingLearningRecords = (records: RecordsByDate): RecordsByDate => {
  const replacement = readPendingLearningReplacement();
  return mergeScheduleRecords(replacement ?? records, readPendingLearningRecords());
};

const useLearningSnapshot = () => {
  const [snapshot, setSnapshot] = useState<LearningDataSnapshot>(() => readLearningDataCache());
  useEffect(() => {
    const unsubscribe = subscribeLearningDataCache(setSnapshot);
    const unsubscribeServer = subscribeLearningDataFromServer();
    const unsubscribePolling = subscribeLearningDataPolling();
    return () => {
      unsubscribe();
      unsubscribeServer();
      unsubscribePolling();
    };
  }, []);
  return [snapshot, setSnapshot] as const;
};

function ScheduleWidget() {
  const days = useMemo(() => generateSchedule(), []);
  const todayDay = useMemo(() => getCurrentScheduleDay(days), [days]);
  const [clock, setClock] = useState(() => new Date());
  const [records, setRecords] = useState<RecordsByDate>(() => withPendingLearningRecords(mergeScheduleRecords(
    getManualRecords(readLearningDataCache()),
    readScheduleRecords(days),
  )));
  const recordsRef = useRef(records);
  const [learningData, setLearningData] = useLearningSnapshot();
  const migrationInFlightRef = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => subscribeScheduleRecords(days, (nextLocalRecords) => {
    const nextRecords = withPendingLearningRecords(nextLocalRecords);
    recordsRef.current = nextRecords;
    setRecords(nextRecords);
  }), [days]);

  useEffect(() => {
    const serviceRecords = getManualRecords(learningData);
    if (Object.keys(serviceRecords).length === 0) {
      return;
    }
    const localFallback = recordsMissingFromSnapshot(readScheduleRecords(days), learningData);
    const nextRecords = withPendingLearningRecords(mergeScheduleRecords(
      serviceRecords,
      localFallback,
    ));
    recordsRef.current = nextRecords;
    setRecords(nextRecords);
    if (!sameScheduleRecords(readScheduleRecords(days), nextRecords)) {
      saveScheduleRecords(nextRecords);
    }
  }, [days, learningData]);

  useEffect(() => {
    const missing = recordsMissingFromSnapshot(records, learningData);
    if (migrationInFlightRef.current || Object.keys(missing).length === 0) {
      return;
    }
    migrationInFlightRef.current = true;
    void putLearningManualRecords(missing, 'merge')
      .then(setLearningData)
      .catch(() => undefined)
      .finally(() => {
        migrationInFlightRef.current = false;
      });
  }, [learningData, records, setLearningData]);

  const todayRecord = recordFor(records, todayDay);
  const progress = getDayProgress(todayDay, todayRecord);
  const stats = useMemo(() => calculateStats(days, records), [days, records]);
  const visibleTasks = todayDay.tasks.filter((task) => ['math', 'linearProbability', 'professional', 'memory', 'evening', 'networkOs'].includes(task.category));
  const timeText = clock.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const toggleTask = (task: ScheduleTask) => {
    if (!task.trackable) {
      return;
    }
    const currentRecords = recordsRef.current;
    const previous = recordFor(currentRecords, todayDay);
    const completed = previous.completedTaskIds.includes(task.id);
    const nextRecord = {
      ...previous,
      completedTaskIds: completed
        ? previous.completedTaskIds.filter((taskId) => taskId !== task.id)
        : [...previous.completedTaskIds, task.id],
    };
    const nextRecords = { ...currentRecords, [todayDay.date]: nextRecord };
    recordsRef.current = nextRecords;
    setRecords(nextRecords);
    saveScheduleRecords(nextRecords);
    queuePendingLearningRecord(todayDay.date, nextRecord);
    void patchLearningDay(todayDay.date, nextRecord)
      .then((snapshot) => {
        clearPendingLearningRecord(todayDay.date, nextRecord);
        setLearningData(snapshot);
      })
      .catch(() => {
        // The local record remains usable and will be retried by the full schedule.
      });
  };

  return (
    <div className="study-widget-content schedule-widget-content">
      <div className="schedule-topline">
        <div>
          <span>今日课表</span>
          <strong>{todayDay.date}<em>{timeText}</em></strong>
          <small>{todayDay.weekday} · {todayDay.type}日</small>
        </div>
        <div className="desktop-progress-ring">
          <b>{progress.rate}%</b>
          <small>{progress.completed}/{progress.total}</small>
        </div>
      </div>

      <div className="desktop-metrics">
        <div><span>总进度</span><b>{stats.completionRate}%</b></div>
        <div><span>高数</span><b>{stats.mathCompletedDays}/30</b></div>
        <div><span>今日块</span><b>{progress.completed}/{progress.total}</b></div>
      </div>

      <div className="desktop-task-list">
        {visibleTasks.map((task) => {
          const completed = todayRecord.completedTaskIds.includes(task.id);
          return (
            <button className={completed ? 'done' : ''} key={task.id} type="button" onClick={() => toggleTask(task)}>
              <span>{task.time}</span>
              <strong>{task.title}</strong>
              <i>{completed ? '✓' : ''}</i>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PomodoroWidget() {
  const [workMinutes, setWorkMinutes] = useState(() => Number(window.localStorage.getItem(widgetStoreKey('pomodoro-work')) ?? '25'));
  const [breakMinutes, setBreakMinutes] = useState(() => Number(window.localStorage.getItem(widgetStoreKey('pomodoro-break')) ?? '5'));
  const [mode, setMode] = useState<'work' | 'break'>('work');
  const [seconds, setSeconds] = useState(() => Math.max(1, workMinutes) * 60);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(() => Number(window.localStorage.getItem(widgetStoreKey('pomodoro-count')) ?? '0'));

  useEffect(() => {
    window.localStorage.setItem(widgetStoreKey('pomodoro-work'), String(workMinutes));
    window.localStorage.setItem(widgetStoreKey('pomodoro-break'), String(breakMinutes));
  }, [workMinutes, breakMinutes]);

  useEffect(() => {
    if (!running) {
      setSeconds((mode === 'work' ? Math.max(1, workMinutes) : Math.max(1, breakMinutes)) * 60);
    }
  }, [workMinutes, breakMinutes, mode, running]);

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = window.setInterval(() => {
      setSeconds((current) => {
        if (current <= 1) {
          if (mode === 'work') {
            setDone((value) => {
              const next = value + 1;
              window.localStorage.setItem(widgetStoreKey('pomodoro-count'), String(next));
              return next;
            });
            setMode('break');
            return Math.max(1, breakMinutes) * 60;
          }
          setMode('work');
          return Math.max(1, workMinutes) * 60;
        }
        return current - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running, mode, workMinutes, breakMinutes]);

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  const resetTimer = () => {
    setRunning(false);
    setSeconds((mode === 'work' ? Math.max(1, workMinutes) : Math.max(1, breakMinutes)) * 60);
  };

  return (
    <div className="study-widget-content pomodoro-widget">
      <span>{mode === 'work' ? '专注周期' : '休息周期'}</span>
      <strong>{mm}:{ss}</strong>
      <small>今日完成 {done} 个番茄</small>
      <div className="pomodoro-settings">
        <label>专注<input type="number" min="1" max="180" value={workMinutes} onChange={(event) => setWorkMinutes(Math.max(1, Number(event.target.value) || 1))} />分</label>
        <label>休息<input type="number" min="1" max="60" value={breakMinutes} onChange={(event) => setBreakMinutes(Math.max(1, Number(event.target.value) || 1))} />分</label>
      </div>
      <div className="widget-button-row">
        <button type="button" onClick={() => setRunning((value) => !value)}>{running ? <Pause size={14} /> : <Play size={14} />} {running ? '暂停' : '开始'}</button>
        <button type="button" onClick={resetTimer}><RotateCcw size={14} /> 重置</button>
      </div>
    </div>
  );
}

function CountdownWidget() {
  const target = new Date('2026-12-20T00:00:00');
  const daysLeft = Math.max(0, Math.ceil((target.getTime() - Date.now()) / 86400000));
  return (
    <div className="study-widget-content countdown-widget">
      <span>考研倒计时</span>
      <strong>{daysLeft}</strong>
      <small>天后进入目标考场</small>
      <p>不需要每天很完美，只需要今天不掉线。</p>
    </div>
  );
}

function TopThreeWidget() {
  const [text, setText] = usePersistentText(widgetStoreKey('top-three'), '1. 高数推进一节\n2. 数据结构刷题\n3. 晚上复盘错题');
  return (
    <div className="study-widget-content text-widget">
      <textarea value={text} onChange={(event) => setText(event.target.value)} />
    </div>
  );
}

function DebtBoardWidget() {
  const [text, setText] = usePersistentText(widgetStoreKey('debt-board'), '欠账：\n- \n\n错题来源：\n- ');
  return (
    <div className="study-widget-content text-widget">
      <textarea value={text} onChange={(event) => setText(event.target.value)} />
    </div>
  );
}

function MemoryCardWidget() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = usePersistentText(widgetStoreKey('memory-card'), '今日背诵：\n- 极限定义的量词顺序\n- 数据结构时间复杂度\n- 计网协议端口');
  const [learningData, setLearningData] = useLearningSnapshot();
  const [manualMode, setManualMode] = useState(false);
  const [cardIndex, setCardIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editFront, setEditFront] = useState('');
  const [editBack, setEditBack] = useState('');
  const [images, setImages] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(widgetStoreKey('memory-images')) ?? '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    window.localStorage.setItem(widgetStoreKey('memory-images'), JSON.stringify(images));
  }, [images]);

  const cards = useMemo(() => learningData.cards
    .filter((card) => card.status !== 'archived')
    .sort((left, right) => {
      const statusOrder = (status: string) => status === 'draft' ? 0 : 1;
      return statusOrder(left.status) - statusOrder(right.status)
        || right.createdAt.localeCompare(left.createdAt);
    }), [learningData.cards]);
  const cardCounts = useMemo(() => ({
    draft: learningData.cards.filter((card) => card.status === 'draft').length,
    active: learningData.cards.filter((card) => card.status === 'active').length,
    archived: learningData.cards.filter((card) => card.status === 'archived').length,
  }), [learningData.cards]);
  const currentCard = cards[cardIndex] ?? null;

  useEffect(() => {
    setCardIndex((current) => Math.max(0, Math.min(current, Math.max(0, cards.length - 1))));
  }, [cards.length]);

  useEffect(() => {
    setRevealed(false);
    setEditing(false);
    setEditFront(currentCard?.front ?? '');
    setEditBack(currentCard?.back ?? '');
  }, [currentCard?.id]);

  const addImage = async (file: File | null) => {
    if (!file || !file.type.startsWith('image/')) {
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    setImages((current) => [...current, dataUrl]);
    setManualMode(true);
  };

  const updateCurrentCard = async (patch: Parameters<typeof patchLearningCard>[1]) => {
    if (!currentCard) {
      return false;
    }
    try {
      const snapshot = await patchLearningCard(currentCard.id, patch);
      setLearningData(snapshot);
      return true;
    } catch {
      // Keep the draft visible so the user can retry when the local service returns.
      return false;
    }
  };

  const saveCardEdits = async () => {
    const saved = await updateCurrentCard({
      front: editFront.trim(),
      back: editBack.trim(),
      userEdited: true,
    });
    if (saved) {
      setEditing(false);
    }
  };

  const stepCard = (direction: -1 | 1) => {
    if (cards.length === 0) {
      return;
    }
    setCardIndex((current) => (current + direction + cards.length) % cards.length);
  };

  const pageText = currentCard?.pageRefs
    .map((item) => item.raw || [item.page ? `p${item.page}` : '', item.question ?? ''].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('、') ?? '';

  return (
    <div
      className="study-widget-content memory-widget memory-card-rich"
      onDragOver={(event) => event.preventDefault()}
      onDrop={async (event) => {
        event.preventDefault();
        await addImage(getFirstImageFile(event.dataTransfer.files));
      }}
    >
      <div className="memory-modebar">
        <span title={`草稿 ${cardCounts.draft} / 启用 ${cardCounts.active} / 忽略 ${cardCounts.archived}`}>
          <Sparkles size={13} /> 草稿 {cardCounts.draft} · 启用 {cardCounts.active} · 忽略 {cardCounts.archived}
        </span>
        <button type="button" disabled={cards.length === 0} onClick={() => setManualMode((value) => !value)}>
          {manualMode || cards.length === 0 ? <BookOpenCheck size={13} /> : <ImagePlus size={13} />}
          {cards.length === 0 ? '暂无 AI 卡' : manualMode ? '查看 AI 卡' : '手写区'}
        </button>
      </div>

      {!manualMode && currentCard ? (
        <section className="structured-memory-card" aria-label={`AI 背诵卡 ${cardIndex + 1}`}>
          <header>
            <span className={currentCard.status === 'draft' ? 'is-draft' : 'is-active'}>
              {currentCard.status === 'draft' ? '草稿' : '已启用'}
            </span>
            <strong>{currentCard.subject || currentCard.sourceTitle || '背诵卡片'}</strong>
            <small>{cardIndex + 1}/{cards.length}</small>
          </header>
          {editing ? (
            <div className="structured-memory-editor">
              <label>正面<textarea value={editFront} onChange={(event) => setEditFront(event.target.value)} /></label>
              <label>背面<textarea value={editBack} onChange={(event) => setEditBack(event.target.value)} /></label>
            </div>
          ) : (
            <div className="structured-memory-body">
              <p>{currentCard.front || currentCard.sourceTitle || '请回忆这条笔记的核心内容。'}</p>
              {revealed ? (
                <div className="structured-memory-answer">{currentCard.back || '该卡片暂无答案。'}</div>
              ) : (
                <button type="button" className="structured-memory-reveal" onClick={() => setRevealed(true)}>
                  <Eye size={13} /> 显示答案
                </button>
              )}
              {(pageText || currentCard.knowledgePath.length > 0 || currentCard.tags.length > 0 || currentCard.dueDate) && (
                <small>
                  {[pageText, currentCard.knowledgePath.join(' / '), currentCard.tags.map((tag) => `#${tag}`).join(' '), currentCard.dueDate ? `复习 ${currentCard.dueDate}` : '']
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              )}
              <div className="structured-memory-actions">
                {currentCard.status === 'draft' ? (
                  <>
                    <button type="button" onClick={() => void updateCurrentCard({ status: 'active' })}><Check size={12} /> 启用</button>
                    <button type="button" onClick={() => void updateCurrentCard({ status: 'archived' })}><X size={12} /> 忽略</button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => void updateCurrentCard({ reviewResult: 'forgotten' })}><RotateCcw size={12} /> 忘记</button>
                    <button type="button" onClick={() => void updateCurrentCard({ reviewResult: 'remembered' })}><Check size={12} /> 记住</button>
                    <button type="button" onClick={() => void updateCurrentCard({ status: 'archived' })}><X size={12} /> 忽略</button>
                  </>
                )}
              </div>
            </div>
          )}
          <footer>
            {editing ? (
              <>
                <button type="button" onClick={() => setEditing(false)}><X size={13} /> 取消</button>
                <button type="button" onClick={() => void saveCardEdits()}><Save size={13} /> 保存</button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => stepCard(-1)} aria-label="上一张"><ChevronLeft size={14} /></button>
                <button type="button" onClick={() => setRevealed((value) => !value)}>
                  {revealed ? <EyeOff size={13} /> : <Eye size={13} />} {revealed ? '隐藏' : '翻卡'}
                </button>
                <button type="button" onClick={() => setEditing(true)}><Pencil size={12} /> 编辑</button>
                <button type="button" onClick={() => stepCard(1)} aria-label="下一张"><ChevronRight size={14} /></button>
              </>
            )}
          </footer>
        </section>
      ) : (
        <>
          <textarea value={text} onChange={(event) => setText(event.target.value)} />
          <div className="memory-image-strip">
            {images.map((src, index) => (
              <figure key={`${src.slice(0, 32)}-${index}`}>
                <img src={src} alt={`背诵图片 ${index + 1}`} />
                <button type="button" onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label="删除图片"><X size={12} /></button>
              </figure>
            ))}
            <button type="button" className="memory-add-image" onClick={() => fileInputRef.current?.click()}><ImagePlus size={15} /> 添加图片</button>
          </div>
        </>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={async (event) => {
          await addImage(getFirstImageFile(event.currentTarget.files));
          event.currentTarget.value = '';
        }}
      />
    </div>
  );
}

function ReviewLogWidget() {
  const [text, setText] = usePersistentText(widgetStoreKey('review-log'), '今日复盘：\n推进：\n卡点：\n明天第一件事：');
  return (
    <div className="study-widget-content text-widget">
      <textarea value={text} onChange={(event) => setText(event.target.value)} />
    </div>
  );
}

function CustomTextWidget({ widget }: { widget: WidgetLayout }) {
  const [text, setText] = usePersistentText(widgetStoreKey(`custom-${widget.id}`), widget.content ?? '');
  return (
    <div className="study-widget-content text-widget custom-text-widget">
      <textarea
        aria-label={`${widget.title}内容`}
        placeholder="在这里写内容……"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    </div>
  );
}

function QuickLinksWidget() {
  const openManagement = () => window.open(`${window.location.origin}/`, '_blank', 'noopener,noreferrer');
  const openConsole = () => window.open(`${window.location.origin}/?console=1`, '_blank', 'noopener,noreferrer');
  return (
    <div className="study-widget-content quick-links-widget">
      <button type="button" onClick={openManagement}><ExternalLink size={14} /> 完整课表</button>
      <button type="button" onClick={openConsole}><ExternalLink size={14} /> 桌面控制台</button>
      <button type="button" onClick={() => void openNoteCaptureApp()}><ExternalLink size={14} /> 笔记台小 App</button>
      <button type="button" onClick={() => window.open('http://127.0.0.1:5174/health', '_blank', 'noopener,noreferrer')}><ExternalLink size={14} /> 笔记服务</button>
    </div>
  );
}

export function renderDesktopWidget(widget: WidgetLayout) {
  switch (widget.type) {
    case 'schedule':
      return <ScheduleWidget />;
    case 'noteDock':
      return null;
    case 'pomodoro':
      return <PomodoroWidget />;
    case 'countdown':
      return <CountdownWidget />;
    case 'topThree':
      return <TopThreeWidget />;
    case 'debtBoard':
      return <DebtBoardWidget />;
    case 'memoryCard':
      return <MemoryCardWidget />;
    case 'reviewLog':
      return <ReviewLogWidget />;
    case 'quickLinks':
      return <QuickLinksWidget />;
    case 'customText':
      return <CustomTextWidget widget={widget} />;
    default:
      return null;
  }
}
