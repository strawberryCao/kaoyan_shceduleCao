import { HttpError, sha256 } from './http.js';
import { readJsonFile } from './github-store.js';

export const LOCAL_AGENT_RUNTIME_PATH = 'data/config/local-assistant/agent-runtime.json';
export const LEGACY_V11_WORKFLOW_COMPAT_PATH = 'control-plane/compatibility/legacy-v11-analysis-workflows.json';

const LEGACY_V11_WORKFLOW_SOURCE_HASH = '511f580d975f781567f37c5bf7ad9410b50c420c6622340b821e8191c40c1c22';
// Keep the two legacy analysis workflows as the global compatibility floor.
// Canvas is validated only when that task is requested, so an older published
// runtime cannot disable unrelated note AI while waiting for the next sync.
const REQUIRED_COMPLETE_WORKFLOWS = Object.freeze(['note_enrichment', 'note_image_understanding']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, maxLength = 400) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function runtimeWorkflowSourceHash(value) {
  const sources = Array.isArray(value?.source?.workflowSources) ? value.source.workflowSources : [];
  const source = sources.find((item) => item?.path === 'agent-workflow-contracts.cjs');
  return text(source?.sha256, 128);
}

function inferCapabilities(providerId, modelId) {
  const model = text(modelId, 160).toLowerCase();
  const result = ['text', 'json'];
  if (
    providerId === 'gemini'
    || /(?:^|[-_.])(vl|vision)(?:[-_.]|$)/i.test(model)
    || /qwen.*vl/i.test(model)
    || /kimi-(?:k2\.(?:5|6)|k3)(?:[-_.]|$)/i.test(model)
  ) result.push('vision');
  if (providerId === 'gemini' || providerId === 'deepseek' || /(?:long|128k|256k|k2)/i.test(model)) result.push('longContext');
  if (/(?:pro|max|thinking|reason|k2\.[56])/i.test(model)) result.push('reasoning');
  return [...new Set(result)];
}

function normalizeModel(providerId, value, catalogOnly = false) {
  const source = typeof value === 'string' ? { id: value } : value;
  if (!isObject(source)) return null;
  const id = text(source.id || source.model, 160);
  if (!id) return null;
  return {
    ...source,
    id,
    capabilities: Array.isArray(source.capabilities) && source.capabilities.length > 0
      ? [...new Set(source.capabilities.map((item) => text(item, 40)).filter(Boolean))]
      : inferCapabilities(providerId, id),
    catalogOnly: source.catalogOnly === true || catalogOnly,
  };
}

function normalizeProvider(providerId, value, preferredModelIds) {
  if (!isObject(value)) return null;
  const explicit = (Array.isArray(value.models) ? value.models : [])
    .map((model) => normalizeModel(providerId, model, false))
    .filter(Boolean);
  const ids = new Set(explicit.map((model) => model.id));
  const selectedCatalog = (Array.isArray(value.catalog) ? value.catalog : [])
    .filter((modelId) => preferredModelIds.has(text(modelId, 160)) && !ids.has(text(modelId, 160)))
    .map((modelId) => normalizeModel(providerId, modelId, true))
    .filter(Boolean);
  return {
    ...value,
    id: providerId,
    models: [...explicit, ...selectedCatalog],
  };
}

function validateRuntime(value) {
  const errors = [];
  if (!isObject(value)) return ['运行时根节点必须是对象'];
  if (Number(value.schemaVersion) < 2) errors.push('schemaVersion 必须大于等于 2');
  if (value.strictMode !== true) errors.push('strictMode 必须为 true');
  if (value.failClosed !== true) errors.push('failClosed 必须为 true');
  if (value.allowBuiltInFallback !== false) errors.push('allowBuiltInFallback 必须为 false');
  if (value.requireLocalWorkflow !== true) errors.push('requireLocalWorkflow 必须为 true');
  if (!isObject(value.source)) errors.push('缺少 source');
  if (!text(value.source?.workflowHash, 128)) errors.push('缺少 workflowHash');
  if (!text(value.source?.configurationHash, 128)) errors.push('缺少 configurationHash');
  if (!isObject(value.tasks) || Object.keys(value.tasks).length === 0) errors.push('缺少 Agent 任务合同');
  if (!isObject(value.providers)) errors.push('providers 必须是对象');
  if (value.workflows !== undefined && !isObject(value.workflows)) errors.push('workflows 必须是对象');
  return errors;
}

