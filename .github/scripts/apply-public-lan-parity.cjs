const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const app = path.join(root, 'outputs', 'kaoyan-schedule-app');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function write(relative, content) {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.replace(/[ \t]+$/gm, '') + (content.endsWith('\n') ? '' : '\n'), 'utf8');
}

function replaceOnce(relative, search, replacement, label) {
  const source = read(relative);
  const count = typeof search === 'string'
    ? source.split(search).length - 1
    : [...source.matchAll(new RegExp(search.source, search.flags.includes('g') ? search.flags : search.flags + 'g'))].length;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`);
  const next = source.replace(search, replacement);
  write(relative, next);
}

function appendOnce(relative, marker, content) {
  const source = read(relative);
  if (source.includes(marker)) return;
  write(relative, source.trimEnd() + '\n\n' + content.trim() + '\n');
}

const contractsPath = 'outputs/kaoyan-schedule-app/scripts/agent-workflow-contracts.cjs';
write(contractsPath, String.raw`'use strict';

const DEFAULT_WORKFLOWS = Object.freeze({
  note_naming: Object.freeze({
    version: 'note-naming-v3',
    steps: Object.freeze([
      '读取局域网 note_naming 任务设置',
      '读取原图与最新用户备注',
      '按局域网 Provider/模型/回退约束路由',
      '应用局域网字段命名规则与标题限制',
      '校验中文标题、科目与 Windows 文件名安全性',
      '更新学习记录与 source-notes 镜像元数据',
    ]),
    prompt: Object.freeze({
      instructions: Object.freeze([
        '你是考研学习笔记整理助手。请结合图片内容和用户备注，为这张学习截图生成适合 Windows 文件名的中文标题。',
        '识别所属科目，只能从 {allowedSubjects} 中选择。',
        '{subjectSelectionRule}',
        'title 目标长度为 {titleMinLength} 到 {titleMaxLength} 个字符，{titleStyleText}。',
        '不要输出随机数、日期或文件后缀。',
        '不要使用 Windows 非法字符：<>:"/\\|?*。',
        '逐条检查字段命名规则。只有图片中能直接看到规则要求的标签及对应值时才算匹配，严禁用相似编号、日期或其他字段猜测。',
        '匹配规则时，ruleId 填规则 id，ruleValue 填原图提取值，ruleEvidence 简述证据；title 仍给出普通内容标题，程序会套用模板。',
        '{genericTitleRule}',
        '保存类型：{captureType}',
        '用户备注：{remark}',
        '字段命名规则：{namingRules}',
      ]),
      outputFormat: '只输出 JSON：{"subject":"科目","title":"标题","reason":"一句话依据","ruleId":"匹配规则id或空字符串","ruleValue":"提取值或空字符串","ruleEvidence":"原图证据或空字符串"}',
    }),
  }),
  question_splitting: Object.freeze({
    version: 'question-splitting-v3',
    steps: Object.freeze([
      '客户端预裁剪并压缩整页图片',
      '读取局域网 question_splitting 任务设置',
      '按局域网 Provider/模型/回退约束路由',
      '识别完整题目区域',
      '按局域网最小区域与留白参数规范化',
      '返回区域给客户端生成可人工调整的裁剪结果',
    ]),
    prompt: Object.freeze({
      instructions: Object.freeze([
        '你是考研题目区域识别器。请在用户已经预裁剪的整页图片中找出每一道完整且相互独立的题目。',
        '不要把同一道题拆成多个区域，也不要把相邻的不同题目合并。',
        '{questionNumberRule}',
        '{optionsRule}',
        '{diagramRule}',
        '原图尺寸：{width}×{height}。',
        'x、y、width、height 使用 0 到 1 的归一化坐标；x、y 是左上角。按从上到下、同一行从左到右排序。',
        '最多返回 {maxQuestions} 个区域。没有可靠区域时返回空 regions。',
      ]),
      outputFormat: '只返回 JSON 对象：{"regions":[{"x":0.0,"y":0.0,"width":0.5,"height":0.3}]}',
    }),
  }),
});

function cleanText(value, maxLength = 4000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function cleanLines(value, fallback) {
  const lines = Array.isArray(value)
    ? value.map((item) => cleanText(item, 2000)).filter(Boolean).slice(0, 40)
    : [];
  return lines.length ? lines : [...fallback];
}

function normalizeWorkflow(taskId, value, fallback) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const prompt = input.prompt && typeof input.prompt === 'object' && !Array.isArray(input.prompt) ? input.prompt : {};
  return {
    id: taskId,
    version: cleanText(input.version, 120) || fallback.version,
    steps: cleanLines(input.steps, fallback.steps),
    prompt: {
      instructions: cleanLines(prompt.instructions, fallback.prompt.instructions),
      outputFormat: cleanText(prompt.outputFormat, 4000) || fallback.prompt.outputFormat,
    },
  };
}

function buildPublicWorkflowContracts(overrides = {}) {
  const source = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
  return Object.fromEntries(Object.entries(DEFAULT_WORKFLOWS).map(([taskId, fallback]) => [
    taskId,
    normalizeWorkflow(taskId, source[taskId], fallback),
  ]));
}

module.exports = {
  DEFAULT_WORKFLOWS,
  buildPublicWorkflowContracts,
};
`);

// Export the local control-plane workflow contracts with the existing runtime.
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/export-agent-runtime.cjs',
  "} = require('./ai-router.cjs');\n",
  "} = require('./ai-router.cjs');\nconst { buildPublicWorkflowContracts } = require('./agent-workflow-contracts.cjs');\n",
  'exporter import workflow contracts',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/export-agent-runtime.cjs',
  "const CONFIG_FILES = new Set(['ai-providers.json', 'qwen-config.json', 'note-taxonomy.json', 'desktop-layout.json']);",
  "const CONFIG_FILES = new Set(['ai-providers.json', 'qwen-config.json', 'agent-workflows.json', 'note-taxonomy.json', 'desktop-layout.json']);",
  'exporter config file allowlist',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/export-agent-runtime.cjs',
  "return ['ai-router.cjs', 'note-ai-analyzer.cjs', 'canvas-ai-organizer.cjs', 'review-github-sync.cjs', 'note-server.cjs']",
  "return ['ai-router.cjs', 'agent-workflow-contracts.cjs', 'note-ai-analyzer.cjs', 'canvas-ai-organizer.cjs', 'review-github-sync.cjs', 'note-server.cjs']",
  'exporter workflow source list',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/export-agent-runtime.cjs',
  "  const tasks = buildTaskContracts(aiConfig.tasks);\n  const workflowSources = workflowSourceRecords();\n  const configurationHash = sha256(stableJson(includedFiles.map(({ path: filePath, sha256: hash }) => ({ path: filePath, sha256: hash }))));\n  const workflowHash = sha256(stableJson({ tasks, workflowSources }));",
  "  const tasks = buildTaskContracts(aiConfig.tasks);\n  const workflowOverrides = readJson(path.join(assistantRoot, 'agent-workflows.json'), aiConfig.workflows || {});\n  const workflows = buildPublicWorkflowContracts(workflowOverrides);\n  const workflowSources = workflowSourceRecords();\n  const configurationHash = sha256(stableJson(includedFiles.map(({ path: filePath, sha256: hash }) => ({ path: filePath, sha256: hash }))));\n  const workflowHash = sha256(stableJson({ tasks, workflows, workflowSources }));\n  const publishedAt = new Date().toISOString();",
  'exporter workflow payload',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/export-agent-runtime.cjs',
  "      updatedAt: null,\n      configurationHash,",
  "      updatedAt: publishedAt,\n      publishedAt,\n      sourceDevice: os.hostname(),\n      configurationHash,",
  'exporter runtime source metadata',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/export-agent-runtime.cjs',
  "    routing: sanitizeValue(aiConfig.routing || {}, report),\n    tasks,\n  };",
  "    routing: sanitizeValue(aiConfig.routing || {}, report),\n    tasks,\n    workflows,\n  };",
  'exporter runtime workflows',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/export-agent-runtime.cjs',
  "    workflowHash,\n    runtimeHash,",
  "    workflowHash,\n    runtimeHash,\n    publishedAt,",
  'exporter manifest timestamp',
);

// Cloudflare must consume the local workflow contract for the two mobile capture tasks.
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/agent-runtime.js',
  "  if (!isObject(value.providers)) errors.push('providers 必须是对象');\n  return errors;",
  "  if (!isObject(value.providers)) errors.push('providers 必须是对象');\n  if (value.workflows !== undefined && !isObject(value.workflows)) errors.push('workflows 必须是对象');\n  return errors;",
  'runtime workflow validation',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/agent-runtime.js',
  "export async function getAgentRuntime(env) {",
  String.raw`function normalizeWorkflow(taskId, value) {
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

export async function getAgentRuntime(env) {`,
  'runtime workflow normalizer',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/agent-runtime.js',
  "  const providers = Object.fromEntries(Object.entries(file.value.providers)\n    .map(([providerId, value]) => [providerId, normalizeProvider(providerId, value, preferredModelIds)])\n    .filter(([, value]) => Boolean(value)));",
  "  const providers = Object.fromEntries(Object.entries(file.value.providers)\n    .map(([providerId, value]) => [providerId, normalizeProvider(providerId, value, preferredModelIds)])\n    .filter(([, value]) => Boolean(value)));\n  const workflows = Object.fromEntries(Object.entries(file.value.workflows || {})\n    .map(([taskId, value]) => [taskId, normalizeWorkflow(taskId, value)])\n    .filter(([, value]) => Boolean(value)));",
  'runtime workflow map',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/agent-runtime.js',
  "    routing: isObject(file.value.routing) ? file.value.routing : {},\n    tasks,\n  };",
  "    routing: isObject(file.value.routing) ? file.value.routing : {},\n    tasks,\n    workflows,\n  };",
  'runtime return workflows',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/agent-runtime.js',
  "  if (task.settings.enabled === false) throw new HttpError(403, `Agent 任务已在局域网配置中心停用：${task.label}`, 'AI_TASK_DISABLED');\n  return { runtime, task, settings: task.settings };",
  "  if (task.settings.enabled === false) throw new HttpError(403, `Agent 任务已在局域网配置中心停用：${task.label}`, 'AI_TASK_DISABLED');\n  const workflow = runtime.workflows?.[taskId] || null;\n  if (['note_naming', 'question_splitting'].includes(taskId) && !workflow) {\n    throw new HttpError(503, `局域网运行时没有发布完整工作流：${taskId}`, 'LOCAL_AGENT_WORKFLOW_MISSING');\n  }\n  return { runtime, task, settings: task.settings, workflow };",
  'runtime task workflow enforcement',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/agent-runtime.js',
  "    activeTasks: Object.values(runtime.tasks).filter((task) => task.active).map((task) => task.id),\n    providerSecrets:",
  "    activeTasks: Object.values(runtime.tasks).filter((task) => task.active).map((task) => task.id),\n    workflowVersions: Object.fromEntries(Object.entries(runtime.workflows || {}).map(([taskId, workflow]) => [taskId, workflow.version])),\n    providerSecrets:",
  'runtime status workflow versions',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/agent-runtime.js',
  "  normalizeProvider,\n});",
  "  normalizeProvider,\n  normalizeWorkflow,\n});",
  'runtime internals workflow normalizer',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/ai-config.js',
  "  const { runtime, task, settings } = await getAgentTask(env, taskId);",
  "  const { runtime, task, settings, workflow } = await getAgentTask(env, taskId);",
  'ai config workflow destructure',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/ai-config.js',
  "    workflowHash: runtime.source.workflowHash,\n  };",
  "    workflowHash: runtime.source.workflowHash,\n    workflow,\n  };",
  'ai config workflow return',
);

replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/ai.js',
  /function splittingPrompt\(settings, width, height\) \{[\s\S]*?\n\}\n\nexport async function detectQuestions/,
  String.raw`function fillTemplate(value, variables) {
  return String(value || '').replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) => String(variables[key] ?? ''));
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
    fillTemplate(workflow.prompt.outputFormat, variables),
    settings.customInstructions ? '局域网配置中心附加规则：' + settings.customInstructions : '',
  ].filter(Boolean).join('\n');
}

