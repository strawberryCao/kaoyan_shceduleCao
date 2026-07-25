'use strict';

const DEFAULT_WORKFLOWS = Object.freeze({
  note_naming: Object.freeze({
    version: 'note-naming-v3',
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
  question_splitting: Object.freeze({
    version: 'question-splitting-v3',
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
        '{questionNumberRule}',
        '{optionsRule}',
        '{diagramRule}',
        '原图尺寸：{width}×{height}。',
        'x、y、width、height 使用 0 到 1 的归一化坐标；x、y 是左上角。按从上到下、同一行从左到右排序。',
        '最多返回 {maxQuestions} 个区域。没有可靠区域时返回空 regions。',
      ]),
      outputFormat: '只返回 JSON 对象：{"regions":[{"x":0.0,"y":0.0,"width":0.5,"height":0.3}]}',
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
      outputFormat: cleanText(prompt.outputFormat, 4000) || fallback.prompt.outputFormat,
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
  buildPublicWorkflowContracts,
};
