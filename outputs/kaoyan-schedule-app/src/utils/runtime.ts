const isLoopbackHostname = (hostname: string): boolean => (
  hostname === '127.0.0.1'
  || hostname === 'localhost'
  || hostname === '::1'
  || hostname === '[::1]'
);

export const IS_CLOUD_RUNTIME = typeof window !== 'undefined'
  && window.location.protocol === 'https:'
  && !isLoopbackHostname(window.location.hostname.toLowerCase());

export const resolveNoteServerUrl = (): string => {
  if (typeof window === 'undefined') return 'http://127.0.0.1:5174';
  const explicitRuntimeUrl = String(import.meta.env?.VITE_NOTE_SERVER_URL || '').trim().replace(/\/+$/, '');
  if (explicitRuntimeUrl) return explicitRuntimeUrl;
  const hostname = window.location.hostname.toLowerCase();
  return isLoopbackHostname(hostname) || window.location.protocol === 'file:'
    ? 'http://127.0.0.1:5174'
    : `${window.location.origin}/api`;
};

export const NOTE_SERVER_URL = resolveNoteServerUrl();
