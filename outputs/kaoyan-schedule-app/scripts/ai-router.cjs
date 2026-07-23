const fs = require('fs');
const path = require('path');
const { loadQwenConfig } = require('./qwen-config.cjs');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CIRCUIT_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;

const PROVIDER_MODEL_CATALOG = Object.freeze({
  qwen: Object.freeze([
    'qwen3-vl-flash',
    'qwen3-vl-plus',
    'qwen3-vl-235b-a22b-instruct',
    'qwen3-vl-235b-a22b-thinking',
    'qwen-vl-plus',
    'qwen-vl-max',
    'qwen3-max',
    'qwen-plus',
    'qwen-turbo',
  ]),
  gemini: Object.freeze([
    'gemini-3.5-flash',
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ]),
  kimi: Object.freeze([
    'kimi-k3',
    'kimi-k2.6',
    'kimi-k2.5',
    'kimi-k2-thinking',
  ]),
});

const TASK_PROFILES = Object.freeze({
  note_naming: Object.freeze({ difficulty: 'low', capabilities: ['text', 'vision', 'json'] }),
  note_classification: Object.freeze({ difficulty: 'medium', capabilities: ['text', 'vision', 'json'] }),
  note_enrichment: Object.freeze({ difficulty: 'medium', capabilities: ['text', 'vision', 'json'] }),
  taxonomy: Object.freeze({ difficulty: 'high', capabilities: ['text', 'json', 'longContext'] }),
  flashcard_generation: Object.freeze({ difficulty: 'medium', capabilities: ['text', 'json'] }),
  widget_generation: Object.freeze({ difficulty: 'high', capabilities: ['text', 'json'] }),
  canvas_organization: Object.freeze({ difficulty: 'high', capabilities: ['text', 'vision', 'json'] }),
  custom: Object.freeze({ difficulty: 'medium', capabilities: ['text'] }),
});

