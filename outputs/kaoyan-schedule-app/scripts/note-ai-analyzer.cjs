const fs = require('fs');
const path = require('path');
const { createAiRouter } = require('./ai-router.cjs');
const {
  AI_SUPPORTED_SUBJECTS,
  AI_FALLBACK_SUBJECT,
  filterTaxonomyForAi,
  resolveAiSubject,
} = require('./ai-subject-policy.cjs');
const { parseRemark } = require('./remark-parser.cjs');
const { NOTE_ANALYSIS_INSTRUCTIONS, NOTE_ANALYSIS_OUTPUT } = require('./agent-workflow-contracts.cjs');
const { mathOneQuestionTypePath, normalizeMathOneQuestionType } = require('./math-one-question-types.cjs');

const ANALYZER_VERSION = 'note-ai-analyzer-v6';
const DEFAULT_TAXONOMY_MAX_CHARS = 12_000;

const NOTE_ANALYSIS_SCHEMA = Object.freeze({
  type: 'object',
  required: [
    'subject',
    'knowledgePoint',
    'aliases',
    'title',
    'summary',
    'tags',
    'wrongReason',
    'intent',
    'items',
    'cards',
    'confidence',
    'reason',
  ],
  additionalProperties: false,
  properties: {
    subject: { type: 'string', minLength: 1, maxLength: 60 },
    knowledgePoint: { type: ['string', 'null'], maxLength: 60 },
    aliases: {
      type: 'object',
      required: ['subject', 'knowledgePoint'],
      additionalProperties: false,
      properties: {
        subject: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 60 } },
        knowledgePoint: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 60 } },
      },
    },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    summary: { type: 'string', minLength: 1, maxLength: 2_000 },
    tags: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 40 } },
    questionType: { type: ['string', 'null'], maxLength: 60 },
    questionTypePath: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 60 } },
    learningTypePath: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 60 } },
    goodQuestionType: { type: ['string', 'null'], enum: ['经典母题', '方法好题', '易错辨析', '综合提升', '新颖拓展', null] },
    wrongReason: { type: ['string', 'null'], maxLength: 500 },
    wrongReasonPath: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 60 } },
    wrongReasonSource: { type: 'string', enum: ['explicit_remark', 'explicit_image', 'ai_inferred', 'none'] },
    wrongReasonConfidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    intent: {
      type: 'object',
      required: ['isQuestion', 'isMistake', 'shouldMemorize'],
      additionalProperties: false,
      properties: {
        isQuestion: { type: 'boolean' },
        isMistake: { type: 'boolean' },
        isGood: { type: 'boolean' },
        shouldMemorize: { type: 'boolean' },
      },
    },
    items: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        required: ['title', 'knowledgePoint', 'summary', 'tags', 'wrongReason', 'intent'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 120 },
          knowledgePoint: { type: ['string', 'null'], maxLength: 60 },
          questionType: { type: ['string', 'null'], maxLength: 60 },
          questionTypePath: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 60 } },
          learningTypePath: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 60 } },
          summary: { type: 'string', minLength: 1, maxLength: 1_000 },
          tags: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 40 } },
          wrongReason: { type: ['string', 'null'], maxLength: 500 },
          wrongReasonPath: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 60 } },
          intent: {
            type: 'object',
            required: ['isQuestion', 'isMistake', 'shouldMemorize'],
            additionalProperties: false,
            properties: {
              isQuestion: { type: 'boolean' },
              isMistake: { type: 'boolean' },
              isGood: { type: 'boolean' },
              shouldMemorize: { type: 'boolean' },
            },
          },
        },
      },
    },
    cards: {
      type: 'array',
      maxItems: 2,
      items: {
        type: 'object',
        required: ['front', 'back'],
        additionalProperties: false,
        properties: {
          front: { type: 'string', minLength: 1, maxLength: 500 },
          back: { type: 'string', minLength: 1, maxLength: 2_000 },
          kind: { type: ['string', 'null'], maxLength: 24 },
          itemIndex: { type: ['integer', 'null'], minimum: 0, maximum: 11 },
        },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', minLength: 1, maxLength: 1_000 },
  },
});

function createNoteAnalysisSchema(options = {}) {
  const schema = JSON.parse(JSON.stringify(NOTE_ANALYSIS_SCHEMA));
  schema.properties.items.maxItems = Math.max(1, Math.min(12, Number(options.maxItems) || 12));
  const configuredMaxCards = options.cardPolicy === 'disabled' ? 0 : Number(options.maxCards);
  schema.properties.cards.maxItems = Math.max(0, Math.min(6, Number.isFinite(configuredMaxCards) ? configuredMaxCards : 2));
  return schema;
}

