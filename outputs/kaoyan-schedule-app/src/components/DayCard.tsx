import { CheckCircle2, Circle, Clock3, Dumbbell } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { DayRecord, ScheduleDay } from '../types';
import { getDateDistanceFromStart, getDayProgress } from '../utils/schedule';

interface DayCardProps {
  day: ScheduleDay;
  record: DayRecord;
  isToday: boolean;
  onToggleTask: (date: string, taskId: string) => void;
}

export function DayCard({ day, record, isToday, onToggleTask }: DayCardProps) {
  const progress = getDayProgress(day, record);
  const dayNumber = getDateDistanceFromStart(day.date) + 1;
  const progressStyle = {
    '--progress': `${progress.rate * 3.6}deg`,
  } as CSSProperties;

  return (
    <section className={isToday ? 'content-panel schedule-panel today-panel' : 'content-panel schedule-panel'}>
      <header className="schedule-hero">
        <div>
          <p className="panel-eyebrow">Day {dayNumber}</p>
          <h1>{day.date}</h1>
          <span className="weekday-line">
            {day.weekday} · {day.type}日
          </span>
        </div>

        <div className="tag-row">
          {isToday && <span className="tag today-tag">今日</span>}
          <span className={day.type === 'A' ? 'tag type-a' : 'tag type-b'}>{day.type}日</span>
          {day.isBasketballDay && (
            <span className="tag basketball-tag">
              <Dumbbell aria-hidden="true" size={15} />
              打球日
            </span>
          )}
        </div>
      </header>

      <div className="progress-summary">
        <div className="progress-ring" style={progressStyle} aria-label={`${day.date} 完成率 ${progress.rate}%`}>
          <span>{progress.rate}%</span>
        </div>
        <div className="progress-copy">
          <p>今日执行进度</p>
          <strong>
            {progress.completed}/{progress.total} 个学习块完成
          </strong>
          <div className="day-progress" aria-hidden="true">
            <span className="day-progress-fill" style={{ width: `${progress.rate}%` }} />
          </div>
        </div>
      </div>

      <div className="timeline" aria-label={`${day.date} 当日课表`}>
        {day.tasks.map((task) => {
          const completed = record.completedTaskIds.includes(task.id);
          const classes = [
            'timeline-item',
            task.trackable ? 'trackable' : 'fixed',
            completed ? 'completed' : '',
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
