import {
  getAgentRuntime,
  getAgentRuntimeStatus,
  getAgentTask,
  LOCAL_AGENT_RUNTIME_PATH,
} from './agent-runtime.js';
import { sha256 } from './http.js';

export const GLOBAL_AI_SETTINGS_PATH = LOCAL_AGENT_RUNTIME_PATH;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

export async function getGlobalAiSettings(env) {
  const runtime = await getAgentRuntime(env);
  const status = await getAgentRuntimeStatus(env);
  return {
    schemaVersion: runtime.schemaVersion,
    updatedAt: runtime.source.updatedAt,
    sourceDevice: 'windows-local-assistant',
    strictMode: true,
    failClosed: true,
    configurationHash: runtime.source.configurationHash,
    workflowHash: runtime.source.workflowHash,
    providers: runtime.providers,
    routing: runtime.routing,
    tasks: Object.fromEntries(Object.entries(runtime.tasks).map(([taskId, task]) => [taskId, {
      ...task.settings,
      active: task.active,
      label: task.label,
      description: task.description,
      profile: task.profile,
      parameterDefinitions: task.parameterDefinitions,
    }])),
    status,
  };
}

export async function getTaskSettings(env, taskId) {
  const { runtime, task, settings, workflow } = await getAgentTask(env, taskId);
  const [taskConfigurationHash, taskWorkflowHash] = await Promise.all([
    sha256(stableJson({
      taskId,
      settings,
      profile: task.profile,
      routing: runtime.routing,
      providers: runtime.providers,
    })),
    sha256(stableJson({ taskId, workflow })),
  ]);
  return {
    ...settings,
    options: settings.options || {},
    namingRules: Array.isArray(settings.namingRules) ? settings.namingRules : [],
    taskId,
    taskLabel: task.label,
    taskProfile: task.profile,
    strictMode: runtime.strictMode,
    failClosed: runtime.failClosed,
    configurationHash: taskConfigurationHash,
    workflowHash: taskWorkflowHash,
    runtimeConfigurationHash: runtime.source.configurationHash,
    runtimeWorkflowHash: runtime.source.workflowHash,
    workflow,
  };
}
