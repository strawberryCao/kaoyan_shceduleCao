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
import { useEffect, useRef } from 'react';
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
  const dateListRef = useRef<HTMLDivElement>(null);
  const filteredDays = days.filter((day) => {
    if (filter === 'all') {
      return true;
    }
    if (filter === 'basketball') {
      return day.isBasketballDay;
    }
    return day.type === filter;
  });

  useEffect(() => {
    dateListRef.current
      ?.querySelector<HTMLElement>('.date-pill.active')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedDay.date, filter]);

  const selectedIndex = filteredDays.findIndex((day) => day.date === selectedDay.date);
  const canStepBack = filteredDays.length > 0 && selectedIndex !== 0;
  const canStepForward = filteredDays.length > 0 && selectedIndex !== filteredDays.length - 1;

  return (
    <aside className="date-rail" aria-label="课表导航">
      <div className="quick-actions compact" aria-label="日期快捷操作">
        <button type="button" onClick={() => onDateChange(todayDay.date)}>
          <Home aria-hidden="true" size={16} />
          今日
        </button>
        <button disabled={!canStepBack} type="button" onClick={() => onStepDay(-1)}>
          <ChevronLeft aria-hidden="true" size={16} />
          前日
        </button>
        <button disabled={!canStepForward} type="button" onClick={() => onStepDay(1)}>
          次日
          <ChevronRight aria-hidden="true" size={16} />
        </button>
      </div>

      <div className="filter-row" aria-label="日期筛选">
        {filters.map((item) => (
          <button
            aria-pressed={filter === item.value}
            className={filter === item.value ? 'active' : ''}
            key={item.value}
            type="button"
            onClick={() => onFilterChange(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="date-list" aria-label="30 天日期列表" ref={dateListRef}>
        {filteredDays.map((day) => {
          const dayNumber = getDateDistanceFromStart(day.date) + 1;
          return (
            <button
              aria-current={selectedDay.date === day.date ? 'date' : undefined}
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
                aria-current={activePanel === panel.value ? 'page' : undefined}
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
