export type NoteKind = 'single' | 'canvas';

export interface SaveNotePayload {
  imageDataUrl: string;
  kind: NoteKind;
  noteUid?: string;
  remark?: string;
  subject?: string;
  canvasProjectId?: string;
}

export interface SaveNoteResult {
  ok: boolean;
  noteUid?: string;
  filePath?: string;
  fileName?: string;
  metadata?: {
    noteUid?: string;
    learning?: {
      tags?: string[];
      noteType?: string;
    };
  };
  learningSyncError?: string | null;
  aiStatus?: 'pending' | 'complete' | 'failed';
  provisional?: boolean;
  idempotentReplay?: boolean;
  error?: string;
}

export const NOTE_SERVER_URL = 'http://127.0.0.1:5174';
const NOTE_SAVE_TIMEOUT_MS = 15_000;

export const createNoteUid = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
};

export const fileToDataUrl = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
};

export const saveNoteImage = async (payload: SaveNotePayload): Promise<SaveNoteResult> => {
  // A caller owns one operation id and reuses it only when retrying that same
  // operation. Independent saves, even with identical image content, must not
  // be collapsed into one note.
  const noteUid = payload.noteUid || createNoteUid();
  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(new DOMException('本地保存等待超时', 'TimeoutError')),
    NOTE_SAVE_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(`${NOTE_SERVER_URL}/save-note`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        subject: '默认文件夹',
        remark: '',
        ...payload,
        noteUid,
      }),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('本地保存暂未确认；可以再次点击保存，系统不会重复创建笔记');
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }

  const result = (await response.json()) as SaveNoteResult;
  if (!response.ok || !result.ok) {
    throw new Error(result.error || '保存失败');
  }
  return result;
};

export const loadImage = (src: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = src;
  });
};
