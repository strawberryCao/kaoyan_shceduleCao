const isLoopbackHostname = (hostname: string): boolean => (
  hostname === '127.0.0.1'
  || hostname === 'localhost'
  || hostname === '::1'
  || hostname === '[::1]'
);

// "Cloud" here means a browser acting as a remote client. This includes the
// Windows LAN fallback as well as Tailscale/Cloudflare, so mobile business
// data never becomes a second browser-owned replica merely because the URL is
// plain HTTP on a trusted LAN.
export const IS_CLOUD_RUNTIME = typeof window !== 'undefined'
  && window.location.protocol !== 'file:'
  && !isLoopbackHostname(window.location.hostname.toLowerCase());

export const IS_AUTHENTICATED_REMOTE_RUNTIME = IS_CLOUD_RUNTIME
  && window.location.protocol === 'https:';

export const IS_TAILSCALE_RUNTIME = IS_AUTHENTICATED_REMOTE_RUNTIME
  && window.location.hostname.toLowerCase().endsWith('.ts.net');

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
