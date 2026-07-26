import { runLocalAgentTask } from './agent-provider.js';
import { getTaskSettings } from './ai-config.js';
import { HttpError } from './http.js';
import { assertRepoPath, readFile } from './github-store.js';
import { applyAiNoteNaming, findNote, getLearningSnapshot } from './learning.js';
import { ALLOWED_NOTE_SUBJECTS, applySharedNamingRuleTemplate, createFallbackNoteTitle, normalizeNoteSubject, sanitizeNoteTitle, validateNoteTitle } from '../shared/note-title-policy.js';

const ASSET_ROOT = 'data/assets/';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
};
const ALLOWED_SUBJECTS = [...ALLOWED_NOTE_SUBJECTS];

function isRenameEligibleNote(note) {
  const sourceType = String(note?.sourceType || '');
  const filePath = String(note?.filePath || '').replaceAll('\\', '/');
  return Boolean(note) && (
    sourceType === 'ai-multi-question'
    || sourceType === 'single-capture'
    || /^multi_[A-Za-z0-9_-]+/i.test(String(note.noteUid || ''))
    || (Array.isArray(note.tags) && note.tags.includes('AI多题拆分'))
    || /^github:\/\/data\/assets\/.+\.(?:jpe?g|png|webp|gif|avif)$/i.test(filePath)
  );
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

function sanitizeSegment(value, fallback = '', maxLength = 80) {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, maxLength);
  return cleaned || fallback;
}

function namingRules(settings) {
  return (Array.isArray(settings.namingRules) ? settings.namingRules : [])
    .filter((rule) => rule && rule.enabled !== false && rule.id && rule.name && rule.when && rule.extract)
    .slice(0, 20)
    .map((rule) => ({
      id: String(rule.id).slice(0, 64),
      name: String(rule.name).slice(0, 80),
      when: String(rule.when).slice(0, 800),
      extract: String(rule.extract).slice(0, 800),
      titleTemplate: String(rule.titleTemplate || '{value}').slice(0, 240),
      validationHint: String(rule.validationHint || '').slice(0, 500),
    }));
}

function fillTemplate(value, variables) {
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
}

function applyNamingRuleTemplate(rule, value, subject, aiTitle) {
  return applySharedNamingRuleTemplate(rule, value, subject, aiTitle);
}

function titleProblem(title, settings, ruleValue = '') {
  return validateNoteTitle(title, {
    ...(settings.options || {}),
    allowRuleIdentifier: Boolean(ruleValue),
    ruleValue,
  }).problem;
}

async function generateTitle(env, image, settings, remark, repairReason = '', captureType = '手机单题拍照') {
  const response = await runLocalAgentTask(env, 'note_naming', {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: namingPrompt(settings, remark, repairReason, captureType) },
        { type: 'image_url', image_url: { url: image } },
      ],
    }],
    imageDataUrl: image,
    json: true,
    temperature: Number(settings.temperature) || 0.15,
    maxTokens: Number(settings.options?.maxTokens) || 900,
    requiredCapabilities: ['vision', 'json'],
  });
  const parsed = response.json && typeof response.json === 'object' ? response.json : {};
  const options = settings.options || {};
  const titleMaxLength = Math.max(6, Math.min(80, Number(options.titleMaxLength) || 22));
  const subject = normalizeNoteSubject(parsed.subject);
  const aiTitle = sanitizeNoteTitle(parsed.title, titleMaxLength);
  const rules = namingRules(settings);
  const matchedRule = rules.find((rule) => rule.id === String(parsed.ruleId || '').trim()) || null;
  const ruleValue = matchedRule ? sanitizeSegment(parsed.ruleValue, '', 100) : '';
  const title = matchedRule && ruleValue
    ? applyNamingRuleTemplate(matchedRule, ruleValue, subject, aiTitle)
    : aiTitle;
  return {
    title,
    subject,
    problem: titleProblem(title, settings, matchedRule && ruleValue ? ruleValue : ''),
    provider: response.provider,
    model: response.model,
    configurationHash: response.configurationHash,
    workflowHash: response.workflowHash,
  };
}

export async function runConfiguredRename(env, noteUid, options = {}) {
  const initialSnapshot = await getLearningSnapshot(env);
  const initialEntry = findNote(initialSnapshot, noteUid);
  if (!initialEntry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
  if (!isRenameEligibleNote(initialEntry.note)) throw new HttpError(403, '这条记录没有可供局域网命名 Agent 处理的云端原图。', 'AI_RENAME_NOT_ALLOWED');

  const settings = await getTaskSettings(env, 'note_naming');
  const normalized = String(initialEntry.note.filePath || '').trim().replaceAll('\\', '/');
  if (!normalized.startsWith('github://')) throw new HttpError(422, '这条笔记没有可供 AI 识别的云端原图。', 'NOTE_IMAGE_UNAVAILABLE');
  const repoPath = assertRepoPath(normalized.slice('github://'.length), ASSET_ROOT);
  const file = await readFile(env, repoPath, { maxBytes: MAX_IMAGE_BYTES });
  const extension = repoPath.split('.').at(-1)?.toLowerCase() || 'jpg';
  const image = `data:${MIME_BY_EXTENSION[extension] || 'image/jpeg'};base64,${bytesToBase64(file.bytes)}`;
  const beforeRequest = findNote(await getLearningSnapshot(env), noteUid)?.note || initialEntry.note;
  const remark = String(beforeRequest.remark || '').trim().slice(0, 4000);

  const captureType = isRenameEligibleNote(initialEntry.note) && initialEntry.note.sourceType === 'ai-multi-question'
    ? 'AI 多题拆分后的单题图片'
    : '手机单题拍照';
  let generated = await generateTitle(env, image, settings, remark, '', captureType);
  if (generated.problem) generated = await generateTitle(env, image, settings, remark, generated.problem, captureType);
  if (generated.problem) {
    generated = {
      ...generated,
      title: createFallbackNoteTitle({ splitIndex: initialEntry.note.sourceSplitIndex, captureType }),
      subject: '默认文件夹',
      problem: '',
      fallbackReason: generated.problem,
    };
  }

  const latestSnapshot = await getLearningSnapshot(env);
  const latestEntry = findNote(latestSnapshot, noteUid);
  if (!latestEntry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
  const baselineTitle = typeof options.baselineTitle === 'string' ? options.baselineTitle : initialEntry.note.title;
  if (latestEntry.note.title !== baselineTitle && (latestEntry.note.userEditedFields || []).includes('title')) {
    return { applied: false, reason: '你已经手动修改标题，AI 结果未覆盖', title: latestEntry.note.title, snapshot: latestSnapshot };
  }
  const snapshot = await applyAiNoteNaming(env, noteUid, {
    title: generated.title,
    subject: generated.subject,
    provider: generated.provider,
    model: generated.model,
    configurationHash: generated.configurationHash,
    workflowHash: generated.workflowHash,
  });
  return {
    applied: true,
    title: generated.title,
    snapshot,
    provider: generated.provider,
    model: generated.model,
    configurationHash: generated.configurationHash,
    workflowHash: generated.workflowHash,
  };
}

export const renameWorkflowInternals = Object.freeze({
  isRenameEligibleNote,
  namingPrompt,
  titleProblem,
});
