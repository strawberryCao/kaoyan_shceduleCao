import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  BookOpenCheck,
  CheckCircle2,
  Clipboard,
  Circle,
  Library,
  Server,
  Sparkles,
} from 'lucide-react';
import { openNoteCaptureApp } from './NoteDock';
import type { RecordsByDate } from '../types';
import {
  fetchLearningData,
  getManualRecords,
  readLearningDataCache,
  readPendingLearningRecords,
  readPendingLearningReplacement,
  recordsMissingFromSnapshot,
  subscribeLearningDataCache,
  subscribeLearningDataFromServer,
  type LearningDataSnapshot,
} from '../utils/learningData';
import { fetchWithTimeout } from '../utils/localService';
import { NOTE_SERVER_URL } from '../utils/notes';
import {
  generateSchedule,
  getCurrentScheduleDay,
  getDayProgress,
  getDefaultRecord,
} from '../utils/schedule';
import {
  mergeScheduleRecords,
  readScheduleRecords,
  sameScheduleRecords,
  saveScheduleRecords,
  subscribeScheduleRecords,
} from '../utils/scheduleRecords';

type ServiceState = 'checking' | 'online' | 'offline';

const go = (path: string) => {
  window.location.assign(`${window.location.origin}/${path}`);
};

const localDate = () => {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
};

const formatToday = (value: Date) => new Intl.DateTimeFormat('zh-CN', {
  month: 'long',
  day: 'numeric',
  weekday: 'long',
}).format(value);

const toMinutes = (value: string) => {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
};

const getCurrentTaskId = (tasks: Array<{ id: string; time: string }>, value: Date) => {
  const currentMinutes = value.getHours() * 60 + value.getMinutes();
  return tasks.find((task) => {
    const [startText, endText] = task.time.split('-');
    if (!startText || !endText) return false;
    return currentMinutes >= toMinutes(startText) && currentMinutes < toMinutes(endText);
  })?.id;
};

const withPendingLearningRecords = (records: RecordsByDate): RecordsByDate => {
  const replacement = readPendingLearningReplacement();
  return mergeScheduleRecords(replacement ?? records, readPendingLearningRecords());
};

