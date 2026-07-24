import {
  getAgentRuntime,
  getAgentRuntimeStatus,
  getAgentTask,
  LOCAL_AGENT_RUNTIME_PATH,
} from './agent-runtime.js';

export const GLOBAL_AI_SETTINGS_PATH = LOCAL_AGENT_RUNTIME_PATH;

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
  const { runtime, task, settings } = await getAgentTask(env, taskId);
  return {
    ...settings,
    options: settings.options || {},
    namingRules: Array.isArray(settings.namingRules) ? settings.namingRules : [],
    taskId,
    taskLabel: task.label,
    taskProfile: task.profile,
    strictMode: runtime.strictMode,
    failClosed: runtime.failClosed,
    configurationHash: runtime.source.configurationHash,
    workflowHash: runtime.source.workflowHash,
  };
}