const TASK_PARAMETER_DEFINITIONS = Object.freeze({
  note_naming: Object.freeze([
    Object.freeze({ id: 'titleStyle', group: '标题规则', type: 'select', label: '标题侧重点', description: '控制普通 AI 标题优先表达什么。字段命名规则匹配时仍以规则模板为准。', default: 'knowledge_point', options: [
      { value: 'knowledge_point', label: '知识点优先' },
      { value: 'question_type', label: '题型优先' },
      { value: 'source_wording', label: '贴近原文' },
    ] }),
    Object.freeze({ id: 'titleMinLength', group: '标题规则', type: 'number', label: '标题最少字数', description: '作为模型生成目标；内容本身很短时不会硬凑无意义文字。', default: 8, min: 4, max: 40, step: 1, unit: '字' }),
    Object.freeze({ id: 'titleMaxLength', group: '标题规则', type: 'number', label: '标题最多字数', description: '程序会在保存前强制截断，避免文件名过长。', default: 22, min: 6, max: 80, step: 1, unit: '字' }),
    Object.freeze({ id: 'useRemark', group: '识别依据', type: 'boolean', label: '结合用户备注', description: '开启后，备注会参与科目判断和标题生成。', default: true }),
    Object.freeze({ id: 'preferSpecificSubject', group: '识别依据', type: 'boolean', label: '优先具体科目', description: '内容可判断时尽量归入具体科目，确实无法判断才进入默认文件夹。', default: true }),
    Object.freeze({ id: 'rejectGenericTitle', group: '质量控制', type: 'boolean', label: '拒绝空泛标题', description: '阻止“待识别、图片笔记、截图”等无信息量标题落盘。', default: true }),
    Object.freeze({ id: 'maxTokens', group: '运行限制', type: 'number', label: '最大输出 Token', description: '命名只需要短输出，调高通常不会提升识别质量。', default: 900, min: 300, max: 2400, step: 100, unit: 'tokens' }),
  ]),
  note_enrichment: Object.freeze([
    Object.freeze({ id: 'summaryDetail', group: '整理深度', type: 'select', label: '摘要详细度', description: '决定摘要与分项说明的浓缩程度。', default: 'standard', options: [
      { value: 'concise', label: '精简' },
      { value: 'standard', label: '标准' },
      { value: 'detailed', label: '详细' },
    ] }),
    Object.freeze({ id: 'maxItems', group: '整理深度', type: 'number', label: '最多拆分条目', description: '一张画布或长笔记最多拆成多少个独立知识条目。', default: 12, min: 1, max: 12, step: 1, unit: '项' }),
    Object.freeze({ id: 'mistakePolicy', group: '分类规则', type: 'select', label: '错题认定方式', description: '“语义判断”允许结合图片与备注推断；“仅明确标记”只认用户标记。', default: 'semantic', options: [
      { value: 'semantic', label: '图片和备注语义判断' },
      { value: 'explicit_only', label: '仅用户明确标记' },
    ] }),
    Object.freeze({ id: 'goodQuestionPolicy', group: '分类规则', type: 'select', label: '好题认定方式', description: '默认只认用户明确标记，避免几乎所有题都进入好题。', default: 'explicit_only', options: [
      { value: 'explicit_only', label: '仅用户明确标记（推荐）' },
      { value: 'ai_high_value', label: '允许 AI 推荐高价值题' },
    ] }),
    Object.freeze({ id: 'memorizePolicy', group: '分类规则', type: 'select', label: '背诵认定方式', description: '决定 AI 能否依据定义、公式和易混点自动判断需要背诵。', default: 'semantic', options: [
      { value: 'semantic', label: '语义判断' },
      { value: 'explicit_only', label: '仅用户明确标记' },
    ] }),
    Object.freeze({ id: 'cardPolicy', group: '卡片质量', type: 'select', label: '卡片生成范围', description: '严格模式只为错题/背诵内容生成；扩展模式允许普通笔记中的高价值主动回忆卡。', default: 'intent_only', options: [
      { value: 'intent_only', label: '仅错题或背诵内容（推荐）' },
      { value: 'high_value', label: '允许其他高价值内容' },
      { value: 'disabled', label: '不自动生成卡片' },
    ] }),
    Object.freeze({ id: 'maxCards', group: '卡片质量', type: 'number', label: '每份笔记最多卡片', description: '这是硬上限；AI 会优先保留价值最高且不重复的卡片。', default: 2, min: 0, max: 6, step: 1, unit: '张' }),
    Object.freeze({ id: 'taxonomyContextChars', group: '运行限制', type: 'number', label: '目录上下文长度', description: '送给 AI 参考的现有科目与知识点目录字符数。目录很大时可调高。', default: 12000, min: 2000, max: 30000, step: 1000, unit: '字符' }),
    Object.freeze({ id: 'maxTokens', group: '运行限制', type: 'number', label: '最大输出 Token', description: '长画布或多题笔记可调高；普通单图无需过大。', default: 4200, min: 1600, max: 8000, step: 200, unit: 'tokens' }),
  ]),
  widget_generation: Object.freeze([
    Object.freeze({ id: 'visualStyle', group: '界面风格', type: 'select', label: '组件视觉风格', description: '规定 AI 生成组件时遵循的整体视觉方向。', default: 'dark_translucent', options: [
      { value: 'dark_translucent', label: '深色半透明' },
      { value: 'light_clean', label: '明亮简洁' },
      { value: 'follow_request', label: '跟随需求描述' },
    ] }),
    Object.freeze({ id: 'interactionLevel', group: '交互能力', type: 'select', label: '交互复杂度', description: '限制生成组件包含的状态与交互复杂程度。', default: 'standard', options: [
      { value: 'static', label: '静态展示' },
      { value: 'standard', label: '常规交互' },
      { value: 'advanced', label: '复杂交互' },
    ] }),
    Object.freeze({ id: 'allowJavaScript', group: '交互能力', type: 'boolean', label: '允许 JavaScript', description: '关闭后只生成 HTML/CSS，程序也会丢弃模型返回的脚本。', default: true }),
    Object.freeze({ id: 'defaultWidth', group: '默认尺寸', type: 'number', label: '默认宽度', description: '需求没有明确尺寸时使用的组件宽度。', default: 360, min: 240, max: 720, step: 10, unit: 'px' }),
    Object.freeze({ id: 'defaultHeight', group: '默认尺寸', type: 'number', label: '默认高度', description: '需求没有明确尺寸时使用的组件高度。', default: 260, min: 150, max: 620, step: 10, unit: 'px' }),
    Object.freeze({ id: 'maxTokens', group: '运行限制', type: 'number', label: '最大输出 Token', description: '复杂组件需要更多输出空间，简单组件可降低以提升速度。', default: 5000, min: 1600, max: 10000, step: 200, unit: 'tokens' }),
  ]),
  canvas_organization: Object.freeze([
    Object.freeze({ id: 'layoutDirection', group: '布局策略', type: 'select', label: '主要阅读方向', description: '控制内容更偏向纵向、横向、网格或由 AI 自行判断。', default: 'auto', options: [
      { value: 'auto', label: 'AI 自动判断' },
      { value: 'top_down', label: '从上到下' },
      { value: 'left_to_right', label: '从左到右' },
      { value: 'grid', label: '规整网格' },
    ] }),
    Object.freeze({ id: 'density', group: '布局策略', type: 'select', label: '布局密度', description: '影响整体留白与信息紧凑程度。', default: 'balanced', options: [
      { value: 'compact', label: '紧凑' },
      { value: 'balanced', label: '均衡' },
      { value: 'spacious', label: '宽松' },
    ] }),
    Object.freeze({ id: 'nodeSpacing', group: '布局策略', type: 'number', label: '节点最小间距', description: '要求图片、文字和批注之间至少保留的距离。', default: 56, min: 16, max: 240, step: 8, unit: 'px' }),
    Object.freeze({ id: 'centerLayout', group: '位置与尺寸', type: 'boolean', label: '整理后围绕画布中心', description: '开启后让整理结果尽量落在画布中央区域。', default: true }),
    Object.freeze({ id: 'avoidHandwriting', group: '位置与尺寸', type: 'boolean', label: '避让手写内容', description: '开启后图片和文本节点不会主动覆盖已有手写笔迹区域。', default: true }),
    Object.freeze({ id: 'resizeMode', group: '位置与尺寸', type: 'select', label: '允许调整节点尺寸', description: '“保持全部尺寸”只移动；其他模式允许 AI 为可读性调整大小。', default: 'all', options: [
      { value: 'none', label: '保持全部尺寸' },
      { value: 'text_only', label: '仅调整文字与批注' },
      { value: 'all', label: '允许调整全部节点' },
    ] }),
    Object.freeze({ id: 'networkRetries', group: '运行与容错', type: 'number', label: '同模型网络重试次数', description: '建议保持 0，避免慢模型重复占用几分钟；网络偶发抖动时可设为 1。', default: 0, min: 0, max: 2, step: 1, unit: '次' }),
    Object.freeze({ id: 'jsonRepairRetries', group: '运行与容错', type: 'number', label: '格式修复重试次数', description: '模型返回的布局 JSON 无法解析时，是否让同一模型重新修复格式。', default: 0, min: 0, max: 2, step: 1, unit: '次' }),
    Object.freeze({ id: 'allowStandardVisionFallback', group: '运行与容错', type: 'boolean', label: '允许普通视觉模型兜底', description: '开启后 Kimi、Gemini 不可用时可尝试通义视觉模型；关闭后只使用支持超长上下文的模型。', default: true }),
    Object.freeze({ id: 'reasoningMode', group: '运行与容错', type: 'select', label: '推理模式', description: '快速模式关闭 K2.6/K2.5 深度思考，并将 K3 调为低推理；画布布局通常无需长时间深度思考。', default: 'fast', options: [
      { value: 'fast', label: '快速（推荐）' },
      { value: 'balanced', label: '均衡' },
      { value: 'deep', label: '深度' },
    ] }),
    Object.freeze({ id: 'tokenBudgetMode', group: '输出预算', type: 'select', label: 'Token 预算方式', description: '固定模式更适合 Kimi 等推理模型；自适应会按节点数量压缩预算，可能让长推理占满预算。', default: 'fixed', options: [
      { value: 'fixed', label: '固定使用最大预算（推荐）' },
      { value: 'adaptive', label: '按画布规模自适应' },
    ] }),
    Object.freeze({ id: 'maxTokens', group: '输出预算', type: 'number', label: '最大完成 Token（含推理）', description: 'Kimi K2.6/K3 的思考过程也会占用此预算；预算耗尽时可能出现推理完成但最终 JSON 为空。', default: 4096, min: 1800, max: 16000, step: 200, unit: 'tokens' }),
  ]),
  note_classification: Object.freeze([
    Object.freeze({ id: 'uncertainThreshold', group: '分类策略', type: 'number', label: '不确定分类阈值', description: '低于此置信度才进入待确认；已经可靠分类的不要求确认。', default: 0.58, min: 0, max: 1, step: 0.05 }),
    Object.freeze({ id: 'preferExistingTaxonomy', group: '分类策略', type: 'boolean', label: '优先已有目录', description: '优先匹配已经存在的科目和知识点名称。', default: true }),
  ]),
  taxonomy: Object.freeze([
    Object.freeze({ id: 'mergeStrategy', group: '目录策略', type: 'select', label: '同义知识点处理', description: '控制近义名称是自动归并还是保持独立。', default: 'conservative', options: [
      { value: 'conservative', label: '保守归并' },
      { value: 'balanced', label: '平衡归并' },
      { value: 'aggressive', label: '积极归并' },
    ] }),
    Object.freeze({ id: 'allowNewKnowledgePoints', group: '目录策略', type: 'boolean', label: '允许新建知识点', description: '一级科目仍受程序白名单约束。', default: true }),
  ]),
  flashcard_generation: Object.freeze([
    Object.freeze({ id: 'maxCards', group: '卡片策略', type: 'number', label: '最多生成卡片', description: '独立卡片任务的一次生成硬上限。', default: 3, min: 1, max: 10, step: 1, unit: '张' }),
    Object.freeze({ id: 'answerDetail', group: '卡片策略', type: 'select', label: '答案详细度', description: '控制卡片背面的解释长度。', default: 'concise', options: [
      { value: 'concise', label: '精简' },
      { value: 'standard', label: '标准' },
      { value: 'detailed', label: '详细' },
    ] }),
  ]),
  custom: Object.freeze([]),
});