export async function detectQuestions`,
  'question splitting prompt from local contract',
);

// Naming becomes available for ordinary mobile single captures as well as multi-question notes.
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/rename-job.js',
  "import { assertRepoPath, readFile } from './github-store.js';\nimport { findNote, getLearningSnapshot, patchNote } from './learning.js';",
  "import { assertRepoPath, readFile } from './github-store.js';\nimport { findNote, getLearningSnapshot, patchNote } from './learning.js';\nimport { updateMirroredCloudNote } from './source-mirror.js';",
  'rename mirror import',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/rename-job.js',
  /function isAiMultiQuestionNote\(note\) \{[\s\S]*?\n\}/,
  String.raw`function isRenameEligibleNote(note) {
  const sourceType = String(note?.sourceType || '');
  const filePath = String(note?.filePath || '').replaceAll('\\', '/');
  return Boolean(note) && (
    sourceType === 'ai-multi-question'
    || sourceType === 'single-capture'
    || /^multi_[A-Za-z0-9_-]+/i.test(String(note.noteUid || ''))
    || (Array.isArray(note.tags) && note.tags.includes('AI多题拆分'))
    || /^github:\/\/data\/assets\/.+\.(?:jpe?g|png|webp|gif|avif)$/i.test(filePath)
  );
}`,
  'rename eligible notes',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/rename-job.js',
  /function namingPrompt\(settings, remark, repairReason = ''\) \{[\s\S]*?\n\}/,
  String.raw`function fillTemplate(value, variables) {
  return String(value || '').replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) => String(variables[key] ?? ''));
}

