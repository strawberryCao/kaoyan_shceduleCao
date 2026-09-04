import { runLocalAgentTask } from './agent-provider.js';
import { getTaskSettings } from './ai-config.js';
import { HttpError } from './http.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const WORKERS_AI_VISION_MODEL = '@cf/moondream/moondream3.1-9B-A2B';

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
  const source = object.bbox ?? object.box ?? object.box_2d ?? object.boundingBox ?? object.bounding_box ?? object;
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

function normalizedBounds(values, imageWidth, imageHeight) {
  const [left, top, right, bottom] = values;
  const scale = coordinateScale(values, imageWidth, imageHeight);
  const x1 = Math.max(0, Math.min(1, left / scale.x));
  const y1 = Math.max(0, Math.min(1, top / scale.y));
  const x2 = Math.max(0, Math.min(1, right / scale.x));
  const y2 = Math.max(0, Math.min(1, bottom / scale.y));
  return { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1 };
}

function normalizeBox(object, imageWidth, imageHeight, settings) {
  const values = rawBox(object);
  if (!values || values.some((value) => value === null)) return null;
  const arraySource = object.bbox ?? object.box ?? object.box_2d ?? object.boundingBox ?? object.bounding_box;
  const direct = normalizedBounds(values, imageWidth, imageHeight);
  const transposed = Array.isArray(arraySource)
    ? normalizedBounds([values[1], values[0], values[3], values[2]], imageWidth, imageHeight)
    : null;
  const useTransposed = Boolean(transposed) && (
    Array.isArray(object.box_2d)
    || (direct.width < direct.height * 0.65 && transposed.width > transposed.height * 1.5)
  );
  const { x1, y1, x2, y2 } = useTransposed ? transposed : direct;
  const minimum = Math.max(0.01, Number(settings.options.minimumRegionPercent ?? 3.5) / 100);
  if (x2 <= x1 || y2 <= y1 || x2 - x1 < minimum || y2 - y1 < minimum) return null;
  const configuredPadding = Math.max(0, Math.min(0.08, Number(settings.options.edgePaddingPercent ?? 1.2) / 100));
  const padX = Math.min(configuredPadding, (x2 - x1) * 0.08);
  const padY = Math.min(configuredPadding, (y2 - y1) * 0.08);
  const paddedX1 = Math.max(0, x1 - padX);
  const paddedY1 = Math.max(0, y1 - padY);
  const confidenceValue = finite(object?.confidence ?? object?.score ?? object?.probability);
  return {
    x: paddedX1,
    y: paddedY1,
    width: Math.min(1, x2 + padX) - paddedX1,
    height: Math.min(1, y2 + padY) - paddedY1,
    confidence: confidenceValue === null ? 0.68 : Math.max(0, Math.min(1, confidenceValue)),
    completeQuestion: object?.completeQuestion !== false && object?.complete_question !== false,
    containsStem: object?.containsStem !== false && object?.contains_stem !== false,
    containsOptions: object?.containsOptions !== false && object?.contains_options !== false,
    containsRequiredDiagram: object?.containsRequiredDiagram !== false && object?.contains_required_diagram !== false,
    containsSolution: object?.containsSolution === true || object?.contains_solution === true,
    continuationOfPrevious: object?.continuationOfPrevious === true || object?.continuation_of_previous === true,
    questionKey: String(object?.questionKey ?? object?.question_key ?? object?.questionNumber ?? object?.question_number ?? object?.label ?? '').trim().slice(0, 80),
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

function horizontalCoverage(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  return width / Math.max(0.0001, Math.min(left.width, right.width));
}

function unionRegion(left, right) {
  const x1 = Math.min(left.x, right.x);
  const y1 = Math.min(left.y, right.y);
  const x2 = Math.max(left.x + left.width, right.x + right.width);
  const y2 = Math.max(left.y + left.height, right.y + right.height);
  return {
    ...left,
    x: x1, y: y1, width: x2 - x1, height: y2 - y1,
    confidence: Math.min(left.confidence, right.confidence),
    completeQuestion: left.completeQuestion !== false || right.completeQuestion !== false,
    containsStem: left.containsStem !== false || right.containsStem !== false,
    containsOptions: left.containsOptions !== false || right.containsOptions !== false,
    containsRequiredDiagram: left.containsRequiredDiagram !== false || right.containsRequiredDiagram !== false,
    containsSolution: left.containsSolution === true || right.containsSolution === true,
    continuationOfPrevious: false,
    questionKey: left.questionKey || right.questionKey || '',
  };
}

function shouldMergeQuestionFragments(previous, current) {
  const sameKey = Boolean(previous.questionKey && current.questionKey && previous.questionKey === current.questionKey);
  if (sameKey) return true;
  if (previous.questionKey && current.questionKey && previous.questionKey !== current.questionKey) return false;
  const gap = current.y - (previous.y + previous.height);
  const aligned = horizontalCoverage(previous, current) >= 0.58;
  const continuation = current.continuationOfPrevious === true
    || current.containsSolution === true
    || current.containsStem === false
    || current.completeQuestion === false;
  return continuation && aligned && gap >= -0.025 && gap <= 0.055;
}

function mergeQuestionFragments(candidates) {
  const merged = [];
  for (const candidate of candidates) {
    const previous = merged.at(-1);
    if (previous && shouldMergeQuestionFragments(previous, candidate)) merged[merged.length - 1] = unionRegion(previous, candidate);
    else merged.push(candidate);
  }
  return merged;
}

function evaluateRegion(region, settings) {
  const options = settings.options || {};
  const area = region.width * region.height;
  const aspectRatio = region.width / Math.max(region.height, 0.0001);
  const minConfidence = Math.max(0.35, Math.min(0.9, Number(options.minimumConfidence) || 0.56));
  const reasons = [];
  if (region.completeQuestion === false) reasons.push('模型判断不是完整独立题目');
  if (region.containsStem === false) reasons.push('缺少完整题干');
  if (region.confidence < minConfidence) reasons.push('置信度低于 ' + minConfidence.toFixed(2));
  if (area < 0.018) reasons.push('区域面积过小');
  if (aspectRatio > 9.5 || aspectRatio < 0.12) reasons.push('区域宽高比异常');
  if (region.y > 0.9 && region.height < 0.1) reasons.push('疑似页脚或页面底部残片');
  if (region.y < 0.015 && region.height < 0.07) reasons.push('疑似页眉残片');
  return { accepted: reasons.length === 0, reason: reasons.join('；'), area, aspectRatio };
}

function normalizeRegions(result, width, height, settings) {
  const rawCandidates = regionCandidates(result)
    .map((object) => normalizeBox(object, width, height, settings))
    .filter(Boolean)
    .sort((left, right) => left.y - right.y || left.x - right.x);
  const candidates = mergeQuestionFragments(rawCandidates);
  const unique = [];
  const rejected = [];
  for (const region of candidates) {
    const quality = evaluateRegion(region, settings);
    if (!quality.accepted) {
      rejected.push({ ...region, reason: quality.reason });
      continue;
    }
    if (unique.some((existing) => overlap(existing, region) > 0.82)) {
      rejected.push({ ...region, reason: '与已保留题目区域高度重叠' });
      continue;
    }
    unique.push(region);
  }
  const maxQuestions = Number(settings.options.maxQuestions) || 24;
  return {
    accepted: unique.slice(0, maxQuestions),
    rejected,
    candidateCount: rawCandidates.length,
  };
}

function fillTemplate(value, variables) {
  return String(value || '').replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) => String(variables[key] ?? ''));
}