const AI_TASK_DEFINITIONS = Object.freeze({
  note_naming: Object.freeze({
    label: '笔记命名',
    description: '识别截图或画布内容，并生成科目与文件名。',
    active: true,
  }),
  note_enrichment: Object.freeze({
    label: '笔记整理与分类',
    description: '提取知识点、错因、题目价值与复习卡片等结构化信息。',
    active: true,
  }),
  widget_generation: Object.freeze({
    label: '桌面组件生成',
    description: '按照需求生成安全、可运行的桌面小组件。',
    active: true,
  }),
  canvas_organization: Object.freeze({
    label: 'AI 自动整理画布',
    description: '理解画布图片、文字、批注和关系后，在后台重新规划清晰布局。',
    active: true,
    defaultTimeoutMs: 90_000,
  }),
  note_classification: Object.freeze({
    label: '独立笔记分类',
    description: '供独立分类流程使用；当前主要分类流程由“笔记整理与分类”承担。',
    active: false,
  }),
  taxonomy: Object.freeze({
    label: '知识目录整理',
    description: '供知识目录归并与层级调整任务使用。',
    active: false,
  }),
  flashcard_generation: Object.freeze({
    label: '独立卡片生成',
    description: '供独立卡片生成流程使用；当前卡片由“笔记整理与分类”一并生成。',
    active: false,
  }),
  custom: Object.freeze({
    label: '其他 AI 任务',
    description: '未单独命名的通用 AI 请求。',
    active: false,
  }),
});

class AiRouterError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AiRouterError';
    this.code = options.code || 'AI_ROUTER_ERROR';
    this.retryable = Boolean(options.retryable);
    this.status = Number.isFinite(options.status) ? options.status : null;
    this.provider = options.provider || null;
    this.model = options.model || null;
    this.attempts = Array.isArray(options.attempts) ? options.attempts : [];
    if (options.cause) this.cause = options.cause;
  }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanApiKey(value) {
  return cleanString(value)
    .replace(/^['"]|['"]$/g, '')
    .replace(/[\r\n\t ]+/g, '');
}

function toFiniteNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const normalized = cleanString(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeNamingRules(value) {
  if (!Array.isArray(value)) return [];
  const rules = [];
  const seen = new Set();
  for (let index = 0; index < value.length && rules.length < 20; index += 1) {
    const input = value[index];
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
    const fallbackId = `naming-rule-${index + 1}`;
    const id = (cleanString(input.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || fallbackId);
    if (seen.has(id)) continue;
    const name = cleanString(input.name).slice(0, 80);
    const when = cleanString(input.when).slice(0, 800);
    const extract = cleanString(input.extract).slice(0, 800);
    const titleTemplate = cleanString(input.titleTemplate).slice(0, 240) || '{value}';
    if (!name || !when || !extract) continue;
    seen.add(id);
    rules.push({
      id,
      name,
      enabled: input.enabled !== false,
      when,
      extract,
      titleTemplate,
      ...(cleanString(input.validationHint) ? { validationHint: cleanString(input.validationHint).slice(0, 500) } : {}),
    });
  }
  return rules;
}

function normalizeTaskOptions(taskId, value) {
  const definitions = TASK_PARAMETER_DEFINITIONS[taskId] || [];
  if (!value || typeof value !== 'object' || Array.isArray(value) || definitions.length === 0) return {};
  const result = {};
  for (const definition of definitions) {
    if (!Object.prototype.hasOwnProperty.call(value, definition.id)) continue;
    const input = value[definition.id];
    if (definition.type === 'boolean') {
      if (typeof input === 'boolean') result[definition.id] = input;
      continue;
    }
    if (definition.type === 'number') {
      const number = Number(input);
      if (!Number.isFinite(number)) continue;
      const bounded = Math.min(definition.max, Math.max(definition.min, number));
      result[definition.id] = Number.isInteger(definition.step) ? Math.round(bounded) : bounded;
      continue;
    }
    if (definition.type === 'select') {
      const selected = cleanString(input);
      if (definition.options.some((option) => option.value === selected)) result[definition.id] = selected;
    }
  }
  return result;
}

function resolveTaskOptions(taskId, settings = {}) {
  const definitions = TASK_PARAMETER_DEFINITIONS[taskId] || [];
  const configured = normalizeTaskOptions(taskId, settings.options);
  return Object.fromEntries(definitions.map((definition) => [
    definition.id,
    Object.prototype.hasOwnProperty.call(configured, definition.id) ? configured[definition.id] : definition.default,
  ]));
}

function normalizeTaskConfigurations(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const taskId of Object.keys(TASK_PROFILES)) {
    const input = value[taskId];
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
    const task = {};
    if (typeof input.enabled === 'boolean') task.enabled = input.enabled;
    const providerId = cleanString(input.providerId).toLowerCase().slice(0, 40);
    const modelId = cleanString(input.modelId).slice(0, 120);
    if (providerId) task.providerId = providerId;
    if (modelId) task.modelId = modelId;
    if (typeof input.fallback === 'boolean') task.fallback = input.fallback;
    if (['low', 'medium', 'high'].includes(input.difficulty)) task.difficulty = input.difficulty;
    if (input.temperature !== undefined && input.temperature !== null && input.temperature !== '') {
      const temperature = Number(input.temperature);
      if (Number.isFinite(temperature)) task.temperature = Math.min(2, Math.max(0, temperature));
    }
    if (input.timeoutMs !== undefined && input.timeoutMs !== null && input.timeoutMs !== '') {
      const timeoutMs = Number(input.timeoutMs);
      if (Number.isFinite(timeoutMs)) task.timeoutMs = Math.round(Math.min(300_000, Math.max(1_000, timeoutMs)));
    }
    const customInstructions = cleanString(input.customInstructions).slice(0, 6_000);
    if (customInstructions) task.customInstructions = customInstructions;
    if (taskId === 'note_naming') {
      const namingRules = normalizeNamingRules(input.namingRules);
      if (namingRules.length > 0) task.namingRules = namingRules;
    }
    const taskOptions = normalizeTaskOptions(taskId, input.options);
    if (Object.keys(taskOptions).length > 0) task.options = taskOptions;
    if (Object.keys(task).length > 0) result[taskId] = task;
  }
  return result;
}

function normalizeCapabilityName(value) {
  const raw = cleanString(value).toLowerCase().replace(/[\s_-]+/g, '');
  const aliases = new Map([
    ['text', 'text'],
    ['vision', 'vision'],
    ['image', 'vision'],
    ['images', 'vision'],
    ['json', 'json'],
    ['structuredoutput', 'json'],
    ['longcontext', 'longContext'],
    ['reasoning', 'reasoning'],
    ['thinking', 'reasoning'],
  ]);
  return aliases.get(raw) || null;
}

function parseCapabilities(value, fallback = ['text']) {
  const rawValues = Array.isArray(value)
    ? value
    : cleanString(value).split(',').map((item) => item.trim()).filter(Boolean);
  const normalized = rawValues.map(normalizeCapabilityName).filter(Boolean);
  const result = normalized.length > 0 ? normalized : fallback;
  return [...new Set(['text', ...result])];
}

function inferCapabilities(providerId, modelId) {
  const model = cleanString(modelId).toLowerCase();
  const capabilities = ['text', 'json'];
  if (
    providerId === 'gemini'
    || /(?:^|[-_.])(vl|vision)(?:[-_.]|$)/i.test(model)
    || /qwen.*vl/i.test(model)
    || /kimi-(?:k2\.(?:5|6)|k3)(?:[-_.]|$)/i.test(model)
  ) {
    capabilities.push('vision');
  }
  if (providerId === 'gemini' || /(?:long|128k|256k|k2)/i.test(model)) {
    capabilities.push('longContext');
  }
  if (/(?:pro|max|thinking|reason|k2\.[56])/i.test(model)) {
    capabilities.push('reasoning');
  }
  return [...new Set(capabilities)];
}

function inferCostTier(modelId) {
  const model = cleanString(modelId).toLowerCase();
  if (/(?:lite|flash|turbo|mini|vl-plus)/i.test(model)) return 1;
  if (/(?:pro|max|thinking|reason|k2\.[56])/i.test(model)) return 3;
  return 2;
}

function inferQualityTier(modelId) {
  const model = cleanString(modelId).toLowerCase();
  if (/(?:pro|max|thinking|reason|k2\.[56])/i.test(model)) return 3;
  if (/(?:lite|mini)/i.test(model)) return 1;
  return 2;
}

function normalizeChatCompletionUrl(value) {
  const raw = cleanString(value).replace(/\/+$/g, '');
  if (!raw) return '';
  if (/\/chat\/completions$/i.test(raw)) return raw;
  return `${raw}/chat/completions`;
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    throw new AiRouterError(`AI 配置文件无法读取：${filePath}`, {
      code: 'AI_CONFIG_INVALID',
      cause: error,
    });
  }
}

function providerFromObject(id, input = {}) {
  const modelInputs = Array.isArray(input.models) && input.models.length > 0
    ? input.models
    : input.model
      ? [{ id: input.model }]
      : [];

  const configuredModels = modelInputs
    .map((modelInput) => {
      const model = typeof modelInput === 'string' ? { id: modelInput } : modelInput || {};
      const modelId = cleanString(model.id || model.model);
      if (!modelId) return null;
      const inferredCapabilities = inferCapabilities(id, modelId);
      return {
        id: modelId,
        capabilities: parseCapabilities(model.capabilities || input.capabilities, inferredCapabilities),
        costTier: toFiniteNumber(model.costTier ?? input.costTier, inferCostTier(modelId), 1, 3),
        qualityTier: toFiniteNumber(model.qualityTier ?? input.qualityTier, inferQualityTier(modelId), 1, 3),
        priority: toFiniteNumber(model.priority, 0, -100, 100),
        supportsResponseFormat: parseBoolean(
          model.supportsResponseFormat ?? input.supportsResponseFormat,
          true,
        ),
        catalogOnly: model.catalogOnly === true,
      };
    })
    .filter(Boolean);
  const configuredIds = new Set(configuredModels.map((model) => model.id));
  const catalogModels = (PROVIDER_MODEL_CATALOG[id] || [])
    .filter((modelId) => !configuredIds.has(modelId))
    .map((modelId) => ({
      id: modelId,
      capabilities: inferCapabilities(id, modelId),
      costTier: inferCostTier(modelId),
      qualityTier: inferQualityTier(modelId),
      priority: 0,
      supportsResponseFormat: true,
      catalogOnly: true,
    }));
  const models = [...configuredModels, ...catalogModels];

  const headers = input.headers && typeof input.headers === 'object'
    ? Object.fromEntries(Object.entries(input.headers).filter(([key, value]) => cleanString(key) && typeof value === 'string'))
    : {};

  return {
    id,
    enabled: parseBoolean(input.enabled, true),
    apiKey: cleanApiKey(input.apiKey),
    baseUrl: normalizeChatCompletionUrl(input.baseUrl),
    priority: toFiniteNumber(input.priority, id === 'qwen' ? 10 : 0, -100, 100),
    headers,
    models,
  };
}

function getLocalProvider(localConfig, id) {
  const providers = localConfig?.providers;
  if (Array.isArray(providers)) {
    return providers.find((provider) => provider?.id === id) || {};
  }
  if (providers && typeof providers === 'object') return providers[id] || {};
  return {};
}

function nonEmptyOverride(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value !== undefined && value !== null && value !== '') result[key] = value;
  }
  return result;
}

