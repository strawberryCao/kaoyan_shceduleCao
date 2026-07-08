export type NoteKind = 'single' | 'canvas';

export interface SaveNotePayload {
  imageDataUrl: string;
  kind: NoteKind;
  remark?: string;
  subject?: string;
}

export interface SaveNoteResult {
  ok: boolean;
  filePath?: string;
  error?: string;
}

export const NOTE_SERVER_URL = 'http://127.0.0.1:5174';

export const fileToDataUrl = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
};

export const saveNoteImage = async (payload: SaveNotePayload): Promise<SaveNoteResult> => {
  const response = await fetch(`${NOTE_SERVER_URL}/save-note`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      subject: '默认文件夹',
      remark: '',
      ...payload,
    }),
  });

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