function parseJsonText(value) {
  if (value && typeof value === 'object') return value;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const candidates = [raw];
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(raw);
  if (fenced) candidates.push(fenced[1].trim());
  const objectStart = raw.indexOf('{');
  const arrayStart = raw.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (starts.length > 0) {
    const start = Math.min(...starts);
    const closing = raw[start] === '{' ? '}' : ']';
    const end = raw.lastIndexOf(closing);
    if (end > start) candidates.push(raw.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
    } catch {}
  }
  return null;
}

async function runWorkersAiQuestionDetection(env, request) {
  if (!env.AI || typeof env.AI.run !== 'function') {
    throw new HttpError(503, 'Cloudflare Workers AI binding is unavailable.', 'WORKERS_AI_UNAVAILABLE');
  }
  const response = await env.AI.run(WORKERS_AI_VISION_MODEL, {
    task: 'query',
    image: request.image,
    question: request.prompt,
    reasoning: false,
    temperature: 0.1,
    max_tokens: request.maxTokens,
    stream: false,
  });
  const output = response?.answer ?? response?.response ?? response?.description ?? response;
  const json = parseJsonText(output);
  if (!json) {
    throw new HttpError(502, 'Cloudflare 视觉模型没有返回可解析的题目区域 JSON。', 'WORKERS_AI_JSON_INVALID');
  }
  return {
    provider: 'cloudflare-workers-ai',
    model: WORKERS_AI_VISION_MODEL,
    text: typeof output === 'string' ? output : JSON.stringify(output),
    json,
    usage: response?.metrics || response?.usage || null,
    configurationHash: request.settings.configurationHash,
    workflowHash: request.settings.workflowHash,
    attempts: [{ provider: 'cloudflare-workers-ai', model: WORKERS_AI_VISION_MODEL, outcome: 'success', retry: 0 }],
  };
}

