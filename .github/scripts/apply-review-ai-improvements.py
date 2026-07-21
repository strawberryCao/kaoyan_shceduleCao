from pathlib import Path

ROOT = Path('outputs/kaoyan-schedule-app')


def load(relative):
    path = ROOT / relative
    return path, path.read_text(encoding='utf-8').replace('\r\n', '\n')


def save(path, text):
    path.write_text(text, encoding='utf-8', newline='\n')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


# Dedicated high-quality task for image-only notes.
path, text = load('scripts/ai-router.cjs')
text = replace_once(
    text,
    "  note_enrichment: Object.freeze({ difficulty: 'medium', capabilities: ['text', 'vision', 'json'] }),\n",
    "  note_enrichment: Object.freeze({ difficulty: 'medium', capabilities: ['text', 'vision', 'json'] }),\n  note_image_understanding: Object.freeze({ difficulty: 'high', capabilities: ['text', 'vision', 'json'] }),\n",
    'image-only task profile',
)
text = replace_once(
    text,
    "  weekly_review_pdf: Object.freeze([\n",
    "  note_image_understanding: Object.freeze([\n    Object.freeze({ id: 'reasoningMode', group: '图像理解', type: 'select', label: '推理强度', description: '无备注时优先使用更强视觉理解；复杂手写过程建议使用均衡或深度。', default: 'balanced', options: [\n      { value: 'fast', label: '快速' },\n      { value: 'balanced', label: '均衡（推荐）' },\n      { value: 'deep', label: '深度' },\n    ] }),\n    Object.freeze({ id: 'maxTokens', group: '图像理解', type: 'number', label: '最大完成 Token', description: '无备注时需要从图片独立理解题意、手写过程和错因。', default: 5200, min: 1800, max: 12000, step: 200, unit: 'tokens' }),\n  ]),\n  weekly_review_pdf: Object.freeze([\n",
    'image-only task parameters',
)
text = replace_once(
    text,
    "  widget_generation: Object.freeze({\n    label: '桌面组件生成',\n",
    "  note_image_understanding: Object.freeze({\n    label: '无备注图片理解',\n    description: '笔记没有备注时，使用独立的高质量视觉模型理解题目、手写过程和错因。',\n    active: true,\n    defaultTimeoutMs: 120_000,\n  }),\n  widget_generation: Object.freeze({\n    label: '桌面组件生成',\n",
    'image-only task definition',
)
save(path, text)