function namingPrompt(settings, remark, repairReason = '', captureType = '手机单题拍照') {
  const workflow = settings.workflow;
  if (!workflow?.prompt?.instructions?.length || !workflow.prompt.outputFormat) {
    throw new HttpError(503, '局域网没有发布拍照命名 Prompt 合同。', 'LOCAL_AGENT_WORKFLOW_MISSING');
  }
  const options = settings.options || {};
  const titleMinLength = Math.max(4, Math.min(40, Number(options.titleMinLength) || 8));
  const titleMaxLength = Math.max(titleMinLength, Math.min(80, Number(options.titleMaxLength) || 22));
  const effectiveRemark = options.useRemark === false ? '' : remark;
  const titleStyleText = {
    knowledge_point: '优先使用知识点或核心概念名称',
    question_type: '优先体现题型与考查动作',
    source_wording: '优先贴近原图中的准确措辞',
  }[options.titleStyle] || '优先使用知识点或核心概念名称';
  const rules = namingRules(settings);
  const variables = {
    allowedSubjects: ALLOWED_SUBJECTS.join('、'),
    subjectSelectionRule: options.preferSpecificSubject === false
      ? '按图片内容选择科目；确实不清晰或跨科时可选择“默认文件夹”。'
      : '只要图片或备注能看出学科，就必须选择最合理的具体科目；只有图片不可读、没有学习内容或确实无法判断时才选“默认文件夹”。',
    titleMinLength,
    titleMaxLength,
    titleStyleText,
    genericTitleRule: options.rejectGenericTitle === false
      ? '没有规则匹配时，ruleId、ruleValue、ruleEvidence 输出空字符串；title 应尽量具体。'
      : '没有规则匹配时，ruleId、ruleValue、ruleEvidence 输出空字符串；禁止使用“待识别、无法识别、未知内容、截图、图片笔记”等空泛标题。',
    captureType,
    remark: effectiveRemark || '无',
    namingRules: rules.length ? JSON.stringify(rules) : '无',
  };
  return [
    ...workflow.prompt.instructions.map((line) => fillTemplate(line, variables)).filter(Boolean),
    fillTemplate(workflow.prompt.outputFormat, variables),
    settings.customInstructions ? '局域网配置中心附加规则：' + settings.customInstructions : '',
    repairReason ? '上一版结果未通过程序校验：' + repairReason + '。必须修正后重新输出。' : '',
  ].filter(Boolean).join('\n');
}`,
  'naming prompt from local contract',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/rename-job.js',
  "async function generateTitle(env, image, settings, remark, repairReason = '') {",
  "async function generateTitle(env, image, settings, remark, repairReason = '', captureType = '手机单题拍照') {",
  'generate title capture type',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/rename-job.js',
  "        { type: 'text', text: namingPrompt(settings, remark, repairReason) },",
  "        { type: 'text', text: namingPrompt(settings, remark, repairReason, captureType) },",
  'generate title prompt call',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/rename-job.js',
  "    title,\n    problem: titleProblem(title, settings),",
  "    title,\n    subject,\n    problem: titleProblem(title, settings),",
  'generate title returns subject',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/rename-job.js',
  "  if (!isAiMultiQuestionNote(initialEntry.note)) throw new HttpError(403, '只有 AI 多题拆分生成的笔记可以重新命名。', 'AI_RENAME_NOT_ALLOWED');",
  "  if (!isRenameEligibleNote(initialEntry.note)) throw new HttpError(403, '这条记录没有可供局域网命名 Agent 处理的云端原图。', 'AI_RENAME_NOT_ALLOWED');",
  'rename eligibility check',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/rename-job.js',
  "  let generated = await generateTitle(env, image, settings, remark);\n  if (generated.problem) generated = await generateTitle(env, image, settings, remark, generated.problem);",
  "  const captureType = isRenameEligibleNote(initialEntry.note) && initialEntry.note.sourceType === 'ai-multi-question'\n    ? 'AI 多题拆分后的单题图片'\n    : '手机单题拍照';\n  let generated = await generateTitle(env, image, settings, remark, '', captureType);\n  if (generated.problem) generated = await generateTitle(env, image, settings, remark, generated.problem, captureType);",
  'rename prompt capture type',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/rename-job.js',
  "  const snapshot = await patchNote(env, noteUid, { patch: { title: generated.title } });\n  return {",
  "  const snapshot = await patchNote(env, noteUid, { patch: {\n    title: generated.title,\n    subject: generated.subject,\n    knowledgePath: [generated.subject],\n  } });\n  const updatedNote = findNote(snapshot, noteUid)?.note;\n  if (updatedNote) await updateMirroredCloudNote(env, updatedNote);\n  return {",
  'rename updates local mirror metadata',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/rename-job.js',
  "  namingPrompt,\n  titleProblem,",
  "  isRenameEligibleNote,\n  namingPrompt,\n  titleProblem,",
  'rename internals eligibility',
);

replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/background-jobs.js',
  "import { runConfiguredRename } from './rename-job.js';",
  "import { isRenameEligibleNote, runConfiguredRename } from './rename-job.js';",
  'background rename eligibility import',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/background-jobs.js',
  /export function isAiMultiQuestionNote\(note\) \{[\s\S]*?\n\}/,
  String.raw`export function isRenameEligibleNote(note) {
  const sourceType = String(note?.sourceType || '');
  const filePath = String(note?.filePath || '').replaceAll('\\', '/');
  return Boolean(note) && (
    sourceType === 'ai-multi-question'
    || sourceType === 'single-capture'
    || /^multi_[A-Za-z0-9_-]+/i.test(String(note.noteUid || ''))
    || (Array.isArray(note.tags) && note.tags.includes('AI多题拆分'))
    || /^github:\/\/data\/assets\/.+\.(?:jpe?g|png|webp|gif|avif)$/i.test(filePath)
  );
}`,
  'background eligible notes',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/background-jobs.js',
  "  if (!isAiMultiQuestionNote(entry.note)) {\n    throw new HttpError(403, '只有 AI 多题拆分生成的笔记可以使用这个重新命名入口。', 'AI_RENAME_NOT_ALLOWED');\n  }",
  "  if (!isRenameEligibleNote(entry.note)) {\n    throw new HttpError(403, '这条记录没有可供局域网命名 Agent 处理的云端原图。', 'AI_RENAME_NOT_ALLOWED');\n  }",
  'background rename permission',
);

// Queue local-control-plane naming for every public image save.
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/media.js',
  "import { mirrorNewCloudImage, mirroredCloudImagePaths } from './source-mirror.js';",
  "import { mirrorNewCloudImage, mirroredCloudImagePaths } from './source-mirror.js';\nimport { enqueueRenameJob, processBackgroundJob } from './background-jobs.js';",
  'media background rename import',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/media.js',
  "  const note = createSavedImageNote({ ...payload, noteUid }, { repoPath }, timestamp);",
  "  const note = createSavedImageNote({ ...payload, sourceType: payload.sourceType || 'single-capture', noteUid }, { repoPath }, timestamp);",
  'media single capture source type',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/media.js',
  "    aiStatus: note.sourceType === 'ai-multi-question' ? 'pending' : 'unavailable',\n    aiAvailable: note.sourceType === 'ai-multi-question',",
  "    aiStatus: 'pending',\n    aiAvailable: true,",
  'media naming status',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/cloudflare/media.js',
  "  const backgroundWork = Promise.allSettled([\n    mirrorNewCloudImage(env, image, note, payload, timestamp),\n    saveReceipt(env, 'save-note', noteUid, requestHash, { ...response, learningData: undefined }),\n  ]).then((result) => reportBackgroundFailure('cloud_note_post_save_failed', noteUid, result));",
  "  const backgroundWork = Promise.allSettled([\n    mirrorNewCloudImage(env, image, note, payload, timestamp),\n    saveReceipt(env, 'save-note', noteUid, requestHash, { ...response, learningData: undefined }),\n  ]).then(async (result) => {\n    reportBackgroundFailure('cloud_note_post_save_failed', noteUid, result);\n    try {\n      const queued = await enqueueRenameJob(env, noteUid);\n      await processBackgroundJob(env, queued.job.id);\n    } catch (error) {\n      console.error(JSON.stringify({ level: 'error', event: 'cloud_note_naming_failed', noteUid, error: error instanceof Error ? error.message : String(error) }));\n    }\n  });",
  'media queue background naming',
);

// Public client waits for the locally configured task instead of aborting at 45 seconds.
replaceOnce(
  'outputs/kaoyan-schedule-app/src/utils/notes.ts',
  "const AI_REQUEST_TIMEOUT_MS = 45_000;",
  "const AI_REQUEST_TIMEOUT_MS = 180_000;",
  'public AI timeout parity',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/src/utils/notes.ts',
  "  model?: string;\n  regions: NormalizedCrop[];",
  "  provider?: string;\n  model?: string;\n  configurationHash?: string;\n  workflowHash?: string;\n  regions: NormalizedCrop[];",
  'detection metadata types',
);

replaceOnce(
  'outputs/kaoyan-schedule-app/src/components/NoteDropApp.tsx',
  "  renameLearningNoteWithAi,\n",
  "",
  'remove blocking explicit rename import',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/src/components/NoteDropApp.tsx',
  "  const dragDepthRef = useRef(0);",
  "  const dragDepthRef = useRef(0);\n  const detectionRunRef = useRef(0);",
  'detection run token',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/src/components/NoteDropApp.tsx',
  /  const confirmMultiPreCrop = async \(crop: NormalizedCrop\) => \{[\s\S]*?\n  const confirmBatchCrop = async/,
  String.raw`  const buildDetectedBatch = async (src: string, sourceUid: string) => {
    const runId = ++detectionRunRef.current;
    setMobileStep('detecting');
    setBatchProgress('2/4 已上传，正在按局域网控制面选择模型…');
    const slowTimer = window.setTimeout(() => {
      if (detectionRunRef.current === runId) setBatchProgress('2/4 AI 仍在识别复杂页面，结果会在当前页返回…');
    }, 15_000);
    try {
      const detection = await detectQuestionRegions(src);
      if (detectionRunRef.current !== runId) return;
      setBatchProgress(('3/4 ' + (detection.provider || '') + ' ' + (detection.model || '') + ' 已识别 ' + detection.regions.length + ' 道题，正在生成裁剪结果…').replace(/\s+/g, ' ').trim());
      const images = await cropManyImages(src, detection.regions);
      if (detectionRunRef.current !== runId) return;
      setBatchImages(images.map((imageSrc) => ({ src: imageSrc, noteUid: createNoteUid(), enabled: true })));
      setBatchProgress('4/4 裁剪完成，请检查每一道题。');
      setMobileStep('batch');
    } finally {
      window.clearTimeout(slowTimer);
    }
  };

  const confirmMultiPreCrop = async (crop: NormalizedCrop) => {
    if (!sourceImage || saving) return;
    try {
      setSaving(true);
      setSaved(false);
      setDialogError('');
      setMobileStep('detecting');
      setBatchProgress('1/4 正在压缩并上传整页图片…');
      const src = await cropImageDataUrl(sourceImage.src, crop, 2200);
      setSourceImage({ src, noteUid: sourceImage.noteUid });
      await buildDetectedBatch(src, sourceImage.noteUid);
    } catch (error) {
      if (detectionRunRef.current === 0) return;
      setDialogError(error instanceof Error ? error.message : 'AI 多题识别失败，请调整范围后重试。');
      setBatchProgress('');
      setMobileStep('mode');
    } finally {
      setSaving(false);
    }
  };

  const startMultiQuestion = async () => {
    if (!sourceImage || saving) return;
    try {
      setSaving(true);
      setDialogError('');
      setBatchProgress('1/4 正在压缩并上传整页图片…');
      await buildDetectedBatch(sourceImage.src, sourceImage.noteUid);
    } catch (error) {
      if (detectionRunRef.current === 0) return;
      setDialogError(error instanceof Error ? error.message : 'AI 多题识别失败，请改用单题模式。');
      setMobileStep('mode');
      setBatchProgress('');
    } finally {
      setSaving(false);
    }
  };

  const confirmBatchCrop = async`,
  'mobile detection staged flow',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/src/components/NoteDropApp.tsx',
  /  const saveBatch = async \(\) => \{[\s\S]*?\n  \};\n\n  const cancelPending/,
  String.raw`  const saveBatch = async () => {
    const selected = batchImages.filter((item) => item.enabled);
    if (selected.length === 0 || saving) {
      setDialogError('请至少保留一道题。');
      return;
    }
    try {
      setSaving(true);
      setDialogError('');
      let latestSnapshot = null;
      for (let index = 0; index < selected.length; index += 1) {
        const item = selected[index];
        setBatchProgress('正在保存 ' + (index + 1) + '/' + selected.length + '；命名会在后台按局域网规则完成…');
        const result = await saveImageReliably({
          imageDataUrl: item.src,
          kind: 'single',
          noteUid: item.noteUid,
          subject: '默认文件夹',
          remark: '',
          sourceType: 'ai-multi-question',
          sourceBatchId: sourceImage?.noteUid || '',
          sourceSplitIndex: index + 1,
          tags: ['AI多题拆分'],
        }, setBatchProgress);
        if (result.learningData) {
          latestSnapshot = result.learningData;
          saveLearningDataCache(result.learningData);
        }
      }
      if (latestSnapshot) saveLearningDataCache(latestSnapshot);
      setSaved(true);
      setStatus('已保存 ' + selected.length + ' 道题，AI 正在后台按局域网规则命名');
      setBatchProgress('');
      setMobileStep('success');
    } catch (error) {
      setDialogError(error instanceof Error ? '批量保存失败：' + error.message : '批量保存失败，请重试。');
      setBatchProgress('');
    } finally {
      setSaving(false);
    }
  };

  const cancelPending`,
  'batch save background naming',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/src/components/NoteDropApp.tsx',
  "        setStatus(result.learningData ? '已保存，学习中心已更新' : '已保存，学习中心正在同步');",
  "        setStatus(result.learningData ? '图片已保存；AI 正在后台按局域网规则命名' : '图片已保存；学习中心与 AI 命名正在后台同步');",
  'single save feedback',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/src/components/NoteDropApp.tsx',
  "          confirmLabel={saving ? '正在加入后台…' : '后台识别并保存'}",
  "          confirmLabel={saving ? '正在准备…' : '开始 AI 识别'}",
  'multi crop label',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/src/components/NoteDropApp.tsx',
  "              <small>先预裁剪整页，再由 AI 后台拆题、保存和命名</small>",
  "              <small>先预裁剪整页；AI 在当前页识别，保存后后台命名</small>",
  'multi mode description',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/src/components/NoteDropApp.tsx',
  "              if (saving) return;\n              if (mobileStep === 'remark') setMobileStep('crop');",
  "              if (mobileStep === 'detecting') {\n                detectionRunRef.current += 1;\n                setSaving(false);\n                setBatchProgress('');\n                setMobileStep('mode');\n                return;\n              }\n              if (saving) return;\n              if (mobileStep === 'remark') setMobileStep('crop');",
  'mobile detection cancel navigation',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/src/components/NoteDropApp.tsx',
  "             <p>{batchProgress || 'AI 正在寻找每一道完整题目的边界。'}</p>\n           </section>",
  "             <p>{batchProgress || 'AI 正在寻找每一道完整题目的边界。'}</p>\n             <ol className=\"mobile-detecting-steps\">\n               <li>上传并压缩原图</li><li>读取局域网 AI 配置</li><li>识别题目边界</li><li>生成可调整裁剪</li>\n             </ol>\n           </section>",
  'mobile detection steps',
);

// A visible in-app back action is required on mobile image previews.
replaceOnce(
  'outputs/kaoyan-schedule-app/src/components/ImageViewer.tsx',
  "  ChevronLeft,",
  "  ArrowLeft,\n  ChevronLeft,",
  'image viewer back icon',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/src/components/ImageViewer.tsx',
  "        <button\n          ref={closeButtonRef}",
  "        <button className=\"image-viewer__back\" type=\"button\" onClick={onClose} aria-label=\"返回学习中心\">\n          <ArrowLeft size={20} /><span>返回</span>\n        </button>\n\n        <button\n          ref={closeButtonRef}",
  'image viewer mobile back',
);
appendOnce(
  'outputs/kaoyan-schedule-app/src/image-viewer.css',
  '/* public-lan-parity-mobile-back */',
  String.raw`/* public-lan-parity-mobile-back */
