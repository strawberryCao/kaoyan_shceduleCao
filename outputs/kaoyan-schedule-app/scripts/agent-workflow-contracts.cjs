'use strict';

const NOTE_ANALYSIS_INSTRUCTIONS = Object.freeze([
  '你是考研笔记的语义整理器。请同时阅读图片与备注，输出严格 JSON。',
  '目标不是机械匹配关键词，而是判断图片实际知识内容、题目类型、用户为何记录它，以及它是否值得记忆或重做。',
  '“记”“记住”“背”“要背”等是很强的记忆意图提示，但没有这些词时，也要依据定义、公式、结论、易混点和用户语义判断。',
  '分类规则：',
  '1. subject 只能从 existingTaxonomy 中已有的标准考研一级科目选择：{supportedSubjects}。禁止创建、提议或输出其他一级科目。',
  '1.1 新领域或更细主题只能写入 knowledgePoint、tags 或 items；无法可靠归类时 subject 必须为“{fallbackSubject}”。',
  '1.2 只要图片或备注能可靠识别为某一标准科目，就不得因为信心不足退回默认分类。',
  '2. subject 与 knowledgePoint 是整张笔记的主分类；多题拆分后的图片通常只含一道题或一个知识单元。',
  '2.1 knowledgePoint 必须是可长期复用的简短分类标签，优先复用 existingTaxonomy 中已有名称或别名；禁止把本题的完整描述、解题结论或一句长话当作新知识点。',
  '2.2 只有现有分类确实无法容纳且新主题会被多条资料复用时才创建知识点；单题细节写入 title、summary、tags 或 items。',
  '3. questionType 概括题型；不是题目则为 null。',
  '4. 错因按证据优先级处理：备注明确写出时标记 explicit_remark；图片划改或订正能直接证明时标记 explicit_image；只有可见步骤足以支持时才允许 ai_inferred；证据不足必须为 null/none。',
  '4.1 wrongReason 最多一句话，只描述具体错误动作，不写完整解法。',
  '5. {summaryRule}',
  '6. {mistakeRule}',
  '6.1 {goodRule}',
  '6.2 {memorizeRule} 错题和好题可以并存。',
  '7. {cardRule}',
  '8. single 通常不要拆成多个 items；只有图片明显包含多个独立知识单元时才拆分，最多 {maxItems} 项。',
  '9. confidence 衡量主分类和语义判断可靠度；低置信度不能代替最佳分类判断。',
  '10. 所有文字使用简洁中文，不要输出 Markdown，不要解释 JSON 之外的内容。',
  '输入上下文：{contextPayload}',
]);

const NOTE_ANALYSIS_OUTPUT = '只输出 JSON：{"subject":"科目","knowledgePoint":"规范知识点或null","questionType":"题型或null","aliases":{"subject":[],"knowledgePoint":[]},"title":"标题","summary":"摘要","tags":[],"wrongReason":null,"wrongReasonSource":"none","wrongReasonConfidence":null,"intent":{"isQuestion":true,"isMistake":false,"isGood":false,"shouldMemorize":false},"items":[{"title":"分项标题","knowledgePoint":"知识点或null","questionType":"题型或null","summary":"分项摘要","tags":[],"wrongReason":null,"intent":{"isQuestion":true,"isMistake":false,"isGood":false,"shouldMemorize":false}}],"cards":[{"front":"问题","back":"答案","kind":"memory或mistake","itemIndex":0}],"confidence":0.9,"reason":"判断依据"}；没有错因时 wrongReason 为 null，没有分项或卡片时使用空数组。';

const DEFAULT_WORKFLOWS = Object.freeze({
  note_enrichment: Object.freeze({
    version: 'note-enrichment-v4',
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
    version: 'note-image-understanding-v4',
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
