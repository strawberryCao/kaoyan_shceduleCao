import { useEffect, useMemo, useState } from 'react';
import { BookOpen, CalendarDays, Dumbbell, Moon, Target, TimerReset } from 'lucide-react';
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

const recordFor = (records: RecordsByDate, day: ScheduleDay): DayRecord => records[day.date] ?? getDefaultRecord();

const describeDayType = (day: ScheduleDay): string => {
  return day.type === 'A' ? 'A日：数据结构 + 计网' : 'B日：组成原理 + 操作系统';
};

const getTaskHint = (task: ScheduleTask): string => {
  switch (task.category) {
    case 'math':
      return '主线推进，至少产出错题记录';
    case 'linearProbability':
      return '概念 + 题型，不贪多';
    case 'professional':
      return '下午主攻专业课';
    case 'memory':
      return '公式、易错点、定义';
    case 'evening':
      return task.title === '打球' ? '打完回来别硬啃难题' : '补欠账、整理错题';
    case 'networkOs':
      return '夜场适合回忆和选择题';
    case 'sleep':
      return '到点收工';
    default:
      return '保持节奏';
  }
};

export function WallpaperView() {
  const days = useMemo(() => generateSchedule(), []);
  const todayDay = useMemo(() => getCurrentScheduleDay(days), [days]);
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
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(makeStoragePayload(records)));
  }, [records]);

  const todayRecord = recordFor(records, todayDay);
  const progress = getDayProgress(todayDay, todayRecord);
  const stats = useMemo(() => calculateStats(days, records), [days, records]);

  const toggleTask = (task: ScheduleTask) => {
    if (!task.trackable) {
      return;
    }

    setRecords((current) => {
      const previous = recordFor(current, todayDay);
      const completed = previous.completedTaskIds.includes(task.id);
      const nextRecord: DayRecord = {
        ...previous,
        completedTaskIds: completed
          ? previous.completedTaskIds.filter((taskId) => taskId !== task.id)
          : [...previous.completedTaskIds, task.id],
      };

      return {
        ...current,
        [todayDay.date]: nextRecord,
      };
    });
  };

  return (
    <main className="lively-wallpaper-page" aria-label="考研课表壁纸模式">
      <section className="lively-wallpaper-card">
        <header className="lively-header">
          <div>
            <p>今日课表</p>
            <h1>{todayDay.date}</h1>
            <span>{todayDay.weekday}</span>
          </div>
          <div className="lively-progress-ring" aria-label={`今日完成 ${progress.rate}%`}>
            <strong>{progress.rate}%</strong>
            <small>{progress.completed}/{progress.total}</small>
          </div>
        </header>

        <section className="lively-tags" aria-label="今日标签">
          <span className={`lively-tag ${todayDay.type === 'A' ? 'type-a' : 'type-b'}`}>
            <Target size={14} aria-hidden="true" />
            {describeDayType(todayDay)}
          </span>
          {todayDay.isBasketballDay && (
            <span className="lively-tag basketball">
              <Dumbbell size={14} aria-hidden="true" />
              20:00-22:00 打球
            </span>
          )}
        </section>

        <section className="lively-overview" aria-label="整体进度">
          <div>
            <CalendarDays size={16} aria-hidden="true" />
            <span>总进度</span>
            <strong>{stats.completionRate}%</strong>
          </div>
          <div>
            <BookOpen size={16} aria-hidden="true" />
            <span>高数</span>
            <strong>{stats.mathCompletedDays}/30</strong>
          </div>
          <div>
            <TimerReset size={16} aria-hidden="true" />
            <span>今日块</span>
            <strong>{progress.completed}/{progress.total}</strong>
          </div>
        </section>

        <section className="lively-timeline" aria-label="今日时间线">
          {todayDay.tasks.map((task) => {
            const completed = todayRecord.completedTaskIds.includes(task.id);
            const isBasketball = task.title === '打球';

            return (
              <button
                className={`lively-task ${completed ? 'completed' : ''} ${isBasketball ? 'basketball-task' : ''}`}
                disabled={!task.trackable}
                key={task.id}
                onClick={() => toggleTask(task)}
                type="button"
              >
                <span className="lively-task-time">{task.time}</span>
                <span className="lively-task-dot" aria-hidden="true" />
                <span className="lively-task-main">
                  <strong>{task.title}</strong>
                  <small>{getTaskHint(task)}</small>
                </span>
                {task.trackable ? (
                  <span className="lively-check" aria-label={completed ? '已完成' : '未完成'}>
                    {completed ? '✓' : ''}
                  </span>
                ) : (
                  <span className="lively-static" aria-hidden="true">
                    {task.category === 'sleep' ? <Moon size={15} /> : ''}
                  </span>
                )}
              </button>
            );
          })}
        </section>

        <footer className="lively-footer">
          <span>壁纸模式由 Lively Wallpaper 加载</span>
          <strong>24:00 睡觉，别拖</strong>
        </footer>
      </section>
    </main>
  );
}
