export type DayType = 'A' | 'B';

export type ViewMode = 'today' | 'full';

export type FilterType = 'all' | 'A' | 'B' | 'basketball';

export type ActivePanel = 'schedule' | 'notes' | 'stats' | 'data';

export type RecordField = 'note' | 'debt' | 'mistakes';

export type TaskCategory =
  | 'math'
  | 'meal'
  | 'linearProbability'
  | 'professional'
  | 'rest'
  | 'memory'
  | 'buffer'
  | 'evening'
  | 'networkOs'
  | 'sleep';

export interface ScheduleTask {
  id: string;
  time: string;
  title: string;
  category: TaskCategory;
  trackable: boolean;
}

export interface ScheduleDay {
  index: number;
  date: string;
  weekday: string;
  type: DayType;
  isBasketballDay: boolean;
  tasks: ScheduleTask[];
}

export interface DayRecord {
  completedTaskIds: string[];
  note: string;
  debt: string;
  mistakes: string;
}

export type RecordsByDate = Record<string, DayRecord>;

export interface StoragePayload {
  version: number;
  exportedAt?: string;
  range?: {
    start: string;
    days: number;
  };
  records: RecordsByDate;
}

export interface Stats {
  totalTasks: number;
  completedTasks: number;
  completionRate: number;
  mathCompletedDays: number;
  aDayCompletedCount: number;
  bDayCompletedCount: number;
}