function normalizeTask(taskId, value) {
  if (!isObject(value)) return null;
  const settings = isObject(value.settings) ? value.settings : {};
  return {
    id: taskId,
    label: text(value.label, 120) || taskId,
    description: text(value.description, 800),
    active: value.active === true,
    profile: isObject(value.profile) ? value.profile : {},
    parameterDefinitions: Array.isArray(value.parameterDefinitions) ? value.parameterDefinitions : [],
    settings: {
      ...settings,
      options: isObject(settings.options) ? settings.options : {},
      namingRules: Array.isArray(settings.namingRules) ? settings.namingRules : [],
    },
  };
}

function normalizeWorkflow(taskId, value) {
  if (!isObject(value)) return null;
  const prompt = isObject(value.prompt) ? value.prompt : {};
  const instructions = Array.isArray(prompt.instructions)
    ? prompt.instructions.map((item) => text(item, 2000)).filter(Boolean).slice(0, 40)
    : [];
  const steps = Array.isArray(value.steps)
    ? value.steps.map((item) => text(item, 400)).filter(Boolean).slice(0, 30)
    : [];
  const outputFormat = text(prompt.outputFormat, 4000);
  if (!text(value.version, 120) || instructions.length === 0 || !outputFormat || steps.length === 0) return null;
  return { id: taskId, version: text(value.version, 120), steps, prompt: { instructions, outputFormat } };
}

function missingCompleteWorkflows(workflows) {
  return REQUIRED_COMPLETE_WORKFLOWS.filter((taskId) => !workflows[taskId]);
}

async function loadLegacyV11Compatibility(env, runtimeValue, workflows) {
  const missing = missingCompleteWorkflows(workflows);
  if (missing.length === 0) return { workflows, compatibility: null };
  const sourceHash = runtimeWorkflowSourceHash(runtimeValue);
  if (sourceHash !== LEGACY_V11_WORKFLOW_SOURCE_HASH) return { workflows, compatibility: null };

  const file = await readJsonFile(env, LEGACY_V11_WORKFLOW_COMPAT_PATH, {
    allowMissing: true,
    maxBytes: 256 * 1024,
  });
  const value = file?.value;
  if (!isObject(value)) {
    throw new HttpError(503, '旧 V11 缺少完整分析工作流，且数据控制面兼容合同不存在。', 'LOCAL_AGENT_COMPATIBILITY_MISSING');
  }
  if (
    Number(value.schemaVersion) !== 1
    || value.expiresWhenWorkflowSourceChanges !== true
    || text(value.legacyWorkflowSourceHash, 128) !== sourceHash
  ) {
    throw new HttpError(503, '数据控制面兼容合同与当前局域网 V11 源码哈希不匹配。', 'LOCAL_AGENT_COMPATIBILITY_INVALID');
  }
  const declaredHash = text(value.workflowContentHash, 128);
  const actualHash = await sha256(stableJson(value.workflows || {}));
  if (!declaredHash || declaredHash !== actualHash) {
    throw new HttpError(503, '数据控制面兼容合同内容哈希校验失败。', 'LOCAL_AGENT_COMPATIBILITY_INVALID');
  }

  const compatible = Object.fromEntries(Object.entries(value.workflows || {})
    .map(([taskId, workflow]) => [taskId, normalizeWorkflow(taskId, workflow)])
    .filter(([, workflow]) => Boolean(workflow)));
  const invalid = missing.filter((taskId) => !compatible[taskId]);
  if (invalid.length > 0) {
    throw new HttpError(503, `数据控制面兼容合同缺少完整工作流：${invalid.join('、')}`, 'LOCAL_AGENT_COMPATIBILITY_INVALID');
  }
  return {
    workflows: { ...workflows, ...compatible },
    compatibility: {
      id: text(value.compatibilityId, 120) || 'legacy-v11-full-note-analysis',
      workflowSourceHash: sourceHash,
      workflowContentHash: actualHash,
      path: LEGACY_V11_WORKFLOW_COMPAT_PATH,
      tasks: missing,
    },
  };
}

