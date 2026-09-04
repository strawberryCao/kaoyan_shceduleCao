import { runLocalAgentTask } from './agent-provider.js';
import { getTaskSettings } from './ai-config.js';
import { getAssetRecord } from './entries.js';
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

function classificationPath(value) {
  return uniqueStrings(value, 3, 60);
}

function stableSubjectForNote(note) {
  const sources = [
    note?.title,
    note?.fileName,
    note?.filePath,
    note?.sourceFilePath,
    ...(Array.isArray(note?.attachments) ? note.attachments.flatMap((item) => [item?.name, item?.filePath]) : []),
  ].map((value) => text(value, 500));
  const namedSubject = SUPPORTED_SUBJECTS.find((subject) => sources.some((value) => (
    value.startsWith(`${subject}_`) || value.includes(`/${subject}_`) || value.includes(`\\${subject}_`)
  )));
  if (namedSubject) return namedSubject;
  const currentSubject = text(note?.subject, 60);
  return Array.isArray(note?.userEditedFields)
    && note.userEditedFields.includes('subject')
    && SUPPORTED_SUBJECTS.includes(currentSubject)
    ? currentSubject
    : '';
}

const GOOD_QUESTION_TYPES = new Set(['经典母题', '方法好题', '易错辨析', '综合提升', '新颖拓展']);

function inferGoodQuestionType(value, isGood) {
  if (!isGood) return null;
  const content = text(value, 4000);
  if (/新颖|创新|拓展|一题多解/u.test(content)) return '新颖拓展';
  if (/综合|压轴|多知识点/u.test(content)) return '综合提升';
  if (/易错|辨析|陷阱/u.test(content)) return '易错辨析';
  if (/方法|技巧|构造|模板/u.test(content)) return '方法好题';
  return '经典母题';
}

function inferWrongReasonPath(value) {
  const reason = text(value, 500).toLowerCase();
  if (!reason) return [];
  if (/走神|分心|注意力/u.test(reason)) return ['粗心大意', '注意力', '走神分心'];
  if (/粗心/u.test(reason)) {
    if (/审题|题意|条件/u.test(reason)) return ['粗心大意', '审题疏漏', '审题不仔细'];
    if (/抄|数据/u.test(reason)) return ['粗心大意', '信息抄录', '抄错数据'];
    if (/计算|算错|运算/u.test(reason)) return ['粗心大意', '计算执行', '计算错误'];
    return ['粗心大意', '信息遗漏', '漏项漏写'];
  }
  if (/漏看|看漏|漏条件|遗漏条件/u.test(reason)) return ['粗心大意', '审题疏漏', '看漏条件'];
  if (/审题|题意|误读/u.test(reason)) return ['粗心大意', '审题疏漏', '误读条件'];
  if (/概念|定义|混淆/u.test(reason)) return ['知识与记忆', '概念辨析', /混/u.test(reason) ? '概念混淆' : '定义不清'];
  if (/公式.*忘|定理.*忘|没记住/u.test(reason)) return ['知识与记忆', '公式定理', '公式遗忘'];
  if (/方法|思路|题型/u.test(reason)) return ['思路与方法', '方法选择', /题型/u.test(reason) ? '未识别题型' : '方法选错'];
  if (/正负|符号/u.test(reason)) return ['推理与计算', '符号表达', '正负号错误'];
  if (/计算|运算|算错/u.test(reason)) return ['推理与计算', '计算执行', '算术计算错误'];
  return ['其他', '信息不足', '尚未明确'];
}