function cleanText(value, maxLength = 2_000) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function uniqueStrings(value, maxItems, maxLength) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const text = cleanText(item, maxLength);
    const key = text.toLocaleLowerCase('zh-CN');
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function normalizeClassificationPath(value) {
  return uniqueStrings(value, 3, 60);
}

const GOOD_QUESTION_TYPES = new Set(['经典母题', '方法好题', '易错辨析', '综合提升', '新颖拓展']);

function inferGoodQuestionType(value, isGood) {
  if (!isGood) return null;
  const content = cleanText(value, 4000);
  if (/新颖|创新|拓展|一题多解/u.test(content)) return '新颖拓展';
  if (/综合|压轴|多知识点/u.test(content)) return '综合提升';
  if (/易错|辨析|陷阱/u.test(content)) return '易错辨析';
  if (/方法|技巧|构造|模板/u.test(content)) return '方法好题';
  return '经典母题';
}

function subjectFromStableNaming(metadata) {
  const fileName = cleanText(metadata?.fileName, 240);
  const prefixed = AI_SUPPORTED_SUBJECTS.find((subject) => fileName.startsWith(`${subject}_`));
  if (prefixed) return prefixed;
  if (metadata?.naming?.status !== 'complete') return '';
  const reason = cleanText(metadata.naming.reason, 1000);
  return AI_SUPPORTED_SUBJECTS.find((subject) => reason.includes(subject)) || '';
}

function inferWrongReasonPath(value) {
  const reason = cleanText(value, 500).toLowerCase();
  if (!reason) return [];
  if (/走神|分心|注意力/u.test(reason)) return ['粗心大意', '注意力', '走神分心'];
  if (/粗心/u.test(reason)) {
    if (/审题|题意|条件/u.test(reason)) return ['粗心大意', '审题疏漏', '审题不仔细'];
    if (/抄|数据/u.test(reason)) return ['粗心大意', '计算疏漏', '抄错数据'];
    if (/计算|算错|运算/u.test(reason)) return ['粗心大意', '计算疏漏', '算术错误'];
    return ['粗心大意', '作答习惯', '漏项漏写'];
  }
  if (/漏看|看漏|漏条件|遗漏条件/u.test(reason)) return ['粗心大意', '审题疏漏', '看漏条件'];
  if (/审题|题意|误读/u.test(reason)) return ['粗心大意', '审题疏漏', '误读条件'];
  if (/概念|定义|性质.*混/u.test(reason)) return ['知识与记忆', '概念辨析', /混/u.test(reason) ? '概念混淆' : '定义不清'];
  if (/公式.*忘|定理.*忘|没记住/u.test(reason)) return ['知识与记忆', '公式定理', '公式遗忘'];
  if (/方法|思路|题型/u.test(reason)) return ['思路与方法', '方法选择', /题型/u.test(reason) ? '未识别题型' : '方法选错'];
  if (/正负|符号/u.test(reason)) return ['推理与计算', '符号表达', '正负号错误'];
  if (/求导/u.test(reason)) return ['推理与计算', '专项计算', '求导错误'];
  if (/积分/u.test(reason)) return ['推理与计算', '专项计算', '积分错误'];
  if (/计算|运算|算错/u.test(reason)) return ['推理与计算', '运算错误', '算术计算错误'];
  if (/忘记|想不起|记忆/u.test(reason)) return ['知识与记忆', '回忆失败', '公式想不起'];
  return ['其他', '信息不足', '尚未明确'];
}

function inferLearningTypePath(value, subject, questionType, intent) {
  const text = cleanText(value, 4000);
  if (subject === '英语') {
    const leaf = /作文|写作|模板/u.test(text) ? '写作模板' : /翻译/u.test(text) ? '翻译表达' : /长难句/u.test(text) ? '长难句' : /语法/u.test(text) ? '语法规则' : '单词短语';
    return ['英语积累', leaf];
  }
  if (subject === '政治') return ['政治材料', /时政|材料/u.test(text) ? '时政材料' : /模板|答题/u.test(text) ? '分析模板' : /原理/u.test(text) ? '原理表述' : '核心概念'];
  if (/易错|警示|注意|避免/u.test(text)) return ['易错警示', '检查清单'];
  if (/结论|推论|规律/u.test(text)) return ['结论规律', '常用结论'];
  if (questionType || /题型|解题|步骤|方法|构造/u.test(text)) return ['题型方法', '标准步骤'];
  if (/公式|定理/u.test(text)) return ['基础知识', '公式定理'];
  if (/原理|机制/u.test(text)) return ['基础知识', '原理机制'];
  return intent?.shouldMemorize ? ['基础知识', '定义概念'] : ['基础知识', '定义概念'];
}

