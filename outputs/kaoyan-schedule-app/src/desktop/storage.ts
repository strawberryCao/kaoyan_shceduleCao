import { DESKTOP_LAYOUT_KEY, getDefaultLayout } from './registry';
import type { WidgetLayout } from './types';

const CHANNEL_NAME = 'kaoyan-desktop-layout';
const LAYOUT_SERVER_URL = 'http://127.0.0.1:5174/layout';

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
    return parsed.filter((item) => item && item.id && item.type);
  } catch {
    return getDefaultLayout();
  }
};

export const fetchDesktopLayoutFromServer = async (): Promise<WidgetLayout[] | null> => {
  try {
    const response = await fetch(`${LAYOUT_SERVER_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json() as { layout?: WidgetLayout[] | null };
    if (Array.isArray(payload.layout)) {
      window.localStorage.setItem(DESKTOP_LAYOUT_KEY, JSON.stringify(payload.layout));
      return payload.layout;
    }
  } catch {
    return null;
  }
  return null;
};

export const saveDesktopLayoutToServer = async (layout: WidgetLayout[]) => {
  try {
    await fetch(LAYOUT_SERVER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ layout }),
    });
  } catch {
    // LocalStorage and BroadcastChannel still work as fallback.
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
        callback(layout);
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
        callback(event.data.layout);
      }
    };
  }

  return () => {
    window.removeEventListener('storage', handleStorage);
    channel?.close();
  };
};

export const saveDesktopLayout = (layout: WidgetLayout[]) => {
  window.localStorage.setItem(DESKTOP_LAYOUT_KEY, JSON.stringify(layout));
  notifyDesktopLayoutChanged(layout);
  void saveDesktopLayoutToServer(layout);
};

export const resetDesktopLayout = (): WidgetLayout[] => {
  const defaults = getDefaultLayout();
  saveDesktopLayout(defaults);
  return defaults;
};
