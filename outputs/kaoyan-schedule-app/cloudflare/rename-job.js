import { HttpError } from './http.js';
import { findNote, getLearningSnapshot, patchNote } from './learning.js';
import { assertRepoPath, readFile } from './github-store.js';
import { getTaskSettings } from './ai-config.js';

const MODEL = '@cf/moondream/moondream3.1-9B-A2B';
const ASSET_ROOT = 'data/assets/';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
};

function isAiMultiQuestionNote(note) {
  return Boolean(note) && (
    note.sourceType === 'ai-multi-question'
    || /^multi_[A-Za-z0-9_-]+/i.test(String(note.noteUid || ''))
    || (Array.isArray(note.tags) && note.tags.includes('AI多题拆分'))
  );
}

function requireAi(env) {
  if (!env.AI || typeof env.AI.run !== 'function') throw new HttpError(503, 'AI 图片识别服务尚未配置。', 'AI_NOT_CONFIGURED');
  return env.AI;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

function extractAnswer(result) {
  const values = [result?.answer, result?.response, result?.text, result?.description, result?.result?.answer, result?.result?.text];
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

function cleanTitle(value, maxLength) {
  return String(value || '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^(?:标题|题目名称)\s*[:：]\s*/u, '')
    .replace(/^[“”"'「」『』]+|[“”"'「」『』]+$/gu, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[<>:"/\\|?*]/g, '')
    .trim()
    .slice(0, maxLength);
}

function titleProblem(title, settings) {
  if (!title) return '标题为空';
  const chinese = title.match(/[\u3400-\u9fff]/gu)?.length || 0;
  const letters = title.match(/[A-Za-z]/g)?.length || 0;
  if (chinese < 2 || (letters > 10 && letters > chinese * 1.5)) return '标题必须以中文为主，不能输出英文句子';
  if (settings.options.rejectGenericTitle !== false && /^(?:待识别|无法识别|未知(?:内容)?|未命名(?:内容)?|图片笔记|截图|题目|练习|exercise|question|image)(?:笔记)?$/iu.test(title)) return '标题过于空泛';
  return '';
}

function namingRulesText(settings) {
  const rules = settings.namingRules.filter((rule) => rule.enabled !== false);
  return rules.length ? JSON.stringify(rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    when: rule.when,
    extract: rule.extract,
    titleTemplate: rule.titleTemplate,
    validationHint: rule.validationHint,
  }))) : '无';
}

function namingQuestion(settings, remark, repairReason = '') {
  const style = {
    knowledge_point: '优先使用核心知识点或概念',
    question_type: '优先体现题型和考查动作',
    source_wording: '优先贴近题目原文的准确措辞',
  }[settings.options.titleStyle] || '优先使用核心知识点或概念';
  return [
    '你是考研学习笔记命名助手。请阅读图片中的完整题目，为它生成便于检索的中文标题。',
    `标题长度 ${settings.options.titleMinLength} 到 ${settings.options.titleMaxLength} 个字符，${style}。`,
    '必须以中文为主；数学符号和 CPU、TCP、Taylor 等必要术语可以保留，但禁止输出整句英文。',
    '不要加序号、引号、解释、日期、文件后缀或换行。',
    '禁止使用“图片笔记、截图、题目、练习、待识别、无法识别”等空泛标题。',
    settings.options.useRemark === false ? '不要使用用户备注。' : `用户最新备注：${remark || '无'}`,
    `字段命名规则：${namingRulesText(settings)}`,
    settings.customInstructions ? `用户在 AI 配置中心设置的附加规则：${settings.customInstructions}` : '',
    repairReason ? `上一版标题未通过程序校验：${repairReason}。请重新生成。` : '',
    '只返回最终标题，不要解释。',
  ].filter(Boolean).join('\n');
}

async function queryTitle(env, image, settings, remark, repairReason = '') {
  const result = await requireAi(env).run(MODEL, {
    task: 'query', image, question: namingQuestion(settings, remark, repairReason), stream: false,
  });
  const title = cleanTitle(extractAnswer(result), settings.options.titleMaxLength || 22);
  return { title, problem: titleProblem(title, settings) };
}

export async function runConfiguredRename(env, noteUid, options = {}) {
  const initialSnapshot = await getLearningSnapshot(env);
  const initialEntry = findNote(initialSnapshot, noteUid);
  if (!initialEntry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
  if (!isAiMultiQuestionNote(initialEntry.note)) throw new HttpError(403, '只有 AI 多题拆分生成的笔记可以重新命名。', 'AI_RENAME_NOT_ALLOWED');

  const settings = await getTaskSettings(env, 'note_naming');
  if (settings.enabled === false) throw new HttpError(403, '笔记命名任务已在配置中心停用。', 'AI_TASK_DISABLED');
  const normalized = String(initialEntry.note.filePath || '').trim().replaceAll('\\', '/');
  if (!normalized.startsWith('github://')) throw new HttpError(422, '这条笔记没有可供 AI 识别的云端原图。', 'NOTE_IMAGE_UNAVAILABLE');
  const repoPath = assertRepoPath(normalized.slice('github://'.length), ASSET_ROOT);
  const file = await readFile(env, repoPath, { maxBytes: MAX_IMAGE_BYTES });
  const extension = repoPath.split('.').at(-1)?.toLowerCase() || 'jpg';
  const image = `data:${MIME_BY_EXTENSION[extension] || 'image/jpeg'};base64,${bytesToBase64(file.bytes)}`;
  const beforeRequest = findNote(await getLearningSnapshot(env), noteUid)?.note || initialEntry.note;
  const remark = String(beforeRequest.remark || '').trim().slice(0, 1800);

  let generated = await queryTitle(env, image, settings, remark);
  if (generated.problem) generated = await queryTitle(env, image, settings, remark, generated.problem);
  if (generated.problem) throw new HttpError(502, `AI 标题未通过校验：${generated.problem}`, 'AI_RENAME_INVALID');

  const latestSnapshot = await getLearningSnapshot(env);
  const latestEntry = findNote(latestSnapshot, noteUid);
  if (!latestEntry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
  const baselineTitle = typeof options.baselineTitle === 'string' ? options.baselineTitle : initialEntry.note.title;
  if (latestEntry.note.title !== baselineTitle && (latestEntry.note.userEditedFields || []).includes('title')) {
    return { applied: false, reason: '你已经手动修改标题，AI 结果未覆盖', title: latestEntry.note.title, snapshot: latestSnapshot };
  }
  const snapshot = await patchNote(env, noteUid, { patch: { title: generated.title } });
  return { applied: true, title: generated.title, snapshot };
}
