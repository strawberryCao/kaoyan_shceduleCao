'use strict';

const { mathOneQuestionTypePrompt } = require('./math-one-question-types.cjs');

const NOTE_ANALYSIS_INSTRUCTIONS = Object.freeze([
  '你是考研笔记的语义整理器。请同时阅读图片与备注，输出严格 JSON。',
  '目标不是机械匹配关键词，而是判断图片实际知识内容、题目类型、用户为何记录它，以及它是否值得记忆或重做。',
  '“记”“记住”“背”“要背”等是很强的记忆意图提示，但没有这些词时，也要依据定义、公式、结论、易混点和用户语义判断。',
  '分类规则：',
  '1. subject 只能从 existingTaxonomy 中已有的标准考研一级科目选择：{supportedSubjects}。禁止创建、提议或输出其他一级科目。',
  '1.1 新领域或更细主题只能写入 knowledgePoint、tags 或 items；无法可靠归类时 subject 必须为“{fallbackSubject}”。',
  '1.2 只要图片或备注能可靠识别为某一标准科目，就不得因为信心不足退回默认分类。',
  '1.3 已位于标准科目目录或 namingEvidence 已给出标准科目时，将其视为独立识图结果形成的稳定锚点；另一模型若给出不同科目，不得自动跨科移动，除非用户明确修改。数学积分中仅出现指数函数、积分或归一化形式，不足以改判为概率论；必须直接出现随机变量、概率、分布、密度、期望、方差等语义证据。',
  '2. subject 与 knowledgePoint 是整张笔记的主分类；多题拆分后的图片通常只含一道题或一个知识单元。',
  '2.1 knowledgePoint 必须是可长期复用的简短分类标签，优先复用 existingTaxonomy 中已有名称或别名；禁止把本题的完整描述、解题结论或一句长话当作新知识点。',
  '2.2 只有现有分类确实无法容纳且新主题会被多条资料复用时才创建知识点；单题细节写入 title、summary、tags 或 items。',
  '3. questionType 概括题型；不是题目则为 null。',
  `3.1 对高等数学、线性代数、概率论，questionType 必须优先从下面的数学一标准叶子题型中选择，不能只写“选择题、填空题、计算题、证明题、综合题”等试卷形式；证据不足时返回 null，不要编造。\n${mathOneQuestionTypePrompt()}`,
  '3.2 questionTypePath 是不含一级科目的 1 到 3 级题型路径，questionType 必须等于最后一级。数学优先写为“章节模块 > 标准叶子题型”；408 等科目写为“知识模块 > 方法族 > 具体题型”，不得把单道题完整描述当分类。不是题目时使用空数组。',
  '4. 错因按证据优先级处理：备注明确写出时标记 explicit_remark；图片划改或订正能直接证明时标记 explicit_image；只有可见步骤足以支持时才允许 ai_inferred；证据不足必须为 null/none。',
  '4.0 必须主动检查图片中题目正文以外的内容：手写批注、圈画、划改、订正文字、老师评语、边栏笔记和箭头关系。若其中直接写明“错在、漏看、算错、不会、没想到、符号错”等，优先作为错因证据，不得忽略。',
  '4.1 wrongReason 最多一句话，只描述具体错误动作，不写完整解法。',
  '4.2 wrongReasonPath 必须是最多三级的稳定错因路径，一级只选：粗心大意、知识与记忆、思路与方法、推理与计算、时间与策略、其他。“粗心大意”下再按审题疏漏、计算疏漏、注意力、作答习惯细分，例如看漏条件、误读条件、算术错误、正负号错误、走神分心、漏项漏写。只有证据充分时才新增稳定叶子，禁止一次生成大量近义类别；没有可靠错因时使用空数组。',
  '5. learningTypePath 描述内容用途，最多三级。一级只能选：基础知识、题型方法、结论规律、易错警示、英语积累、政治材料。二级优先选：定义概念、原理机制、公式定理、性质条件、术语辨析；题型识别、标准步骤、方法选择、构造技巧、答题模板；常用结论、等价关系、适用条件、边界反例、推论拓展；易混概念、条件遗漏、符号范围、特殊情形、检查清单；单词短语、长难句、翻译表达、写作模板、语法规则；核心概念、原理表述、时政材料、分析模板、关键词句。第三级仅在确有稳定细分时填写。',
  '5.1 intent.isGood 为 true 时，goodQuestionType 只能选：经典母题、方法好题、易错辨析、综合提升、新颖拓展；不是好题时为 null。分类宁可少而稳定，不得为单题新造类别。',
  '6. {summaryRule}',
  '7. {mistakeRule}',
  '7.1 {goodRule}',
  '7.2 {memorizeRule} 错题和好题可以并存。',
  '8. {cardRule}',
  '9. single 通常不要拆成多个 items；只有图片明显包含多个独立知识单元时才拆分，最多 {maxItems} 项。',
  '10. confidence 衡量主分类和语义判断可靠度；低置信度不能代替最佳分类判断。',
  '11. 所有文字使用简洁中文，不要输出 Markdown，不要解释 JSON 之外的内容。',
  '输入上下文：{contextPayload}',
]);

