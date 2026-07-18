import { DESKTOP_LAYOUT_KEY, getDefaultLayout } from './registry';
import type { WidgetLayout } from './types';
import { fetchWithTimeout } from '../utils/localService';

const CHANNEL_NAME = 'kaoyan-desktop-layout';
const LAYOUT_SERVER_URL = 'http://127.0.0.1:5174/layout';
const LAYOUT_EVENTS_URL = 'http://127.0.0.1:5174/layout/events';

const normalizeDesktopLayout = (layout: WidgetLayout[]): WidgetLayout[] => layout
  .filter((item) => item && item.id && item.type)
  .map((item) => item.type === 'noteDock' && item.title === '笔记暂存'
    ? { ...item, title: '笔记小 App' }
    : item);

export const loadDesktopLayout = (): WidgetLayout[] => {
  const saved = window.localStorage.getItem(DESKTOP_LAYOUT_KEY);
  if (!saved) {
    return getDefaultLayout();
  }

  try {
    const parsed = JSON.parse(saved) as WidgetLayout[];
    if (!Array.isArray(parsed)) {
      return getDefaultLayout();
    }
    return normalizeDesktopLayout(parsed);
  } catch {
    return getDefaultLayout();
  }
};

export const fetchDesktopLayoutFromServer = async (): Promise<WidgetLayout[] | null> => {
  try {
    const response = await fetchWithTimeout(LAYOUT_SERVER_URL, { cache: 'no-store' }, 1800);
    if (!response.ok) {
      return null;
    }
    const payload = await response.json() as { layout?: WidgetLayout[] | null };
    if (Array.isArray(payload.layout)) {
      return normalizeDesktopLayout(payload.layout);
    }
  } catch {
    return null;
  }
  return null;
};

export const saveDesktopLayoutToServer = async (layout: WidgetLayout[]): Promise<boolean> => {
  try {
    const response = await fetchWithTimeout(LAYOUT_SERVER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ layout }),
    }, 2200);
    return response.ok;
  } catch {
    // LocalStorage and BroadcastChannel still work as fallback.
    return false;
  }
};

export const notifyDesktopLayoutChanged = (layout: WidgetLayout[]) => {
  if ('BroadcastChannel' in window) {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ type: 'layout-changed', layout });
    channel.close();
  }
};

export const subscribeDesktopLayoutChanged = (callback: (layout: WidgetLayout[]) => void) => {
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== DESKTOP_LAYOUT_KEY || !event.newValue) {
      return;
    }
    try {
      const layout = JSON.parse(event.newValue) as WidgetLayout[];
      if (Array.isArray(layout)) {
        callback(normalizeDesktopLayout(layout));
      }
    } catch {
      // Ignore invalid layout payloads.
    }
  };

  window.addEventListener('storage', handleStorage);

  let channel: BroadcastChannel | null = null;
  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event) => {
      if (event.data?.type === 'layout-changed' && Array.isArray(event.data.layout)) {
        callback(normalizeDesktopLayout(event.data.layout));
      }
    };
  }

  return () => {
    window.removeEventListener('storage', handleStorage);
    channel?.close();
  };
};

export const saveDesktopLayoutLocally = (layout: WidgetLayout[]): boolean => {
  try {
    window.localStorage.setItem(DESKTOP_LAYOUT_KEY, JSON.stringify(layout));
    notifyDesktopLayoutChanged(layout);
    return true;
  } catch {
    return false;
  }
};

export const subscribeDesktopLayoutFromServer = (callback: (layout: WidgetLayout[]) => void) => {
  if (!('EventSource' in window)) {
    return () => undefined;
  }
  const source = new EventSource(LAYOUT_EVENTS_URL);
  const handleLayout = (event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as { layout?: WidgetLayout[] | null };
      if (Array.isArray(payload.layout)) {
        callback(normalizeDesktopLayout(payload.layout));
      }
    } catch {
      // Keep the last good layout. EventSource reconnects automatically.
    }
  };
  source.addEventListener('layout', handleLayout as EventListener);
  return () => {
    source.removeEventListener('layout', handleLayout as EventListener);
    source.close();
  };
};

export interface DesktopLayoutSaveResult {
  localSaved: boolean;
  serverSaved: boolean;
}

export const saveDesktopLayout = async (layout: WidgetLayout[]): Promise<DesktopLayoutSaveResult> => {
  const localSaved = saveDesktopLayoutLocally(layout);
  const serverSaved = await saveDesktopLayoutToServer(layout);
  return { localSaved, serverSaved };
};

export const resetDesktopLayout = (): WidgetLayout[] => {
  const defaults = getDefaultLayout();
  void saveDesktopLayout(defaults);
  return defaults;
};
