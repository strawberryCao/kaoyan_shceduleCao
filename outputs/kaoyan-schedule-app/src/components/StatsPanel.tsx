import { BarChart3, BookOpenCheck, CheckCircle2, Layers } from 'lucide-react';
import type { Stats } from '../types';

interface StatsPanelProps {
  stats: Stats;
}

export function StatsPanel({ stats }: StatsPanelProps) {
  return (
    <section className="stats-panel" aria-label="学习统计">
      <div className="primary-stat">
        <div className="stat-heading">
          <BarChart3 aria-hidden="true" size={20} />
          <span>总完成率</span>
        </div>
        <div className="primary-stat-value">
          <strong>{stats.completionRate}%</strong>
          <span>{stats.completedTasks}/{stats.totalTasks} 个学习块</span>
        </div>
        <div className="progress-track" aria-label={`总完成率 ${stats.completionRate}%`}>
          <span className="progress-fill" style={{ width: `${stats.completionRate}%` }} />
        </div>
      </div>

      <div className="stats-breakdown">
        <div className="stats-metric">
          <div className="stat-heading">
            <BookOpenCheck aria-hidden="true" size={20} />
            <span>高数完成</span>
          </div>
          <strong>{stats.mathCompletedDays}<span>天</span></strong>
        </div>

        <div className="stats-metric">
          <div className="stat-heading">
            <CheckCircle2 aria-hidden="true" size={20} />
            <span>A日完成</span>
          </div>
          <strong>{stats.aDayCompletedCount}<span>天</span></strong>
        </div>

        <div className="stats-metric">
          <div className="stat-heading">
            <Layers aria-hidden="true" size={20} />
            <span>B日完成</span>
          </div>
          <strong>{stats.bDayCompletedCount}<span>天</span></strong>
        </div>
      </div>
    </section>
  );
}