.image-viewer__back {
  position: absolute;
  z-index: 7;
  top: 18px;
  left: 18px;
  display: none;
  align-items: center;
  gap: 6px;
}
@media (max-width: 760px), (pointer: coarse) and (max-width: 1024px) {
  .image-viewer__back {
    display: inline-flex;
    top: max(10px, env(safe-area-inset-top));
    left: max(10px, env(safe-area-inset-left));
    min-height: 40px;
    padding: 0 13px;
    border-radius: 999px;
  }
  .image-viewer__close {
    top: max(10px, env(safe-area-inset-top));
    right: max(10px, env(safe-area-inset-right));
  }
}`,
);
appendOnce(
  'outputs/kaoyan-schedule-app/src/note-drop-mobile.css',
  '/* public-lan-parity-detection-steps */',
  String.raw`/* public-lan-parity-detection-steps */
.mobile-detecting-steps {
  margin: 18px auto 0;
  padding: 0;
  width: min(340px, 88vw);
  list-style: none;
  display: grid;
  gap: 8px;
  text-align: left;
}
.mobile-detecting-steps li {
  padding: 10px 12px;
  border-radius: 12px;
  background: color-mix(in srgb, currentColor 7%, transparent);
}
`,
);

// Make cloud learning-data merge part of the actual installed runtime, not an installer-only text patch.
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/windows-note-folder-sync.ps1',
  /function Commit-Pending\(\[string\]\$ClonePath, \[string\]\$Message\) \{[\s\S]*?\n\}/,
  String.raw`function Commit-Pending([string]$ClonePath, [string]$Message) {
  $candidatePaths = @(
    'source-notes',
    'data/cloud/learning-data.json',
    'data/config',
    'data/deletions',
    'data/local-delete-recycle',
    'data/quarantine'
  )
  $paths = @()
  foreach ($candidate in $candidatePaths) {
    if (Test-Path -LiteralPath (Join-Path $ClonePath $candidate)) { $paths += $candidate; continue }
    $tracked = Invoke-Git @('ls-files', '--', $candidate) $ClonePath
    if (-not [string]::IsNullOrWhiteSpace($tracked.Output)) { $paths += $candidate }
  }
  if ($paths.Count -eq 0) { return $false }
  $status = Invoke-Git (@('status', '--porcelain', '--') + $paths) $ClonePath
  if ([string]::IsNullOrWhiteSpace($status.Output)) { return $false }
  Invoke-Git (@('add', '-A', '--') + $paths) $ClonePath | Out-Null
  $diff = Invoke-Git (@('diff', '--cached', '--quiet', '--') + $paths) $ClonePath @(0, 1)
  if ($diff.ExitCode -eq 1) {
    Invoke-Git @('commit', '-m', $Message) $ClonePath | Out-Null
    return $true
  }
  return $false
}`,
  'sync commit learning data',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/windows-note-folder-sync.ps1',
  "  Materialize-CloudNotes $localPath $remotePath\n  Export-SafeAssistantConfiguration $clonePath $assistantRoot",
  "  Materialize-CloudNotes $localPath $remotePath\n  $mergeScript = Join-Path $workRoot 'merge-learning-data.cjs'\n  if (-not (Test-Path -LiteralPath $mergeScript)) { throw 'Learning data merger was not found.' }\n  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue\n  if ($null -eq $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction Stop }\n  & $nodeCommand.Source $mergeScript --config $ConfigPath | Out-Null\n  if ($LASTEXITCODE -ne 0) { throw 'Learning data merge failed.' }\n  # Agent configuration is published one-way by windows-assistant-config-sync.ps1.",
  'sync direct structured merge',
);

// Installer now installs source-complete scripts without brittle runtime string patching.
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/install-note-folder-sync.ps1',
  "$version = '20260724-learning-sync-v10'",
  "$version = '20260725-public-lan-parity-v11'",
  'installer version v11',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/install-note-folder-sync.ps1',
  "foreach ($dependency in @('ai-router.cjs', 'qwen-config.cjs', 'note-ai-analyzer.cjs', 'canvas-ai-organizer.cjs', 'review-github-sync.cjs', 'note-server.cjs')) {",
  "foreach ($dependency in @('ai-router.cjs', 'agent-workflow-contracts.cjs', 'qwen-config.cjs', 'note-ai-analyzer.cjs', 'canvas-ai-organizer.cjs', 'review-github-sync.cjs', 'note-server.cjs')) {",
  'installer workflow contract dependency',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/install-note-folder-sync.ps1',
  /\$runtimeText = Get-Content -LiteralPath \$runtimePath -Raw -Encoding UTF8[\s\S]*?Write-Utf8Bom \$runtimePath \$runtimeText/,
  "$runtimeText = Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8\nWrite-Utf8Bom $runtimePath $runtimeText",
  'installer remove obsolete runtime patching',
);

// Refresh D-drive sync runtime from the current project whenever local services start.
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/start-local-services-hidden.ps1',
  "function Start-HiddenNodeProcess([string]$ScriptPath) {",
  String.raw`function Refresh-SyncRuntime {
  $syncRoot = if ($env:KAOYAN_SYNC_ROOT) { $env:KAOYAN_SYNC_ROOT } else { 'D:\kaoyandata\NoteFolderSync' }
  $configPath = Join-Path $syncRoot 'config.json'
  if (-not (Test-Path -LiteralPath $configPath)) { return }
  foreach ($name in @(
    'windows-note-folder-sync.ps1',
    'windows-assistant-config-sync.ps1',
    'merge-learning-data.cjs',
    'export-agent-runtime.cjs',
    'agent-workflow-contracts.cjs',
    'assistant-config-watch.cjs',
    'ai-router.cjs',
    'qwen-config.cjs',
    'note-ai-analyzer.cjs',
    'canvas-ai-organizer.cjs',
    'review-github-sync.cjs',
    'note-server.cjs'
  )) {
    $source = Join-Path $projectRoot (Join-Path 'scripts' $name)
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $syncRoot $name) -Force }
  }
  $runner = Join-Path $syncRoot 'run-global-sync.ps1'
  if (Test-Path -LiteralPath $runner) {
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $runner, '-ConfigPath', $configPath) -WindowStyle Hidden
  }
}

