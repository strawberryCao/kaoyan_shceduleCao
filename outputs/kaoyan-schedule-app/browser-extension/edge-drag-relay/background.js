const MESSAGE = Object.freeze({
  capture: 'KAOYAN_RELAY_CAPTURE_VISIBLE_TAB',
  resolve: 'KAOYAN_RELAY_RESOLVE_TRANSFER',
  open: 'KAOYAN_RELAY_OPEN_ASSET',
});

const safeHttpUrl = (value) => {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const resolveTransfer = async (rawUrl) => {
  const url = safeHttpUrl(rawUrl);
  if (!url) throw new Error('接力地址无效。');
  let lastError = null;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
      });
      const result = await response.json().catch(() => null);
      if (response.ok && result?.ok && result?.asset) return result;
      if (response.status !== 404) {
        throw new Error(result?.error || `资料服务返回 ${response.status}`);
      }
      lastError = new Error(result?.error || '资料尚未登记。');
    } catch (error) {
      lastError = error;
    }
    await delay(70 + attempt * 45);
  }
  throw lastError || new Error('没有找到本次资料接力。');
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MESSAGE.capture) {
    const windowId = sender.tab?.windowId;
    chrome.tabs.captureVisibleTab(windowId, {
      format: 'jpeg',
      quality: 84,
    }).then(
      (dataUrl) => sendResponse({ ok: true, dataUrl }),
      (error) => sendResponse({ ok: false, error: error?.message || String(error) }),
    );
    return true;
  }

  if (message?.type === MESSAGE.resolve) {
    resolveTransfer(message.url).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: error?.message || String(error) }),
    );
    return true;
  }

  if (message?.type === MESSAGE.open) {
    const url = safeHttpUrl(message.url);
    if (!url) {
      sendResponse({ ok: false, error: '资料地址无效。' });
      return false;
    }
    chrome.tabs.create({ url }).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error?.message || String(error) }),
    );
    return true;
  }

  return false;
});
