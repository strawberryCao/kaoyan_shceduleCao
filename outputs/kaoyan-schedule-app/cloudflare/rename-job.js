import { runLocalAgentTask } from './agent-provider.js';
import { getTaskSettings } from './ai-config.js';
import { HttpError } from './http.js';
import { assertRepoPath, readFile } from './github-store.js';
import { findNote, getLearningSnapshot, patchNote } from './learning.js';

const ASSET_ROOT = 'data/assets/';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
};
const ALLOWED_SUBJECTS = ['高等数学', '线性代数', '概率论', '数据结构', '计算机组成', '操作系统', '计算机网络', '英语', '政治', '默认文件夹'];

function isAiMultiQuestionNote(note) {
  return Boolean(note) && (
    note.sourceType === 'ai-multi-question'
    || /^multi_[A-Za-z0-9_-]+/i.test(String(note.noteUid || ''))
    || (Array.isArray(note.tags) && note.tags.includes('AI多题拆分'))
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

function namingPrompt(settings, remark, repairReason = '') {
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
  return [
    '你是考研学习笔记整理助手。请结合图片内容和用户备注，为这张学习截图生成适合 Windows 文件名的中文标题。',
    '要求：',
    `1. 识别所属科目，只能从：${ALLOWED_SUBJECTS.join('、')} 中选择。`,
    options.preferSpecificSubject === false
      ? '1.1 按图片内容选择科目；确实不清晰或跨科时可选择“默认文件夹”。'
      : '1.1 只要图片或备注能看出学科，就必须选择最合理的具体科目；只有图片不可读、没有学习内容或确实无法判断时才选“默认文件夹”。不要因为不完全确定就退回默认。',
    `2. title 目标长度为 ${titleMinLength} 到 ${titleMaxLength} 个字符，${titleStyleText}。`,
    '3. 不要输出随机数，不要输出日期，不要输出文件后缀。',
    '4. 不要使用 Windows 非法字符：<>:"/\\|?*。',
    '5. 先逐条检查“字段命名规则”。只有图片中能直接看到规则要求的标签及对应值时才算匹配，严禁用相似编号、日期或其他字段猜测。',
    '6. 如果匹配规则：ruleId 填规则 id，ruleValue 填原图中提取到的字段值，ruleEvidence 简述标签和值的位置；title 仍给出普通内容标题。程序会根据模板生成最终标题。',
    options.rejectGenericTitle === false
      ? '7. 如果没有规则匹配：ruleId、ruleValue、ruleEvidence 都输出空字符串；title 应尽量给出具体可见主题。'
      : '7. 如果没有规则匹配：ruleId、ruleValue、ruleEvidence 都输出空字符串。禁止输出“待识别”“无法识别”“未知内容”“截图”“图片笔记”作为 title；应给出图片中最具体的可见主题。',
    '8. 只输出 JSON：{"subject":"科目","title":"标题","reason":"一句话依据","ruleId":"匹配规则id或空字符串","ruleValue":"提取值或空字符串","ruleEvidence":"原图证据或空字符串"}',
    '保存类型：AI 多题拆分后的单题图片',
    `用户备注：${effectiveRemark || '无'}`,
    `字段命名规则：${rules.length ? JSON.stringify(rules) : '无'}`,
    settings.customInstructions ? `局域网配置中心附加规则：${settings.customInstructions}` : '',
    repairReason ? `上一版结果未通过程序校验：${repairReason}。必须修正后重新输出。` : '',
  ].filter(Boolean).join('\n');
}

function applyNamingRuleTemplate(rule, value, subject, aiTitle) {
  const template = String(rule?.titleTemplate || '{value}').slice(0, 240);
  return sanitizeSegment(template
    .replace(/\{value\}/g, value)
    .replace(/\{subject\}/g, subject)
    .replace(/\{aiTitle\}/g, aiTitle), value || aiTitle, 80);
}

function titleProblem(title, settings) {
  if (!title) return '标题为空';
  const chinese = title.match(/[\u3400-\u9fff]/gu)?.length || 0;
  const letters = title.match(/[A-Za-z]/g)?.length || 0;
  if (chinese < 2 || (letters > 10 && letters > chinese * 1.5)) return '标题必须以中文为主，不能输出英文句子';
  if (settings.options?.rejectGenericTitle !== false && /^(?:待识别|无法识别|未知(?:内容)?|未命名(?:内容)?|图片笔记|截图|题目|练习|exercise|question|image)(?:笔记)?$/iu.test(title)) return '标题过于空泛';
  return '';
}

async function generateTitle(env, image, settings, remark, repairReason = '') {
  const response = await runLocalAgentTask(env, 'note_naming', {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: namingPrompt(settings, remark, repairReason) },
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
  const subject = ALLOWED_SUBJECTS.includes(String(parsed.subject || '').trim()) ? String(parsed.subject).trim() : '默认文件夹';
  const aiTitle = sanitizeSegment(parsed.title, '', titleMaxLength);
  const rules = namingRules(settings);
  const matchedRule = rules.find((rule) => rule.id === String(parsed.ruleId || '').trim()) || null;
  const ruleValue = matchedRule ? sanitizeSegment(parsed.ruleValue, '', 100) : '';
  const title = matchedRule && ruleValue
    ? applyNamingRuleTemplate(matchedRule, ruleValue, subject, aiTitle)
    : aiTitle;
  return {
    title,
    problem: titleProblem(title, settings),
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
  if (!isAiMultiQuestionNote(initialEntry.note)) throw new HttpError(403, '只有 AI 多题拆分生成的笔记可以重新命名。', 'AI_RENAME_NOT_ALLOWED');

  const settings = await getTaskSettings(env, 'note_naming');
  const normalized = String(initialEntry.note.filePath || '').trim().replaceAll('\\', '/');
  if (!normalized.startsWith('github://')) throw new HttpError(422, '这条笔记没有可供 AI 识别的云端原图。', 'NOTE_IMAGE_UNAVAILABLE');
  const repoPath = assertRepoPath(normalized.slice('github://'.length), ASSET_ROOT);
  const file = await readFile(env, repoPath, { maxBytes: MAX_IMAGE_BYTES });
  const extension = repoPath.split('.').at(-1)?.toLowerCase() || 'jpg';
  const image = `data:${MIME_BY_EXTENSION[extension] || 'image/jpeg'};base64,${bytesToBase64(file.bytes)}`;
  const beforeRequest = findNote(await getLearningSnapshot(env), noteUid)?.note || initialEntry.note;
  const remark = String(beforeRequest.remark || '').trim().slice(0, 4000);

  let generated = await generateTitle(env, image, settings, remark);
  if (generated.problem) generated = await generateTitle(env, image, settings, remark, generated.problem);
  if (generated.problem) throw new HttpError(502, `AI 标题未通过校验：${generated.problem}`, 'AI_RENAME_INVALID');

  const latestSnapshot = await getLearningSnapshot(env);
  const latestEntry = findNote(latestSnapshot, noteUid);
  if (!latestEntry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
  const baselineTitle = typeof options.baselineTitle === 'string' ? options.baselineTitle : initialEntry.note.title;
  if (latestEntry.note.title !== baselineTitle && (latestEntry.note.userEditedFields || []).includes('title')) {
    return { applied: false, reason: '你已经手动修改标题，AI 结果未覆盖', title: latestEntry.note.title, snapshot: latestSnapshot };
  }
  const snapshot = await patchNote(env, noteUid, { patch: { title: generated.title } });
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
  namingPrompt,
  titleProblem,
});