function mimeTypeForPath(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  const mimeTypes = new Map([
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'],
    ['.gif', 'image/gif'],
    ['.bmp', 'image/bmp'],
    ['.png', 'image/png'],
  ]);
  return mimeTypes.get(ext) || 'application/octet-stream';
}

function imagePathToDataUrl(imagePath) {
  if (typeof imagePath !== 'string' || !imagePath.trim()) {
    throw new TypeError('analyzeNote requires context.imagePath');
  }
  const resolved = path.resolve(imagePath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    const wrapped = new Error(`Note image is unavailable: ${path.basename(resolved)}`);
    wrapped.code = 'NOTE_IMAGE_UNAVAILABLE';
    wrapped.cause = error;
    throw wrapped;
  }
  if (!stat.isFile()) {
    const error = new Error(`Note image is not a file: ${path.basename(resolved)}`);
    error.code = 'NOTE_IMAGE_INVALID';
    throw error;
  }
  const mime = mimeTypeForPath(resolved);
  if (!mime.startsWith('image/')) {
    const error = new Error(`Unsupported note image type: ${path.extname(resolved) || '(none)'}`);
    error.code = 'NOTE_IMAGE_UNSUPPORTED';
    throw error;
  }
  return `data:${mime};base64,${fs.readFileSync(resolved).toString('base64')}`;
}

function collectImagePaths(context = {}) {
  const candidates = [
    ...(Array.isArray(context.imagePaths) ? context.imagePaths : []),
    context.imagePath,
    ...(Array.isArray(context.metadata?.attachments)
      ? context.metadata.attachments.map((attachment) => attachment?.filePath)
      : []),
    ...(Array.isArray(context.metadata?.learning?.attachments)
      ? context.metadata.learning.attachments.map((attachment) => attachment?.filePath)
      : []),
  ];
  const seen = new Set();
  const paths = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const resolved = path.resolve(candidate);
    const key = resolved.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || !mimeTypeForPath(resolved).startsWith('image/')) continue;
    } catch {
      continue;
    }
    seen.add(key);
    paths.push(resolved);
    if (paths.length >= 8) break;
  }
  if (paths.length === 0) {
    // Preserve the previous explicit error contract when no usable image was
    // found, while still accepting multi-image material notes.
    imagePathToDataUrl(context.imagePath);
  }
  return paths;
}

