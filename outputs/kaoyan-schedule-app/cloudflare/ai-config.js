import { readJsonFile } from './github-store.js';

export const GLOBAL_AI_SETTINGS_PATH = 'data/config/global-ai-settings.json';

const DEFAULT_TASKS = Object.freeze({
  note_naming: Object.freeze({
    enabled: true,
    customInstructions: '',
    namingRules: [],
    options: Object.freeze({
      titleStyle: 'knowledge_point',
      titleMinLength: 8,
      titleMaxLength: 22,
      useRemark: true,
      preferSpecificSubject: true,
      rejectGenericTitle: true,
      maxTokens: 900,
    }),
  }),
  question_splitting: Object.freeze({
    enabled: true,
    customInstructions: '',
    options: Object.freeze({
      maxQuestions: 24,
      includeQuestionNumber: true,
      includeOptions: true,
      includeDiagram: true,
      edgePaddingPercent: 1.2,
      minimumRegionPercent: 3.5,
      maxTokens: 1600,
    }),
  }),
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, maxLength = 6000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function finite(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeRules(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).filter(isObject).map((rule, index) => ({
    id: text(rule.id, 64) || `naming-rule-${index + 1}`,
    name: text(rule.name, 80),
    enabled: rule.enabled !== false,
    when: text(rule.when, 800),
    extract: text(rule.extract, 800),
    titleTemplate: text(rule.titleTemplate, 240) || '{value}',
    validationHint: text(rule.validationHint, 500),
  }));
}

function normalizeTask(taskId, value) {
  const defaults = DEFAULT_TASKS[taskId] || Object.freeze({ enabled: true, customInstructions: '', options: {} });
  const source = isObject(value) ? value : {};
  const inputOptions = isObject(source.options) ? source.options : {};
  const options = { ...defaults.options };

  if (taskId === 'note_naming') {
    if (['knowledge_point', 'question_type', 'source_wording'].includes(inputOptions.titleStyle)) options.titleStyle = inputOptions.titleStyle;
    options.titleMinLength = Math.round(finite(inputOptions.titleMinLength, defaults.options.titleMinLength, 4, 40));
    options.titleMaxLength = Math.round(finite(inputOptions.titleMaxLength, defaults.options.titleMaxLength, options.titleMinLength, 80));
    if (typeof inputOptions.useRemark === 'boolean') options.useRemark = inputOptions.useRemark;
    if (typeof inputOptions.preferSpecificSubject === 'boolean') options.preferSpecificSubject = inputOptions.preferSpecificSubject;
    if (typeof inputOptions.rejectGenericTitle === 'boolean') options.rejectGenericTitle = inputOptions.rejectGenericTitle;
    options.maxTokens = Math.round(finite(inputOptions.maxTokens, defaults.options.maxTokens, 300, 2400));
  } else if (taskId === 'question_splitting') {
    options.maxQuestions = Math.round(finite(inputOptions.maxQuestions, defaults.options.maxQuestions, 1, 24));
    options.edgePaddingPercent = finite(inputOptions.edgePaddingPercent, defaults.options.edgePaddingPercent, 0, 8);
    options.minimumRegionPercent = finite(inputOptions.minimumRegionPercent, defaults.options.minimumRegionPercent, 1, 20);
    options.maxTokens = Math.round(finite(inputOptions.maxTokens, defaults.options.maxTokens, 500, 4000));
    for (const key of ['includeQuestionNumber', 'includeOptions', 'includeDiagram']) {
      if (typeof inputOptions[key] === 'boolean') options[key] = inputOptions[key];
    }
  }

  return {
    enabled: source.enabled !== false,
    customInstructions: text(source.customInstructions),
    namingRules: taskId === 'note_naming' ? normalizeRules(source.namingRules) : [],
    options,
    // These preferences are retained for the local router. Cloudflare Workers AI
    // deliberately ignores them because provider credentials are environment-only.
    providerId: text(source.providerId, 40),
    modelId: text(source.modelId, 120),
    fallback: typeof source.fallback === 'boolean' ? source.fallback : true,
    temperature: finite(source.temperature, 0.15, 0, 2),
    timeoutMs: Math.round(finite(source.timeoutMs, taskId === 'question_splitting' ? 90000 : 45000, 1000, 300000)),
  };
}

export async function getGlobalAiSettings(env) {
  const file = await readJsonFile(env, GLOBAL_AI_SETTINGS_PATH, {
    allowMissing: true,
    maxBytes: 512 * 1024,
  });
  const source = isObject(file?.value) ? file.value : {};
  const tasks = isObject(source.tasks) ? source.tasks : {};
  return {
    schemaVersion: 1,
    updatedAt: text(source.updatedAt, 80) || null,
    sourceDevice: text(source.sourceDevice, 120) || null,
    tasks: {
      note_naming: normalizeTask('note_naming', tasks.note_naming),
      question_splitting: normalizeTask('question_splitting', tasks.question_splitting),
    },
  };
}

export async function getTaskSettings(env, taskId) {
  const config = await getGlobalAiSettings(env);
  return config.tasks[taskId] || normalizeTask(taskId, null);
}
