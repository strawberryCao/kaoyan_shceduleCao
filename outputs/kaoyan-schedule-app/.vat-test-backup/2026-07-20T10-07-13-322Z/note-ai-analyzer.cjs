const fs = require('fs');
const path = require('path');
const { createAiRouter } = require('./ai-router.cjs');
const {
  AI_408_SUBJECTS,
  AI_FALLBACK_SUBJECT,
  filterTaxonomyForAi,
  resolveAiSubject,
} = require('./ai-subject-policy.cjs');
const { parseRemark } = require('./remark-parser.cjs');

const ANALYZER_VERSION = 'note-ai-analyzer-v3';
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
    wrongReason: { type: ['string', 'null'], maxLength: 500 },
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
          summary: { type: 'string', minLength: 1, maxLength: 1_000 },
          tags: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 40 } },
          wrongReason: { type: ['string', 'null'], maxLength: 500 },
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

function detectStrongIntentHints(remark, parsed) {
  const text = typeof remark === 'string' ? remark.normalize('NFKC') : '';
  const standaloneMemory = /(?:^|[\s#【\[，,。；;：:])(?:记|记住|背|要背)(?=$|[\s#】\]，,。；;：:])/u.test(text);
  const phraseMemory = /(?:要记住|记下来|需要记|必须记|背下来|需要背|必须背|重点背|熟记)/u.test(text);
  return {
    isMistake: Boolean(parsed?.flags?.isMistake),
    isGood: Boolean(parsed?.flags?.isClassic),
    shouldMemorize: Boolean(parsed?.flags?.shouldMemorize || standaloneMemory || phraseMemory),
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
    existingTaxonomy: taxonomy,
  };
}

function buildPrompt(contextPayload) {
  return [
    '你是考研笔记的语义整理器。请同时阅读图片与备注，输出严格 JSON。',
    '目标不是机械匹配关键词，而是判断图片实际知识内容、题目类型、用户为何记录它，以及它是否值得记忆或重做。',
    '“记”“记住”“背”“要背”等是很强的记忆意图提示，但没有这些词时，也要依据定义、公式、结论、易混点和用户语义判断；不能只靠固定词表。',
    '分类规则：',
    `1. subject 只能从 existingTaxonomy 中已有的 408 一级科目选择：${AI_408_SUBJECTS.join('、')}。禁止创建、提议或输出其他一级科目。`,
    `1.1 新领域或更细的主题只能写入 knowledgePoint/tags/items，绝不能写入 subject；无法可靠归入上述四科时 subject 必须为“${AI_FALLBACK_SUBJECT}”。`,
    '1.2 你必须做出最合理的科目判断。只要图片或备注能可靠识别为某个 408 科目，就不得因为信心不足而退回默认分类；默认分类只用于图片不可读、没有学习内容、跨科歧义或确实无法判断。',
    '2. aliases 只放与规范分类真正同义的名称，不要放上下位概念或无关标签。',
    '3. subject/knowledgePoint 是整张笔记用于归档的主分类。canvas 含多道题时选共同或最主要分类，并在 items 中逐项描述。',
    '4. single 通常是一道题或一个知识单元；除非图片明显包含多个独立题目，不要拆成多个 items。canvas 可以返回多个 items，但不要因此为每个 item 都生成卡片。',
    '5. questionType 概括题型（如极限计算、证明题、选择题、代码分析）；不是题目则为 null。wrongReason 必须根据备注和图片语义总结真实错因；无法判断则为 null，禁止编造。',
    '6. intent.isMistake 表示用户将它作为错题/易错内容记录；intent.isGood 表示题目具有典型方法、多解价值、迁移价值或用户明确标记为好题/经典；intent.shouldMemorize 表示需要背诵、熟记或主动回忆。三个标签可以并存，错题绝不排斥同时成为好题。不要因为它仅仅是一道普通题就设为 true。',
    '7. 只有整张或对应 item 存在明确错题意图或记忆意图时才生成 cards；普通参考笔记的 cards 必须为空。每份笔记最多生成 2 张，优先只生成 1 张最有价值、能主动回忆且答案明确的卡片；不要逐项铺量、不要同义重复、不要只抄标题。',
    '8. confidence 衡量主分类和语义判断的可靠程度；置信度只用于记录可靠性，不用于要求用户确认，也不能替代你的最佳分类判断。图片不清晰或跨多个不相关主题时应降低。',
    '9. 所有文字使用简洁中文。不要输出 Markdown，不要解释 JSON 之外的内容。',
    '必须严格使用以下 JSON 结构；没有错因时 wrongReason 为 null，没有分项或卡片时用空数组：',
    '{"subject":"科目","knowledgePoint":"规范知识点或null","questionType":"题型或null","aliases":{"subject":[],"knowledgePoint":[]},"title":"标题","summary":"摘要","tags":[],"wrongReason":null,"intent":{"isQuestion":true,"isMistake":false,"isGood":true,"shouldMemorize":false},"items":[{"title":"分项标题","knowledgePoint":"知识点或null","questionType":"题型或null","summary":"分项摘要","tags":[],"wrongReason":null,"intent":{"isQuestion":true,"isMistake":false,"isGood":true,"shouldMemorize":false}}],"cards":[{"front":"问题","back":"答案","kind":"memory或mistake","itemIndex":0}],"confidence":0.9,"reason":"判断依据"}',
    '输入上下文：',
    JSON.stringify(contextPayload),
  ].join('\n');
}

function normalizeIntent(value) {
  return {
    isQuestion: value?.isQuestion === true,
    isMistake: value?.isMistake === true,
    isGood: value?.isGood === true,
    shouldMemorize: value?.shouldMemorize === true,
  };
}

function normalizeItems(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((item) => ({
    title: cleanText(item.title, 120),
    knowledgePoint: cleanText(item.knowledgePoint, 60) || null,
    questionType: cleanText(item.questionType, 60) || null,
    summary: cleanText(item.summary, 1_000),
    tags: uniqueStrings(item.tags, 12, 40),
    wrongReason: cleanText(item.wrongReason, 500) || null,
    intent: normalizeIntent(item.intent),
  }));
}

function cardAllowed(card, overallIntent, items, hints, allTags) {
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

function normalizeCards(value, overallIntent, items, hints, tags) {
  if (!Array.isArray(value)) return [];
  const cards = [];
  const seenQuestions = new Set();
  for (let index = 0; index < value.length && cards.length < 2; index += 1) {
    const card = value[index];
    if (!card || typeof card !== 'object' || !cardAllowed(card, overallIntent, items, hints, tags)) continue;
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

function normalizeAnalysis(aiResult, provider, model, parsed, hints) {
  if (!aiResult || typeof aiResult !== 'object' || Array.isArray(aiResult)) {
    const error = new Error('AI note analyzer returned an invalid result');
    error.code = 'NOTE_AI_RESULT_INVALID';
    throw error;
  }
  const aliases = aiResult.aliases && typeof aiResult.aliases === 'object' ? aiResult.aliases : {};
  const aiIntent = normalizeIntent(aiResult.intent);
  const intent = {
    ...aiIntent,
    isMistake: aiIntent.isMistake || hints.isMistake,
    isGood: aiIntent.isGood || hints.isGood,
    shouldMemorize: aiIntent.shouldMemorize || hints.shouldMemorize,
  };
  const items = normalizeItems(aiResult.items);
  const questionType = cleanText(aiResult.questionType, 60) || null;
  const tags = uniqueStrings([
    ...(Array.isArray(aiResult.tags) ? aiResult.tags : []),
    ...(intent.isMistake ? ['错题'] : []),
    ...(intent.isGood || items.some((item) => item.intent.isGood) ? ['好题'] : []),
    ...(intent.shouldMemorize ? ['背诵'] : []),
    ...(questionType ? [`题型:${questionType}`] : []),
  ], 20, 40);
  const cards = normalizeCards(aiResult.cards, intent, items, hints, tags);
  const confidence = Number(aiResult.confidence);
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
    wrongReason: cleanText(aiResult.wrongReason, 500) || null,
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
    const parsed = parseRemark(typeof metadata.remark === 'string' ? metadata.remark : '');
    const hints = detectStrongIntentHints(metadata.remark, parsed);
    // Unknown legacy/user subjects remain in the persisted taxonomy, but they
    // are deliberately omitted from the AI prompt so the model cannot select
    // them as a new top-level classification.
    const taxonomy = compactTaxonomy(filterTaxonomyForAi(context.taxonomy), taxonomyMaxChars);
    const promptContext = makePromptContext(context, parsed, hints, taxonomy);
    const imageDataUrl = imagePathToDataUrl(context.imagePath);

    const result = await router.complete({
      task: 'note_enrichment',
      difficulty: metadata.kind === 'canvas' ? 'high' : 'medium',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildPrompt(promptContext) },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
      responseSchema: NOTE_ANALYSIS_SCHEMA,
      temperature: 0.1,
      maxTokens: metadata.kind === 'canvas' ? 4_000 : 2_400,
    });

    const analysis = normalizeAnalysis(result.json, result.provider, result.model, parsed, hints);
    const subjectDecision = resolveAiSubject(context.taxonomy, {
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
    return {
      ...analysis,
      subject: subjectDecision.subject,
      // Never attach an unknown model-proposed first-level name as an alias to
      // a valid 408 subject or to the fallback bucket.
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
  if (!defaultAnalyzer) defaultAnalyzer = createNoteAiAnalyzer();
  return defaultAnalyzer(context);
}
analyzeNote.analyzerVersion = ANALYZER_VERSION;

module.exports = {
  ANALYZER_VERSION,
  NOTE_ANALYSIS_SCHEMA,
  analyzeNote,
  compactTaxonomy,
  createNoteAiAnalyzer,
  detectStrongIntentHints,
  imagePathToDataUrl,
};