function detectStrongIntentHints(remark, parsed) {
  const text = typeof remark === 'string' ? remark.normalize('NFKC') : '';
  const standaloneMemory = /(?:^|[\s#【\[，,。；;：:])(?:记|记住|记忆|背|背诵|要背)(?=$|[\s#】\]，,。；;：:])/u.test(text);
  const phraseMemory = /(?:要记住|记下来|需要记|必须记|背下来|需要背|必须背|重点背|熟记)/u.test(text);
  const explicitMistake = Boolean(parsed?.flags?.isMistake);
  const explicitMemory = Boolean(parsed?.flags?.shouldMemorize || standaloneMemory || phraseMemory);
  return {
    isMistake: explicitMistake,
    isGood: Boolean(parsed?.flags?.isClassic),
    shouldMemorize: explicitMemory,
    explicitMistake,
    explicitMemory,
    memorySignal: standaloneMemory || phraseMemory ? 'strong-language-hint' : parsed?.flags?.shouldMemorize ? 'local-parser' : null,
  };
}

function compactTaxonomy(taxonomy, maxChars = DEFAULT_TAXONOMY_MAX_CHARS) {
  const limit = Math.max(500, Number(maxChars) || DEFAULT_TAXONOMY_MAX_CHARS);
  const output = {
    revision: Number.isInteger(taxonomy?.revision) ? taxonomy.revision : null,
    truncated: false,
    subjects: [],
  };
  const subjects = Array.isArray(taxonomy?.subjects) ? taxonomy.subjects : [];

  for (const subject of subjects) {
    const compactSubject = {
      name: cleanText(subject?.name, 60),
      aliases: uniqueStrings(subject?.aliases, 8, 60),
      knowledgePoints: [],
    };
    if (!compactSubject.name) continue;
    const withSubject = { ...output, subjects: [...output.subjects, compactSubject] };
    if (JSON.stringify(withSubject).length > limit) {
      output.truncated = true;
      break;
    }
    output.subjects.push(compactSubject);

    const points = Array.isArray(subject?.knowledgePoints) ? subject.knowledgePoints : [];
    for (const point of points) {
      const compactPoint = {
        name: cleanText(point?.name, 60),
        aliases: uniqueStrings(point?.aliases, 8, 60),
      };
      if (!compactPoint.name) continue;
      compactSubject.knowledgePoints.push(compactPoint);
      if (JSON.stringify(output).length > limit) {
        compactSubject.knowledgePoints.pop();
        output.truncated = true;
        break;
      }
    }
    if (output.truncated) break;
  }

  return output;
}

function makePromptContext(context, parsed, hints, taxonomy) {
  const metadata = context.metadata && typeof context.metadata === 'object' ? context.metadata : {};
  const current = context.currentCategory && typeof context.currentCategory === 'object'
    ? context.currentCategory
    : {};
  return {
    captureKind: metadata.kind === 'canvas' ? 'canvas' : 'single',
    existingTitle: cleanText(metadata.title, 120) || null,
    remark: typeof metadata.remark === 'string' ? metadata.remark.slice(0, 4_000) : '',
    locallyParsed: {
      pages: Array.isArray(parsed.pages) ? parsed.pages.slice(0, 60) : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 30) : [],
      explicitTags: uniqueStrings(parsed.explicitTags, 20, 40),
      inferredTags: uniqueStrings(parsed.inferredTags, 20, 40),
      wrongReasons: uniqueStrings(parsed.wrongReasons, 10, 200),
      cautions: uniqueStrings(parsed.cautions, 10, 200),
      sources: uniqueStrings(parsed.sources, 10, 80),
      flags: parsed.flags || {},
      strongIntentHints: hints,
    },
    currentCategory: {
      subject: cleanText(current.subject, 60) || null,
      knowledgePoint: cleanText(current.knowledgePoint, 60) || null,
    },
    namingEvidence: {
      subject: subjectFromStableNaming(metadata) || null,
      reason: cleanText(metadata.naming?.reason, 1000) || null,
      fileName: cleanText(metadata.fileName, 240) || null,
      visualEvidence: metadata.classifier?.visualEvidence || metadata.learning?.visualEvidence || null,
    },
    existingLearning: {
      noteType: cleanText(metadata.learning?.noteType, 40) || null,
      organizationStatus: cleanText(metadata.learning?.organizationStatus, 40) || null,
      questionTypePath: normalizeClassificationPath(metadata.learning?.questionTypePath),
      wrongReason: cleanText(metadata.learning?.wrongReason, 500) || null,
      wrongReasonPath: normalizeClassificationPath(metadata.learning?.wrongReasonPath),
      learningTypePath: normalizeClassificationPath(metadata.learning?.learningTypePath),
      wrongReasonSource: cleanText(metadata.learning?.wrongReasonSource, 40) || null,
      userEditedFields: uniqueStrings(metadata.learning?.userEditedFields, 30, 60),
    },
    existingTaxonomy: taxonomy,
  };
}

function fillAnalysisTemplate(value, variables) {
  return String(value || '').replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) => String(variables[key] ?? ''));
}

function buildPrompt(contextPayload, options = {}) {
  const maxItems = Math.max(1, Math.min(12, Number(options.maxItems) || 12));
  const requestedMaxCards = Number(options.maxCards);
  const maxCards = options.cardPolicy === 'disabled'
    ? 0
    : Math.max(0, Math.min(6, Number.isFinite(requestedMaxCards) ? requestedMaxCards : 2));
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
  const exclusiveIntentRule = contextPayload?.locallyParsed?.strongIntentHints?.explicitMistake
    && !contextPayload?.locallyParsed?.strongIntentHints?.explicitMemory
    ? '用户只明确标记了错题、没有标记背诵；intent.shouldMemorize 和所有分项的 shouldMemorize 必须为 false，不得仅因题目含公式或定义而加入背诵分类。'
    : '';
  const cardRule = options.cardPolicy === 'disabled'
    ? 'cards 必须为空数组。'
    : options.cardPolicy === 'high_value'
      ? `最多生成 ${maxCards} 张高价值主动回忆卡片；答案必须明确且不重复，宁缺毋滥。`
      : `只有整张或对应分项存在明确错题意图或记忆意图时才生成 cards；最多 ${maxCards} 张。`;
  const variables = {
    supportedSubjects: AI_SUPPORTED_SUBJECTS.join('、'),
    fallbackSubject: AI_FALLBACK_SUBJECT,
    maxItems,
    maxCards,
    summaryRule,
    mistakeRule,
    goodRule,
    memorizeRule,
    exclusiveIntentRule,
    cardRule,
    contextPayload: JSON.stringify(contextPayload),
  };
  return [
    ...NOTE_ANALYSIS_INSTRUCTIONS.map((line) => fillAnalysisTemplate(line, variables)).filter(Boolean),
    variables.exclusiveIntentRule,
    fillAnalysisTemplate(NOTE_ANALYSIS_OUTPUT, variables),
  ].filter(Boolean).join('\n');
}