# Image-only routing and wrong-reason provenance.
path, text = load('scripts/note-ai-analyzer.cjs')
text = replace_once(text, "const ANALYZER_VERSION = 'note-ai-analyzer-v3';", "const ANALYZER_VERSION = 'note-ai-analyzer-v4';", 'analyzer version')
text = replace_once(
    text,
    "    'wrongReason',\n    'intent',\n",
    "    'wrongReason',\n    'wrongReasonSource',\n    'wrongReasonConfidence',\n    'intent',\n",
    'wrong reason required fields',
)
text = replace_once(
    text,
    "    wrongReason: { type: ['string', 'null'], maxLength: 500 },\n    intent: {\n",
    "    wrongReason: { type: ['string', 'null'], maxLength: 500 },\n    wrongReasonSource: { type: 'string', enum: ['explicit_remark', 'explicit_image', 'ai_inferred', 'none'] },\n    wrongReasonConfidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },\n    intent: {\n",
    'wrong reason schema',
)
text = replace_once(
    text,
    "    existingTaxonomy: taxonomy,\n  };\n}\n",
    "    existingLearning: {\n      noteType: cleanText(metadata.learning?.noteType, 40) || null,\n      organizationStatus: cleanText(metadata.learning?.organizationStatus, 40) || null,\n      wrongReason: cleanText(metadata.learning?.wrongReason, 500) || null,\n      wrongReasonSource: cleanText(metadata.learning?.wrongReasonSource, 40) || null,\n      userEditedFields: uniqueStrings(metadata.learning?.userEditedFields, 30, 60),\n    },\n    existingTaxonomy: taxonomy,\n  };\n}\n",
    'prompt existing learning state',
)
text = replace_once(
    text,
    "    '5. questionType 概括题型（如极限计算、证明题、选择题、代码分析）；不是题目则为 null。wrongReason 必须根据备注和图片语义总结真实错因；无法判断则为 null，禁止编造。',\n",
    "    '5. questionType 概括题型（如极限计算、证明题、选择题、代码分析）；不是题目则为 null。',\n    '5.0 错因按证据优先级处理：备注明确写出错因时只做忠实提取，wrongReasonSource=explicit_remark；图片中明确标注、划改或订正能直接证明错因时为 explicit_image；前两者都没有、但可从可见错误步骤与订正可靠推断时，才允许给出一句简短推断并标记 ai_inferred；证据不足必须返回 null/none，禁止猜测。',\n    '5.0.1 wrongReason 最多一句话，描述具体错误动作，不写完整解法、不教学、不扩展知识。wrongReasonConfidence 只表示错因判断可靠度。',\n",
    'wrong reason prompt rules',
)
old_example = "    '{\"subject\":\"科目\",\"knowledgePoint\":\"规范知识点或null\",\"questionType\":\"题型或null\",\"aliases\":{\"subject\":[],\"knowledgePoint\":[]},\"title\":\"标题\",\"summary\":\"摘要\",\"tags\":[],\"wrongReason\":null,\"intent\":{\"isQuestion\":true,\"isMistake\":false,\"isGood\":false,\"shouldMemorize\":false},\"items\":[{\"title\":\"分项标题\",\"knowledgePoint\":\"知识点或null\",\"questionType\":\"题型或null\",\"summary\":\"分项摘要\",\"tags\":[],\"wrongReason\":null,\"intent\":{\"isQuestion\":true,\"isMistake\":false,\"isGood\":false,\"shouldMemorize\":false}}],\"cards\":[{\"front\":\"问题\",\"back\":\"答案\",\"kind\":\"memory或mistake\",\"itemIndex\":0}],\"confidence\":0.9,\"reason\":\"判断依据\"}',\n"
new_example = "    '{\"subject\":\"科目\",\"knowledgePoint\":\"规范知识点或null\",\"questionType\":\"题型或null\",\"aliases\":{\"subject\":[],\"knowledgePoint\":[]},\"title\":\"标题\",\"summary\":\"摘要\",\"tags\":[],\"wrongReason\":null,\"wrongReasonSource\":\"none\",\"wrongReasonConfidence\":null,\"intent\":{\"isQuestion\":true,\"isMistake\":false,\"isGood\":false,\"shouldMemorize\":false},\"items\":[{\"title\":\"分项标题\",\"knowledgePoint\":\"知识点或null\",\"questionType\":\"题型或null\",\"summary\":\"分项摘要\",\"tags\":[],\"wrongReason\":null,\"intent\":{\"isQuestion\":true,\"isMistake\":false,\"isGood\":false,\"shouldMemorize\":false}}],\"cards\":[{\"front\":\"问题\",\"back\":\"答案\",\"kind\":\"memory或mistake\",\"itemIndex\":0}],\"confidence\":0.9,\"reason\":\"判断依据\"}',\n"
text = replace_once(text, old_example, new_example, 'wrong reason JSON example')
text = replace_once(
    text,
    "function normalizeAnalysis(aiResult, provider, model, parsed, hints, options = {}) {\n",
    "function normalizeAnalysis(aiResult, provider, model, parsed, hints, options = {}, promptContext = {}) {\n",
    'normalize signature',
)
text = replace_once(
    text,
    "  const cards = normalizeCards(aiResult.cards, intent, items, hints, tags, options);\n  const confidence = Number(aiResult.confidence);\n  return {\n",
    "  const cards = normalizeCards(aiResult.cards, intent, items, hints, tags, options);\n  const confidence = Number(aiResult.confidence);\n  const explicitRemarkReason = uniqueStrings(parsed?.wrongReasons, 1, 500)[0] || '';\n  const manualWrongReason = cleanText(promptContext?.existingLearning?.wrongReason, 500);\n  const manualFields = new Set(promptContext?.existingLearning?.userEditedFields || []);\n  const manualLocked = manualFields.has('wrongReason');\n  const aiWrongReason = cleanText(aiResult.wrongReason, 500);\n  const allowedWrongReasonSources = new Set(['explicit_remark', 'explicit_image', 'ai_inferred', 'none']);\n  const wrongReason = manualLocked ? manualWrongReason : explicitRemarkReason || aiWrongReason || null;\n  let wrongReasonSource = manualLocked\n    ? (manualWrongReason ? 'manual' : 'manual_deleted')\n    : explicitRemarkReason\n      ? 'explicit_remark'\n      : allowedWrongReasonSources.has(aiResult.wrongReasonSource)\n        ? aiResult.wrongReasonSource\n        : aiWrongReason ? 'ai_inferred' : 'none';\n  if (!wrongReason) wrongReasonSource = manualLocked ? 'manual_deleted' : 'none';\n  const rawWrongReasonConfidence = Number(aiResult.wrongReasonConfidence);\n  const wrongReasonConfidence = manualLocked\n    ? (manualWrongReason ? 1 : null)\n    : explicitRemarkReason\n      ? 1\n      : wrongReason && Number.isFinite(rawWrongReasonConfidence)\n        ? Math.min(1, Math.max(0, rawWrongReasonConfidence))\n        : wrongReason ? 0.55 : null;\n  return {\n",
    'normalize wrong reason provenance',
)
text = replace_once(
    text,
    "    wrongReason: cleanText(aiResult.wrongReason, 500) || null,\n    intent,\n",
    "    wrongReason,\n    wrongReasonSource,\n    wrongReasonConfidence,\n    intent,\n",
    'normalized wrong reason fields',
)
text = replace_once(
    text,
    "    const taskOptions = typeof router.getTaskOptions === 'function' ? router.getTaskOptions('note_enrichment') : {};\n    const metadata = context.metadata && typeof context.metadata === 'object' ? context.metadata : {};\n    const parsed = parseRemark(typeof metadata.remark === 'string' ? metadata.remark : '');\n    const hints = detectStrongIntentHints(metadata.remark, parsed);\n",
    "    const metadata = context.metadata && typeof context.metadata === 'object' ? context.metadata : {};\n    const remarkMissing = !cleanText(metadata.remark, 4_000);\n    const taskId = remarkMissing ? 'note_image_understanding' : 'note_enrichment';\n    const baseTaskOptions = typeof router.getTaskOptions === 'function' ? router.getTaskOptions('note_enrichment') : {};\n    const taskOptions = typeof router.getTaskOptions === 'function'\n      ? { ...baseTaskOptions, ...router.getTaskOptions(taskId) }\n      : baseTaskOptions;\n    const parsed = parseRemark(typeof metadata.remark === 'string' ? metadata.remark : '');\n    const baseHints = detectStrongIntentHints(metadata.remark, parsed);\n    const existingTags = Array.isArray(metadata.learning?.tags) ? metadata.learning.tags : [];\n    const hints = {\n      ...baseHints,\n      isMistake: baseHints.isMistake || metadata.learning?.noteType === 'mistake' || existingTags.includes('错题'),\n      shouldMemorize: baseHints.shouldMemorize || metadata.learning?.noteType === 'memory' || existingTags.includes('背诵'),\n    };\n",
    'image-only route setup',
)
text = replace_once(
    text,
    "      task: 'note_enrichment',\n      difficulty: metadata.kind === 'canvas' ? 'high' : 'medium',\n",
    "      task: taskId,\n      difficulty: remarkMissing || metadata.kind === 'canvas' ? 'high' : 'medium',\n",
    'image-only route request',
)
text = replace_once(
    text,
    "    const analysis = normalizeAnalysis(result.json, result.provider, result.model, parsed, hints, taskOptions);\n",
    "    const analysis = normalizeAnalysis(result.json, result.provider, result.model, parsed, hints, taskOptions, promptContext);\n",
    'normalize prompt context',
)
save(path, text)

