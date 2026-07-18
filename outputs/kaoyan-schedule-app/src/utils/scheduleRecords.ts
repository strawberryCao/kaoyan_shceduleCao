import type { RecordsByDate, ScheduleDay } from '../types';
import { makeStoragePayload, normalizeRecords, STORAGE_KEY } from './schedule';

const SCHEDULE_RECORDS_EVENT = 'kaoyan-schedule-records-changed';

export const readScheduleRecords = (days: ScheduleDay[]): RecordsByDate => {
  try {
    return normalizeRecords(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'), days);
  } catch {
    return {};
  }
};

export const saveScheduleRecords = (records: RecordsByDate) => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(makeStoragePayload(records)));
  window.dispatchEvent(new CustomEvent(SCHEDULE_RECORDS_EVENT, { detail: records }));
};

export const subscribeScheduleRecords = (
  days: ScheduleDay[],
  callback: (records: RecordsByDate) => void,
) => {
  const handleCustom = (event: Event) => {
    callback(normalizeRecords((event as CustomEvent<unknown>).detail, days));
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) {
      return;
    }
    try {
      callback(normalizeRecords(JSON.parse(event.newValue), days));
    } catch {
      // Keep the last usable records when another process writes bad data.
    }
  };
  window.addEventListener(SCHEDULE_RECORDS_EVENT, handleCustom);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(SCHEDULE_RECORDS_EVENT, handleCustom);
    window.removeEventListener('storage', handleStorage);
  };
};

export const mergeScheduleRecords = (...sources: Array<RecordsByDate | null | undefined>): RecordsByDate => (
  Object.assign({}, ...sources.filter(Boolean))
);

export const sameScheduleRecords = (left: RecordsByDate, right: RecordsByDate) => (
  JSON.stringify(left) === JSON.stringify(right)
);
