from pathlib import Path
import re

ROOT = Path('outputs/kaoyan-schedule-app')


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding='utf-8')


def write(relative: str, value: str) -> None:
    (ROOT / relative).write_text(value, encoding='utf-8')


def replace_once(source: str, before: str, after: str, label: str) -> str:
    count = source.count(before)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one anchor, found {count}')
    return source.replace(before, after, 1)


analysis = read('cloudflare/note-analysis-job.js')
analysis = replace_once(
    analysis,
    "preserveTitle: Array.isArray(latest.userEditedFields) && latest.userEditedFields.includes('title'),",
    "preserveTitle: true,",
    'preserve specialized naming title',
)
write('cloudflare/note-analysis-job.js', analysis)

learning = read('cloudflare/learning.js')
learning = replace_once(
    learning,
    "const tags = userFields.has('tags') ? uniqueStrings(note.tags) : uniqueStrings(input.tags);",
    "const tags = userFields.has('tags') ? uniqueStrings(note.tags) : uniqueStrings([...(Array.isArray(note.tags) ? note.tags : []), ...(Array.isArray(input.tags) ? input.tags : [])]);",
    'preserve source tags during AI enrichment',
)
write('cloudflare/learning.js', learning)

analyzer = read('scripts/note-ai-analyzer.cjs')
analyzer = replace_once(
    analyzer,
    "const { parseRemark } = require('./remark-parser.cjs');",
    "const { parseRemark } = require('./remark-parser.cjs');\nconst { NOTE_ANALYSIS_INSTRUCTIONS, NOTE_ANALYSIS_OUTPUT } = require('./agent-workflow-contracts.cjs');",
    'shared analysis contract import',
)
new_build_prompt = r'''function fillAnalysisTemplate(value, variables) {
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
    cardRule,
    contextPayload: JSON.stringify(contextPayload),
  };
  return [
    ...NOTE_ANALYSIS_INSTRUCTIONS.map((line) => fillAnalysisTemplate(line, variables)).filter(Boolean),
    fillAnalysisTemplate(NOTE_ANALYSIS_OUTPUT, variables),
  ].join('\n');
}'''
pattern = re.compile(r"function buildPrompt\(contextPayload, options = \{\}\) \{[\s\S]*?\n\}\n\nfunction normalizeIntent")
if len(pattern.findall(analyzer)) != 1:
    raise RuntimeError('shared buildPrompt boundary was not unique')
analyzer = pattern.sub(new_build_prompt + '\n\nfunction normalizeIntent', analyzer, count=1)
write('scripts/note-ai-analyzer.cjs', analyzer)

test_file = read('scripts/mobile-local-first-analysis.test.cjs')
test_file += r'''

test('local and cloud analysis render the same LAN-published prompt contract', () => {
  const analyzer = text('scripts/note-ai-analyzer.cjs');
  const contracts = text('scripts/agent-workflow-contracts.cjs');
  assert.match(analyzer, /NOTE_ANALYSIS_INSTRUCTIONS/);
  assert.match(analyzer, /NOTE_ANALYSIS_OUTPUT/);
  assert.match(analyzer, /fillAnalysisTemplate/);
  assert.match(contracts, /note-enrichment-v4/);
});

test('interrupted cloud AI processing jobs become recoverable after a bounded lease', () => {
  const jobs = text('cloudflare/background-jobs.js');
  assert.match(jobs, /PROCESSING_STALE_MS/);
  assert.match(jobs, /isStaleProcessing/);
  assert.match(jobs, /上次 AI 任务被中断/);
  assert.match(jobs, /job\.status === 'queued' \|\| isStaleProcessing/);
});

test('full enrichment preserves the naming-agent title and capture source tags', () => {
  const analysis = text('cloudflare/note-analysis-job.js');
  const learning = text('cloudflare/learning.js');
  assert.match(analysis, /preserveTitle: true/);
  assert.match(learning, /Array\.isArray\(note\.tags\)/);
  assert.match(learning, /Array\.isArray\(input\.tags\)/);
});
'''
write('scripts/mobile-local-first-analysis.test.cjs', test_file)

print('final local-first reliability and shared prompt contract applied')
