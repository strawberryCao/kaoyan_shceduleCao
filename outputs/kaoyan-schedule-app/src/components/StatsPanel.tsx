import { BarChart3, BookOpenCheck, CheckCircle2, Layers } from 'lucide-react';
import type { Stats } from '../types';

interface StatsPanelProps {
  stats: Stats;
}

export function StatsPanel({ stats }: StatsPanelProps) {
  return (
    <section className="stats-panel" aria-label="学习统计">
      <div className="stats-card primary-stat">
        <div className="stat-heading">
          <BarChart3 aria-hidden="true" size={20} />
          <span>总完成率</span>
        </div>
        <strong>{stats.completionRate}%</strong>
        <div className="progress-track" aria-label={`总完成率 ${stats.completionRate}%`}>
          <span className="progress-fill" style={{ width: `${stats.completionRate}%` }} />
        </div>
        <small>
          {stats.completedTasks}/{stats.totalTasks} 个学习块
        </small>
      </div>

      <div className="stats-card">
        <div className="stat-heading">
          <BookOpenCheck aria-hidden="true" size={20} />
          <span>高数完成</span>
        </div>
        <strong>{stats.mathCompletedDays}</strong>
        <small>天</small>
      </div>

      <div className="stats-card">
        <div className="stat-heading">
          <CheckCircle2 aria-hidden="true" size={20} />
          <span>A日完成</span>
        </div>
        <strong>{stats.aDayCompletedCount}</strong>
        <small>天</small>
      </div>

      <div className="stats-card">
        <div className="stat-heading">
          <Layers aria-hidden="true" size={20} />
          <span>B日完成</span>
        </div>
        <strong>{stats.bDayCompletedCount}</strong>
        <small>天</small>
      </div>
    </section>
  );
}