function envProviderConfig(env, id) {
  if (id === 'qwen') {
    return {
      apiKey: env.QWEN_API_KEY || env.DASHSCOPE_API_KEY,
      model: env.QWEN_MODEL,
      baseUrl: env.QWEN_BASE_URL,
      capabilities: env.QWEN_CAPABILITIES,
      costTier: env.QWEN_COST_TIER,
      qualityTier: env.QWEN_QUALITY_TIER,
      priority: env.QWEN_PRIORITY,
      supportsResponseFormat: env.QWEN_SUPPORTS_RESPONSE_FORMAT,
    };
  }
  if (id === 'gemini') {
    return {
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      baseUrl: env.GEMINI_BASE_URL,
      capabilities: env.GEMINI_CAPABILITIES,
      costTier: env.GEMINI_COST_TIER,
      qualityTier: env.GEMINI_QUALITY_TIER,
      priority: env.GEMINI_PRIORITY,
      supportsResponseFormat: env.GEMINI_SUPPORTS_RESPONSE_FORMAT,
    };
  }
  return {
    apiKey: env.KIMI_API_KEY || env.MOONSHOT_API_KEY,
    model: env.KIMI_MODEL || env.MOONSHOT_MODEL,
    baseUrl: env.KIMI_BASE_URL || env.MOONSHOT_BASE_URL,
    capabilities: env.KIMI_CAPABILITIES || env.MOONSHOT_CAPABILITIES,
    costTier: env.KIMI_COST_TIER || env.MOONSHOT_COST_TIER,
    qualityTier: env.KIMI_QUALITY_TIER || env.MOONSHOT_QUALITY_TIER,
    priority: env.KIMI_PRIORITY || env.MOONSHOT_PRIORITY,
    supportsResponseFormat: env.KIMI_SUPPORTS_RESPONSE_FORMAT || env.MOONSHOT_SUPPORTS_RESPONSE_FORMAT,
  };
}