export function AppHub() {
  const days = useMemo(() => generateSchedule(), []);
  const todayDay = useMemo(() => getCurrentScheduleDay(days), [days]);
  const [learningData, setLearningData] = useState<LearningDataSnapshot>(() => readLearningDataCache());
  const [records, setRecords] = useState(() => {
    const cached = readLearningDataCache();
    return withPendingLearningRecords(mergeScheduleRecords(
      getManualRecords(cached),
      readScheduleRecords(days),
    ));
  });
  const [serviceState, setServiceState] = useState<ServiceState>('checking');
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const controller = new AbortController();
    const applyServiceSnapshot = (snapshot: LearningDataSnapshot) => {
      setLearningData(snapshot);
      const localFallback = recordsMissingFromSnapshot(readScheduleRecords(days), snapshot);
      const nextRecords = withPendingLearningRecords(mergeScheduleRecords(
        getManualRecords(snapshot),
        localFallback,
      ));
      setRecords(nextRecords);
      if (!sameScheduleRecords(readScheduleRecords(days), nextRecords)) {
        saveScheduleRecords(nextRecords);
      }
    };
    const unsubscribeSchedule = subscribeScheduleRecords(days, (nextLocalRecords) => {
      setRecords(withPendingLearningRecords(nextLocalRecords));
    });
    const unsubscribeLearning = subscribeLearningDataCache(applyServiceSnapshot);
    const unsubscribeServer = subscribeLearningDataFromServer();
    void fetchLearningData(controller.signal).then(applyServiceSnapshot).catch(() => undefined);
    void fetchWithTimeout(`${NOTE_SERVER_URL}/health`, {
      cache: 'no-store',
      signal: controller.signal,
    }, 1800)
      .then((response) => setServiceState(response.ok ? 'online' : 'offline'))
      .catch(() => setServiceState('offline'));
    const timer = window.setInterval(() => setNow(new Date()), 60000);
    return () => {
      controller.abort();
      unsubscribeSchedule();
      unsubscribeLearning();
      unsubscribeServer();
      window.clearInterval(timer);
    };
  }, [days]);

  const todayRecord = records[todayDay.date] ?? getDefaultRecord();
  const progress = getDayProgress(todayDay, todayRecord);
  const todayNotes = learningData.days[todayDay.date]?.autoNotes.length ?? 0;
  const today = localDate();
  const dueCards = learningData.cards.filter((card) => card.status === 'active' && (!card.dueDate || card.dueDate <= today)).length;
  const draftCards = learningData.cards.filter((card) => card.status === 'draft').length;
  const completedTaskIds = new Set(todayRecord.completedTaskIds);
  const currentTaskId = getCurrentTaskId(todayDay.tasks, now);

  return (
    <main className="app-hub-page">
      <section className="app-hub-shell">
        <header className="hub-topbar">
          <h1>首页</h1>
          <div className="hub-date">
            <strong>{formatToday(now)}</strong>
            <time>{now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
          </div>
        </header>

        <section className="hub-workbench">
          <section className="hub-today-pane">
            <header className="hub-today-heading">
              <div>
                <span>今天</span>
                <h1>{todayDay.weekday} · {todayDay.type} 日</h1>
              </div>
              <div className="hub-progress-number">
                <strong>{progress.rate}%</strong>
                <span>{progress.completed}/{progress.total} 完成</span>
              </div>
            </header>

            <div className="hub-progress-track" aria-label={`今日完成率 ${progress.rate}%`}>
              <span style={{ width: `${progress.rate}%` }} />
            </div>

            <div className="hub-task-list" aria-label="今日任务">
              {todayDay.tasks.map((task) => {
                const completed = completedTaskIds.has(task.id);
                const current = !completed && task.id === currentTaskId;
                return (
                  <div className={[completed ? 'is-complete' : '', current ? 'is-current' : ''].filter(Boolean).join(' ')} key={task.id}>
                    {completed ? <CheckCircle2 size={18} /> : <Circle size={18} />}
                    <time>{task.time}</time>
                    <strong>{task.title}</strong>
                    {current && <span className="hub-task-state">进行中</span>}
                  </div>
                );
              })}
            </div>

            <button className="hub-primary-action" type="button" onClick={() => go('')}>
              打开今日课表 <ArrowRight size={17} />
            </button>
          </section>

          <aside className="hub-flow-pane">
            <h2>接下来</h2>
            <div className="hub-flow-list">
              <button type="button" onClick={() => void openNoteCaptureApp()}>
                <span><Clipboard size={20} /></span>
                <strong>快速记图</strong>
                <ArrowRight size={17} />
              </button>
              <button type="button" onClick={() => go('?panel=learning')}>
                <span><BookOpenCheck size={20} /></span>
                <strong>到期复习</strong>
                <b>{dueCards} 张</b>
                <ArrowRight size={17} />
              </button>
              <button type="button" onClick={() => go('?panel=learning&filter=draft')}>
                <span><Sparkles size={20} /></span>
                <strong>确认 AI 草稿</strong>
                <b>{draftCards} 张</b>
                <ArrowRight size={17} />
              </button>
              <button type="button" onClick={() => go('?panel=learning&view=knowledge')}>
                <span><Library size={20} /></span>
                <strong>查看今日笔记</strong>
                <b>{todayNotes} 条</b>
                <ArrowRight size={17} />
              </button>
            </div>
            <button className="hub-service" type="button" onClick={() => window.open('http://127.0.0.1:5174/health', '_blank', 'noopener,noreferrer')}>
              <Server size={17} />
              本地服务
              <strong className={serviceState}>{serviceState === 'checking' ? '检查中' : serviceState === 'online' ? '正常' : '离线'}</strong>
            </button>
          </aside>
        </section>

      </section>
    </main>
  );
}
