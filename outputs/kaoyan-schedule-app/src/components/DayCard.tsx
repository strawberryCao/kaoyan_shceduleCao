import { CheckCircle2, Circle, Clock3, Dumbbell } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DayRecord, ScheduleDay } from '../types';
import { getDayProgress } from '../utils/schedule';

interface DayCardProps {
  day: ScheduleDay;
  record: DayRecord;
  isToday: boolean;
  onToggleTask: (date: string, taskId: string) => void;
}

const getMinutes = (value: string): number => {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
};

const isTaskHappeningNow = (time: string, now: Date): boolean => {
  const [start, end] = time.split('-');
  if (!start || !end) {
    return false;
  }
  const current = now.getHours() * 60 + now.getMinutes();
  return current >= getMinutes(start) && current < getMinutes(end);
};

export function DayCard({ day, record, isToday, onToggleTask }: DayCardProps) {
  const progress = getDayProgress(day, record);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className={isToday ? 'content-panel schedule-panel today-panel' : 'content-panel schedule-panel'}>
      <header className="schedule-hero">
        <div>
          <h1>{day.date}</h1>
          <span className="weekday-line">{day.weekday}{isToday ? ' · 今天' : ''}</span>
        </div>

        <div className="tag-row">
          <span className={day.type === 'A' ? 'tag type-a' : 'tag type-b'}>{day.type}日</span>
          {day.isBasketballDay && (
            <span className="tag basketball-tag">
              <Dumbbell aria-hidden="true" size={15} />
              打球日
            </span>
          )}
        </div>
      </header>

      <div className="day-progress-summary">
        <div className="day-progress-copy">
          <strong>{progress.completed}/{progress.total} 已完成</strong>
          <span>{progress.rate}%</span>
        </div>
        <div className="day-progress" aria-label={`${day.date} 完成率 ${progress.rate}%`}>
          <span className="day-progress-fill" style={{ width: `${progress.rate}%` }} />
        </div>
      </div>

      <div className="timeline" aria-label={`${day.date} 当日课表`}>
        {day.tasks.map((task) => {
          const completed = record.completedTaskIds.includes(task.id);
          const happeningNow = isToday && isTaskHappeningNow(task.time, now);
          const classes = [
            'timeline-item',
            task.trackable ? 'trackable' : 'fixed',
            completed ? 'completed' : '',
            happeningNow ? 'current-task' : '',
            task.category === 'evening' && day.isBasketballDay ? 'basketball-task' : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <label className={classes} key={task.id}>
              <span className="timeline-time">{task.time}</span>
              <span className="timeline-dot" aria-hidden="true">
                {completed ? <CheckCircle2 size={18} /> : task.trackable ? <Circle size={18} /> : <Clock3 size={18} />}
              </span>
              <span className="timeline-title">{task.title}</span>
              {happeningNow && <span className="current-task-label">进行中</span>}
              {task.trackable && (
                <input
                  aria-label={`${task.time} ${task.title}`}
                  checked={completed}
                  onChange={() => onToggleTask(day.date, task.id)}
                  type="checkbox"
                />
              )}
            </label>
          );
        })}
      </div>
    </section>
  );
}
