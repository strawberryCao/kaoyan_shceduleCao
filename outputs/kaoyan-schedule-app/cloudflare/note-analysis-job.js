import { runLocalAgentTask } from './agent-provider.js';
import { getTaskSettings } from './ai-config.js';
import { HttpError } from './http.js';
import { assertRepoPath, readFile, readJsonFile } from './github-store.js';
import { applyAiNoteEnrichment, findNote, getLearningSnapshot } from './learning.js';

const ASSET_ROOT = 'data/assets/';
const TAXONOMY_PATH = 'data/config/note-taxonomy.json';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_SUBJECTS = ['高等数学', '线性代数', '概率论', '数据结构', '计算机组成', '操作系统', '计算机网络', '英语', '政治'];
const FALLBACK_SUBJECT = '默认文件夹';
const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
};

function text(value, maxLength = 2000) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function uniqueStrings(value, maxItems = 20, maxLength = 80) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const output = [];
  for (const item of source) {
    const normalized = text(item, maxLength);
    const key = normalized.toLocaleLowerCase('zh-CN');
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= maxItems) break;
  }
  return output;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

function fillTemplate(value, variables) {
  return String(value || '').replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) => String(variables[key] ?? ''));
}

function strongHints(note) {
  const remark = text(note.remark, 4000);
  const tags = uniqueStrings(note.tags, 30, 80);
  const facets = uniqueStrings(note.facets, 12, 40);
  const memoryLanguage = /(?:要记住|记下来|需要记|必须记|背下来|需要背|必须背|重点背|熟记|(?:^|[\s#，,。；;：:])(?:记|背)(?=$|[\s#，,。；;：:]))/u.test(remark);
  return {
    isMistake: note.noteType === 'mistake' || facets.includes('mistake') || tags.some((tag) => tag.includes('错题')) || /(?:错题|做错|错因|不会|易错)/u.test(remark),
    isGood: note.goodQuestion === true || facets.includes('good') || tags.some((tag) => /好题|经典题|典型题|精品题/u.test(tag)) || /(?:好题|经典题|典型题|精品题)/u.test(remark),
    shouldMemorize: note.noteType === 'memory' || facets.includes('memory') || tags.some((tag) => /背诵|记忆/u.test(tag)) || memoryLanguage,
  };
}

function compactTaxonomy(value, maxChars) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const allowed = new Set([...SUPPORTED_SUBJECTS, FALLBACK_SUBJECT]);
  const subjects = (Array.isArray(source.subjects) ? source.subjects : [])
    .filter((subject) => allowed.has(text(subject?.name, 60)))
    .map((subject) => ({
      name: text(subject.name, 60),
      aliases: uniqueStrings(subject.aliases, 8, 60),
      knowledgePoints: (Array.isArray(subject.knowledgePoints) ? subject.knowledgePoints : []).map((point) => ({
        name: text(point?.name, 60),
        aliases: uniqueStrings(point?.aliases, 8, 60),
      })).filter((point) => point.name),
    }));
  const result = { revision: Number.isInteger(source.revision) ? source.revision : null, subjects };
  const limit = Math.max(2000, Math.min(30000, Number(maxChars) || 12000));
  while (JSON.stringify(result).length > limit && result.subjects.some((subject) => subject.knowledgePoints.length > 0)) {
    const longest = [...result.subjects].sort((left, right) => right.knowledgePoints.length - left.knowledgePoints.length)[0];
    longest.knowledgePoints.pop();
  }
  return result;
}

function policyVariables(settings, note, taxonomy, hints) {
  const options = settings.options || {};
  const maxItems = Math.max(1, Math.min(12, Number(options.maxItems) || 12));
  const maxCards = options.cardPolicy === 'disabled' ? 0 : Math.max(0, Math.min(6, Number(options.maxCards) || 2));
  const summaryRule = {
    concise: '摘要只保留结论、关键条件和核心错因，避免展开推导。',
    detailed: '摘要可以保留必要推导、条件边界与易错对比，但不要重复抄题。',
    standard: '摘要兼顾核心结论、必要依据与可复习性。',
  }[options.summaryDetail] || '摘要兼顾核心结论、必要依据与可复习性。';
  const mistakeRule = options.mistakePolicy === 'explicit_only'
    ? 'intent.isMistake 只在用户备注、标签或本地解析结果明确表示错题或易错时为 true，不得自行扩大。'
    : 'intent.isMistake 可结合备注、图片订正痕迹和解题语义判断，但不能把普通练习一律当作错题。';
  const goodRule = options.goodQuestionPolicy === 'ai_high_value'
    ? 'intent.isGood 可在用户明确标记时为 true，也可用于具有明显方法价值且值得二刷的题目；必须说明价值。'
    : 'intent.isGood 只在用户备注或标签明确标记好题、经典题、典型题或精品题时为 true。';
  const memorizeRule = options.memorizePolicy === 'explicit_only'
    ? 'intent.shouldMemorize 只在用户明确要求背诵、熟记或主动回忆时为 true。'
    : 'intent.shouldMemorize 可依据定义、公式、结论、易混点和用户语义判断。';
  const cardRule = options.cardPolicy === 'disabled'
    ? 'cards 必须为空数组。'
    : options.cardPolicy === 'high_value'
      ? `最多生成 ${maxCards} 张高价值主动回忆卡片；答案必须明确且不重复，宁缺毋滥。`
      : `只有整张或对应分项存在明确错题意图或记忆意图时才生成 cards；最多 ${maxCards} 张。`;
  const context = {
    captureKind: note.sourceType === 'ai-multi-question' ? 'single-from-split' : 'single',
    existingTitle: text(note.title, 120) || null,
    remark: text(note.remark, 4000),
    locallyParsed: {
      explicitTags: uniqueStrings(note.tags, 20, 40),
      strongIntentHints: hints,
      sourceType: text(note.sourceType, 80),
      sourceBatchId: text(note.sourceBatchId, 160),
      sourceSplitIndex: Number(note.sourceSplitIndex) || null,
    },
    currentCategory: {
      subject: text(note.subject, 60) || FALLBACK_SUBJECT,
      knowledgePoint: Array.isArray(note.knowledgePath) ? text(note.knowledgePath[1], 60) || null : null,
    },
    existingLearning: {
      noteType: text(note.noteType, 40) || null,
      organizationStatus: text(note.organizationStatus, 40) || null,
      wrongReason: text(note.wrongReason, 500) || null,
      userEditedFields: uniqueStrings(note.userEditedFields, 30, 60),
    },
    existingTaxonomy: taxonomy,
  };
  return {
    supportedSubjects: SUPPORTED_SUBJECTS.join('、'),
    fallbackSubject: FALLBACK_SUBJECT,
    maxItems,
    maxCards,
    summaryRule,
    mistakeRule,
    goodRule,
    memorizeRule,
    cardRule,
    contextPayload: JSON.stringify(context),
  };
}

function analysisPrompt(settings, note, taxonomy, hints) {
  const workflow = settings.workflow;
  if (!workflow?.prompt?.instructions?.length || !workflow.prompt.outputFormat) {
    throw new HttpError(503, '局域网没有发布完整笔记分析 Prompt 合同。', 'LOCAL_AGENT_WORKFLOW_MISSING');
  }
  const variables = policyVariables(settings, note, taxonomy, hints);
  return [
    ...workflow.prompt.instructions.map((line) => fillTemplate(line, variables)).filter(Boolean),
    fillTemplate(workflow.prompt.outputFormat, variables),
    settings.customInstructions ? `局域网配置中心附加规则：${settings.customInstructions}` : '',
  ].filter(Boolean).join('\n');
}

function normalizeIntent(value, hints, settings) {
  const source = value && typeof value === 'object' ? value : {};
  const options = settings.options || {};
  return {
    isQuestion: source.isQuestion === true,
    isMistake: options.mistakePolicy === 'explicit_only' ? hints.isMistake : source.isMistake === true || hints.isMistake,
    isGood: options.goodQuestionPolicy === 'ai_high_value' ? source.isGood === true || hints.isGood : hints.isGood,
    shouldMemorize: options.memorizePolicy === 'explicit_only' ? hints.shouldMemorize : source.shouldMemorize === true || hints.shouldMemorize,
  };
}

function normalizeAnalysis(value, note, hints, settings) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(502, 'AI 笔记分析结果无效。', 'AI_ANALYSIS_INVALID');
  const options = settings.options || {};
  const intent = normalizeIntent(value.intent, hints, settings);
  const subjectCandidate = text(value.subject, 60);
  const subject = SUPPORTED_SUBJECTS.includes(subjectCandidate) ? subjectCandidate : FALLBACK_SUBJECT;
  const knowledgePoint = text(value.knowledgePoint, 60) || null;
  const questionType = text(value.questionType, 60) || null;
  const tags = uniqueStrings([
    ...(Array.isArray(value.tags) ? value.tags : []),
    ...(intent.isMistake ? ['错题'] : []),
    ...(intent.shouldMemorize ? ['背诵'] : []),
    ...(questionType ? [`题型:${questionType}`] : []),
  ], 20, 40).filter((tag) => !['好题', '经典题', '典型题', '精品题'].includes(tag));
  const maxItems = Math.max(1, Math.min(12, Number(options.maxItems) || 12));
  const items = (Array.isArray(value.items) ? value.items : []).slice(0, maxItems).map((item) => ({
    title: text(item?.title, 120),
    knowledgePoint: text(item?.knowledgePoint, 60) || null,
    questionType: text(item?.questionType, 60) || null,
    summary: text(item?.summary, 1000),
    tags: uniqueStrings(item?.tags, 12, 40),
    wrongReason: text(item?.wrongReason, 500) || null,
    intent: normalizeIntent(item?.intent, hints, settings),
  }));
  const maxCards = options.cardPolicy === 'disabled' ? 0 : Math.max(0, Math.min(6, Number(options.maxCards) || 2));
  const cards = (Array.isArray(value.cards) ? value.cards : []).slice(0, maxCards).map((card, index) => ({
    sourceKey: text(card?.sourceKey, 120) || `ai:${Number.isInteger(card?.itemIndex) ? card.itemIndex : 'root'}:${index}`,
    kind: card?.kind === 'mistake' || intent.isMistake ? 'mistake' : 'memory',
    front: text(card?.front, 500),
    back: text(card?.back, 2000),
    itemIndex: Number.isInteger(card?.itemIndex) ? card.itemIndex : null,
  })).filter((card) => card.front.length >= 4 && card.back.length >= 6 && card.front !== card.back);
  const confidence = Number(value.confidence);
  const wrongReason = text(value.wrongReason, 500) || null;
  const allowedWrongSources = new Set(['explicit_remark', 'explicit_image', 'ai_inferred', 'none']);
  return {
    title: text(value.title, 120) || text(note.title, 120) || '图片笔记',
    subject,
    knowledgePoint,
    knowledgePath: [subject, ...(knowledgePoint ? [knowledgePoint] : [])],
    summary: text(value.summary, 2000),
    tags,
    questionType,
    wrongReason,
    wrongReasonSource: wrongReason ? (allowedWrongSources.has(value.wrongReasonSource) ? value.wrongReasonSource : 'ai_inferred') : 'none',
    wrongReasonConfidence: wrongReason && Number.isFinite(Number(value.wrongReasonConfidence)) ? Math.max(0, Math.min(1, Number(value.wrongReasonConfidence))) : wrongReason ? 0.55 : null,
    intent,
    items,
    cards,
    noteType: intent.isMistake ? 'mistake' : intent.shouldMemorize ? 'memory' : intent.isQuestion ? 'question' : 'note',
    goodQuestion: intent.isGood,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    reason: text(value.reason, 1000),
  };
}

export async function runConfiguredNoteAnalysis(env, noteUid) {
  const snapshot = await getLearningSnapshot(env);
  const entry = findNote(snapshot, noteUid);
  if (!entry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
  const normalized = String(entry.note.filePath || '').trim().replaceAll('\\', '/');
  if (!normalized.startsWith('github://')) throw new HttpError(422, '这条笔记没有可供 AI 分析的云端原图。', 'NOTE_IMAGE_UNAVAILABLE');
  const repoPath = assertRepoPath(normalized.slice('github://'.length), ASSET_ROOT);
  const file = await readFile(env, repoPath, { maxBytes: MAX_IMAGE_BYTES });
  const extension = repoPath.split('.').at(-1)?.toLowerCase() || 'jpg';
  const image = `data:${MIME_BY_EXTENSION[extension] || 'image/jpeg'};base64,${bytesToBase64(file.bytes)}`;
  const taskId = text(entry.note.remark, 4000) ? 'note_enrichment' : 'note_image_understanding';
  const settings = await getTaskSettings(env, taskId);
  const taxonomyFile = await readJsonFile(env, TAXONOMY_PATH, { allowMissing: true, maxBytes: 2 * 1024 * 1024 });
  const taxonomy = compactTaxonomy(taxonomyFile?.value, settings.options?.taxonomyContextChars);
  const hints = strongHints(entry.note);
  const response = await runLocalAgentTask(env, taskId, {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: analysisPrompt(settings, entry.note, taxonomy, hints) },
        { type: 'image_url', image_url: { url: image } },
      ],
    }],
    imageDataUrl: image,
    json: true,
    temperature: 0.1,
    maxTokens: Number(settings.options?.maxTokens) || (taskId === 'note_image_understanding' ? 5200 : 4200),
    requiredCapabilities: ['vision', 'json'],
  });
  const analysis = normalizeAnalysis(response.json, entry.note, hints, settings);
  const latest = findNote(await getLearningSnapshot(env), noteUid)?.note;
  if (!latest) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
  const stored = await applyAiNoteEnrichment(env, noteUid, {
    ...analysis,
    provider: response.provider,
    model: response.model,
    taskId,
    configurationHash: response.configurationHash,
    workflowHash: response.workflowHash,
    preserveTitle: Array.isArray(latest.userEditedFields) && latest.userEditedFields.includes('title'),
  });
  return { analysis, snapshot: stored, provider: response.provider, model: response.model, taskId };
}

export const noteAnalysisInternals = Object.freeze({
  analysisPrompt,
  compactTaxonomy,
  normalizeAnalysis,
  strongHints,
});
