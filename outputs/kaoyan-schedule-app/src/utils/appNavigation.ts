const APP_LOCATION_EVENT = 'kaoyan:app-location-change';

const appUrl = (path: string): URL => new URL(path || '/', `${window.location.origin}/`);

export const navigateApp = (path: string, options: { replace?: boolean } = {}) => {
  const next = appUrl(path);
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const target = `${next.pathname}${next.search}${next.hash}`;
  if (current === target) return;
  if (options.replace) window.history.replaceState(window.history.state, '', target);
  else window.history.pushState(window.history.state, '', target);
  window.dispatchEvent(new Event(APP_LOCATION_EVENT));
};

export const openAppTarget = (target: string) => {
  const next = new URL(target, window.location.href);
  if (next.origin === window.location.origin) {
    navigateApp(`${next.pathname}${next.search}${next.hash}`);
    return;
  }
  window.location.assign(next.href);
};

export const getAppLocation = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

export const subscribeAppLocation = (callback: () => void) => {
  const notify = () => callback();
  window.addEventListener('popstate', notify);
  window.addEventListener(APP_LOCATION_EVENT, notify);
  return () => {
    window.removeEventListener('popstate', notify);
    window.removeEventListener(APP_LOCATION_EVENT, notify);
  };
};
