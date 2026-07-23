import { useEffect, useMemo, useRef, useState } from 'react';
import { DataPanel } from './DataPanel';
import { DayCard } from './DayCard';
import { LearningCenter, type LearningCardPatch } from './LearningCenter';
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
} from '../utils/schedule';
import {
  mergeScheduleRecords,
  readScheduleRecords,
  sameScheduleRecords,
  saveScheduleRecords,
  subscribeScheduleRecords,
} from '../utils/scheduleRecords';
import {
  applyLearningNoteReviewActions,
  clearPendingLearningRecord,
  clearPendingLearningReplacement,
  createLearningNote,
  deleteLearningCard,
  deleteLearningNote,
  fetchLearningData,
  getManualRecords,
  patchLearningDay,
  patchLearningCard,
  patchLearningNote,
  putLearningManualRecords,
  queuePendingLearningRecord,
  queuePendingLearningReplacement,
  readLearningDataCache,
  readPendingLearningRecords,
  readPendingLearningReplacement,
  subscribeLearningDataCache,
  subscribeLearningDataFromServer,
  subscribeLearningDataPolling,
  type LearningDataSnapshot,
  type LearningNoteReviewAction,
} from '../utils/learningData';

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

const panelTitles: Record<ActivePanel, string> = {
  schedule: '完整课表',
  notes: '每日记录',
  stats: '学习统计',
  data: '数据管理',
  learning: '学习中心',
};

const getInitialPanel = (): ActivePanel => {
  const panel = new URLSearchParams(window.location.search).get('panel');
  return panel === 'learning' || panel === 'notes' || panel === 'stats' || panel === 'data'
    ? panel
    : 'schedule';
};

const sameDayRecord = (left: DayRecord, right: DayRecord) => JSON.stringify(left) === JSON.stringify(right);

const mergePendingRecords = (
  snapshot: LearningDataSnapshot,
  livePending: RecordsByDate = {},
): RecordsByDate => mergeScheduleRecords(
  getManualRecords(snapshot),
  readPendingLearningReplacement(),
  readPendingLearningRecords(),
  livePending,
);

