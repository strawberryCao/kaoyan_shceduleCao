import { useEffect, useMemo, useRef, useState } from 'react';
import { DataPanel } from './DataPanel';
import { DayCard } from './DayCard';
import { NotesPanel } from './NotesPanel';
import { Sidebar } from './Sidebar';
import { StatsPanel } from './StatsPanel';
import type { ActivePanel, DayRecord, FilterType, RecordField, RecordsByDate, ScheduleDay } from '../types';
import {
  calculateStats,
  generateSchedule,
  getCurrentScheduleDay,
  getDefaultRecord,
  getScheduleRangeText,
  makeStoragePayload,
  normalizeRecords,
  STORAGE_KEY,
} from '../utils/schedule';

const matchesFilter = (day: ScheduleDay, filter: FilterType): boolean => {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'basketball') {
    return day.isBasketballDay;
  }
  return day.type === filter;
};

const panelButtons: Array<{ value: ActivePanel; label: string }> = [
  { value: 'schedule', label: '课表' },
  { value: 'notes', label: '记录' },
  { value: 'stats', label: '统计' },
  { value: 'data', label: '数据' },
];

export function ScheduleApp() {
  const days = useMemo(() => generateSchedule(), []);
  const todayDay = useMemo(() => getCurrentScheduleDay(days), [days]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activePanel, setActivePanel] = useState<ActivePanel>('schedule');
  const [filter, setFilter] = useState<FilterType>('all');
  const [selectedDate, setSelectedDate] = useState(todayDay.date);
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

  const selectedDay = days.find((day) => day.date === selectedDate) ?? todayDay;
  const stats = useMemo(() => calculateStats(days, records), [days, records]);
  const filteredDays = useMemo(() => days.filter((day) => matchesFilter(day, filter)), [days, filter]);

  const getRecord = (day: ScheduleDay): DayRecord => records[day.date] ?? getDefaultRecord();

  const updateRecord = (date: string, updater: (record: DayRecord) => DayRecord) => {
    setRecords((current) => {
      const previous = current[date] ?? getDefaultRecord();
      return {
        ...current,
        [date]: updater(previous),
      };
    });
  };

  const toggleTask = (date: string, taskId: string) => {
    updateRecord(date, (record) => {
      const hasTask = record.completedTaskIds.includes(taskId);
      return {
        ...record,
        completedTaskIds: hasTask
          ? record.completedTaskIds.filter((id) => id !== taskId)
          : [...record.completedTaskIds, taskId],
      };
    });
  };

  const updateField = (date: string, field: RecordField, value: string) => {
    updateRecord(date, (record) => ({
      ...record,
      [field]: value,
    }));
  };

  const changeFilter = (nextFilter: FilterType) => {
    setFilter(nextFilter);
    if (!matchesFilter(selectedDay, nextFilter)) {
      const nextDay = days.find((day) => matchesFilter(day, nextFilter)) ?? todayDay;
      setSelectedDate(nextDay.date);
    }
  };

  const stepDay = (direction: -1 | 1) => {
    const currentIndex = days.findIndex((day) => day.date === selectedDay.date);
    const nextIndex = Math.min(Math.max(currentIndex + direction, 0), days.length - 1);
    setSelectedDate(days[nextIndex].date);
    setActivePanel('schedule');
  };

  const exportRecords = () => {
    const payload = makeStoragePayload(records);
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'kaoyan-schedule-records.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const importRecords = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const normalized = normalizeRecords(parsed, days);
      setRecords(normalized);
      window.alert('导入成功，记录已更新。');
    } catch {
      window.alert('导入失败，请选择有效的 JSON 记录文件。');
    }
  };

  const clearRecords = () => {
    const confirmed = window.confirm('确定清空所有完成记录、备注、欠账和错题提醒吗？此操作不可撤销。');
    if (confirmed) {
      setRecords({});
    }
  };

  const renderPanel = () => {
    if (activePanel === 'notes') {
      return <NotesPanel day={selectedDay} onUpdateField={updateField} record={getRecord(selectedDay)} />;
    }

    if (activePanel === 'stats') {
      return (
        <section className="content-panel stats-view" aria-label="学习统计">
          <div className="panel-heading">
            <p>整体进度</p>
            <h2>30 天统计</h2>
          </div>
          <StatsPanel stats={stats} />
        </section>
      );
    }

    if (activePanel === 'data') {
      return <DataPanel onClear={clearRecords} onExport={exportRecords} onImportClick={() => fileInputRef.current?.click()} />;
    }

    return (
      <DayCard
        day={selectedDay}
        isToday={selectedDay.date === todayDay.date}
        onToggleTask={toggleTask}
        record={getRecord(selectedDay)}
      />
    );
  };

  return (
    <main className="app-shell">
      <section className="desktop-frame">
        <header className="desktop-commandbar">
          <div className="command-title">
            <span className="soft-mark">研</span>
            <div>
              <p>30 天考研计划</p>
              <h1>考研学习课表</h1>
            </div>
          </div>

          <div className="command-meta">
            <span>{getScheduleRangeText()}</span>
          </div>
        </header>

        <div className="workspace">
          <Sidebar
            activePanel={activePanel}
            days={days}
            filter={filter}
            onDateChange={(date) => {
              setSelectedDate(date);
              setActivePanel('schedule');
            }}
            onFilterChange={changeFilter}
            onPanelChange={setActivePanel}
            onStepDay={stepDay}
            selectedDay={selectedDay}
            todayDay={todayDay}
            wallpaperMode={false}
          />

          <section className="main-stage">{renderPanel()}</section>
        </div>

        <nav className="bottom-panel-tabs" aria-label="功能切换">
          {panelButtons.map((panel) => (
            <button
              className={activePanel === panel.value ? 'active' : ''}
              key={panel.value}
              type="button"
              onClick={() => setActivePanel(panel.value)}
            >
              {panel.label}
            </button>
          ))}
        </nav>
      </section>

      <input
        accept="application/json,.json"
        className="visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void importRecords(file);
          }
          event.currentTarget.value = '';
        }}
        ref={fileInputRef}
        type="file"
      />
    </main>
  );
}