export async function getAgentRuntime(env) {
  const file = await readJsonFile(env, LOCAL_AGENT_RUNTIME_PATH, {
    allowMissing: true,
    maxBytes: 2 * 1024 * 1024,
  });
  if (!file?.value) {
    throw new HttpError(503, '尚未收到 Windows 局域网版本发布的 Agent 运行时配置。', 'LOCAL_AGENT_RUNTIME_MISSING');
  }
  const errors = validateRuntime(file.value);
  if (errors.length > 0) {
    throw new HttpError(503, `局域网 Agent 运行时配置无效：${errors.slice(0, 4).join('；')}`, 'LOCAL_AGENT_RUNTIME_INVALID');
  }
  const tasks = Object.fromEntries(Object.entries(file.value.tasks)
    .map(([taskId, value]) => [taskId, normalizeTask(taskId, value)])
    .filter(([, value]) => Boolean(value)));
  const preferredModelIds = new Set(Object.values(tasks).map((task) => text(task.settings.modelId, 160)).filter(Boolean));
  const providers = Object.fromEntries(Object.entries(file.value.providers)
    .map(([providerId, value]) => [providerId, normalizeProvider(providerId, value, preferredModelIds)])
    .filter(([, value]) => Boolean(value)));
  const publishedWorkflows = Object.fromEntries(Object.entries(file.value.workflows || {})
    .map(([taskId, value]) => [taskId, normalizeWorkflow(taskId, value)])
    .filter(([, value]) => Boolean(value)));
  const resolved = await loadLegacyV11Compatibility(env, file.value, publishedWorkflows);
  const publishedWorkflowHash = text(file.value.source.workflowHash, 128);
  const effectiveWorkflowHash = resolved.compatibility
    ? await sha256(stableJson({ publishedWorkflowHash, compatibilityWorkflowHash: resolved.compatibility.workflowContentHash }))
    : publishedWorkflowHash;
  return {
    schemaVersion: Number(file.value.schemaVersion),
    strictMode: true,
    failClosed: true,
    allowBuiltInFallback: false,
    requireLocalWorkflow: true,
    source: {
      updatedAt: text(file.value.source.updatedAt, 100) || null,
      configurationHash: text(file.value.source.configurationHash, 128),
      workflowHash: effectiveWorkflowHash,
      publishedWorkflowHash,
      workflowSources: Array.isArray(file.value.source.workflowSources) ? file.value.source.workflowSources : [],
      compatibility: resolved.compatibility,
    },
    providers,
    routing: isObject(file.value.routing) ? file.value.routing : {},
    tasks,
    workflows: resolved.workflows,
  };
}

export async function getAgentTask(env, taskId) {
  const runtime = await getAgentRuntime(env);
  const task = runtime.tasks[taskId];
  if (!task) throw new HttpError(503, `局域网运行时没有发布 Agent 任务：${taskId}`, 'LOCAL_AGENT_TASK_MISSING');
  if (task.active !== true) throw new HttpError(403, `Agent 任务已在局域网版本停用：${task.label}`, 'AI_TASK_DISABLED');
  if (task.settings.enabled === false) throw new HttpError(403, `Agent 任务已在局域网配置中心停用：${task.label}`, 'AI_TASK_DISABLED');
  const workflow = runtime.workflows?.[taskId] || null;
  if (['note_naming', 'question_splitting', 'note_enrichment', 'note_image_understanding', 'canvas_note_understanding'].includes(taskId) && !workflow) {
    throw new HttpError(503, `局域网运行时没有发布完整工作流：${taskId}`, 'LOCAL_AGENT_WORKFLOW_MISSING');
  }
  return { runtime, task, settings: task.settings, workflow };
}

export function providerSecretStatus(env, runtime) {
  return Object.fromEntries(Object.entries(runtime.providers || {}).map(([providerId, provider]) => {
    const secretRef = text(provider?.secretRef, 100);
    const configured = Boolean(secretRef && env?.[secretRef]);
    return [providerId, {
      secretRef: secretRef || null,
      configured,
      cloudUsable: provider?.cloudUsable !== false,
      modelCount: Array.isArray(provider?.models) ? provider.models.length : 0,
    }];
  }));
}

export async function getAgentRuntimeStatus(env) {
  const runtime = await getAgentRuntime(env);
  return {
    strictMode: runtime.strictMode,
    failClosed: runtime.failClosed,
    configurationUpdatedAt: runtime.source.updatedAt,
    configurationHash: runtime.source.configurationHash,
    workflowHash: runtime.source.workflowHash,
    publishedWorkflowHash: runtime.source.publishedWorkflowHash,
    compatibility: runtime.source.compatibility,
    configuredTasks: Object.keys(runtime.tasks),
    activeTasks: Object.values(runtime.tasks).filter((task) => task.active).map((task) => task.id),
    workflowVersions: Object.fromEntries(Object.entries(runtime.workflows || {}).map(([taskId, workflow]) => [taskId, workflow.version])),
    providerSecrets: providerSecretStatus(env, runtime),
  };
}

export const agentRuntimeInternals = Object.freeze({
  inferCapabilities,
  missingCompleteWorkflows,
  normalizeProvider,
  normalizeWorkflow,
  runtimeWorkflowSourceHash,
  stableJson,
});