# Non-blocking GitHub sync with visible phases.
path, text = load('scripts/review-github-sync.cjs')
text = replace_once(text, "  let running = null;\n", "  let running = null;\n  let activeAction = '';\n", 'sync active action')
text = replace_once(
    text,
    "    return { ...readJson(statusPath, {}), settings: taskSettings(configPath), running: Boolean(running) };\n",
    "    return { ...readJson(statusPath, {}), settings: taskSettings(configPath), running: Boolean(running), runningAction: activeAction || null };\n",
    'sync status action',
)
text = replace_once(
    text,
    "  async function push(scheduleKey = currentScheduleKey(taskSettings(configPath))) {\n    const settings = taskSettings(configPath);\n",
    "  async function push(scheduleKey = currentScheduleKey(taskSettings(configPath))) {\n    const settings = taskSettings(configPath);\n    updateStatus({ phase: 'preparing', progress: 8, message: '正在准备 GitHub 数据仓库…', lastError: null });\n",
    'push preparing',
)
text = replace_once(
    text,
    "    const aiConfig = providerPublicConfig(configPath, settings);\n    const notes = exportReviewData({ learningSnapshot: getLearningSnapshot(), repositoryRoot: workingRoot, settings, aiConfig });\n",
    "    updateStatus({ phase: 'exporting', progress: 38, message: '正在导出已确认的错题和背诵内容…' });\n    const aiConfig = providerPublicConfig(configPath, settings);\n    const notes = exportReviewData({ learningSnapshot: getLearningSnapshot(), repositoryRoot: workingRoot, settings, aiConfig });\n",
    'push exporting',
)
text = replace_once(
    text,
    "    runGit(['config', 'user.name', 'Kaoyan Review Sync'], { cwd: workingRoot });\n",
    "    updateStatus({ phase: 'committing', progress: 68, message: '正在提交本次综合数据…' });\n    runGit(['config', 'user.name', 'Kaoyan Review Sync'], { cwd: workingRoot });\n",
    'push committing',
)
text = replace_once(
    text,
    "    pushWithRemoteRefresh(workingRoot, settings.branch);\n    updateStatus({ lastPushAt: new Date().toISOString(), lastScheduleKey: scheduleKey, lastPushCount: notes.length, lastPushResult: 'pushed', lastError: null });\n",
    "    updateStatus({ phase: 'pushing', progress: 82, message: '正在推送 GitHub；远程更新时会自动同步后重试…' });\n    pushWithRemoteRefresh(workingRoot, settings.branch);\n    updateStatus({ phase: 'complete', progress: 100, message: `已同步 ${notes.length} 条内容，GitHub 正在生成 PDF。`, lastPushAt: new Date().toISOString(), lastScheduleKey: scheduleKey, lastPushCount: notes.length, lastPushResult: 'pushed', lastError: null });\n",
    'push final phase',
)
text = replace_once(
    text,
    "  async function pull() {\n    const settings = taskSettings(configPath);\n",
    "  async function pull() {\n    const settings = taskSettings(configPath);\n    updateStatus({ phase: 'checking_pdf', progress: 15, message: '正在检查远程 PDF 版本…', lastError: null });\n",
    'pull preparing',
)
text = replace_once(
    text,
    "    ensureDirectory(settings.outputDirectory);\n    let downloaded = 0;\n",
    "    ensureDirectory(settings.outputDirectory);\n    updateStatus({ phase: 'downloading_pdf', progress: 48, message: '正在校验并下载最新版 PDF…' });\n    let downloaded = 0;\n",
    'pull downloading',
)
text = replace_once(
    text,
    "    updateStatus({ lastPullAt: new Date().toISOString(), lastRemoteGeneratedAt: manifest.generatedAt || null, lastPullResult: downloaded ? 'downloaded' : 'unchanged', lastError: null });\n",
    "    updateStatus({ phase: 'complete', progress: 100, message: downloaded ? `已下载 ${downloaded} 份最新版 PDF。` : '本地 PDF 已是最新版。', lastPullAt: new Date().toISOString(), lastRemoteGeneratedAt: manifest.generatedAt || null, lastPullResult: downloaded ? 'downloaded' : 'unchanged', lastError: null });\n",
    'pull complete',
)
text = replace_once(
    text,
    "  function runExclusive(action) {\n    if (running) return running;\n    running = Promise.resolve().then(action).catch((error) => {\n      updateStatus({ lastError: error instanceof Error ? error.message : String(error), lastErrorAt: new Date().toISOString() });\n      throw error;\n    }).finally(() => { running = null; });\n    return running;\n  }\n",
    "  function runExclusive(actionName, action) {\n    if (running) return running;\n    activeAction = actionName;\n    running = Promise.resolve().then(action).catch((error) => {\n      updateStatus({ phase: 'failed', progress: 100, message: '任务失败，请查看错误信息。', lastError: error instanceof Error ? error.message : String(error), lastErrorAt: new Date().toISOString() });\n      throw error;\n    }).finally(() => { running = null; activeAction = ''; });\n    return running;\n  }\n\n  function startBackground(actionName, action) {\n    if (running) return { ok: true, accepted: false, running: true, action: activeAction || actionName };\n    void runExclusive(actionName, action).catch(() => undefined);\n    return { ok: true, accepted: true, running: true, action: actionName };\n  }\n",
    'background runner',
)
text = replace_once(text, "      runExclusive(runAutomaticCycle).catch((error) => console.warn('Review GitHub startup sync failed:', error.message));\n", "      runExclusive('automatic', runAutomaticCycle).catch((error) => console.warn('Review GitHub startup sync failed:', error.message));\n", 'automatic startup')
text = replace_once(text, "      runExclusive(runAutomaticCycle).catch((error) => console.warn('Review GitHub periodic sync failed:', error.message));\n", "      runExclusive('automatic', runAutomaticCycle).catch((error) => console.warn('Review GitHub periodic sync failed:', error.message));\n", 'automatic interval')
text = replace_once(
    text,
    "  return { status, push: () => runExclusive(push), pull: () => runExclusive(pull), start, stop };\n",
    "  return {\n    status,\n    push: () => runExclusive('push', push),\n    pull: () => runExclusive('pull', pull),\n    startPush: () => startBackground('push', push),\n    startPull: () => startBackground('pull', pull),\n    start,\n    stop,\n  };\n",
    'sync manager API',
)
save(path, text)

print('Applied AI routing and non-blocking review sync changes.')