function normalizeIntent(value) {
  return {
    isQuestion: value?.isQuestion === true,
    isMistake: value?.isMistake === true,
    isGood: value?.isGood === true,
    shouldMemorize: value?.shouldMemorize === true,
  };
}

function normalizeItems(value, maxItems = 12) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, Math.max(1, Math.min(12, maxItems))).map((item) => ({
    title: cleanText(item.title, 120),
    knowledgePoint: cleanText(item.knowledgePoint, 60) || null,
    questionType: cleanText(item.questionType, 60) || null,
    questionTypePath: normalizeClassificationPath(item.questionTypePath),
    summary: cleanText(item.summary, 1_000),
    tags: uniqueStrings(item.tags, 12, 40),
    wrongReason: cleanText(item.wrongReason, 500) || null,
    wrongReasonPath: normalizeClassificationPath(item.wrongReasonPath),
    learningTypePath: normalizeClassificationPath(item.learningTypePath),
    intent: normalizeIntent(item.intent),
  }));
}

function cardAllowed(card, overallIntent, items, hints, allTags, options) {
  if (options.cardPolicy === 'disabled') return false;
  if (options.cardPolicy === 'high_value') return true;
  const itemIndex = Number.isInteger(card?.itemIndex) ? card.itemIndex : null;
  const itemIntent = itemIndex !== null && items[itemIndex] ? items[itemIndex].intent : null;
  const tagsSignal = allTags.some((tag) => ['错题', '易错', '背诵', '记忆'].includes(tag));
  return Boolean(
    hints.isMistake
    || hints.shouldMemorize
    || overallIntent.isMistake
    || overallIntent.shouldMemorize
    || itemIntent?.isMistake
    || itemIntent?.shouldMemorize
    || tagsSignal
  );
}

function normalizeCards(value, overallIntent, items, hints, tags, options = {}) {
  if (!Array.isArray(value)) return [];
  const maxCards = options.cardPolicy === 'disabled'
    ? 0
    : Math.max(0, Math.min(6, Number.isFinite(Number(options.maxCards)) ? Number(options.maxCards) : 2));
  const cards = [];
  const seenQuestions = new Set();
  for (let index = 0; index < value.length && cards.length < maxCards; index += 1) {
    const card = value[index];
    if (!card || typeof card !== 'object' || !cardAllowed(card, overallIntent, items, hints, tags, options)) continue;
    const front = cleanText(card.front, 500);
    const back = cleanText(card.back, 2_000);
    if (front.length < 4 || back.length < 6 || front === back) continue;
    const questionKey = front.toLocaleLowerCase('zh-CN').replace(/[\s，。！？、；：,.!?;:]+/gu, '');
    if (!questionKey || seenQuestions.has(questionKey)) continue;
    seenQuestions.add(questionKey);
    const itemIndex = Number.isInteger(card.itemIndex) && card.itemIndex >= 0 && card.itemIndex < items.length
      ? card.itemIndex
      : null;
    const scopedIntent = itemIndex === null ? overallIntent : items[itemIndex].intent;
    const fallbackKind = scopedIntent.isMistake || overallIntent.isMistake || hints.isMistake ? 'mistake' : 'memory';
    const requestedKind = cleanText(card.kind, 24).toLowerCase();
    const kind = requestedKind === 'mistake' ? 'mistake' : fallbackKind;
    cards.push({
      sourceKey: `ai:${itemIndex ?? 'root'}:${cards.length}`,
      kind,
      front,
      back,
      status: 'active',
      ...(itemIndex === null ? {} : { itemIndex }),
    });
  }
  return cards;
}