async function requestQuestionDetection(env, request) {
  try {
    return await runLocalAgentTask(env, 'question_splitting', request);
  } catch (externalError) {
    if (!env.AI || typeof env.AI.run !== 'function') throw externalError;
    try {
      const fallback = await runWorkersAiQuestionDetection(env, {
        image: request.imageDataUrl,
        prompt: request.messages[0].content[0].text,
        maxTokens: request.maxTokens,
        settings: request.settings,
      });
      console.log(JSON.stringify({
        event: 'capture.question_detection.fallback_success',
        externalCode: externalError?.code || 'AI_PROVIDER_ERROR',
        provider: fallback.provider,
        model: fallback.model,
      }));
      return fallback;
    } catch (workersAiError) {
      console.error(JSON.stringify({
        event: 'capture.question_detection.fallback_failed',
        externalCode: externalError?.code || 'AI_PROVIDER_ERROR',
        workersAiCode: workersAiError?.code || 'WORKERS_AI_ERROR',
        message: workersAiError instanceof Error ? workersAiError.message.slice(0, 500) : String(workersAiError).slice(0, 500),
      }));
      throw new HttpError(
        502,
        `公网 AI 题目识别失败：${workersAiError instanceof Error ? workersAiError.message : String(workersAiError)}`,
        'QUESTION_DETECTION_PROVIDERS_FAILED',
        {
          externalCode: externalError?.code || 'AI_PROVIDER_ERROR',
          workersAiCode: workersAiError?.code || 'WORKERS_AI_ERROR',
          retryable: true,
        },
      );
    }
  }
}

function splittingPrompt(settings, width, height) {
  const workflow = settings.workflow;
  if (!workflow?.prompt?.instructions?.length || !workflow.prompt.outputFormat) {
    throw new HttpError(503, '局域网没有发布多题裁剪 Prompt 合同。', 'LOCAL_AGENT_WORKFLOW_MISSING');
  }
  const options = settings.options || {};
  const variables = {
    width: width || '未知',
    height: height || '未知',
    maxQuestions: Number(options.maxQuestions) || 24,
    questionNumberRule: options.includeQuestionNumber !== false ? '必须包含题号或题目标识。' : '',
    optionsRule: options.includeOptions !== false ? '选择题必须包含全部选项。' : '',
    diagramRule: options.includeDiagram !== false ? '必须包含与题干相关的公式、表格和配图。' : '',
  };
  return [
    ...workflow.prompt.instructions.map((line) => fillTemplate(line, variables)).filter(Boolean),
    '最高优先级分组规则：同一题号或例号的题干、分析、解答、答案、公式和续接内容必须合成一个区域；从题号开始，到下一题号开始之前结束。',
    '禁止把“分析”“解”“答案”或同一例题的下半部分单独输出成另一道题。每个区域返回稳定 questionKey；续接片段设置 continuationOfPrevious=true，解答区域设置 containsSolution=true。',
    fillTemplate(workflow.prompt.outputFormat, variables),
    settings.customInstructions ? '局域网配置中心附加规则：' + settings.customInstructions : '',
  ].filter(Boolean).join('\n');
}

export async function detectQuestions(env, payload, context = {}) {
  const image = decodeImageDataUrl(payload?.imageDataUrl);
  const width = Math.max(0, Number(payload?.imageWidth) || 0);
  const height = Math.max(0, Number(payload?.imageHeight) || 0);
  // Background Workflows already load and audit this task configuration.
  // Reusing it avoids another GitHub-backed runtime read and guarantees the
  // prompt and saved processing hashes describe the same configuration.
  const settings = context.settings || await getTaskSettings(env, 'question_splitting');
  const response = await requestQuestionDetection(env, {
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
    maxTokens: Math.min(1200, Math.max(500, Number(settings.options.maxTokens) || 900)),
    requiredCapabilities: ['vision', 'json'],
    settings,
    validateJson(json, candidate) {
      const candidateRegions = normalizeRegions(json, width, height, settings);
      if (candidateRegions.accepted.length > 0) return;
      const firstReason = candidateRegions.rejected[0]?.reason || '';
      throw new HttpError(
        422,
        `视觉模型 ${candidate.provider}/${candidate.model} 没有返回可用题目区域${firstReason ? `：${firstReason}` : ''}`,
        'AI_NO_VALID_QUESTION_REGIONS',
        {
          retryable: false,
          provider: candidate.provider,
          model: candidate.model,
          candidateCount: candidateRegions.candidateCount,
          rejectedCount: candidateRegions.rejected.length,
        },
      );
    },
  });
  const normalized = normalizeRegions(response.json, width, height, settings);
  if (normalized.accepted.length === 0) {
    const detail = normalized.rejected[0]?.reason ? '：' + normalized.rejected[0].reason : '';
    throw new HttpError(422, '没有识别到完整题目' + detail + '，请调整预裁剪范围或改用单题模式。', 'NO_QUESTIONS_DETECTED');
  }
  return {
    ok: true,
    provider: response.provider,
    model: response.model,
    configurationHash: response.configurationHash,
    workflowHash: response.workflowHash,
    regions: normalized.accepted,
    rejectedRegions: normalized.rejected,
    quality: {
      candidateCount: normalized.candidateCount,
      acceptedCount: normalized.accepted.length,
      rejectedCount: normalized.rejected.length,
    },
  };
}

export const questionDetectionInternals = Object.freeze({
  evaluateRegion,
  mergeQuestionFragments,
  normalizeRegions,
  parseJsonText,
  runWorkersAiQuestionDetection,
  splittingPrompt,
});