const NOTE_ANALYSIS_OUTPUT = '只输出 JSON：{"subject":"科目","knowledgePoint":"规范知识点或null","questionType":"题型叶子或null","questionTypePath":["一级题型","二级题型","三级题型"],"learningTypePath":["学习用途一级","二级","三级"],"goodQuestionType":null,"aliases":{"subject":[],"knowledgePoint":[]},"title":"标题","summary":"摘要","tags":[],"wrongReason":null,"wrongReasonPath":["错因一级","错因二级","错因三级"],"wrongReasonSource":"none","wrongReasonConfidence":null,"intent":{"isQuestion":true,"isMistake":false,"isGood":false,"shouldMemorize":false},"items":[{"title":"分项标题","knowledgePoint":"知识点或null","questionType":"题型或null","questionTypePath":[],"learningTypePath":[],"summary":"分项摘要","tags":[],"wrongReason":null,"wrongReasonPath":[],"intent":{"isQuestion":true,"isMistake":false,"isGood":false,"shouldMemorize":false}}],"cards":[{"front":"问题","back":"答案","kind":"memory或mistake","itemIndex":0}],"confidence":0.9,"reason":"判断依据"}；没有题型或错因时对应路径使用空数组，没有分项或卡片时使用空数组。';

const DEFAULT_WORKFLOWS = Object.freeze({
  note_enrichment: Object.freeze({
    version: 'note-enrichment-v6',
    steps: Object.freeze([
      '读取局域网 note_enrichment 任务设置与现有分类目录',
      '合并图片、备注、标签与强意图提示',
      '按局域网 Provider/模型/回退约束路由',
      '生成科目、知识点、题型、错因、意图、分项和卡片',
      '应用局域网分类政策并保护用户手动修改字段',
      '更新学习记录、卡片与 source-notes 镜像',
    ]),
    prompt: Object.freeze({
      instructions: NOTE_ANALYSIS_INSTRUCTIONS,
      outputFormat: NOTE_ANALYSIS_OUTPUT,
    }),
  }),
  note_image_understanding: Object.freeze({
    version: 'note-image-understanding-v6',
    steps: Object.freeze([
      '读取局域网 note_image_understanding 与 note_enrichment 任务设置',
      '在没有备注时独立理解题目、公式、手写过程和订正痕迹',
      '按局域网 Provider/模型/推理强度与回退约束路由',
      '生成与 note_enrichment 相同的完整结构化结果',
      '应用局域网分类政策并保护用户手动修改字段',
      '更新学习记录、卡片与 source-notes 镜像',
    ]),
    prompt: Object.freeze({
      instructions: NOTE_ANALYSIS_INSTRUCTIONS,
      outputFormat: NOTE_ANALYSIS_OUTPUT,
    }),
  }),
  note_naming: Object.freeze({
    version: 'note-naming-v4',
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
        '标题必须以简洁中文为主；禁止输出英文解释、模型拒答、无法识别说明或整句英文。',
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
  canvas_note_understanding: Object.freeze({
    version: 'canvas-note-understanding-v1',
    steps: Object.freeze([
      '使用独立高级长上下文视觉模型读取整张画布预览',
      '同时识别题目、手写过程、批注、错因和节点之间的空间关系',
      '生成标题、科目、知识点、题型、错因与学习用途',
      '保护用户手动修改字段并将低置信度结果送入待确认',
    ]),
    prompt: Object.freeze({
      instructions: Object.freeze([
        ...NOTE_ANALYSIS_INSTRUCTIONS,
        '这是由画布发布的整页学习笔记。必须把空间上相邻、由箭头/连线关联、或同一题号下的题目、草稿、订正与批注作为同一上下文理解。',
        '标题应概括画布的核心学习主题；如果画布包含多个并列主题，选择主要主题并在 items 中拆分。',
      ]),
      outputFormat: NOTE_ANALYSIS_OUTPUT,
    }),
  }),
  material_naming: Object.freeze({
    version: 'material-naming-v2',
    steps: Object.freeze([
      '读取局域网 material_naming 任务设置',
      '一次性读取速记正文以及全部附件的原名、可提取文本与图片',
      '按局域网 Provider/模型/回退约束路由',
      '先判断整组资料的共同主题和资料之间的关系',
      '再按每份资料在本条速记中的作用生成名称',
      '保留文件后缀并过滤 Windows 非法字符',
      '异步更新学习记录，不阻塞原文件保存',
    ]),
    prompt: Object.freeze({
      instructions: Object.freeze([
        '你是考研速记资料命名器，只负责命名，不回答问题，不总结资料。',
        '必须先完整理解速记正文和整组附件的共同主题、先后关系与互补关系，再开始命名；禁止把附件拆开后孤立判断。',
        'noteTitle 表达整组资料共同主题，必须简短，不得把每个附件标题机械拼接到一起。',
        '每个附件名称既要表达内容，也要体现它在本条速记中的作用，例如“概念原文、例题解析、我的批注、动态演示、总结图、补充证明”。',
        '同组附件名称应能彼此区分并保持统一主题，不能只换“资料一、资料二”。',
        'files 中 index 必须与输入一致，不能遗漏、合并或新增资料。',
        '名称不得包含文件后缀、日期、随机数、路径或 Windows 非法字符。',
        '不要使用“资料、文档、图片、截图、未命名”等无信息量名称。',
      ]),
      outputFormat: '只输出 JSON：{"noteTitle":"整条速记标题","files":[{"index":0,"name":"附件内容名称"}]}',
    }),
  }),
  taxonomy: Object.freeze({
    version: 'taxonomy-consolidation-v1',
    steps: Object.freeze([
      '读取全部科目下现有知识点、出现次数和详细错因',
      '严格保持一级科目边界与用户手动分类',
      '合并同义、近义和过度具体的单题描述',
      '保留教材级上下位区别并维持适中的分类数量',
      '把每个输入名称恰好映射到一个规范分类',
      '覆盖率、科目边界和分类数量校验通过后原子写入',
    ]),
    prompt: Object.freeze({
      instructions: Object.freeze([
        '你负责整理整个考研资料库的分类体系，不回答题目，也不总结笔记。',
        '必须在同一科目内全局比较全部名称后再归并，严禁跨一级科目合并。',
        '规范知识点应是简短、可长期复用、接近教材目录粒度的名词短语；不能是一道题的完整描述或一句结论。',
        '不要把不同的上下位概念过度合并，也不要为每道题保留一个独立分类。',
        '每个输入 knowledgePoint 必须且只能原样出现在一个 aliases 数组中。',
        '错因类别用于筛选，应稳定且简短；具体错误句子必须保留为 alias，不能改写或丢弃。',
        '用户手动分类只作为固定边界，不允许覆盖。',
      ]),
      outputFormat: '只输出 JSON：{"knowledgeGroups":[{"subject":"一级科目","canonical":"规范知识点","aliases":["原始知识点"]}],"wrongReasonGroups":[{"category":"稳定错因类别","aliases":["原始错因句子"]}]}',
    }),
  }),
  semantic_search: Object.freeze({
    version: 'semantic-search-v1',
    steps: Object.freeze([
      '读取局域网 semantic_search 任务设置',
      '理解用户自然语言查询意图',
      '扩展可能出现在考研资料中的同义词、公式名和相关概念',
      '交给本地索引完成匹配与排序',
      '返回原始资料命中，不生成答案或总结',
    ]),
    prompt: Object.freeze({
      instructions: Object.freeze([
        '你只负责扩展考研学习资料搜索词，不回答问题，不总结资料。',
        '根据用户表达的含义，给出可能出现在笔记中的同义词、相关概念、公式名称和常见中文说法。',
        '词语应短、具体、适合检索，不得编造结论。',
      ]),
      outputFormat: '只输出 JSON：{"terms":["检索词"]}',
    }),
  }),
  question_splitting: Object.freeze({
    version: 'question-splitting-v5',
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
        '同一题号或例号的题干、分析、解答、答案和续接公式属于一个题目单元；必须从题号开始框到下一题号开始之前。',
        '禁止把“分析”“解”“答案”或同一例题的下半部分单独输出成另一道题。',
        '{questionNumberRule}',
        '{optionsRule}',
        '{diagramRule}',
        '原图尺寸：{width}×{height}。',
        'x、y、width、height 使用 0 到 1 的归一化坐标；x、y 是左上角。按从上到下、同一行从左到右排序。',
        '最多返回 {maxQuestions} 个区域。没有可靠区域时返回空 regions。',
        '每个区域必须同时判断是否为完整独立题目、是否含完整题干，并给出 0 到 1 的 confidence。不要把页眉、页脚、页码、孤立公式或残缺选项当作题目。',
      ]),
      outputFormat: '只返回 JSON 对象：{"regions":[{"x":0.0,"y":0.0,"width":0.5,"height":0.3,"confidence":0.95,"questionKey":"例4.9","completeQuestion":true,"containsStem":true,"containsOptions":true,"containsRequiredDiagram":true,"containsSolution":true,"continuationOfPrevious":false}]}',
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
      outputFormat: cleanText(prompt.outputFormat, 12000) || fallback.prompt.outputFormat,
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
  NOTE_ANALYSIS_INSTRUCTIONS,
  NOTE_ANALYSIS_OUTPUT,
  buildPublicWorkflowContracts,
};