function loadAiProviderConfigs(options = {}) {
  const env = options.env || process.env;
  const legacyQwen = options.legacyQwenConfig || loadQwenConfig();
  const configPath = options.configPath
    || env.KAOYAN_AI_CONFIG_PATH
    || path.join(legacyQwen.assistantRoot, 'ai-providers.json');
  const localConfig = options.localConfig || readJsonFile(configPath);

  const legacyQwenInput = {
    apiKey: legacyQwen.apiKey,
    model: legacyQwen.model,
    baseUrl: legacyQwen.baseUrl,
    capabilities: inferCapabilities('qwen', legacyQwen.model),
  };

  const defaults = {
    qwen: legacyQwenInput,
    // Gemini and Kimi remain opt-in because a key and model are still required;
    // the standard OpenAI-compatible endpoints are safe defaults.
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    kimi: { baseUrl: 'https://api.moonshot.cn/v1' },
  };

  const providers = ['qwen', 'gemini', 'kimi']
    .map((id) => {
      const environment = envProviderConfig(env, id);
      const localProvider = getLocalProvider(localConfig, id);
      const merged = nonEmptyOverride(
        nonEmptyOverride(defaults[id], localProvider),
        environment,
      );
      // The desktop configuration is the user-visible source of truth for
      // credentials. A stale Windows environment variable must not silently
      // replace a newer key saved in ai-providers.json.
      if (cleanString(localProvider.apiKey)) merged.apiKey = localProvider.apiKey;
      // A model explicitly selected in the environment must override a local
      // multi-model list as well, rather than becoming an unused sibling field.
      if (cleanString(environment.model)) delete merged.models;
      return providerFromObject(id, merged);
    })
    .filter((provider) => provider.enabled && provider.apiKey && provider.baseUrl && provider.models.length > 0);

  const routing = localConfig.routing && typeof localConfig.routing === 'object'
    ? localConfig.routing
    : {};

  return {
    configPath,
    providers,
    tasks: normalizeTaskConfigurations(localConfig.tasks),
    routing: {
      timeoutMs: toFiniteNumber(
        env.AI_TIMEOUT_MS || routing.timeoutMs,
        DEFAULT_TIMEOUT_MS,
        1,
        300_000,
      ),
      circuitThreshold: toFiniteNumber(
        env.AI_CIRCUIT_THRESHOLD || routing.circuitThreshold,
        DEFAULT_CIRCUIT_THRESHOLD,
        1,
        20,
      ),
      circuitCooldownMs: toFiniteNumber(
        env.AI_CIRCUIT_COOLDOWN_MS || routing.circuitCooldownMs,
        DEFAULT_CIRCUIT_COOLDOWN_MS,
        100,
        86_400_000,
      ),
      networkRetries: toFiniteNumber(
        env.AI_NETWORK_RETRIES || routing.networkRetries,
        1,
        0,
        3,
      ),
      jsonRepairRetries: toFiniteNumber(
        env.AI_JSON_REPAIR_RETRIES || routing.jsonRepairRetries,
        1,
        0,
        2,
      ),
    },
  };
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item === 'string' ? item : item?.text || item?.content || '')
      .filter(Boolean)
      .join('\n');
  }
  return cleanString(content);
}

function sanitizeProviderErrorMessage(value) {
  return cleanString(value)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[已隐藏的 API Key]')
    .slice(0, 300);
}

async function readProviderErrorMessage(response) {
  try {
    if (typeof response?.text === 'function') {
      const text = await response.text();
      try {
        const parsed = JSON.parse(text);
        return sanitizeProviderErrorMessage(
          parsed?.error?.message || parsed?.message || parsed?.detail || text,
        );
      } catch {
        return sanitizeProviderErrorMessage(text);
      }
    }
    if (typeof response?.json === 'function') {
      const parsed = await response.json();
      return sanitizeProviderErrorMessage(
        parsed?.error?.message || parsed?.message || parsed?.detail || '',
      );
    }
  } catch {
    // Preserve the HTTP status even when the provider's error body is invalid.
  }
  return '';
}

function repairCommonLlmJson(text) {
  const latexCommand = /\\(?=(?:frac|dfrac|tfrac|left|right|sum|prod|int|lim|infty|sqrt|partial|mathrm|mathbf|operatorname|cdot|times|theta|alpha|beta|gamma|delta|epsilon|varepsilon|lambda|mu|sigma|phi|varphi|omega|ln|sin|cos|tan|log|exp|begin|end)\b)/g;
  return String(text || '')
    .replace(latexCommand, '\\\\')
    .replace(/(?<!\\)\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g, '\\\\')
    .replace(/,\s*([}\]])/g, '$1');
}

function parseJsonCandidate(candidate) {
  const repaired = repairCommonLlmJson(candidate);
  const attempts = repaired === candidate ? [candidate] : [repaired, candidate];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // Try the next safe recovery form.
    }
  }
  return null;
}

function extractJsonValue(text) {
  const raw = cleanString(text);
  if (!raw) return null;
  const parsedRaw = parseJsonCandidate(raw);
  if (parsedRaw !== null) return parsedRaw;
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(raw);
  const candidate = fenced ? fenced[1].trim() : raw;
  const parsedCandidate = parseJsonCandidate(candidate);
  if (parsedCandidate !== null) return parsedCandidate;
  const objectStart = candidate.indexOf('{');
  const arrayStart = candidate.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const opening = candidate[start];
  const closing = opening === '{' ? '}' : ']';
  const end = candidate.lastIndexOf(closing);
  if (end <= start) return null;
  return parseJsonCandidate(candidate.slice(start, end + 1));
}

function pruneUnknownJsonProperties(value, schema) {
  if (!schema || typeof schema !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => pruneUnknownJsonProperties(item, schema.items));
  }
  if (value === null || typeof value !== 'object') return value;
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const entries = Object.entries(value)
    .filter(([key]) => schema.additionalProperties !== false || Object.hasOwn(properties, key))
    .map(([key, item]) => [key, pruneUnknownJsonProperties(item, properties[key])]);
  return Object.fromEntries(entries);
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function validateJsonAgainstSchema(value, schema, currentPath = '$') {
  if (!schema || typeof schema !== 'object') return [];
  const errors = [];

  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf.map((variant) => validateJsonAgainstSchema(value, variant, currentPath));
    if (!variants.some((variantErrors) => variantErrors.length === 0)) {
      errors.push(`${currentPath} does not match any allowed schema`);
    }
    return errors;
  }

  if (Array.isArray(schema.oneOf)) {
    const matchCount = schema.oneOf
      .map((variant) => validateJsonAgainstSchema(value, variant, currentPath))
      .filter((variantErrors) => variantErrors.length === 0).length;
    if (matchCount !== 1) errors.push(`${currentPath} must match exactly one schema`);
    return errors;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${currentPath} must equal the configured constant`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${currentPath} is not an allowed value`);
  }

  if (schema.type) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowedTypes.some((type) => typeMatches(value, type))) {
      errors.push(`${currentPath} must be ${allowedTypes.join(' or ')}`);
      return errors;
    }
  }

  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${currentPath} is shorter than ${schema.minLength}`);
    }
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(`${currentPath} is longer than ${schema.maxLength}`);
    }
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${currentPath} has an invalid format`);
      } catch {
        errors.push(`${currentPath} uses an invalid schema pattern`);
      }
    }
  }

  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${currentPath} is too small`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${currentPath} is too large`);
  }

  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) errors.push(`${currentPath} has too few items`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) errors.push(`${currentPath} has too many items`);
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateJsonAgainstSchema(item, schema.items, `${currentPath}[${index}]`));
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${currentPath}.${key} is required`);
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateJsonAgainstSchema(value[key], childSchema, `${currentPath}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`${currentPath}.${key} is not allowed`);
      }
    }
  }

  return errors;
}

