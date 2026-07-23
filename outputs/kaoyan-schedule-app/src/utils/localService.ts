export const fetchWithTimeout = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 3000,
): Promise<Response> => {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);

  if (upstreamSignal?.aborted) {
    abortFromUpstream();
  } else {
    upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  }

  const timer = window.setTimeout(
    () => controller.abort(new DOMException('本地服务响应超时', 'TimeoutError')),
    timeoutMs,
  );
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
};
