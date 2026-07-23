import { HttpError } from './http.js';
import { findNote, getLearningSnapshot, patchNote } from './learning.js';
import { assertRepoPath, readFile } from './github-store.js';
import { getTaskSettings } from './ai-config.js';

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

function normalizeBox(object, imageWidth, imageHeight, settings) {
  const values = rawBox(object);
  if (!values || values.some((value) => value === null)) return null;
  const [left, top, right, bottom] = values;
  const scale = coordinateScale(values, imageWidth, imageHeight);
  const x1 = Math.max(0, Math.min(1, left / scale.x));
  const y1 = Math.max(0, Math.min(1, top / scale.y));
  const x2 = Math.max(0, Math.min(1, right / scale.x));
  const y2 = Math.max(0, Math.min(1, bottom / scale.y));
  const minimum = Math.max(0.01, Number(settings.options.minimumRegionPercent || 3.5) / 100);
  if (x2 - x1 < minimum || y2 - y1 < minimum) return null;
  const configuredPadding = Math.max(0, Math.min(0.08, Number(settings.options.edgePaddingPercent || 1.2) / 100));
  const padX = Math.min(configuredPadding, (x2 - x1) * 0.08);
  const padY = Math.min(configuredPadding, (y2 - y1) * 0.08);
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

function normalizeRegions(result, width, height, settings) {
  const candidates = Array.isArray(result?.objects)
    ? result.objects
    : Array.isArray(result?.result?.objects) ? result.result.objects
      : Array.isArray(result?.detections) ? result.detections : [];
  const regions = candidates
    .map((object) => normalizeBox(object, width, height, settings))
    .filter(Boolean)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const unique = [];
  for (const region of regions) {
    if (!unique.some((existing) => overlap(existing, region) > 0.82)) unique.push(region);
  }
  return unique.slice(0, settings.options.maxQuestions || 24);
}

function splittingTarget(settings) {
  const parts = ['a complete exam question or exercise problem block'];
  if (settings.options.includeQuestionNumber !== false) parts.push('its question number');
  if (settings.options.includeOptions !== false) parts.push('all answer choices');
  if (settings.options.includeDiagram !== false) parts.push('all related formulas and diagrams');
  return [
    parts.join(', including '),
    'Do not split one question into multiple objects. Do not merge adjacent independent questions.',
    settings.customInstructions || '',
  ].filter(Boolean).join('. ');
}

export async function detectQuestions(env, payload) {
  const image = decodeImageDataUrl(payload?.imageDataUrl);
  const width = Math.max(0, Number(payload?.imageWidth) || 0);
  const height = Math.max(0, Number(payload?.imageHeight) || 0);
  const settings = await getTaskSettings(env, 'question_splitting');
  if (settings.enabled === false) throw new HttpError(403, '多题识别任务已在配置中心停用。', 'AI_TASK_DISABLED');
  let result;
  try {
    result = await requireAi(env).run(MODEL, {
      task: 'detect',
      image,
      target: splittingTarget(settings),
      max_objects: settings.options.maxQuestions || 24,
      stream: false,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'question_detection_failed', error: error instanceof Error ? error.message : String(error) }));
    throw new HttpError(502, 'AI 多题识别失败，请重试或改用单题裁剪。', 'AI_QUESTION_DETECTION_FAILED');
  }
  const regions = normalizeRegions(result, width, height, settings);
  if (regions.length === 0) {
    throw new HttpError(422, '没有识别到完整题目，请调整预裁剪范围或改用单题模式。', 'NO_QUESTIONS_DETECTED');
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

function cleanTitle(value, maxLength) {
  return String(value || '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^(?:标题|题目名称)\s*[:：]\s*/u, '')
    .replace(/^[“”"'「」『』]+|[“”"'「」『』]+$/gu, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[<>:"/\\|?*]/g, '')
    .trim()
    .slice(0, maxLength);
}

function titleProblem(title, settings) {
  if (!title) return '标题为空';
  const chinese = title.match(/[\u3400-\u9fff]/gu)?.length || 0;
  const letters = title.match(/[A-Za-z]/g)?.length || 0;
  if (chinese < 2 || (letters > 10 && letters > chinese * 1.5)) return '标题必须以中文为主，不能输出英文句子';
  if (settings.options.rejectGenericTitle !== false && /^(?:待识别|无法识别|未知(?:内容)?|未命名(?:内容)?|图片笔记|截图|题目|练习|exercise|question|image)(?:笔记)?$/iu.test(title)) {
    return '标题过于空泛';
  }
  return '';
}

function namingRulesText(settings) {
  const rules = settings.namingRules.filter((rule) => rule.enabled !== false);
  if (rules.length === 0) return '无';
  return JSON.stringify(rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    when: rule.when,
    extract: rule.extract,
    titleTemplate: rule.titleTemplate,
    validationHint: rule.validationHint,
  })));
}

function namingQuestion(settings, remark, repairReason = '') {
  const style = {
    knowledge_point: '优先使用核心知识点或概念',
    question_type: '优先体现题型和考查动作',
    source_wording: '优先贴近题目原文的准确措辞',
  }[settings.options.titleStyle] || '优先使用核心知识点或概念';
  return [
    '你是考研学习笔记命名助手。请阅读图片中的完整题目，为它生成便于检索的中文标题。',
    `标题长度 ${settings.options.titleMinLength} 到 ${settings.options.titleMaxLength} 个字符，${style}。`,
    '必须以中文为主；数学符号和 CPU、TCP、Taylor 等必要术语可以保留，但禁止输出整句英文。',
    '不要加序号、引号、解释、日期、文件后缀或换行。',
    '禁止使用“图片笔记、截图、题目、练习、待识别、无法识别”等空泛标题。',
    settings.options.useRemark === false ? '不要使用用户备注。' : `用户最新备注：${remark || '无'}`,
    `字段命名规则：${namingRulesText(settings)}`,
    settings.customInstructions ? `用户在 AI 配置中心设置的附加规则：${settings.customInstructions}` : '',
    repairReason ? `上一版标题未通过程序校验：${repairReason}。请重新生成。` : '',
    '只返回最终标题，不要解释。',
  ].filter(Boolean).join('\n');
}

async function queryTitle(env, image, settings, remark, repairReason = '') {
  const result = await requireAi(env).run(MODEL, {
    task: 'query',
    image,
    question: namingQuestion(settings, remark, repairReason),
    stream: false,
  });
  const title = cleanTitle(extractAnswer(result), settings.options.titleMaxLength || 22);
  return { title, problem: titleProblem(title, settings) };
}

export async function renameNoteWithAi(env, noteUid, options = {}) {
  const initialSnapshot = await getLearningSnapshot(env);
  const initialEntry = findNote(initialSnapshot, noteUid);
  if (!initialEntry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
  if (initialEntry.note.sourceType !== 'ai-multi-question') {
    throw new HttpError(403, 'Only AI multi-question notes can use this rename action.', 'AI_RENAME_NOT_ALLOWED');
  }
  const settings = await getTaskSettings(env, 'note_naming');
  if (settings.enabled === false) throw new HttpError(403, '笔记命名任务已在配置中心停用。', 'AI_TASK_DISABLED');

  const repoPath = noteAssetPath(initialEntry.note.filePath);
  const file = await readFile(env, repoPath, { maxBytes: MAX_IMAGE_BYTES });
  const extension = repoPath.split('.').at(-1)?.toLowerCase() || 'jpg';
  const mime = MIME_BY_EXTENSION[extension] || 'image/jpeg';
  const image = `data:${mime};base64,${bytesToBase64(file.bytes)}`;
  const latestBeforeRequest = findNote(await getLearningSnapshot(env), noteUid)?.note || initialEntry.note;
  const remark = String(latestBeforeRequest.remark || '').trim().slice(0, 1800);

  let generated;
  try {
    generated = await queryTitle(env, image, settings, remark);
    if (generated.problem) generated = await queryTitle(env, image, settings, remark, generated.problem);
  } catch (error) {
    console.error(JSON.stringify({ event: 'note_ai_rename_failed', noteUid, error: error instanceof Error ? error.message : String(error) }));
    throw new HttpError(502, 'AI 自动命名失败，请稍后重试。', 'AI_RENAME_FAILED');
  }
  if (generated.problem) throw new HttpError(502, `AI 标题未通过校验：${generated.problem}`, 'AI_RENAME_INVALID');

  const latestSnapshot = await getLearningSnapshot(env);
  const latestEntry = findNote(latestSnapshot, noteUid);
  if (!latestEntry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
  const baselineTitle = typeof options.baselineTitle === 'string' ? options.baselineTitle : initialEntry.note.title;
  if (latestEntry.note.title !== baselineTitle && (latestEntry.note.userEditedFields || []).includes('title')) {
    return {
      applied: false,
      reason: '你已经手动修改标题，AI 结果未覆盖',
      title: latestEntry.note.title,
      snapshot: latestSnapshot,
    };
  }
  const snapshot = await patchNote(env, noteUid, { patch: { title: generated.title } });
  return { applied: true, title: generated.title, snapshot };
}
