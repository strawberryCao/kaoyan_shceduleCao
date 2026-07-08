import type {
  DayRecord,
  DayType,
  RecordsByDate,
  ScheduleDay,
  ScheduleTask,
  Stats,
  StoragePayload,
} from '../types';

export const START_DATE = '2026-07-09';
export const SCHEDULE_DAYS = 30;
export const STORAGE_KEY = 'kaoyan-schedule-records-v1';
export const STORAGE_VERSION = 1;

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const emptyRecord = (): DayRecord => ({
  completedTaskIds: [],
  note: '',
  debt: '',
  mistakes: '',
});

const parseLocalDate = (date: string): Date => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day);
};

export const formatLocalDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const addDays = (date: string, days: number): string => {
  const next = parseLocalDate(date);
  next.setDate(next.getDate() + days);
  return formatLocalDate(next);
};

const makeTask = (
  date: string,
  slug: string,
  time: string,
  title: string,
  category: ScheduleTask['category'],
  trackable: boolean,
): ScheduleTask => ({
  id: `${date}-${slug}`,
  time,
  title,
  category,
  trackable,
});

export const generateSchedule = (): ScheduleDay[] => {
  return Array.from({ length: SCHEDULE_DAYS }, (_, index) => {
    const date = addDays(START_DATE, index);
    const jsDate = parseLocalDate(date);
    const type: DayType = index % 2 === 0 ? 'A' : 'B';
    const isBasketballDay = [1, 3, 5].includes(jsDate.getDay());
    const linearTitle = index % 2 === 0 ? '线代' : '概率论';
    const professionalTitle = type === 'A' ? '数据结构' : '组成原理';
    const nightTitle = type === 'A' ? '计算机网络' : '操作系统';
    const eveningTitle = isBasketballDay ? '打球' : '机动复盘/错题整理';

    return {
      index,
      date,
      weekday: WEEKDAYS[jsDate.getDay()],
      type,
      isBasketballDay,
      tasks: [
        makeTask(date, 'math', '08:00-12:00', '高数', 'math', true),
        makeTask(date, 'lunch', '12:00-13:00', '午饭/午休', 'meal', false),
        makeTask(
          date,
          index % 2 === 0 ? 'linear' : 'probability',
          '13:00-15:00',
          linearTitle,
          'linearProbability',
          true,
        ),
        makeTask(
          date,
          type === 'A' ? 'data-structure' : 'computer-architecture',
          '15:00-18:00',
          professionalTitle,
          'professional',
          true,
        ),
        makeTask(date, 'dinner', '18:00-19:00', '晚饭/休息', 'rest', false),
        makeTask(date, 'memory', '19:00-19:30', '背自己记的东西', 'memory', true),
        makeTask(date, 'buffer', '19:30-20:00', '缓冲', 'buffer', false),
        makeTask(
          date,
          isBasketballDay ? 'basketball' : 'review',
          '20:00-22:00',
          eveningTitle,
          'evening',
          true,
        ),
        makeTask(
          date,
          type === 'A' ? 'network' : 'operating-system',
          '22:00-24:00',
          nightTitle,
          'networkOs',
          true,
        ),
        makeTask(date, 'sleep', '24:00', '睡觉', 'sleep', false),
      ],
    };
  });
};

export const getDefaultRecord = (): DayRecord => emptyRecord();

export const getDayProgress = (day: ScheduleDay, record?: DayRecord) => {
  const trackableTasks = day.tasks.filter((task) => task.trackable);
  const completed = trackableTasks.filter((task) =>
    record?.completedTaskIds.includes(task.id),
  ).length;

  return {
    total: trackableTasks.length,
    completed,
    rate: trackableTasks.length === 0 ? 0 : Math.round((completed / trackableTasks.length) * 100),
  };
};

export const isDayFullyComplete = (day: ScheduleDay, record?: DayRecord): boolean => {
  const trackableTasks = day.tasks.filter((task) => task.trackable);
  return (
    trackableTasks.length > 0 &&
    trackableTasks.every((task) => record?.completedTaskIds.includes(task.id))
  );
};