function inferLearningTypePath(value, subject, questionType) {
  const content = text(value, 4000);
  if (subject === '英语') return ['英语积累', /作文|写作|模板/u.test(content) ? '写作模板' : /翻译/u.test(content) ? '翻译表达' : /长难句/u.test(content) ? '长难句' : /语法/u.test(content) ? '语法规则' : '单词短语'];
  if (subject === '政治') return ['政治材料', /时政|材料/u.test(content) ? '时政材料' : /模板|答题/u.test(content) ? '分析模板' : /原理/u.test(content) ? '原理表述' : '核心概念'];
  if (/易错|警示|注意|避免/u.test(content)) return ['易错警示', '检查清单'];
  if (/结论|推论|规律/u.test(content)) return ['结论规律', '常用结论'];
  if (questionType || /题型|解题|步骤|方法|构造/u.test(content)) return ['题型方法', '标准步骤'];
  if (/公式|定理/u.test(content)) return ['基础知识', '公式定理'];
  if (/原理|机制/u.test(content)) return ['基础知识', '原理机制'];
  return ['基础知识', '定义概念'];
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
  const memoryLanguage = /(?:要记住|记下来|需要记|必须记|背下来|需要背|必须背|重点背|熟记|(?:^|[\s#，,。；;：:])(?:记|记忆|背|背诵)(?=$|[\s#，,。；;：:]))/u.test(remark);
  const explicitMistake = facets.includes('mistake') || /(?:错题|做错|错因|不会|易错)/u.test(remark);
  const explicitMemory = facets.includes('memory') || memoryLanguage;
  return {
    isMistake: note.noteType === 'mistake' || explicitMistake || tags.some((tag) => tag.includes('错题')),
    isGood: note.goodQuestion === true || facets.includes('good') || tags.some((tag) => /好题|经典题|典型题|精品题/u.test(tag)) || /(?:好题|经典题|典型题|精品题)/u.test(remark),
    shouldMemorize: note.noteType === 'memory' || explicitMemory || tags.some((tag) => /背诵|记忆/u.test(tag)),
    explicitMistake,
    explicitMemory,
  };
}

async function resolveImageRepoPath(env, note) {
  const candidates = [
    { filePath: note?.filePath },
    ...(Array.isArray(note?.attachments) ? note.attachments : []),
  ];
  for (const candidate of candidates) {
    const declared = String(candidate?.cloudPath || candidate?.filePath || '').trim().replaceAll('\\', '/');
    if (/^github:\/\/data\/assets\/.+\.(?:jpe?g|png|webp|gif|avif)$/i.test(declared)) {
      return assertRepoPath(declared.slice('github://'.length), ASSET_ROOT);
    }
    const assetId = String(candidate?.assetId || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(assetId)) continue;
    const record = await getAssetRecord(env, assetId);
    if (!record?.path) continue;
    const repoPath = assertRepoPath(String(record?.path || ''), ASSET_ROOT);
    if (/\.(?:jpe?g|png|webp|gif|avif)$/i.test(repoPath)) return repoPath;
  }
  throw new HttpError(422, '这条笔记没有可供 AI 分析的云端原图。', 'NOTE_IMAGE_UNAVAILABLE');
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
  const exclusiveIntentRule = hints.explicitMistake && !hints.explicitMemory
    ? '用户只明确标记了错题、没有标记背诵；intent.shouldMemorize 和所有分项的 shouldMemorize 必须为 false，不得仅因题目含公式或定义而加入背诵分类。'
    : '';
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
      questionTypePath: classificationPath(note.questionTypePath),
      wrongReason: text(note.wrongReason, 500) || null,
      wrongReasonPath: classificationPath(note.wrongReasonPath),
      learningTypePath: classificationPath(note.learningTypePath),
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
    exclusiveIntentRule,
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
    variables.exclusiveIntentRule,
    fillTemplate(workflow.prompt.outputFormat, variables),
    settings.customInstructions ? `局域网配置中心附加规则：${settings.customInstructions}` : '',
  ].filter(Boolean).join('\n');
}

function normalizeIntent(value, hints, settings) {
  const source = value && typeof value === 'object' ? value : {};
  const options = settings.options || {};
  const suppressInferredMemory = hints.explicitMistake === true && hints.explicitMemory !== true;
  return {
    isQuestion: source.isQuestion === true,
    isMistake: options.mistakePolicy === 'explicit_only' ? hints.isMistake : source.isMistake === true || hints.isMistake,
    isGood: options.goodQuestionPolicy === 'ai_high_value' ? source.isGood === true || hints.isGood : hints.isGood,
    shouldMemorize: suppressInferredMemory
      ? false
      : options.memorizePolicy === 'explicit_only' ? hints.shouldMemorize : source.shouldMemorize === true || hints.shouldMemorize,
  };
}

function normalizeAnalysis(value, note, hints, settings) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(502, 'AI 笔记分析结果无效。', 'AI_ANALYSIS_INVALID');
  const options = settings.options || {};
  const intent = normalizeIntent(value.intent, hints, settings);
  const suppressInferredMemory = hints.explicitMistake === true && hints.explicitMemory !== true;
  const subjectCandidate = text(value.subject, 60);
  const stableSubject = stableSubjectForNote(note);
  const subject = stableSubject
    ? stableSubject
    : SUPPORTED_SUBJECTS.includes(subjectCandidate) ? subjectCandidate : FALLBACK_SUBJECT;
  const knowledgePoint = text(value.knowledgePoint, 60) || null;
  const questionType = text(value.questionType, 60) || null;
  const tags = uniqueStrings([
    ...(Array.isArray(value.tags) ? value.tags : []),
    ...(intent.isMistake ? ['错题'] : []),
    ...(intent.shouldMemorize ? ['背诵'] : []),
    ...(questionType ? [`题型:${questionType}`] : []),
  ], 20, 40).filter((tag) => (
    !['好题', '经典题', '典型题', '精品题'].includes(tag)
    && (!suppressInferredMemory || !/(?:背诵|记忆|要背|记住)/u.test(tag))
  ));
  const maxItems = Math.max(1, Math.min(12, Number(options.maxItems) || 12));
  const items = (Array.isArray(value.items) ? value.items : []).slice(0, maxItems).map((item) => ({
    title: text(item?.title, 120),
    knowledgePoint: text(item?.knowledgePoint, 60) || null,
    questionType: text(item?.questionType, 60) || null,
    questionTypePath: classificationPath(item?.questionTypePath),
    summary: text(item?.summary, 1000),
    tags: uniqueStrings(item?.tags, 12, 40)
      .filter((tag) => !suppressInferredMemory || !/(?:背诵|记忆|要背|记住)/u.test(tag)),
    wrongReason: text(item?.wrongReason, 500) || null,
    wrongReasonPath: classificationPath(item?.wrongReasonPath),
    learningTypePath: classificationPath(item?.learningTypePath),
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
  const questionTypePath = questionType
    ? classificationPath(value.questionTypePath).length > 0 ? classificationPath(value.questionTypePath) : [questionType]
    : [];
  const wrongReasonPath = classificationPath(value.wrongReasonPath).length > 0
    ? classificationPath(value.wrongReasonPath)
    : inferWrongReasonPath(wrongReason);
  const learningTypePath = classificationPath(value.learningTypePath).length > 0
    ? classificationPath(value.learningTypePath)
    : inferLearningTypePath([value.title, value.summary, ...(Array.isArray(value.tags) ? value.tags : [])].join(' '), subject, questionType);
  const requestedGoodQuestionType = text(value.goodQuestionType, 40);
  const goodQuestionType = intent.isGood
    ? GOOD_QUESTION_TYPES.has(requestedGoodQuestionType)
      ? requestedGoodQuestionType
      : inferGoodQuestionType([value.title, value.summary, ...(Array.isArray(value.tags) ? value.tags : [])].join(' '), true)
    : null;
  const allowedWrongSources = new Set(['explicit_remark', 'explicit_image', 'ai_inferred', 'none']);
  return {
    title: text(value.title, 120) || text(note.title, 120) || '图片笔记',
    subject,
    knowledgePoint,
    knowledgePath: [subject, ...(knowledgePoint ? [knowledgePoint] : [])],
    summary: text(value.summary, 2000),
    tags,
    questionType,
    questionTypePath,
    wrongReason,
    wrongReasonPath,
    learningTypePath,
    wrongReasonSource: wrongReason ? (allowedWrongSources.has(value.wrongReasonSource) ? value.wrongReasonSource : 'ai_inferred') : 'none',
    wrongReasonConfidence: wrongReason && Number.isFinite(Number(value.wrongReasonConfidence)) ? Math.max(0, Math.min(1, Number(value.wrongReasonConfidence))) : wrongReason ? 0.55 : null,
    intent,
    items,
    cards,
    noteType: intent.isMistake ? 'mistake' : intent.shouldMemorize ? 'memory' : intent.isQuestion ? 'question' : 'note',
    goodQuestion: intent.isGood,
    goodQuestionType,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    reason: text(value.reason, 1000),
  };
}

export async function runConfiguredNoteAnalysis(env, noteUid) {
  const snapshot = await getLearningSnapshot(env);
  const entry = findNote(snapshot, noteUid);
  if (!entry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
  const repoPath = await resolveImageRepoPath(env, entry.note);
  const file = await readFile(env, repoPath, { maxBytes: MAX_IMAGE_BYTES });
  const extension = repoPath.split('.').at(-1)?.toLowerCase() || 'jpg';
  const image = `data:${MIME_BY_EXTENSION[extension] || 'image/jpeg'};base64,${bytesToBase64(file.bytes)}`;
  const aiSelection = entry.note.aiSelection && typeof entry.note.aiSelection === 'object'
    ? entry.note.aiSelection : null;
  const canvasTask = entry.note.kind === 'canvas' || entry.note.sourceType === 'canvas-publish';
  const enrichmentSettings = await getTaskSettings(env, 'note_enrichment');
  const collaborationEnabled = enrichmentSettings.options?.collaborationMode === 'vision_then_reasoning';
  const taskId = canvasTask
    ? 'canvas_note_understanding'
    : collaborationEnabled || !text(entry.note.remark, 4000) ? 'note_image_understanding' : 'note_enrichment';
  const settings = taskId === 'note_enrichment' ? enrichmentSettings : await getTaskSettings(env, taskId);
  const taxonomyFile = await readJsonFile(env, TAXONOMY_PATH, { allowMissing: true, maxBytes: 2 * 1024 * 1024 });
  const taxonomy = compactTaxonomy(taxonomyFile?.value, settings.options?.taxonomyContextChars);
  const hints = strongHints(entry.note);
  const routeOverride = aiSelection?.mode === 'model'
    ? { preferredProvider: text(aiSelection.providerId, 80), preferredModel: text(aiSelection.modelId, 160), allowFallback: false }
    : canvasTask
      ? { difficulty: 'high' }
      : aiSelection?.mode === 'auto-light'
        ? { ignoreTaskModelPreference: true, difficulty: 'low' }
        : aiSelection?.mode === 'auto-advanced'
        ? { ignoreTaskModelPreference: true, difficulty: 'high' }
        : {};
  const visualResponse = await runLocalAgentTask(env, taskId, {
    ...routeOverride,
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
    maxTokens: Number(settings.options?.maxTokens) || (canvasTask ? 3200 : taskId === 'note_image_understanding' ? 5200 : 4200),
    requiredCapabilities: ['vision', 'json'],
  });
  let response = visualResponse;
  let finalSettings = settings;
  let finalTaskId = taskId;
  // A save-time selection is an explicit cost/quality decision. Never append
  // a hidden reviewer model after the chosen model has succeeded. The legacy
  // two-stage collaboration path remains available only to old records that
  // predate per-save AI selection.
  if (collaborationEnabled && !canvasTask && !aiSelection) {
    try {
      const reviewer = await runLocalAgentTask(env, 'note_enrichment', {
        messages: [{
          role: 'user',
          content: [
            '你是第二阶段分类与学习整理复核 Agent。你不能直接看到原图，必须依据视觉 Agent 的结构化初审证据，并结合用户备注和已有考研目录做更严格的科目边界判断。',
            '如果内容属于机器学习、软件工具、桌面环境等非标准考研一级科目，subject 必须为“默认文件夹”，不得因为图片当前存放目录而归入数据结构或计算机组成。',
            analysisPrompt(enrichmentSettings, entry.note, taxonomy, hints),
            `视觉 Agent 初审 JSON：${JSON.stringify(visualResponse.json).slice(0, 16_000)}`,
          ].join('\n'),
        }],
        json: true,
        temperature: 0.05,
        maxTokens: Number(enrichmentSettings.options?.maxTokens) || 4_200,
        requiredCapabilities: ['text', 'json'],
      });
      response = {
        ...reviewer,
        provider: `${visualResponse.provider}+${reviewer.provider}`,
        model: `${visualResponse.model} -> ${reviewer.model}`,
      };
      finalSettings = enrichmentSettings;
      finalTaskId = 'note_image_understanding+note_enrichment';
    } catch {
      // A reviewer outage must not make image capture or AI organization
      // unavailable; the schema-validated visual result remains usable.
    }
  }
  const analysis = normalizeAnalysis(response.json, entry.note, hints, finalSettings);
  const latest = findNote(await getLearningSnapshot(env), noteUid)?.note;
  if (!latest) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
  const stored = await applyAiNoteEnrichment(env, noteUid, {
    ...analysis,
    provider: response.provider,
    model: response.model,
    taskId: finalTaskId,
    configurationHash: response.configurationHash,
    workflowHash: response.workflowHash,
    preserveTitle: false,
  });
  return { analysis, snapshot: stored, provider: response.provider, model: response.model, taskId: finalTaskId };
}

export const noteAnalysisInternals = Object.freeze({
  analysisPrompt,
  compactTaxonomy,
  normalizeAnalysis,
  resolveImageRepoPath,
  strongHints,
});
