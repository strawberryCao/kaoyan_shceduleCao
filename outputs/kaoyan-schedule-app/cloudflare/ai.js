import { runLocalAgentTask } from './agent-provider.js';
import { getTaskSettings } from './ai-config.js';
import { HttpError } from './http.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

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
  const source = object.bbox ?? object.box ?? object.boundingBox ?? object.bounding_box ?? object;
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
  const minimum = Math.max(0.01, Number(settings.options.minimumRegionPercent ?? 3.5) / 100);
  if (x2 <= x1 || y2 <= y1 || x2 - x1 < minimum || y2 - y1 < minimum) return null;
  const configuredPadding = Math.max(0, Math.min(0.08, Number(settings.options.edgePaddingPercent ?? 1.2) / 100));
  const padX = Math.min(configuredPadding, (x2 - x1) * 0.08);
  const padY = Math.min(configuredPadding, (y2 - y1) * 0.08);
  const paddedX1 = Math.max(0, x1 - padX);
  const paddedY1 = Math.max(0, y1 - padY);
  return {
    x: paddedX1,
    y: paddedY1,
    width: Math.min(1, x2 + padX) - paddedX1,
    height: Math.min(1, y2 + padY) - paddedY1,
  };
}

function overlap(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = width * height;
  const smaller = Math.min(left.width * left.height, right.width * right.height);
  return smaller > 0 ? intersection / smaller : 0;
}

function regionCandidates(result) {
  if (Array.isArray(result)) return result;
  for (const key of ['regions', 'questions', 'objects', 'detections', 'boxes']) {
    if (Array.isArray(result?.[key])) return result[key];
  }
  return [];
}

function normalizeRegions(result, width, height, settings) {
  const regions = regionCandidates(result)
    .map((object) => normalizeBox(object, width, height, settings))
    .filter(Boolean)
    .sort((left, right) => left.y - right.y || left.x - right.x);
  const unique = [];
  for (const region of regions) {
    if (!unique.some((existing) => overlap(existing, region) > 0.82)) unique.push(region);
  }
  return unique.slice(0, Number(settings.options.maxQuestions) || 24);
}

function splittingPrompt(settings, width, height) {
  const requirements = [
    settings.options.includeQuestionNumber !== false ? '必须包含题号或题目标识' : '',
    settings.options.includeOptions !== false ? '选择题必须包含全部选项' : '',
    settings.options.includeDiagram !== false ? '必须包含与题干相关的公式、表格和配图' : '',
  ].filter(Boolean);
  return [
    '你是考研题目区域识别器。请在用户已经预裁剪的整页图片中找出每一道完整且相互独立的题目。',
    '不要把同一道题拆成多个区域；不要把相邻的不同题目合并。',
    ...requirements,
    `原图尺寸：${width || '未知'}×${height || '未知'}。`,
    '只返回 JSON 对象，格式为：{"regions":[{"x":0.0,"y":0.0,"width":0.5,"height":0.3}]}。',
    'x、y、width、height 使用 0 到 1 的归一化坐标；x、y 是左上角。按从上到下、同一行从左到右排序。',
    `最多返回 ${Number(settings.options.maxQuestions) || 24} 个区域。没有可靠区域时返回 {"regions":[]}。`,
    settings.customInstructions ? `局域网配置中心附加规则：${settings.customInstructions}` : '',
  ].filter(Boolean).join('\n');
}

export async function detectQuestions(env, payload) {
  const image = decodeImageDataUrl(payload?.imageDataUrl);
  const width = Math.max(0, Number(payload?.imageWidth) || 0);
  const height = Math.max(0, Number(payload?.imageHeight) || 0);
  const settings = await getTaskSettings(env, 'question_splitting');
  const response = await runLocalAgentTask(env, 'question_splitting', {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: splittingPrompt(settings, width, height) },
        { type: 'image_url', image_url: { url: image } },
      ],
    }],
    imageDataUrl: image,
    json: true,
    temperature: Number(settings.temperature) || 0.1,
    maxTokens: Number(settings.options.maxTokens) || 1600,
    requiredCapabilities: ['vision', 'json'],
  });
  const regions = normalizeRegions(response.json, width, height, settings);
  if (regions.length === 0) {
    throw new HttpError(422, '没有识别到完整题目，请调整预裁剪范围或改用单题模式。', 'NO_QUESTIONS_DETECTED');
  }
  return {
    ok: true,
    provider: response.provider,
    model: response.model,
    configurationHash: response.configurationHash,
    workflowHash: response.workflowHash,
    regions,
  };
}

export const questionDetectionInternals = Object.freeze({ normalizeRegions, splittingPrompt });