function containsImage(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(containsImage);
  if (typeof value !== 'object') return false;
  if (value.type === 'image_url' || value.type === 'input_image' || value.image_url) return true;
  return Object.values(value).some(containsImage);
}

function normalizeDifficulty(value, fallback) {
  return ['low', 'medium', 'high'].includes(value) ? value : fallback;
}

function buildRequirements(request) {
  const profile = TASK_PROFILES[request.task] || TASK_PROFILES.custom;
  const difficulty = normalizeDifficulty(request.difficulty, profile.difficulty);
  const capabilities = new Set(profile.capabilities);
  (request.requiredCapabilities || []).forEach((capability) => {
    const normalized = normalizeCapabilityName(capability);
    if (normalized) capabilities.add(normalized);
  });
  if (containsImage(request.messages)) capabilities.add('vision');
  if (request.responseSchema || request.json === true) capabilities.add('json');
  return { difficulty, capabilities: [...capabilities] };
}

function modelScore(provider, model, difficulty) {
  const qualityWeight = difficulty === 'high' ? 18 : difficulty === 'medium' ? 9 : 3;
  const costWeight = difficulty === 'low' ? 14 : difficulty === 'medium' ? 7 : 2;
  return (
    provider.priority
    + model.priority
    + model.qualityTier * qualityWeight
    + (4 - model.costTier) * costWeight
  );
}