function normalizeAnalysis(aiResult, provider, model, parsed, hints, options = {}, promptContext = {}) {
  if (!aiResult || typeof aiResult !== 'object' || Array.isArray(aiResult)) {
    const error = new Error('AI note analyzer returned an invalid result');
    error.code = 'NOTE_AI_RESULT_INVALID';
    throw error;
  }
  const aliases = aiResult.aliases && typeof aiResult.aliases === 'object' ? aiResult.aliases : {};
  const aiIntent = normalizeIntent(aiResult.intent);
  const suppressInferredMemory = hints.explicitMistake === true && hints.explicitMemory !== true;
  const intent = {
    ...aiIntent,
    isMistake: options.mistakePolicy === 'explicit_only' ? hints.isMistake : aiIntent.isMistake || hints.isMistake,
    isGood: options.goodQuestionPolicy === 'ai_high_value' ? aiIntent.isGood || hints.isGood : hints.isGood,
    shouldMemorize: suppressInferredMemory
      ? false
      : options.memorizePolicy === 'explicit_only' ? hints.shouldMemorize : aiIntent.shouldMemorize || hints.shouldMemorize,
  };
  const items = normalizeItems(aiResult.items, Number(options.maxItems) || 12).map((item) => ({
    ...item,
    tags: suppressInferredMemory
      ? item.tags.filter((tag) => !/(?:背诵|记忆|要背|记住)/u.test(tag))
      : item.tags,
    intent: {
      ...item.intent,
      ...(options.mistakePolicy === 'explicit_only' ? { isMistake: hints.isMistake } : {}),
      ...(options.goodQuestionPolicy !== 'ai_high_value' ? { isGood: hints.isGood } : {}),
      ...(suppressInferredMemory
        ? { shouldMemorize: false }
        : options.memorizePolicy === 'explicit_only' ? { shouldMemorize: hints.shouldMemorize } : {}),
    },
  }));
  const questionType = cleanText(aiResult.questionType, 60) || null;
  const tags = uniqueStrings([
    ...(Array.isArray(aiResult.tags) ? aiResult.tags : []),
    ...(intent.isMistake ? ['错题'] : []),
    ...(intent.shouldMemorize ? ['背诵'] : []),
    ...(questionType ? [`题型:${questionType}`] : []),
  ], 20, 40).filter((tag) => (
    !['好题', '经典题', '典型题', '精品题'].includes(tag)
    && (!suppressInferredMemory || !/(?:背诵|记忆|要背|记住)/u.test(tag))
  ));
  const cards = normalizeCards(aiResult.cards, intent, items, hints, tags, options);
  const confidence = Number(aiResult.confidence);
  const explicitRemarkReason = uniqueStrings(parsed?.wrongReasons, 1, 500)[0] || '';
  const manualWrongReason = cleanText(promptContext?.existingLearning?.wrongReason, 500);
  const manualFields = new Set(promptContext?.existingLearning?.userEditedFields || []);
  const manualLocked = manualFields.has('wrongReason');
  const aiWrongReason = cleanText(aiResult.wrongReason, 500);
  const allowedWrongReasonSources = new Set(['explicit_remark', 'explicit_image', 'ai_inferred', 'none']);
  const wrongReason = manualLocked ? manualWrongReason : explicitRemarkReason || aiWrongReason || null;
  let wrongReasonSource = manualLocked
    ? (manualWrongReason ? 'manual' : 'manual_deleted')
    : explicitRemarkReason
      ? 'explicit_remark'
      : allowedWrongReasonSources.has(aiResult.wrongReasonSource)
        ? aiResult.wrongReasonSource
        : aiWrongReason ? 'ai_inferred' : 'none';
  if (!wrongReason) wrongReasonSource = manualLocked ? 'manual_deleted' : 'none';
  const rawWrongReasonConfidence = Number(aiResult.wrongReasonConfidence);
  const wrongReasonConfidence = manualLocked
    ? (manualWrongReason ? 1 : null)
    : explicitRemarkReason
      ? 1
      : wrongReason && Number.isFinite(rawWrongReasonConfidence)
        ? Math.min(1, Math.max(0, rawWrongReasonConfidence))
        : wrongReason ? 0.55 : null;
  const questionTypePath = normalizeClassificationPath(aiResult.questionTypePath);
  const wrongReasonPath = manualFields.has('wrongReasonPath')
    ? normalizeClassificationPath(promptContext?.existingLearning?.wrongReasonPath)
    : normalizeClassificationPath(aiResult.wrongReasonPath).length > 0
      ? normalizeClassificationPath(aiResult.wrongReasonPath)
      : inferWrongReasonPath(wrongReason);
  const learningTypePath = manualFields.has('learningTypePath')
    ? normalizeClassificationPath(promptContext?.existingLearning?.learningTypePath)
    : normalizeClassificationPath(aiResult.learningTypePath).length > 0
      ? normalizeClassificationPath(aiResult.learningTypePath)
      : inferLearningTypePath(
          [aiResult.title, aiResult.summary, ...(Array.isArray(aiResult.tags) ? aiResult.tags : [])].join(' '),
          cleanText(aiResult.subject, 60),
          questionType,
          intent,
        );
  const requestedGoodQuestionType = cleanText(aiResult.goodQuestionType, 40);
  const goodQuestionType = intent.isGood
    ? GOOD_QUESTION_TYPES.has(requestedGoodQuestionType)
      ? requestedGoodQuestionType
      : inferGoodQuestionType([aiResult.title, aiResult.summary, ...(Array.isArray(aiResult.tags) ? aiResult.tags : [])].join(' '), true)
    : null;
  return {
    subject: cleanText(aiResult.subject, 60),
    knowledgePoint: cleanText(aiResult.knowledgePoint, 60) || null,
    aliases: {
      subject: uniqueStrings(aliases.subject, 8, 60),
      knowledgePoint: uniqueStrings(aliases.knowledgePoint, 12, 60),
    },
    // Organizer v1 consumes these two flattened aliases.
    subjectAliases: uniqueStrings(aliases.subject, 8, 60),
    knowledgePointAliases: uniqueStrings(aliases.knowledgePoint, 12, 60),
    title: cleanText(aiResult.title, 120),
    summary: cleanText(aiResult.summary, 2_000),
    tags,
    questionType,
    questionTypePath,
    wrongReason,
    wrongReasonPath,
    learningTypePath,
    goodQuestionType,
    wrongReasonSource,
    wrongReasonConfidence,
    intent,
    items,
    cards,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    reason: cleanText(aiResult.reason, 1_000),
    provider,
    model,
    local: {
      pages: Array.isArray(parsed.pages) ? parsed.pages : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      strongIntentHints: hints,
    },
  };
}