function Start-HiddenNodeProcess([string]$ScriptPath) {`,
  'startup sync runtime refresh function',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/start-local-services-hidden.ps1',
  "if (-not (Test-ListeningPort 5174)) {",
  "Refresh-SyncRuntime\n\nif (-not (Test-ListeningPort 5174)) {",
  'startup invoke sync runtime refresh',
);

// Local file access can open cloud-synchronized attachments from the Caobijidata clone.
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/note-file-access.cjs',
  /function resolveNoteFile\(notesRoot, requestedPath\) \{[\s\S]*?\n\}/,
  String.raw`function resolveNoteFile(notesRoot, requestedPath, options = {}) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    const error = new Error('缺少笔记文件路径');
    error.code = 'NOTE_PATH_REQUIRED';
    throw error;
  }

  const normalized = requestedPath.trim().replaceAll('\\', '/');
  const cloneRoot = path.resolve(options.cloneRoot || process.env.KAOYAN_DATA_CLONE_PATH || 'D:\\kaoyandata\\Caobijidata');
  let filePath;
  let allowedRoot;
  if (normalized.startsWith('github://data/assets/')) {
    allowedRoot = path.join(cloneRoot, 'data', 'assets');
    filePath = path.resolve(cloneRoot, normalized.slice('github://'.length));
  } else if (normalized.startsWith('github://source-notes/')) {
    allowedRoot = path.join(cloneRoot, 'source-notes');
    filePath = path.resolve(cloneRoot, normalized.slice('github://'.length));
  } else if (normalized.startsWith('data/assets/')) {
    allowedRoot = path.join(cloneRoot, 'data', 'assets');
    filePath = path.resolve(cloneRoot, normalized);
  } else {
    allowedRoot = path.resolve(notesRoot);
    filePath = path.resolve(requestedPath);
  }
  if (!isInside(allowedRoot, filePath)) {
    const error = new Error('不允许访问笔记目录以外的文件');
    error.code = 'NOTE_PATH_FORBIDDEN';
    throw error;
  }

  const extension = path.extname(filePath).toLowerCase();
  const mime = NOTE_MIME_BY_EXT.get(extension);
  if (!mime) {
    const error = new Error('不支持的笔记文件类型');
    error.code = 'NOTE_FILE_UNSUPPORTED';
    throw error;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    const error = new Error('笔记文件不存在');
    error.code = 'NOTE_FILE_NOT_FOUND';
    throw error;
  }

  return { filePath, mime, extension, inline: mime.startsWith('image/') };
}`,
  'local cloud attachment mapping',
);

// Regression tests cover the control-plane contract, mobile timeout, single naming, and data merge.
write('outputs/kaoyan-schedule-app/scripts/public-lan-parity.test.cjs', String.raw`const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildPublicWorkflowContracts } = require('./agent-workflow-contracts.cjs');
const { resolveNoteFile } = require('./note-file-access.cjs');

