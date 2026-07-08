import { DESKTOP_LAYOUT_KEY, getDefaultLayout } from './registry';
import type { WidgetLayout } from './types';

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

export const saveDesktopLayout = (layout: WidgetLayout[]) => {
  window.localStorage.setItem(DESKTOP_LAYOUT_KEY, JSON.stringify(layout));
};

export const resetDesktopLayout = (): WidgetLayout[] => {
  const defaults = getDefaultLayout();
  saveDesktopLayout(defaults);
  return defaults;
};
