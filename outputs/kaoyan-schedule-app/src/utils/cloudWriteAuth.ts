const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const STORAGE_KEY = 'kaoyan-cloud-write-authorization';
const CLOUD_USERNAME = 'caobiji';
const PUBLIC_API_PATHS = new Set(['/api/health', '/api/note-file']);

const isLoopbackHostname = (hostname: string): boolean => (
  hostname === '127.0.0.1'
  || hostname === 'localhost'
  || hostname === '::1'
  || hostname === '[::1]'
);

const readStoredAuthorization = (): string => {
  try {
    const persistent = window.localStorage.getItem(STORAGE_KEY) || '';
    if (persistent) return persistent;
    const legacy = window.sessionStorage.getItem(STORAGE_KEY) || '';
    if (legacy) {
      window.localStorage.setItem(STORAGE_KEY, legacy);
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
    return legacy;
  } catch {
    try { return window.sessionStorage.getItem(STORAGE_KEY) || ''; }
    catch { return ''; }
  }
};

const storeAuthorization = (value: string): void => {
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, value);
    else window.localStorage.removeItem(STORAGE_KEY);
    window.sessionStorage.removeItem(STORAGE_KEY);
    return;
  } catch {
    // Fall back to the current browser session only when persistent storage is blocked.
  }
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, value);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be unavailable in hardened browser modes.
  }
};

const encodeBasicAuthorization = (password: string): string => {
  const bytes = new TextEncoder().encode(`${CLOUD_USERNAME}:${password}`);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return `Basic ${window.btoa(binary)}`;
};

const promptForPassword = (retry = false): string => {
  const message = retry
    ? '密码不正确，请重新输入。验证成功后此设备会长期记住。'
    : '首次访问学习数据需要输入密码。验证成功后此设备不再重复询问：';
  const password = window.prompt(message) || '';
  return password ? encodeBasicAuthorization(password) : '';
};

const isProtectedCloudRequest = (request: Request): boolean => {
  const url = new URL(request.url, window.location.href);
  if (url.origin !== window.location.origin || !(url.pathname === '/api' || url.pathname.startsWith('/api/'))) return false;
  if (PUBLIC_API_PATHS.has(url.pathname)) return false;
  return WRITE_METHODS.has(request.method.toUpperCase()) || request.method.toUpperCase() === 'GET';
};

const isAuthenticationFailure = async (response: Response): Promise<boolean> => {
  if (response.status !== 401) return false;
  try {
    const payload = await response.clone().json() as { code?: string };
    return payload?.code === 'AUTH_REQUIRED';
  } catch {
    return true;
  }
};

export function installCloudWriteAuthentication(): void {
  if (typeof window === 'undefined') return;
  if (window.location.protocol !== 'https:' || isLoopbackHostname(window.location.hostname.toLowerCase())) return;
  if ((window.fetch as typeof window.fetch & { __kaoyanWriteAuthInstalled?: boolean }).__kaoyanWriteAuthInstalled) return;

  const originalFetch = window.fetch.bind(window);
  const authenticatedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const normalizedInput = typeof input === 'string' || input instanceof URL
      ? new URL(String(input), window.location.href).toString()
      : input;
    const request = new Request(normalizedInput, init);
    if (!isProtectedCloudRequest(request)) return originalFetch(request);

    const send = (authorization: string): Promise<Response> => {
      const headers = new Headers(request.headers);
      if (authorization) headers.set('Authorization', authorization);
      else headers.delete('Authorization');
      return originalFetch(new Request(request.clone(), { headers }));
    };

    let authorization = readStoredAuthorization();
    if (!authorization) authorization = promptForPassword(false);
    let response = await send(authorization);
    if (!(await isAuthenticationFailure(response))) {
      if (response.ok && authorization) storeAuthorization(authorization);
      return response;
    }

    storeAuthorization('');
    authorization = promptForPassword(true);
    if (!authorization) return response;
    response = await send(authorization);
    if (response.ok) storeAuthorization(authorization);
    else if (await isAuthenticationFailure(response)) storeAuthorization('');
    return response;
  };

  (authenticatedFetch as typeof authenticatedFetch & { __kaoyanWriteAuthInstalled?: boolean }).__kaoyanWriteAuthInstalled = true;
  window.fetch = authenticatedFetch as typeof window.fetch;
}