const root = path.resolve(__dirname, '..');
const text = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('local runtime exports complete naming and splitting workflow contracts', () => {
  const workflows = buildPublicWorkflowContracts();
  for (const taskId of ['note_naming', 'question_splitting']) {
    assert.ok(workflows[taskId].version);
    assert.ok(workflows[taskId].steps.length >= 4);
    assert.ok(workflows[taskId].prompt.instructions.length >= 5);
    assert.match(workflows[taskId].prompt.outputFormat, /JSON/);
  }
});

test('public mobile capture waits longer than the local splitting timeout and does not block on explicit rename calls', () => {
  const notes = text('src/utils/notes.ts');
  const capture = text('src/components/NoteDropApp.tsx');
  assert.match(notes, /AI_REQUEST_TIMEOUT_MS = 180_000/);
  assert.doesNotMatch(capture, /renameLearningNoteWithAi/);
  assert.match(capture, /AI 正在后台按局域网规则命名/);
  assert.match(capture, /读取局域网 AI 配置/);
});

test('Windows synchronization directly merges cloud learning data', () => {
  const sync = text('scripts/windows-note-folder-sync.ps1');
  assert.match(sync, /merge-learning-data\.cjs/);
  assert.match(sync, /data\/cloud\/learning-data\.json/);
  assert.match(sync, /Learning data merge failed/);
});

