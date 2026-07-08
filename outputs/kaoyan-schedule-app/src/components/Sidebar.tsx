import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Database,
  Dumbbell,
  Home,
  ListChecks,
  NotebookPen,
} from 'lucide-react';
import type { ActivePanel, FilterType, ScheduleDay } from '../types';
import { getDateDistanceFromStart } from '../utils/schedule';

interface SidebarProps {
  days: ScheduleDay[];
  selectedDay: ScheduleDay;
  todayDay: ScheduleDay;
  activePanel: ActivePanel;
  filter: FilterType;
  wallpaperMode: boolean;
  onPanelChange: (panel: ActivePanel) => void;
  onDateChange: (date: string) => void;
  onFilterChange: (filter: FilterType) => void;
  onStepDay: (direction: -1 | 1) => void;
}

const panels: Array<{ value: ActivePanel; label: string; icon: typeof ListChecks; desktopOnly?: boolean }> = [
  { value: 'schedule', label: '课表', icon: ListChecks },
  { value: 'notes', label: '记录', icon: NotebookPen },
  { value: 'stats', label: '统计', icon: BarChart3 },
  { value: 'data', label: '数据', icon: Database, desktopOnly: true },
];

const filters: Array<{ value: FilterType; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'A', label: 'A日' },
  { value: 'B', label: 'B日' },
  { value: 'basketball', label: '打球' },
];

export function Sidebar({
  days,
  selectedDay,
  todayDay,
  activePanel,
  filter,
  wallpaperMode,
  onPanelChange,
  onDateChange,
  onFilterChange,
  onStepDay,
}: SidebarProps) {
  const filteredDays = days.filter((day) => {
    if (filter === 'all') {
      return true;
    }
    if (filter === 'basketball') {
      return day.isBasketballDay;
    }
    return day.type === filter;
  });

  return (
    <aside className="date-rail" aria-label="课表导航">
      <div className="rail-head">
        <p>当前查看</p>
        <strong>{selectedDay.date.slice(5)}</strong>
        <span>{selectedDay.weekday}</span>
      </div>

      <div className="quick-actions compact" aria-label="日期快捷操作">
        <button type="button" onClick={() => onDateChange(todayDay.date)}>
          <Home aria-hidden="true" size={16} />
          今日
        </button>
        <button type="button" onClick={() => onStepDay(-1)}>
          <ChevronLeft aria-hidden="true" size={16} />
          前一天
        </button>
        <button type="button" onClick={() => onStepDay(1)}>
          后一天
          <ChevronRight aria-hidden="true" size={16} />
        </button>
      </div>

      <div className="filter-row" aria-label="日期筛选">
        {filters.map((item) => (
          <button
            className={filter === item.value ? 'active' : ''}
            key={item.value}
            type="button"
            onClick={() => onFilterChange(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="date-list" aria-label="30 天日期列表">
        {filteredDays.map((day) => {
          const dayNumber = getDateDistanceFromStart(day.date) + 1;
          return (
            <button
              className={selectedDay.date === day.date ? 'date-pill active' : 'date-pill'}
              key={day.date}
              type="button"
              onClick={() => onDateChange(day.date)}
            >
              <span>{dayNumber}</span>
              <strong>{day.date.slice(5)}</strong>
              <em>{day.type}日</em>
              {day.isBasketballDay && <Dumbbell aria-label="打球日" size={15} />}
            </button>
          );
        })}
      </div>

      <nav className="panel-tabs compact" aria-label="功能切换">
        {panels
          .filter((panel) => !(wallpaperMode && panel.desktopOnly))
          .map((panel) => {
            const Icon = panel.icon;
            return (
              <button
                className={activePanel === panel.value ? 'active' : ''}
                key={panel.value}
                type="button"
                onClick={() => onPanelChange(panel.value)}
              >
                <Icon aria-hidden="true" size={17} />
                {panel.label}
              </button>
            );
          })}
      </nav>
    </aside>
  );
}
