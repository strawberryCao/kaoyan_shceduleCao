import { Clipboard, ExternalLink } from 'lucide-react';
import { NOTE_SERVER_URL } from '../utils/notes';
import { fetchWithTimeout } from '../utils/localService';

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const waitForNativeNoteApp = async (timeoutMs = 3200) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(`${NOTE_SERVER_URL}/note-app-status`, { cache: 'no-store' }, 700);
      const payload = await response.json() as { readyAt?: string | null };
      const readyAt = typeof payload.readyAt === 'string' ? new Date(payload.readyAt).getTime() : Number.NaN;
      if (response.ok && Number.isFinite(readyAt) && Date.now() - readyAt < 5000) {
        return true;
      }
    } catch {
      // Keep waiting briefly for the Electron renderer heartbeat.
    }
    await wait(160);
  }
  return false;
};

export const openNoteCaptureAppSilently = async () => {
  if (window.kaoyanDesktop?.openNoteApp) {
    try {
      await window.kaoyanDesktop.openNoteApp();
      return true;
    } catch {
      // Continue to the local launch bridge.
    }
  }

  try {
    const response = await fetchWithTimeout(`${NOTE_SERVER_URL}/open-note-app`, { method: 'POST' }, 2500);
    return response.ok;
  } catch {
    return false;
  }
};

export const openNoteCaptureApp = async () => {
  if (window.kaoyanDesktop?.openNoteApp) {
    try {
      await window.kaoyanDesktop.openNoteApp();
      return;
    } catch {
      // Continue to the local launch bridge when an older desktop process is running.
    }
  }

  try {
    const response = await fetchWithTimeout(`${NOTE_SERVER_URL}/open-note-app`, { method: 'POST' }, 2500);
    if (response.ok && await waitForNativeNoteApp()) {
      return;
    }
  } catch {
    // Report a real launch failure below. Never substitute a browser popup.
  }

  window.alert('Electron 笔记小 App 启动失败。请重新运行“一键启动考研桌面助手”后再试。');
};

export const closeNoteCaptureApp = async () => {
  if (window.kaoyanDesktop?.closeNoteApp) {
    try {
      await window.kaoyanDesktop.closeNoteApp();
      return true;
    } catch {
      // Continue to the local control bridge when the desktop IPC is unavailable.
    }
  }

  try {
    const response = await fetchWithTimeout(`${NOTE_SERVER_URL}/close-note-app`, { method: 'POST' }, 2500);
    return response.ok;
  } catch {
    return false;
  }
};

export function NoteDock() {
  return (
    <section
      className="note-dock note-dock-launcher"
      onClick={() => void openNoteCaptureApp()}
      tabIndex={0}
      aria-label="打开笔记台"
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void openNoteCaptureApp();
        }
      }}
    >
      <div className="note-dock-main">
        <span className="note-dock-icon"><Clipboard size={16} aria-hidden="true" /></span>
        <div>
          <p>笔记小 App</p>
          <span>点击打开桌面拖图窗</span>
        </div>
      </div>
      <button
        className="note-canvas-button"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void openNoteCaptureApp();
        }}
        title="打开笔记台"
      >
        <ExternalLink size={15} aria-hidden="true" />
      </button>
    </section>
  );
}
