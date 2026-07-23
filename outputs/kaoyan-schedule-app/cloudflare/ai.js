import { HttpError } from './http.js';
import { findNote, getLearningSnapshot, patchNote } from './learning.js';
import { assertRepoPath, readFile } from './github-store.js';

const MODEL = '@cf/moondream/moondream3.1-9B-A2B';
const ASSET_ROOT = 'data/assets/';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

function requireAi(env) {
  if (!env.AI || typeof env.AI.run !== 'function') {
    throw new HttpError(503, 'AI 图片识别服务尚未配置。', 'AI_NOT_CONFIGURED');
  }
  return env.AI;
}

function decodeImageDataUrl(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'imageDataUrl is required.', 'INVALID_AI_IMAGE');
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  if (!match) throw new HttpError(400, 'imageDataUrl must contain a base64 image.', 'INVALID_AI_IMAGE');
  const length = Math.floor(match[2].replace(/[\r\n]/g, '').length * 0.75);
  if (length > MAX_IMAGE_BYTES) throw new HttpError(413, '图片过大，请先裁剪或降低分辨率。', 'PAYLOAD_TOO_LARGE');
  return value;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rawBox(object) {
  if (!object || typeof object !== 'object') return null;
  const source = object.bbox ?? object.box ?? object.bounding_box ?? object;
  if (Array.isArray(source) && source.length >= 4) return source.slice(0, 4).map(finite);
  if (!source || typeof source !== 'object') return null;
  const left = finite(source.x_min ?? source.xmin ?? source.x1 ?? source.left ?? source.x);
  const top = finite(source.y_min ?? source.ymin ?? source.y1 ?? source.top ?? source.y);
  let right = finite(source.x_max ?? source.xmax ?? source.x2 ?? source.right);
  let bottom = finite(source.y_max ?? source.ymax ?? source.y2 ?? source.bottom);
  const width = finite(source.width ?? source.w);
  const height = finite(source.height ?? source.h);
  if (right === null && left !== null && width !== null) right = left + width;
  if (bottom === null && top !== null && height !== null) bottom = top + height;
  return [left, top, right, bottom];
}

function coordinateScale(values, imageWidth, imageHeight) {
  const max = Math.max(...values.map((value) => Math.abs(value ?? 0)));
  if (max <= 1.5) return { x: 1, y: 1 };
  if (max <= 100) return { x: 100, y: 100 };
  if (max <= 1000) return { x: 1000, y: 1000 };
  if (imageWidth > 0 && imageHeight > 0) return { x: imageWidth, y: imageHeight };
  return { x: max, y: max };
}

function normalizeBox(object, imageWidth, imageHeight) {
  const values = rawBox(object);
  if (!values || values.some((value) => value === null)) return null;
  const [left, top, right, bottom] = values;
  const scale = coordinateScale(values, imageWidth, imageHeight);
  const x1 = Math.max(0, Math.min(1, left / scale.x));
  const y1 = Math.max(0, Math.min(1, top / scale.y));
  const x2 = Math.max(0, Math.min(1, right / scale.x));
  const y2 = Math.max(0, Math.min(1, bottom / scale.y));
  if (x2 - x1 < 0.04 || y2 - y1 < 0.035) return null;
  const padX = Math.min(0.012, (x2 - x1) * 0.05);
  const padY = Math.min(0.012, (y2 - y1) * 0.05);
  return {
    x: Math.max(0, x1 - padX),
    y: Math.max(0, y1 - padY),
    width: Math.min(1, x2 + padX) - Math.max(0, x1 - padX),
    height: Math.min(1, y2 + padY) - Math.max(0, y1 - padY),
  };
}

function overlap(left, right) {
  const x = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const y = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = x * y;
  const smaller = Math.min(left.width * left.height, right.width * right.height);
  return smaller > 0 ? intersection / smaller : 0;
}

function normalizeRegions(result, width, height) {
  const candidates = Array.isArray(result?.objects)
    ? result.objects
    : Array.isArray(result?.result?.objects) ? result.result.objects
      : Array.isArray(result?.detections) ? result.detections : [];
  const regions = candidates
    .map((object) => normalizeBox(object, width, height))
    .filter(Boolean)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const unique = [];
  for (const region of regions) {
    if (!unique.some((existing) => overlap(existing, region) > 0.82)) unique.push(region);
  }
  return unique.slice(0, 24);
}

export async function detectQuestions(env, payload) {
  const image = decodeImageDataUrl(payload?.imageDataUrl);
  const width = Math.max(0, Number(payload?.imageWidth) || 0);
  const height = Math.max(0, Number(payload?.imageHeight) || 0);
  let result;
  try {
    result = await requireAi(env).run(MODEL, {
      task: 'detect',
      image,
      target: 'a complete exam question or exercise problem block, including its question number, formulas, diagram and answer choices',
      max_objects: 24,
      stream: false,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'question_detection_failed', error: error instanceof Error ? error.message : String(error) }));
    throw new HttpError(502, 'AI 多题识别失败，请重试或改用单题裁剪。', 'AI_QUESTION_DETECTION_FAILED');
  }
  const regions = normalizeRegions(result, width, height);
  if (regions.length === 0) {
    throw new HttpError(422, '没有识别到完整题目，请调整拍摄角度或改用单题裁剪。', 'NO_QUESTIONS_DETECTED');
  }
  return { ok: true, model: MODEL, regions };
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

function noteAssetPath(value) {
  const normalized = typeof value === 'string' ? value.trim().replaceAll('\\', '/') : '';
  if (!normalized.startsWith('github://')) throw new HttpError(422, '这条笔记没有可供 AI 识别的云端原图。', 'NOTE_IMAGE_UNAVAILABLE');
  return assertRepoPath(normalized.slice('github://'.length), ASSET_ROOT);
}

function extractAnswer(result) {
  const values = [result?.answer, result?.response, result?.text, result?.description, result?.result?.answer, result?.result?.text];
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^(?:标题|题目名称)\s*[:：]\s*/u, '')
    .replace(/^[“”"'「」『』]+|[“”"'「」『』]+$/gu, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export async function renameNoteWithAi(env, noteUid) {
  const snapshot = await getLearningSnapshot(env);
  const entry = findNote(snapshot, noteUid);
  if (!entry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
  const repoPath = noteAssetPath(entry.note.filePath);
  const file = await readFile(env, repoPath, { maxBytes: MAX_IMAGE_BYTES });
  const extension = repoPath.split('.').at(-1)?.toLowerCase() || 'jpg';
  const mime = MIME_BY_EXTENSION[extension] || 'image/jpeg';
  const image = `data:${mime};base64,${bytesToBase64(file.bytes)}`;
  const remark = String(entry.note.remark || '').trim().slice(0, 1800);
  let result;
  try {
    result = await requireAi(env).run(MODEL, {
      task: 'query',
      image,
      question: `请为图片中的考研题目生成一个准确、便于检索的中文标题。结合用户备注，但不要照抄无关内容。标题应概括核心知识点或题型，12到30个汉字，不要引号、序号、解释或换行。用户备注：${remark || '无'}`,
      stream: false,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'note_ai_rename_failed', noteUid, error: error instanceof Error ? error.message : String(error) }));
    throw new HttpError(502, 'AI 自动命名失败，请稍后重试。', 'AI_RENAME_FAILED');
  }
  const title = cleanTitle(extractAnswer(result));
  if (!title) throw new HttpError(502, 'AI 没有返回可用标题，请稍后重试。', 'AI_RENAME_EMPTY');
  return patchNote(env, noteUid, { patch: { title } });
}
