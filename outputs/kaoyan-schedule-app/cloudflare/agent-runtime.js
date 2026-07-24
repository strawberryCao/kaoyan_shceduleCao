import { HttpError } from './http.js';
import { readJsonFile } from './github-store.js';

export const LOCAL_AGENT_RUNTIME_PATH = 'data/config/local-assistant/agent-runtime.json';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, maxLength = 400) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
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

export async function getAgentRuntime(env) {
  const file = await readJsonFile(env, LOCAL_AGENT_RUNTIME_PATH, {
    allowMissing: true,
    maxBytes: 2 * 1024 * 1024,
  });
  if (!file?.value) {
    throw new HttpError(
      503,
      '尚未收到 Windows 局域网版本发布的 Agent 运行时配置。',
      'LOCAL_AGENT_RUNTIME_MISSING',
    );
  }
  const errors = validateRuntime(file.value);
  if (errors.length > 0) {
    throw new HttpError(
      503,
      `局域网 Agent 运行时配置无效：${errors.slice(0, 4).join('；')}`,
      'LOCAL_AGENT_RUNTIME_INVALID',
    );
  }
  const tasks = Object.fromEntries(Object.entries(file.value.tasks)
    .map(([taskId, value]) => [taskId, normalizeTask(taskId, value)])
    .filter(([, value]) => Boolean(value)));
  return {
    schemaVersion: Number(file.value.schemaVersion),
    strictMode: true,
    failClosed: true,
    allowBuiltInFallback: false,
    requireLocalWorkflow: true,
    source: {
      updatedAt: text(file.value.source.updatedAt, 100) || null,
      configurationHash: text(file.value.source.configurationHash, 128),
      workflowHash: text(file.value.source.workflowHash, 128),
      workflowSources: Array.isArray(file.value.source.workflowSources) ? file.value.source.workflowSources : [],
    },
    providers: file.value.providers,
    routing: isObject(file.value.routing) ? file.value.routing : {},
    tasks,
  };
}

export async function getAgentTask(env, taskId) {
  const runtime = await getAgentRuntime(env);
  const task = runtime.tasks[taskId];
  if (!task) {
    throw new HttpError(
      503,
      `局域网运行时没有发布 Agent 任务：${taskId}`,
      'LOCAL_AGENT_TASK_MISSING',
    );
  }
  if (task.active !== true) {
    throw new HttpError(403, `Agent 任务已在局域网版本停用：${task.label}`, 'AI_TASK_DISABLED');
  }
  if (task.settings.enabled === false) {
    throw new HttpError(403, `Agent 任务已在局域网配置中心停用：${task.label}`, 'AI_TASK_DISABLED');
  }
  return { runtime, task, settings: task.settings };
}

export function providerSecretStatus(env, runtime) {
  return Object.fromEntries(Object.entries(runtime.providers || {}).map(([providerId, provider]) => {
    const secretRef = text(provider?.secretRef, 100);
    const configured = Boolean(secretRef && env?.[secretRef]);
    return [providerId, {
      secretRef: secretRef || null,
      configured,
      cloudUsable: provider?.cloudUsable !== false,
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
    configuredTasks: Object.keys(runtime.tasks),
    activeTasks: Object.values(runtime.tasks).filter((task) => task.active).map((task) => task.id),
    providerSecrets: providerSecretStatus(env, runtime),
  };
}