function createNoteAiAnalyzer(options = {}) {
  const router = options.router || createAiRouter(options.routerOptions || {});
  const taxonomyMaxChars = Number(options.taxonomyMaxChars || process.env.KAOYAN_AI_TAXONOMY_MAX_CHARS)
    || DEFAULT_TAXONOMY_MAX_CHARS;

  const analyzer = async function noteAiAnalyzer(context = {}) {
    const metadata = context.metadata && typeof context.metadata === 'object' ? context.metadata : {};
    const remarkMissing = !cleanText(metadata.remark, 4_000);
    const baseTaskOptions = typeof router.getTaskOptions === 'function' ? router.getTaskOptions('note_enrichment') : {};
    // One vision-capable call is the reliable write path. A previous version
    // synchronously chained a second reviewer for every note, so provider
    // retries could exhaust the five-minute outer job lease before any result
    // was persisted.
    const canvasTask = metadata.kind === 'canvas' || metadata.sourceType === 'canvas-publish';
    const taskId = canvasTask
      ? 'canvas_note_understanding'
      : remarkMissing ? 'note_image_understanding' : 'note_enrichment';
    const taskOptions = typeof router.getTaskOptions === 'function'
      ? { ...baseTaskOptions, ...router.getTaskOptions(taskId) }
      : baseTaskOptions;
    const parsed = parseRemark(typeof metadata.remark === 'string' ? metadata.remark : '');
    const baseHints = detectStrongIntentHints(metadata.remark, parsed);
    const existingTags = Array.isArray(metadata.learning?.tags) ? metadata.learning.tags : [];
    const hints = {
      ...baseHints,
      isMistake: baseHints.isMistake || metadata.learning?.noteType === 'mistake' || existingTags.includes('错题'),
      shouldMemorize: baseHints.shouldMemorize || metadata.learning?.noteType === 'memory' || existingTags.includes('背诵'),
    };
    // Unknown legacy/user subjects remain in the persisted taxonomy, but they
    // are deliberately omitted from the AI prompt so the model cannot select
    // them as a new top-level classification.
    const taxonomy = compactTaxonomy(
      filterTaxonomyForAi(context.taxonomy),
      Number(taskOptions.taxonomyContextChars) || taxonomyMaxChars,
    );
    const promptContext = makePromptContext(context, parsed, hints, taxonomy);
    const imagePaths = collectImagePaths(context);
    const imageContent = imagePaths.flatMap((imagePath, index) => [
      { type: 'text', text: `整组资料图片 ${index + 1}/${imagePaths.length}：${path.basename(imagePath)}` },
      { type: 'image_url', image_url: { url: imagePathToDataUrl(imagePath) } },
    ]);

    const visualResult = await router.complete({
      task: taskId,
      difficulty: canvasTask ? 'high' : remarkMissing ? 'high' : 'medium',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildPrompt(promptContext, taskOptions) },
            ...imageContent,
          ],
        },
      ],
      responseSchema: createNoteAnalysisSchema(taskOptions),
      temperature: 0.1,
      maxTokens: Number(taskOptions.maxTokens) || (metadata.kind === 'canvas' ? 5_200 : 3_200),
      networkRetries: 0,
      jsonRepairRetries: 0,
    });
    const analysis = normalizeAnalysis(
      visualResult.json,
      visualResult.provider,
      visualResult.model,
      parsed,
      hints,
      taskOptions,
      promptContext,
    );
    let subjectDecision = resolveAiSubject(context.taxonomy, {
      requestedSubject: analysis.subject,
      subjectAliases: analysis.subjectAliases,
      currentSubject: context.currentCategory?.subject,
      knowledgePoint: analysis.knowledgePoint,
      questionType: analysis.questionType,
      title: analysis.title,
      summary: analysis.summary,
      tags: analysis.tags,
      items: analysis.items,
    });
    const currentSubject = cleanText(context.currentCategory?.subject, 60);
    const stableSubject = promptContext.namingEvidence?.subject
      || (promptContext.existingLearning?.userEditedFields?.includes('subject')
        && AI_SUPPORTED_SUBJECTS.includes(currentSubject)
        ? currentSubject
        : '');
    if (stableSubject && subjectDecision.subject !== stableSubject) {
      subjectDecision = {
        ...resolveAiSubject(context.taxonomy, { requestedSubject: stableSubject }),
        reason: 'stable-subject-anchor',
      };
    }
    const questionType = normalizeMathOneQuestionType(
      subjectDecision.subject,
      analysis.questionType,
      [analysis.title, analysis.summary, analysis.knowledgePoint, metadata.remark].filter(Boolean).join(' '),
    );
    const canonicalMathPath = mathOneQuestionTypePath(
      subjectDecision.subject,
      questionType,
      [analysis.title, analysis.summary, analysis.knowledgePoint, metadata.remark].filter(Boolean).join(' '),
    );
    const modelQuestionPath = normalizeClassificationPath(analysis.questionTypePath);
    const questionTypePath = !questionType
      ? []
      : canonicalMathPath.length > 1
        ? canonicalMathPath
        : modelQuestionPath.length > 0
          ? [...modelQuestionPath.slice(0, 2), questionType].filter((item, index, values) => values.indexOf(item) === index).slice(0, 3)
          : [questionType];
    const items = analysis.items.map((item) => ({
      ...item,
      questionType: normalizeMathOneQuestionType(
        subjectDecision.subject,
        item.questionType,
        [item.title, item.summary, item.knowledgePoint, analysis.title].filter(Boolean).join(' '),
      ),
    })).map((item) => ({
      ...item,
      questionTypePath: item.questionType
        ? mathOneQuestionTypePath(subjectDecision.subject, item.questionType, [item.title, item.summary].join(' ')).length > 1
          ? mathOneQuestionTypePath(subjectDecision.subject, item.questionType, [item.title, item.summary].join(' '))
          : normalizeClassificationPath(item.questionTypePath).length > 0
            ? normalizeClassificationPath(item.questionTypePath)
            : [item.questionType]
        : [],
      wrongReasonPath: normalizeClassificationPath(item.wrongReasonPath).length > 0
        ? normalizeClassificationPath(item.wrongReasonPath)
        : inferWrongReasonPath(item.wrongReason),
      learningTypePath: normalizeClassificationPath(item.learningTypePath).length > 0
        ? normalizeClassificationPath(item.learningTypePath)
        : analysis.learningTypePath,
    }));
    return {
      ...analysis,
      subject: subjectDecision.subject,
      questionType,
      questionTypePath,
      items,
      tags: uniqueStrings([
        ...analysis.tags.filter((tag) => !tag.startsWith('题型:')),
        ...(questionType ? [`题型:${questionType}`] : []),
      ], 20, 40),
      // Never attach an unknown model-proposed first-level name as an alias to
      // a valid standard exam subject or to the fallback bucket.
      aliases: {
        ...analysis.aliases,
        subject: subjectDecision.reason === 'direct' || subjectDecision.reason === 'alias'
          ? analysis.aliases.subject
          : [],
      },
      subjectAliases: subjectDecision.reason === 'direct' || subjectDecision.reason === 'alias'
        ? analysis.subjectAliases
        : [],
      subjectPolicy: {
        fallback: subjectDecision.fallback,
        reason: subjectDecision.reason,
      },
    };
  };
  analyzer.analyzerVersion = ANALYZER_VERSION;
  return analyzer;
}

let defaultAnalyzer = null;

async function analyzeNote(context) {
  if (!defaultAnalyzer) {
    const os = require('node:os');
    const assistantRoot = process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手');
    const { createPersistentAiRequestGuard } = require('./ai-request-budget.cjs');
    const configPath = process.env.KAOYAN_AI_CONFIG_PATH || path.join(assistantRoot, 'ai-providers.json');
    defaultAnalyzer = createNoteAiAnalyzer({
      routerOptions: {
        beforeAttempt: createPersistentAiRequestGuard({
          assistantRoot,
          getSettings: () => {
            try {
              return JSON.parse(fs.readFileSync(configPath, 'utf8')).usageProtection;
            } catch {
              return undefined;
            }
          },
        }),
      },
    });
  }
  return defaultAnalyzer(context);
}
analyzeNote.analyzerVersion = ANALYZER_VERSION;

module.exports = {
  ANALYZER_VERSION,
  NOTE_ANALYSIS_SCHEMA,
  analyzeNote,
  createNoteAnalysisSchema,
  compactTaxonomy,
  createNoteAiAnalyzer,
  detectStrongIntentHints,
  imagePathToDataUrl,
};