export const calculateStats = (days: ScheduleDay[], records: RecordsByDate): Stats => {
  let totalTasks = 0;
  let completedTasks = 0;
  let mathCompletedDays = 0;
  let aDayCompletedCount = 0;
  let bDayCompletedCount = 0;

  days.forEach((day) => {
    const record = records[day.date];
    const trackableTasks = day.tasks.filter((task) => task.trackable);
    totalTasks += trackableTasks.length;
    completedTasks += trackableTasks.filter((task) =>
      record?.completedTaskIds.includes(task.id),
    ).length;

    const mathTask = day.tasks.find((task) => task.category === 'math');
    if (mathTask && record?.completedTaskIds.includes(mathTask.id)) {
      mathCompletedDays += 1;
    }

    if (isDayFullyComplete(day, record)) {
      if (day.type === 'A') {
        aDayCompletedCount += 1;
      } else {
        bDayCompletedCount += 1;
      }
    }
  });

  return {
    totalTasks,
    completedTasks,
    completionRate: totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100),
    mathCompletedDays,
    aDayCompletedCount,
    bDayCompletedCount,
  };
};

export const getCurrentScheduleDay = (days: ScheduleDay[], currentDate = new Date()): ScheduleDay => {
  const today = formatLocalDate(currentDate);

  if (today <= days[0].date) {
    return days[0];
  }

  const lastDay = days[days.length - 1];
  if (today >= lastDay.date) {
    return lastDay;
  }

  return days.find((day) => day.date === today) ?? days[0];
};

const getScheduleTaskIdsByDate = (days: ScheduleDay[]): Map<string, Set<string>> => {
  return new Map(days.map((day) => [day.date, new Set(day.tasks.map((task) => task.id))]));
};

const readString = (value: unknown): string => (typeof value === 'string' ? value : '');

export const normalizeRecords = (value: unknown, days: ScheduleDay[]): RecordsByDate => {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const payload = value as Partial<StoragePayload> | RecordsByDate;
  const rawRecords =
    'records' in payload && payload.records && typeof payload.records === 'object'
      ? payload.records
      : payload;
  const taskIdsByDate = getScheduleTaskIdsByDate(days);
  const normalized: RecordsByDate = {};

  days.forEach((day) => {
    const rawRecord = (rawRecords as Record<string, unknown>)[day.date];
    if (!rawRecord || typeof rawRecord !== 'object') {
      return;
    }

    const dayTaskIds = taskIdsByDate.get(day.date) ?? new Set<string>();
    const typedRecord = rawRecord as Partial<DayRecord>;
    const completedTaskIds = Array.isArray(typedRecord.completedTaskIds)
      ? typedRecord.completedTaskIds.filter(
          (taskId): taskId is string => typeof taskId === 'string' && dayTaskIds.has(taskId),
        )
      : [];

    const record: DayRecord = {
      completedTaskIds,
      note: readString(typedRecord.note),
      debt: readString(typedRecord.debt),
      mistakes: readString(typedRecord.mistakes),
    };

    if (
      record.completedTaskIds.length > 0 ||
      record.note.length > 0 ||
      record.debt.length > 0 ||
      record.mistakes.length > 0
    ) {
      normalized[day.date] = record;
    }
  });

  return normalized;
};

export const makeStoragePayload = (records: RecordsByDate): StoragePayload => ({
  version: STORAGE_VERSION,
  exportedAt: new Date().toISOString(),
  range: {
    start: START_DATE,
    days: SCHEDULE_DAYS,
  },
  records,
});

export const getScheduleRangeText = (): string => {
  const endDate = addDays(START_DATE, SCHEDULE_DAYS - 1);
  return `${START_DATE} 至 ${endDate}`;
};

export const getDateDistanceFromStart = (date: string): number => {
  return Math.round((parseLocalDate(date).getTime() - parseLocalDate(START_DATE).getTime()) / DAY_IN_MS);
};
