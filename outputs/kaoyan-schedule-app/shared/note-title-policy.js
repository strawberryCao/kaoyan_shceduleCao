export const ALLOWED_NOTE_SUBJECTS = Object.freeze([
  '高等数学', '线性代数', '概率论', '数据结构', '计算机组成',
  '操作系统', '计算机网络', '英语', '政治', '默认文件夹',
]);

const GENERIC_TITLE_PATTERN = /^(?:待识别|无法识别|未知(?:内容)?|未命名(?:内容)?|图片笔记|截图|题目|练习|exercise|question|image)(?:笔记)?$/iu;
const REFUSAL_PATTERN = /(?:the image does not|does not contain|cannot identify|unable to identify|i cannot|as an ai|no question|problem statement)/iu;

export function sanitizeNoteTitle(value, maxLength = 22) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\|?*\u0000-\u001f]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, Math.max(6, Math.min(80, Number(maxLength) || 22)));
}

export function normalizeNoteSubject(value, fallback = '默认文件夹') {
  const candidate = String(value || '').normalize('NFKC').trim();
  return ALLOWED_NOTE_SUBJECTS.includes(candidate) ? candidate : fallback;
}

export function validateNoteTitle(value, options = {}) {
  const titleMinLength = Math.max(4, Math.min(40, Number(options.titleMinLength) || 8));
  const titleMaxLength = Math.max(titleMinLength, Math.min(80, Number(options.titleMaxLength) || 22));
  const title = sanitizeNoteTitle(value, titleMaxLength);
  const ruleValue = sanitizeNoteTitle(options.ruleValue, 80);
  const ruleMatched = options.allowRuleIdentifier === true && Boolean(ruleValue) && title.includes(ruleValue);
  if (!title) return { ok: false, title, problem: '标题为空' };
  if (title.length < (ruleMatched ? 2 : Math.min(4, titleMinLength))) return { ok: false, title, problem: '标题过短' };
  const chinese = title.match(/[\u3400-\u9fff]/gu)?.length || 0;
  const letters = title.match(/[A-Za-z]/g)?.length || 0;
  if (REFUSAL_PATTERN.test(title)) return { ok: false, title, problem: '标题包含模型拒答或英文说明句' };
  if (!ruleMatched && (chinese < 2 || (letters > 10 && letters > chinese * 1.5))) {
    return { ok: false, title, problem: '标题必须以中文为主，不能输出英文句子' };
  }
  if (options.rejectGenericTitle !== false && GENERIC_TITLE_PATTERN.test(title)) {
    return { ok: false, title, problem: '标题过于空泛' };
  }
  return { ok: true, title, problem: '' };
}

export function createFallbackNoteTitle({ splitIndex = null, captureType = '' } = {}) {
  const index = Number(splitIndex);
  if (Number.isInteger(index) && index > 0) return '待确认题目·第' + index + '题';
  return /画布/u.test(String(captureType || '')) ? '待确认画布笔记' : '待确认题目';
}

export function applySharedNamingRuleTemplate(rule, value, subject, aiTitle) {
  const template = String(rule?.titleTemplate || '{value}').slice(0, 240);
  return sanitizeNoteTitle(template
    .replace(/\{value\}/g, value)
    .replace(/\{subject\}/g, subject)
    .replace(/\{aiTitle\}/g, aiTitle), 80);
}
