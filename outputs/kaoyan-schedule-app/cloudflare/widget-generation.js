import { runLocalAgentTask } from './agent-provider.js';
import { getTaskSettings } from './ai-config.js';
import { HttpError, sha256 } from './http.js';

function clamp(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

function validateArtifact({ html, css, js }) {
  const failures = [];
  if (/<\/?(?:script|style|iframe|object|embed|link|meta|base|form)\b/i.test(html)) failures.push('HTML contains a blocked tag');
  if (/\son[a-z]+\s*=/i.test(html)) failures.push('HTML contains an inline event handler');
  if (/\s(?:href|src|srcset|xlink:href|action|formaction|poster|ping)\s*=/i.test(html)) failures.push('HTML contains a navigation or resource URL attribute');
  if (/@import\b|url\(\s*(["']?)\s*(?:https?:|\/\/|javascript:)/i.test(css)) failures.push('CSS contains an external resource');
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|postMessage|window|globalThis|self|location|open|parent|top|opener|frames|defaultView|eval|constructor)\b|\b(?:href|src|srcset|xlinkHref|action|formAction|poster|ping)\b|\bdocument\s*\.\s*(?:cookie|URL|documentURI)\b/i.test(js) || /\bFunction\s*\(/.test(js)) failures.push('JavaScript contains a network, storage, or cross-page API');
  if (failures.length) throw new HttpError(422, `Generated HTML failed offline validation: ${failures.join('; ')}`, 'AI_HTML_VALIDATION_FAILED');
}

export async function generateHtmlWidget(env, payload = {}) {
  const taskId = payload.taskId === 'interactive_note_generation'
    ? 'interactive_note_generation'
    : 'widget_generation';
  const isInteractiveNote = taskId === 'interactive_note_generation';
  const userPrompt = String(payload.prompt || '').trim().slice(0, isInteractiveNote ? 15_000 : 1_200);
  if (userPrompt.length < 3) throw new HttpError(400, '请至少用一句话描述 HTML 笔记需求。', 'INVALID_AI_HTML_PROMPT');
  const settings = await getTaskSettings(env, taskId);
  const options = settings.options || {};
  const defaultWidth = clamp(options.defaultWidth, isInteractiveNote ? 520 : 360, 240, 720);
  const defaultHeight = clamp(options.defaultHeight, isInteractiveNote ? 360 : 260, 150, 620);
  const visualStyle = {
    light_clean: '学习中心一致的暖白底、棕色强调、克制阴影',
    dark_translucent: '深色半透明卡片',
    follow_request: '跟随本次需求描述',
  }[options.visualStyle] || '明亮简洁';
  const interaction = {
    static: '静态展示，不生成需要 JavaScript 的交互',
    standard: '只生成必要的常规交互，状态清晰且可以恢复',
    advanced: '可以生成较复杂的本地交互，但仍必须遵守离线安全限制',
  }[options.interactionLevel] || '只生成必要的常规交互，状态清晰且可以恢复';
  const density = {
    concise: '少文字、突出公式或操作，不重复速记正文',
    balanced: '保留必要说明、操作提示与结论',
    detailed: '提供完整步骤提示，但避免冗长段落',
  }[options.contentDensity] || '保留必要说明、操作提示与结论';
  const responsive = {
    adaptive: '同时适配手机与桌面，控件可换行且不得横向溢出',
    mobile_first: '优先窄屏触控',
    desktop_first: '优先桌面空间，但窄屏仍可操作',
  }[options.responsiveMode] || '同时适配手机与桌面';
  const prompt = [
    isInteractiveNote
      ? '你是“考研桌面助手”学习中心的离线 HTML 交互笔记创作器。只输出 JSON，不要 Markdown 或解释。'
      : '你是“考研桌面助手”的桌面组件生成器。只输出 JSON，不要 Markdown 或解释。',
    `JSON 格式：{"title":"标题","width":${defaultWidth},"height":${defaultHeight},"html":"...","css":"...","js":"..."}`,
    '只使用原生 HTML、CSS、JavaScript；HTML 不含 script/style 标签。',
    '禁止外部库、URL、字体、图片、网络请求、表单提交、跨页面通信、浏览器存储和父页面访问。',
    `所有交互只操作当前文档 DOM；交互要求：${interaction}；视觉风格：${visualStyle}；响应式要求：${responsive}。`,
    isInteractiveNote ? `内容密度：${density}。` : '',
    isInteractiveNote && options.requireResetControl !== false ? '只要有可变状态，就必须提供清晰的重置操作。' : '',
    options.allowJavaScript === false ? 'js 必须是空字符串。' : '可以使用安全的原生 JavaScript。',
    settings.customInstructions ? `用户长期规则：${String(settings.customInstructions).slice(0, 6_000)}` : '',
    `用户需求：${userPrompt}`,
  ].filter(Boolean).join('\n');
  const response = await runLocalAgentTask(env, taskId, {
    messages: [
      { role: 'system', content: '只返回符合指定结构的 JSON。' },
      { role: 'user', content: prompt },
    ],
    json: true,
    temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : isInteractiveNote ? 0.25 : 0.35,
    maxTokens: Number(options.maxTokens) || 5000,
    maxCandidateCount: isInteractiveNote ? 2 : undefined,
    overallTimeoutMs: isInteractiveNote ? 570_000 : undefined,
    requiredCapabilities: ['text', 'json'],
    validateJson(json) {
      const candidateHtml = String(json?.html || '').slice(0, 40_000);
      if (!candidateHtml.trim()) throw new HttpError(422, 'AI 返回的内容缺少 HTML。', 'AI_HTML_EMPTY');
      validateArtifact({
        html: candidateHtml,
        css: String(json?.css || '').slice(0, 30_000),
        js: options.allowJavaScript === false ? '' : String(json?.js || '').slice(0, 30_000),
      });
    },
  });
  const html = String(response.json?.html || '').slice(0, 40_000);
  const css = String(response.json?.css || '').slice(0, 30_000);
  const js = options.allowJavaScript === false ? '' : String(response.json?.js || '').slice(0, 30_000);
  if (!html.trim()) throw new HttpError(422, 'AI 返回的内容缺少 HTML。', 'AI_HTML_EMPTY');
  validateArtifact({ html, css, js });
  return {
    ok: true,
    provider: response.provider || '',
    model: response.model || '',
    attempts: Array.isArray(response.attempts) ? response.attempts : [],
    artifactHash: await sha256(JSON.stringify({ html, css, js })),
    validationProfile: 'offline-html-v1',
    widget: {
      title: String(response.json?.title || 'AI 交互笔记').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 30) || 'AI 交互笔记',
      width: clamp(response.json?.width, defaultWidth, 240, 720),
      height: clamp(response.json?.height, defaultHeight, 150, 620),
      html,
      css,
      js,
    },
  };
}

export const widgetGenerationInternals = Object.freeze({ validateArtifact });