test('local note access maps synchronized cloud attachments into the Caobijidata clone', () => {
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kaoyan-cloud-file-'));
  const clone = path.join(temp, 'Caobijidata');
  const file = path.join(clone, 'data', 'assets', 'quick-1', '01-note.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'hello');
  const resolved = resolveNoteFile(path.join(temp, 'notes'), 'github://data/assets/quick-1/01-note.txt', { cloneRoot: clone });
  assert.equal(resolved.filePath, file);
  assert.match(resolved.mime, /^text\/plain/);
});

test('single cloud captures and multi-question notes are both eligible for LAN-controlled naming', () => {
  const rename = text('cloudflare/rename-job.js');
  const media = text('cloudflare/media.js');
  assert.match(rename, /sourceType === 'single-capture'/);
  assert.match(rename, /updateMirroredCloudNote/);
  assert.match(media, /enqueueRenameJob/);
  assert.match(media, /sourceType: payload\.sourceType \|\| 'single-capture'/);
});
`);

appendOnce(
  'outputs/kaoyan-schedule-app/cloudflare/agent-provider.test.mjs',
  "workflow contract is required",
  String.raw`
test('workflow contract is required for public naming and splitting tasks', () => {
  const workflow = { version: 'v1', steps: ['route'], prompt: { instructions: ['instruction'], outputFormat: 'JSON' } };
  const normalized = agentRuntimeInternals.normalizeWorkflow('question_splitting', workflow);
  assert.equal(normalized.version, 'v1');
  assert.equal(normalized.prompt.outputFormat, 'JSON');
});
`,
);

process.stdout.write('public LAN parity source patch applied\n');
