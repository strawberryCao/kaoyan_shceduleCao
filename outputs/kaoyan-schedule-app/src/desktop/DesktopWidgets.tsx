import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, ImagePlus, Pause, Play, RotateCcw, X } from 'lucide-react';
import { NoteDock } from '../components/NoteDock';
import type { DayRecord, RecordsByDate, ScheduleDay, ScheduleTask } from '../types';
import {
  calculateStats,
  generateSchedule,
  getCurrentScheduleDay,
  getDayProgress,
  getDefaultRecord,
  makeStoragePayload,
  normalizeRecords,
  STORAGE_KEY,
} from '../utils/schedule';
import { fileToDataUrl } from '../utils/notes';
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

const openNoteCaptureWindow = () => {
  const opened = window.open(
    `${window.location.origin}/?notes=1`,
    'kaoyan_note_capture',
    'width=1280,height=860,left=80,top=60',
  );
  opened?.focus();
};

function ScheduleWidget() {
  const days = useMemo(() => generateSchedule(), []);
  const todayDay = useMemo(() => getCurrentScheduleDay(days), [days]);
  const [clock, setClock] = useState(() => new Date());
  const [records, setRecords] = useState<RecordsByDate>(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      return {};
    }
    try {
      return normalizeRecords(JSON.parse(saved), days);
    } catch {
      return {};
    }
  });

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(makeStoragePayload(records)));
  }, [records]);

  const todayRecord = recordFor(records, todayDay);
  const progress = getDayProgress(todayDay, todayRecord);
  const stats = useMemo(() => calculateStats(days, records), [days, records]);
  const visibleTasks = todayDay.tasks.filter((task) => ['math', 'linearProbability', 'professional', 'memory', 'evening', 'networkOs'].includes(task.category));
  const timeText = clock.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const toggleTask = (task: ScheduleTask) => {
    if (!task.trackable) {
      return;
    }
    setRecords((current) => {
      const previous = recordFor(current, todayDay);
      const completed = previous.completedTaskIds.includes(task.id);
      return {
        ...current,
        [todayDay.date]: {
          ...previous,
          completedTaskIds: completed
            ? previous.completedTaskIds.filter((taskId) => taskId !== task.id)
            : [...previous.completedTaskIds, task.id],
        },
      };
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

  const addImage = async (file: File | null) => {
    if (!file || !file.type.startsWith('image/')) {
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    setImages((current) => [...current, dataUrl]);
  };

  return (
    <div
      className="study-widget-content memory-widget memory-card-rich"
      onDragOver={(event) => event.preventDefault()}
      onDrop={async (event) => {
        event.preventDefault();
        await addImage(getFirstImageFile(event.dataTransfer.files));
      }}
    >
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
      <button type="button" onClick={openNoteCaptureWindow}><ExternalLink size={14} /> 笔记台</button>
      <button type="button" onClick={() => window.open('http://127.0.0.1:5174/health', '_blank', 'noopener,noreferrer')}><ExternalLink size={14} /> 笔记服务</button>
    </div>
  );
}

export function renderDesktopWidget(widget: WidgetLayout) {
  switch (widget.type) {
    case 'schedule':
      return <ScheduleWidget />;
    case 'noteDock':
      return <NoteDock />;
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