function safeAttempt(provider, model, phase, outcome, error) {
  return {
    provider,
    model,
    phase,
    outcome,
    code: error?.code || null,
    status: error?.status || null,
    message: error?.message ? sanitizeProviderErrorMessage(error.message) : null,
  };
}

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAiRouter(options = {}) {
  const loaded = options.config
    ? {
      providers: options.config.providers || [],
      routing: options.config.routing || {},
      tasks: options.config.tasks || {},
    }
    : loadAiProviderConfigs(options);
  const providers = loaded.providers.map((provider) => providerFromObject(provider.id, provider));
  const taskConfigurations = normalizeTaskConfigurations(loaded.tasks);
  const routing = {
    timeoutMs: toFiniteNumber(options.timeoutMs ?? loaded.routing.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 300_000),
    circuitThreshold: toFiniteNumber(
      options.circuitThreshold ?? loaded.routing.circuitThreshold,
      DEFAULT_CIRCUIT_THRESHOLD,
      1,
      20,
    ),
    circuitCooldownMs: toFiniteNumber(
      options.circuitCooldownMs ?? loaded.routing.circuitCooldownMs,
      DEFAULT_CIRCUIT_COOLDOWN_MS,
      100,
      86_400_000,
    ),
    networkRetries: toFiniteNumber(options.networkRetries ?? loaded.routing.networkRetries, 1, 0, 3),
    jsonRepairRetries: toFiniteNumber(options.jsonRepairRetries ?? loaded.routing.jsonRepairRetries, 1, 0, 2),
  };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new AiRouterError('当前 Node.js 环境没有可用的 fetch', { code: 'AI_FETCH_UNAVAILABLE' });
  }
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || sleepDefault;
  const circuits = new Map();

  function getCircuit(providerId) {
    if (!circuits.has(providerId)) {
      circuits.set(providerId, { consecutiveFailures: 0, openUntil: 0 });
    }
    return circuits.get(providerId);
  }

  function isCircuitOpen(providerId) {
    const state = getCircuit(providerId);
    if (state.openUntil > now()) return true;
    if (state.openUntil > 0) {
      state.openUntil = 0;
      state.consecutiveFailures = 0;
    }
    return false;
  }

  function recordSuccess(providerId) {
    const state = getCircuit(providerId);
    state.consecutiveFailures = 0;
    state.openUntil = 0;
  }

  function recordFailure(providerId, error) {
    const state = getCircuit(providerId);
    state.consecutiveFailures += 1;
    if (error?.code === 'AI_AUTH_ERROR') {
      state.consecutiveFailures = Math.max(state.consecutiveFailures, routing.circuitThreshold);
      state.openUntil = now() + Math.max(routing.circuitCooldownMs, 24 * 60 * 60 * 1000);
      return;
    }
    if (state.consecutiveFailures >= routing.circuitThreshold) {
      state.openUntil = now() + routing.circuitCooldownMs;
    }
  }

  function candidatesFor(request) {
    const requirements = buildRequirements(request);
    const allowed = Array.isArray(request.allowedProviders) && request.allowedProviders.length > 0
      ? new Set(request.allowedProviders)
      : null;
    const blocked = new Set(request.blockedProviders || []);
    const maxCostTier = Number.isFinite(request.maxCostTier)
      ? Math.min(3, Math.max(1, request.maxCostTier))
      : null;
    const preferredProvider = cleanString(request.preferredProvider).toLowerCase();
    const preferredModel = cleanString(request.preferredModel);
    const hasPreference = Boolean(preferredProvider || preferredModel);
    const strictPreference = hasPreference && request.allowFallback === false;

    const candidates = [];
    for (const provider of providers) {
      if (!provider.enabled || !provider.apiKey || !provider.baseUrl || provider.models.length === 0) continue;
      if (allowed && !allowed.has(provider.id)) continue;
      if (blocked.has(provider.id) || isCircuitOpen(provider.id)) continue;
      for (const model of provider.models) {
        const preferred = hasPreference && (!preferredProvider || provider.id === preferredProvider)
          && (!preferredModel || model.id === preferredModel);
        if (strictPreference && !preferred) continue;
        if (model.catalogOnly && (!preferredModel || model.id !== preferredModel)) continue;
        if (maxCostTier && model.costTier > maxCostTier) continue;
        if (!requirements.capabilities.every((capability) => model.capabilities.includes(capability))) continue;
        candidates.push({
          provider,
          model,
          score: modelScore(provider, model, requirements.difficulty) + (preferred ? 10_000 : 0),
        });
      }
    }
    return {
      ...requirements,
      candidates: candidates.sort((left, right) => right.score - left.score),
    };
  }

  async function fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AiRouterError('AI 请求超时', { code: 'AI_TIMEOUT', retryable: true }));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        fetchImpl(url, { ...init, signal: controller.signal }),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof AiRouterError) throw error;
      const aborted = controller.signal.aborted || error?.name === 'AbortError';
      throw new AiRouterError(aborted ? 'AI 请求超时' : 'AI 网络请求失败', {
        code: aborted ? 'AI_TIMEOUT' : 'AI_NETWORK_ERROR',
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestModel(provider, model, request, messages) {
    const isKimiThinkingModel = provider.id === 'kimi' && /kimi-(?:k3|k2\.(?:5|6))/i.test(model.id);
    const reasoningMode = ['fast', 'balanced', 'deep'].includes(request.taskOptions?.reasoningMode)
      ? request.taskOptions.reasoningMode
      : null;
    const payload = {
      model: model.id,
      messages,
    };
    if (provider.id === 'kimi' && reasoningMode) {
      if (/kimi-k2\.(?:5|6)/i.test(model.id)) {
        payload.thinking = { type: reasoningMode === 'fast' ? 'disabled' : 'enabled' };
      } else if (/kimi-k3/i.test(model.id)) {
        payload.reasoning_effort = reasoningMode === 'fast' ? 'low' : reasoningMode === 'balanced' ? 'high' : 'max';
      }
    }
    if (!isKimiThinkingModel) {
      payload.temperature = request.temperature ?? (request.responseSchema || request.json ? 0.1 : 0.3);
    }
    if (Number.isFinite(request.maxTokens)) {
      if (isKimiThinkingModel) payload.max_completion_tokens = request.maxTokens;
      else payload.max_tokens = request.maxTokens;
    }
    if ((request.responseSchema || request.json) && model.supportsResponseFormat) {
      payload.response_format = { type: 'json_object' };
    }

    const response = await fetchWithTimeout(
      provider.baseUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
          ...provider.headers,
        },
        body: JSON.stringify(payload),
      },
      toFiniteNumber(request.timeoutMs, routing.timeoutMs, 1, 300_000),
    );

    if (!response || typeof response.ok !== 'boolean') {
      throw new AiRouterError('AI 服务返回了无效响应', { code: 'AI_INVALID_RESPONSE', retryable: true });
    }
    if (!response.ok) {
      const status = response.status;
      const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
      const providerMessage = await readProviderErrorMessage(response);
      throw new AiRouterError(`AI 服务请求失败（HTTP ${status}）${providerMessage ? `：${providerMessage}` : ''}`, {
        code: status === 401 || status === 403 ? 'AI_AUTH_ERROR' : 'AI_HTTP_ERROR',
        retryable,
        status,
      });
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new AiRouterError('AI 服务没有返回有效 JSON 包装', {
        code: 'AI_INVALID_RESPONSE',
        retryable: true,
        cause: error,
      });
    }
    const choice = data?.choices?.[0] || {};
    const text = contentToText(choice?.message?.content);
    if (!text) {
      const finishReason = cleanString(choice?.finish_reason);
      const completionTokens = Number(data?.usage?.completion_tokens);
      const reasoningTokens = Number(data?.usage?.completion_tokens_details?.reasoning_tokens);
      const tokenBudget = Number(payload.max_completion_tokens || payload.max_tokens);
      const details = [
        finishReason ? `结束原因 ${finishReason}` : '',
        Number.isFinite(completionTokens) ? `完成 Token ${completionTokens}${Number.isFinite(tokenBudget) ? `/${tokenBudget}` : ''}` : '',
        Number.isFinite(reasoningTokens) ? `其中推理 Token ${reasoningTokens}` : '',
      ].filter(Boolean);
      const budgetExhausted = finishReason === 'length'
        || (Number.isFinite(completionTokens) && Number.isFinite(tokenBudget) && completionTokens >= tokenBudget * 0.95);
      throw new AiRouterError(
        `AI 服务返回了空内容${details.length ? `（${details.join('；')}）` : ''}${budgetExhausted ? '，可能是推理过程耗尽了完成 Token 预算' : ''}`,
        { code: budgetExhausted ? 'AI_TOKEN_BUDGET_EXHAUSTED' : 'AI_EMPTY_RESPONSE', retryable: true },
      );
    }
    return { text, usage: data?.usage || null };
  }

  function validateResult(raw, request) {
    if (!request.responseSchema && request.json !== true && typeof request.validate !== 'function') {
      return { text: raw.text, json: undefined, usage: raw.usage };
    }
    let json = extractJsonValue(raw.text);
    if (json === null) {
      throw new AiRouterError('AI 没有返回可解析的 JSON', { code: 'AI_JSON_INVALID', retryable: true });
    }
    if (typeof request.normalizeJson === 'function') {
      try {
        json = request.normalizeJson(json);
      } catch (error) {
        throw new AiRouterError(`AI JSON 规范化失败：${error instanceof Error ? error.message : String(error)}`, {
          code: 'AI_JSON_NORMALIZE_FAILED',
          retryable: true,
          cause: error,
        });
      }
    }
    let schemaErrors = request.responseSchema
      ? validateJsonAgainstSchema(json, request.responseSchema)
      : [];
    if (schemaErrors.length > 0 && schemaErrors.every((message) => message.endsWith(' is not allowed'))) {
      const pruned = pruneUnknownJsonProperties(json, request.responseSchema);
      const prunedErrors = validateJsonAgainstSchema(pruned, request.responseSchema);
      if (prunedErrors.length === 0) {
        json = pruned;
        schemaErrors = [];
      }
    }
    if (schemaErrors.length > 0) {
      const shape = Array.isArray(json)
        ? `根节点是数组（${json.length} 项）`
        : json && typeof json === 'object'
          ? `返回字段：${Object.keys(json).slice(0, 12).join(', ') || '无'}`
          : `根节点类型：${typeof json}`;
      throw new AiRouterError(`AI JSON 不符合要求：${schemaErrors.slice(0, 4).join('；')}（${shape}）`, {
        code: 'AI_SCHEMA_INVALID',
        retryable: true,
      });
    }
    if (typeof request.validate === 'function') {
      const validation = request.validate(json);
      if (validation !== true && validation !== undefined) {
        const message = typeof validation === 'string' ? validation : '自定义校验未通过';
        throw new AiRouterError(`AI JSON 不符合要求：${message}`, {
          code: 'AI_SCHEMA_INVALID',
          retryable: true,
        });
      }
    }
    return { text: raw.text, json, usage: raw.usage };
  }

  function repairMessages(messages, error, responseText, schema) {
    const schemaText = schema ? JSON.stringify(schema) : '一个有效 JSON 值';
    return [
      ...messages,
      { role: 'assistant', content: String(responseText || '').slice(0, 16_000) },
      {
        role: 'user',
        content: [
          '上一条输出无法通过程序校验。请只返回修正后的 JSON，不要使用 Markdown，也不要解释。',
          `校验问题：${error.message.slice(0, 500)}`,
          `目标 JSON Schema：${schemaText.slice(0, 8_000)}`,
        ].join('\n'),
      },
    ];
  }

  function applyTaskConfiguration(request) {
    const taskConfiguration = taskConfigurations[request.task] || {};
    if (taskConfiguration.enabled === false) {
      throw new AiRouterError('这个 AI 任务已在配置中心停用', { code: 'AI_TASK_DISABLED' });
    }
    const taskOptions = resolveTaskOptions(request.task, taskConfiguration);
    const parameterDefinitions = TASK_PARAMETER_DEFINITIONS[request.task] || [];
    const configuredParameterText = parameterDefinitions.length > 0
      ? parameterDefinitions.map((definition) => {
        const value = taskOptions[definition.id];
        const selected = definition.type === 'select'
          ? definition.options.find((option) => option.value === value)?.label || value
          : value;
        return `${definition.label}：${typeof selected === 'boolean' ? (selected ? '开启' : '关闭') : selected}${definition.unit ? ` ${definition.unit}` : ''}`;
      }).join('\n')
      : '';
    const systemSections = [
      configuredParameterText ? [
        '以下是当前任务在 AI 配置中心设置的专属参数。程序会对关键上限再次校验，你也必须按这些参数执行。',
        configuredParameterText,
      ].join('\n') : '',
      taskConfiguration.customInstructions ? [
        '以下是用户在 AI 任务配置中心为当前任务设置的附加规则。',
        '请遵守这些规则，但不得破坏程序要求的 JSON 结构、安全限制或必填字段。',
        taskConfiguration.customInstructions,
      ].join('\n') : '',
    ].filter(Boolean);
    const messages = systemSections.length > 0
      ? [
        {
          role: 'system',
          content: systemSections.join('\n\n'),
        },
        ...request.messages,
      ]
      : request.messages;
    return {
      ...request,
      messages,
      ...(taskConfiguration.providerId ? { preferredProvider: taskConfiguration.providerId } : {}),
      ...(taskConfiguration.modelId ? { preferredModel: taskConfiguration.modelId } : {}),
      ...(typeof taskConfiguration.fallback === 'boolean' ? { allowFallback: taskConfiguration.fallback } : {}),
      ...(taskConfiguration.difficulty ? { difficulty: taskConfiguration.difficulty } : {}),
      ...(Number.isFinite(taskConfiguration.temperature) ? { temperature: taskConfiguration.temperature } : {}),
      ...(Number.isFinite(taskConfiguration.timeoutMs) ? { timeoutMs: taskConfiguration.timeoutMs } : {}),
      taskOptions,
    };
  }

  function getTaskOptions(taskId) {
    return resolveTaskOptions(taskId, taskConfigurations[taskId] || {});
  }

  async function complete(request = {}) {
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new AiRouterError('messages 不能为空', { code: 'AI_REQUEST_INVALID' });
    }
    const effectiveRequest = applyTaskConfiguration(request);
    const requestNetworkRetries = Math.round(toFiniteNumber(
      effectiveRequest.networkRetries,
      routing.networkRetries,
      0,
      3,
    ));
    const requestJsonRepairRetries = Math.round(toFiniteNumber(
      effectiveRequest.jsonRepairRetries,
      routing.jsonRepairRetries,
      0,
      2,
    ));
    const route = candidatesFor(effectiveRequest);
    if (route.candidates.length === 0) {
      throw new AiRouterError(
        `没有满足能力要求的可用 AI（${route.capabilities.join(', ')}）`,
        { code: 'AI_NO_PROVIDER' },
      );
    }

    const attempts = [];
    for (const { provider, model } of route.candidates) {
      let messages = effectiveRequest.messages;
      let networkAttempt = 0;
      let repairAttempt = 0;
      while (true) {
        try {
          if (typeof effectiveRequest.onAttempt === 'function') {
            try {
              effectiveRequest.onAttempt({
                provider: provider.id,
                model: model.id,
                attempt: networkAttempt + repairAttempt + 1,
                phase: repairAttempt > 0 ? 'repair' : networkAttempt > 0 ? 'retry' : 'request',
                timeoutMs: toFiniteNumber(effectiveRequest.timeoutMs, routing.timeoutMs, 1, 300_000),
                maxTokens: Number.isFinite(effectiveRequest.maxTokens) ? effectiveRequest.maxTokens : null,
                allowFallback: effectiveRequest.allowFallback !== false,
                reasoningMode: effectiveRequest.taskOptions?.reasoningMode || null,
              });
            } catch {
              // Progress reporting must never interrupt the actual AI request.
            }
          }
          const raw = await requestModel(provider, model, effectiveRequest, messages);
          try {
            const validated = validateResult(raw, effectiveRequest);
            recordSuccess(provider.id);
            attempts.push(safeAttempt(provider.id, model.id, repairAttempt > 0 ? 'repair' : 'request', 'success'));
            return {
              ...validated,
              provider: provider.id,
              model: model.id,
              difficulty: route.difficulty,
              attempts,
            };
          } catch (validationError) {
            attempts.push(safeAttempt(provider.id, model.id, 'validation', 'failed', validationError));
            if (repairAttempt < requestJsonRepairRetries) {
              repairAttempt += 1;
              messages = repairMessages(messages, validationError, raw.text, effectiveRequest.responseSchema);
              continue;
            }
            recordFailure(provider.id, validationError);
            break;
          }
        } catch (error) {
          const safeError = error instanceof AiRouterError
            ? error
            : new AiRouterError('AI 调用失败', { code: 'AI_PROVIDER_ERROR', retryable: true, cause: error });
          attempts.push(safeAttempt(provider.id, model.id, 'request', 'failed', safeError));
          if (safeError.retryable && networkAttempt < requestNetworkRetries) {
            networkAttempt += 1;
            await sleep(Math.min(2_000, 200 * (2 ** (networkAttempt - 1))));
            continue;
          }
          recordFailure(provider.id, safeError);
          break;
        }
      }
    }

    const finalAttempt = [...attempts].reverse().find((attempt) => attempt.outcome === 'failed');
    const finalDetail = finalAttempt
      ? `${finalAttempt.provider}/${finalAttempt.model}：${finalAttempt.message || finalAttempt.code || '未知错误'}`
      : '';
    const attemptedModels = new Set(attempts.map((attempt) => `${attempt.provider}/${attempt.model}`));
    const failureTitle = attemptedModels.size <= 1 ? 'AI 调用失败' : '所有可用 AI 均调用失败';
    throw new AiRouterError(`${failureTitle}${finalDetail ? `（${finalDetail}）` : ''}`, {
      code: 'AI_ALL_PROVIDERS_FAILED',
      attempts,
    });
  }

  function getStatus() {
    return {
      providers: providers.map((provider) => ({
        id: provider.id,
        enabled: provider.enabled && Boolean(provider.apiKey),
        models: provider.models.map((model) => ({
          id: model.id,
          capabilities: [...model.capabilities],
          costTier: model.costTier,
          qualityTier: model.qualityTier,
          catalogOnly: model.catalogOnly === true,
        })),
        circuit: {
          open: isCircuitOpen(provider.id),
          consecutiveFailures: getCircuit(provider.id).consecutiveFailures,
          openUntil: getCircuit(provider.id).openUntil || null,
        },
      })),
      tasks: normalizeTaskConfigurations(taskConfigurations),
    };
  }

  function resetCircuit(providerId) {
    if (providerId) circuits.delete(providerId);
    else circuits.clear();
  }

  return {
    complete,
    getTaskOptions,
    getStatus,
    resetCircuit,
  };
}

module.exports = {
  AI_TASK_DEFINITIONS,
  AiRouterError,
  TASK_PARAMETER_DEFINITIONS,
  TASK_PROFILES,
  createAiRouter,
  extractJsonValue,
  loadAiProviderConfigs,
  normalizeTaskConfigurations,
  normalizeNamingRules,
  normalizeTaskOptions,
  normalizeChatCompletionUrl,
  PROVIDER_MODEL_CATALOG,
  resolveTaskOptions,
  validateJsonAgainstSchema,
};