export function ScheduleApp() {
  const days = useMemo(() => generateSchedule(), []);
  const todayDay = useMemo(() => getCurrentScheduleDay(days), [days]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activePanel, setActivePanel] = useState<ActivePanel>(getInitialPanel);
  const [filter, setFilter] = useState<FilterType>('all');
  const [selectedDate, setSelectedDate] = useState(todayDay.date);
  const [records, setRecords] = useState<RecordsByDate>(() => readScheduleRecords(days));
  const [learningData, setLearningData] = useState<LearningDataSnapshot>(() => readLearningDataCache());
  const recordsRef = useRef(records);
  const learningDataRef = useRef(learningData);
  const syncTimersRef = useRef(new Map<string, number>());
  const pendingSyncRecordsRef = useRef(new Map<string, DayRecord>());
  const inFlightSyncRecordsRef = useRef(new Map<string, DayRecord>());
  const initialHydrationRef = useRef(true);

  const applyRecords = (next: RecordsByDate, persist = false) => {
    if (sameScheduleRecords(recordsRef.current, next)) {
      return;
    }
    recordsRef.current = next;
    setRecords(next);
    if (persist) {
      saveScheduleRecords(next);
    }
  };

  const readLivePendingRecords = (): RecordsByDate => Object.fromEntries(pendingSyncRecordsRef.current);

  const acceptLearningSnapshot = (snapshot: LearningDataSnapshot, force = false) => {
    const current = learningDataRef.current;
    const incomingUpdatedAt = snapshot.updatedAt ? Date.parse(snapshot.updatedAt) : Number.NaN;
    const currentUpdatedAt = current.updatedAt ? Date.parse(current.updatedAt) : Number.NaN;
    const isNewerServerEpoch = Number.isFinite(incomingUpdatedAt)
      && (!Number.isFinite(currentUpdatedAt) || incomingUpdatedAt > currentUpdatedAt);

    // A rebuild or restore can legitimately restart from a lower revision.
    // In that case the newer server timestamp is authoritative over an older
    // localStorage snapshot, while genuinely older events are still ignored.
    if (!force && snapshot.revision < current.revision && !isNewerServerEpoch) {
      return false;
    }
    learningDataRef.current = snapshot;
    setLearningData(snapshot);
    return true;
  };

  const applyLearningSnapshot = (snapshot: LearningDataSnapshot, syncRecords = true) => {
    if (!acceptLearningSnapshot(snapshot)) {
      return false;
    }
    if (syncRecords && !initialHydrationRef.current) {
      applyRecords(mergePendingRecords(snapshot, readLivePendingRecords()), true);
    }
    return true;
  };

  const submitLatestRecord = (date: string) => {
    if (inFlightSyncRecordsRef.current.has(date)) {
      return;
    }
    const record = pendingSyncRecordsRef.current.get(date);
    if (!record) {
      return;
    }

    inFlightSyncRecordsRef.current.set(date, record);
    let succeeded = false;
    void patchLearningDay(date, record)
      .then((snapshot) => {
        succeeded = true;
        const accepted = applyLearningSnapshot(snapshot);

        const latest = pendingSyncRecordsRef.current.get(date);
        if (latest && sameDayRecord(latest, record)) {
          pendingSyncRecordsRef.current.delete(date);
          clearPendingLearningRecord(date, record);
          applyRecords(mergePendingRecords(
            accepted ? snapshot : learningDataRef.current,
            readLivePendingRecords(),
          ), true);
        }
      })
      .catch(() => {
        // Keep the newest local value queued for the next successful load.
      })
      .finally(() => {
        const active = inFlightSyncRecordsRef.current.get(date);
        if (active && sameDayRecord(active, record)) {
          inFlightSyncRecordsRef.current.delete(date);
        }
        const latest = pendingSyncRecordsRef.current.get(date);
        const wasSuperseded = Boolean(latest && !sameDayRecord(latest, record));
        if (
          latest
          && (succeeded || wasSuperseded)
          && !syncTimersRef.current.has(date)
        ) {
          submitLatestRecord(date);
        }
      });
  };

  const scheduleRecordSync = (date: string, record: DayRecord, delay = 0) => {
    queuePendingLearningRecord(date, record);
    pendingSyncRecordsRef.current.set(date, record);

    const previousTimer = syncTimersRef.current.get(date);
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
      syncTimersRef.current.delete(date);
    }

    if (delay <= 0) {
      submitLatestRecord(date);
      return;
    }

    const timer = window.setTimeout(() => {
      syncTimersRef.current.delete(date);
      submitLatestRecord(date);
    }, delay);
    syncTimersRef.current.set(date, timer);
  };

  useEffect(() => subscribeScheduleRecords(days, (next) => {
    applyRecords(mergeScheduleRecords(
      next,
      readPendingLearningReplacement(),
      readPendingLearningRecords(),
      readLivePendingRecords(),
    ));
  }), [days]);

  useEffect(() => subscribeLearningDataCache((snapshot) => {
    applyLearningSnapshot(snapshot);
  }), []);

  useEffect(() => subscribeLearningDataFromServer(), []);

  // iPad Safari may suspend an EventSource while the tab is in the background.
  // Polling refreshes immediately on mount and provides a quiet fallback.
  useEffect(() => subscribeLearningDataPolling(), []);

  useEffect(() => {
    const controller = new AbortController();
    Object.entries(readPendingLearningRecords()).forEach(([date, record]) => {
      if (!pendingSyncRecordsRef.current.has(date)) {
        pendingSyncRecordsRef.current.set(date, record);
      }
    });

    void (async () => {
      try {
        let snapshot = await fetchLearningData(controller.signal);
        if (controller.signal.aborted) {
          return;
        }

        const pendingReplacement = readPendingLearningReplacement();
        if (pendingReplacement !== null) {
          snapshot = await putLearningManualRecords(pendingReplacement, 'replace');
          const latestReplacement = readPendingLearningReplacement();
          if (latestReplacement !== null && sameScheduleRecords(latestReplacement, pendingReplacement)) {
            clearPendingLearningReplacement();
          }
        }

        const pendingRecords = readPendingLearningRecords();
        for (const [date, record] of Object.entries(pendingRecords)) {
          if (!pendingSyncRecordsRef.current.has(date)) {
            pendingSyncRecordsRef.current.set(date, record);
          }
        }

        const localToMerge = recordsRef.current;
        if (
          pendingReplacement === null
          && Object.keys(pendingRecords).length === 0
          && Object.keys(localToMerge).length > 0
          && !sameScheduleRecords(getManualRecords(snapshot), localToMerge)
        ) {
          snapshot = await putLearningManualRecords(localToMerge, 'merge');
        }

        if (!controller.signal.aborted) {
          const accepted = acceptLearningSnapshot(snapshot, true);
          applyRecords(mergePendingRecords(
            accepted ? snapshot : learningDataRef.current,
            readLivePendingRecords(),
          ), true);
        }
      } catch {
        // Keep the existing schedule localStorage and cached AI notes while offline.
      } finally {
        initialHydrationRef.current = false;
        if (!controller.signal.aborted) {
          pendingSyncRecordsRef.current.forEach((_record, date) => submitLatestRecord(date));
        }
      }
    })();

    return () => controller.abort();
  }, []);

  useEffect(() => () => {
    syncTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    syncTimersRef.current.clear();

    const pending = mergeScheduleRecords(
      readPendingLearningRecords(),
      readLivePendingRecords(),
    );
    Object.entries(pending).forEach(([date, record]) => {
      void patchLearningDay(date, record, undefined, { keepalive: true }).catch(() => {
        // The durable pending queue remains available for the next launch.
      });
    });
  }, []);

  const selectedDay = days.find((day) => day.date === selectedDate) ?? todayDay;
  const stats = useMemo(() => calculateStats(days, records), [days, records]);
  const filteredDays = useMemo(() => days.filter((day) => matchesFilter(day, filter)), [days, filter]);

  const getRecord = (day: ScheduleDay): DayRecord => records[day.date] ?? getDefaultRecord();

  const updateRecord = (
    date: string,
    updater: (record: DayRecord) => DayRecord,
    syncDelay = 0,
  ) => {
    const previous = recordsRef.current[date] ?? getDefaultRecord();
    const nextRecord = updater(previous);
    applyRecords({
      ...recordsRef.current,
      [date]: nextRecord,
    }, true);
    scheduleRecordSync(date, nextRecord, syncDelay);
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
    }), 350);
  };

  const changeFilter = (nextFilter: FilterType) => {
    setFilter(nextFilter);
    if (!matchesFilter(selectedDay, nextFilter)) {
      const nextDay = days.find((day) => matchesFilter(day, nextFilter)) ?? todayDay;
      setSelectedDate(nextDay.date);
    }
  };

  const stepDay = (direction: -1 | 1) => {
    const navigationDays = filteredDays.length > 0 ? filteredDays : days;
    const currentIndex = navigationDays.findIndex((day) => day.date === selectedDay.date);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = Math.min(Math.max(safeIndex + direction, 0), navigationDays.length - 1);
    setSelectedDate(navigationDays[nextIndex].date);
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
      queuePendingLearningReplacement(normalized);
      applyRecords(normalized, true);
      try {
        const snapshot = await putLearningManualRecords(normalized, 'replace');
        const latestReplacement = readPendingLearningReplacement();
        if (latestReplacement !== null && sameScheduleRecords(latestReplacement, normalized)) {
          clearPendingLearningReplacement();
        }
        applyLearningSnapshot(snapshot);
      } catch {
        // The imported records remain local and are retried when the service returns.
      }
      window.alert('导入成功，记录已更新。');
    } catch {
      window.alert('导入失败，请选择有效的 JSON 记录文件。');
    }
  };

  const clearRecords = () => {
    const confirmed = window.confirm('确定清空所有完成记录、备注、欠账和错题提醒吗？此操作不可撤销。');
    if (confirmed) {
      queuePendingLearningReplacement({});
      applyRecords({}, true);
      void putLearningManualRecords({}, 'replace')
        .then((snapshot) => {
          const latestReplacement = readPendingLearningReplacement();
          if (latestReplacement !== null && sameScheduleRecords(latestReplacement, {})) {
            clearPendingLearningReplacement();
          }
          applyLearningSnapshot(snapshot);
        })
        .catch(() => {
          // Keep the pending clear operation until the local service is available.
        });
    }
  };

  const renderPanel = () => {
    if (activePanel === 'learning') {
      return (
        <LearningCenter
          snapshot={learningData}
          scheduleDays={days}
          onOpenDate={(date) => {
            if (days.some((day) => day.date === date)) {
              setSelectedDate(date);
              setActivePanel('notes');
            }
          }}
          onPatchCard={async (cardId: string, patch: LearningCardPatch) => {
            const snapshot = await patchLearningCard(cardId, patch);
            applyLearningSnapshot(snapshot);
          }}
          onDeleteCard={async (cardId) => {
            const snapshot = await deleteLearningCard(cardId);
            applyLearningSnapshot(snapshot);
          }}
          onCreateNote={async (input) => {
            const snapshot = await createLearningNote(input);
            applyLearningSnapshot(snapshot);
          }}
          onPatchNote={async (noteUid, patch) => {
            const snapshot = await patchLearningNote(noteUid, patch);
            applyLearningSnapshot(snapshot);
          }}
          onReviewNotes={async (actions: LearningNoteReviewAction[]) => {
            const response = await applyLearningNoteReviewActions(actions);
            applyLearningSnapshot(response.snapshot);
          }}
          onDeleteNote={async (noteUid) => {
            const snapshot = await deleteLearningNote(noteUid);
            applyLearningSnapshot(snapshot);
          }}
        />
      );
    }

    if (activePanel === 'notes') {
      return (
        <NotesPanel
          day={selectedDay}
          onUpdateField={updateField}
          record={getRecord(selectedDay)}
          autoNotes={learningData.days[selectedDay.date]?.autoNotes ?? []}
        />
      );
    }

    if (activePanel === 'stats') {
      return (
        <section className="content-panel stats-view" aria-label="学习统计">
          <div className="panel-heading">
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
    <main className={`app-shell schedule-app-shell panel-${activePanel}`}>
      <section className="desktop-frame schedule-frame">
        <header className="desktop-commandbar schedule-commandbar">
          <div className="schedule-command-title">
            <h1>{panelTitles[activePanel]}</h1>
            <span>{getScheduleRangeText()}</span>
          </div>
          <nav className="schedule-panel-switcher" aria-label="课表功能切换">
            {panelButtons.map((panel) => (
              <button
                aria-current={activePanel === panel.value ? 'page' : undefined}
                className={activePanel === panel.value ? 'active' : ''}
                key={panel.value}
                type="button"
                onClick={() => setActivePanel(panel.value)}
              >
                {panel.label}
              </button>
            ))}
          </nav>
        </header>

        <div className={`workspace schedule-workspace panel-${activePanel}`}>
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

          <section className={`main-stage schedule-main-stage panel-${activePanel}`}>{renderPanel()}</section>
        </div>

        <nav className="bottom-panel-tabs schedule-bottom-tabs" aria-label="课表功能切换">
          {panelButtons.map((panel) => (
            <button
              aria-current={activePanel === panel.value ? 'page' : undefined}
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
