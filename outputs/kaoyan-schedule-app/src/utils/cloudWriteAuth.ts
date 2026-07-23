const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const STORAGE_KEY = 'kaoyan-cloud-write-authorization';
const CLOUD_USERNAME = 'caobiji';

const isLoopbackHostname = (hostname: string): boolean => (
  hostname === '127.0.0.1'
  || hostname === 'localhost'
  || hostname === '::1'
  || hostname === '[::1]'
);

const readStoredAuthorization = (): string => {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
};

const storeAuthorization = (value: string): void => {
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, value);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Session storage may be unavailable in hardened browser modes.
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
    ? '编辑密码不正确，请重新输入。取消后仍可继续浏览。'
    : '当前页面可公开浏览。保存、修改或删除内容需要输入编辑密码：';
  const password = window.prompt(message) || '';
  return password ? encodeBasicAuthorization(password) : '';
};

const isProtectedCloudWrite = (request: Request): boolean => {
  if (!WRITE_METHODS.has(request.method.toUpperCase())) return false;
  const url = new URL(request.url, window.location.href);
  return url.origin === window.location.origin && (url.pathname === '/api' || url.pathname.startsWith('/api/'));
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
    if (!isProtectedCloudWrite(request)) return originalFetch(request);

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
