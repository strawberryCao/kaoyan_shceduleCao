import { useEffect, useMemo, useRef, useState } from 'react';
import { EyeOff, LocateFixed, Minus, MoreHorizontal, Pin, X } from 'lucide-react';
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
  const desktopMode = Boolean(window.kaoyanDesktop?.isElectron);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activePanel, setActivePanel] = useState<ActivePanel>('schedule');
  const [detailOpen, setDetailOpen] = useState(false);
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

  if (desktopMode) {
    return (
      <main className="app-shell desktop-shell wallpaper-desktop-shell">
        <section className="wallpaper-widget">
          <header className="widget-toolbar">
            <div>
              <p>今日课表</p>
              <strong>{selectedDay.date}</strong>
            </div>

            <div className="widget-actions" aria-label="桌面组件操作">
              <button type="button" title="恢复到红框位置" onClick={() => void window.kaoyanDesktop?.restoreDefaultPosition()}>
                <LocateFixed aria-hidden="true" size={15} />
              </button>
              <button type="button" title="保存当前位置" onClick={() => void window.kaoyanDesktop?.savePosition()}>
                <Pin aria-hidden="true" size={15} />
              </button>
              <button type="button" title="最小化" onClick={() => window.kaoyanDesktop?.minimize()}>
                <Minus aria-hidden="true" size={15} />
              </button>
              <button type="button" title="隐藏到托盘" onClick={() => window.kaoyanDesktop?.hide()}>
                <EyeOff aria-hidden="true" size={15} />
              </button>
              <button type="button" title="退出" onClick={() => window.kaoyanDesktop?.close()}>
                <X aria-hidden="true" size={15} />
              </button>
              <button
                className={detailOpen ? 'active' : ''}
                type="button"
                title="更多"
                onClick={() => setDetailOpen((open) => !open)}
              >
                <MoreHorizontal aria-hidden="true" size={16} />
              </button>
            </div>
          </header>

          <section className="widget-core">
            <DayCard
              day={selectedDay}
              isToday={selectedDay.date === todayDay.date}
              onToggleTask={toggleTask}
              record={getRecord(selectedDay)}
            />
          </section>

          {detailOpen && (
            <aside className="widget-detail-drawer" aria-label="详细功能">
              <div className="drawer-head">
                <span>详细功能</span>
                <button type="button" onClick={() => setDetailOpen(false)}>
                  <X aria-hidden="true" size={15} />
                  收起
                </button>
              </div>

              <nav className="drawer-tabs" aria-label="详情切换">
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

              {activePanel === 'schedule' && (
                <section className="drawer-section">
                  <div className="drawer-quick-row">
                    <button type="button" onClick={() => setSelectedDate(todayDay.date)}>
                      今日
                    </button>
                    <button type="button" onClick={() => stepDay(-1)}>
                      前一天
                    </button>
                    <button type="button" onClick={() => stepDay(1)}>
                      后一天
                    </button>
                  </div>

                  <div className="drawer-filter-row">
                    {(['all', 'A', 'B', 'basketball'] as FilterType[]).map((item) => (
                      <button
                        className={filter === item ? 'active' : ''}
                        key={item}
                        type="button"
                        onClick={() => changeFilter(item)}
                      >
                        {item === 'all' ? '全部' : item === 'basketball' ? '打球' : `${item}日`}
                      </button>
                    ))}
                  </div>

                  <div className="drawer-date-strip">
                    {filteredDays.map((day) => (
                      <button
                        className={selectedDay.date === day.date ? 'active' : ''}
                        key={day.date}
                        type="button"
                        onClick={() => setSelectedDate(day.date)}
                      >
                        <span>{day.date.slice(5)}</span>
                        <small>{day.type}日</small>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {activePanel === 'notes' && (
                <NotesPanel day={selectedDay} onUpdateField={updateField} record={getRecord(selectedDay)} />
              )}

              {activePanel === 'stats' && (
                <section className="content-panel stats-view" aria-label="学习统计">
                  <div className="panel-heading">
                    <p>整体进度</p>
                    <h2>30 天统计</h2>
                  </div>
                  <StatsPanel stats={stats} />
                </section>
              )}

              {activePanel === 'data' && (
                <DataPanel onClear={clearRecords} onExport={exportRecords} onImportClick={() => fileInputRef.current?.click()} />
              )}
            </aside>
          )}

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
        </section>
      </main>
    );
  }

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
