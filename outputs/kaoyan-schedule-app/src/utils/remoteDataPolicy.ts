import { IS_CLOUD_RUNTIME } from './runtime';

const EXACT_BUSINESS_KEYS = new Set([
  'kaoyan-learning-data-v1',
  'kaoyan-learning-pending-records-v1',
  'kaoyan-learning-pending-replace-v1',
  'kaoyan-schedule-records-v1',
  'kaoyan.canvas.lastDraftId.v1',
]);

const BUSINESS_KEY_PREFIXES = [
  'kaoyan.canvas.draft.v1.',
  'kaoyan.canvas.publishRemark.v1.',
];

let prepared = false;

/**
 * Remote browsers are viewers/editors for Mac-owned data, not replicas.
 * Remove obsolete plaintext caches left by older builds while preserving the
 * dedicated encrypted transient queues used for content that has not reached
 * the Mac yet.
 */
export const prepareRemotePrivateStorage = (): void => {
  if (!IS_CLOUD_RUNTIME || prepared || typeof window === 'undefined') return;
  prepared = true;
  try {
    const remove: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && (EXACT_BUSINESS_KEYS.has(key) || BUSINESS_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)))) {
        remove.push(key);
      }
    }
    remove.forEach((key) => window.localStorage.removeItem(key));
    // Activity cards are only a derived view of encrypted outbox/server task
    // state. Older plaintext IndexedDB copies are safe to discard.
    window.indexedDB?.deleteDatabase('kaoyan-activity-tasks-v1');
  } catch {
    // Private browsing may make storage unreadable. Runtime modules already
    // stay memory-only, so cleanup failure does not re-enable persistence.
  }
};

export const remoteDataPolicyInternals = Object.freeze({
  exactBusinessKeys: [...EXACT_BUSINESS_KEYS],
  businessKeyPrefixes: [...BUSINESS_KEY_PREFIXES],
});
