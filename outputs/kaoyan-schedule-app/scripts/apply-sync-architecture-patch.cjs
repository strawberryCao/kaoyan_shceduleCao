const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function write(relative, content) {
  fs.writeFileSync(path.join(root, relative), content, 'utf8');
  console.log(`patched ${relative}`);
}

function replaceOnce(content, search, replacement, label) {
  if (content.includes(replacement)) return content;
  const index = content.indexOf(search);
  if (index < 0) throw new Error(`Patch anchor not found: ${label}`);
  return content.slice(0, index) + replacement + content.slice(index + search.length);
}

function insertBefore(content, anchor, insertion, marker, label) {
  if (content.includes(marker)) return content;
  const index = content.indexOf(anchor);
  if (index < 0) throw new Error(`Patch anchor not found: ${label}`);
  return content.slice(0, index) + insertion + content.slice(index);
}

function patchNoteDrop() {
  let content = read('src/components/NoteDropApp.tsx');
  content = insertBefore(
    content,
    "import { fetchWithTimeout } from '../utils/localService';",
    "import { enqueueMultiQuestionJob, resumeMultiQuestionJobs } from '../utils/noteBackgroundJobs';\n",
    "../utils/noteBackgroundJobs",
    'NoteDrop background import',
  );
  content = replaceOnce(
    content,
    "type MobileStep = 'capture' | 'mode' | 'crop' | 'remark' | 'detecting' | 'batch' | 'batch-crop' | 'success';",
    "type MobileStep = 'capture' | 'mode' | 'crop' | 'multi-crop' | 'remark' | 'detecting' | 'batch' | 'batch-crop' | 'success';",
    'NoteDrop mobile step',
  );
  content = insertBefore(
    content,
    "  useEffect(() => {\n    if (!window.kaoyanDesktop?.isElectron) return;",
    "  useEffect(() => {\n    if (isMobileCapture) void resumeMultiQuestionJobs();\n  }, [isMobileCapture]);\n\n",
    'resumeMultiQuestionJobs();',
    'NoteDrop resume jobs',
  );
  content = insertBefore(
    content,
    "  const startMultiQuestion = async () => {",
    "  const confirmMultiPreCrop = async (crop: NormalizedCrop) => {\n    if (!sourceImage || saving) return;\n    try {\n      setSaving(true);\n      setDialogError('');\n      const src = await cropImageDataUrl(sourceImage.src, crop, 2200);\n      await enqueueMultiQuestionJob(src);\n      setSaved(true);\n      setStatus('已保存到后台队列，可以直接离开；系统会自动拆题、保存并命名');\n      setMobileStep('success');\n      setSourceImage(null);\n    } catch (error) {\n      setDialogError(error instanceof Error ? error.message : '后台任务创建失败，请重试。');\n    } finally {\n      setSaving(false);\n    }\n  };\n\n",
    'confirmMultiPreCrop',
    'NoteDrop multi pre-crop handler',
  );
  content = insertBefore(
    content,
    "    if (mobileStep === 'crop' && sourceImage) {",
    "    if (mobileStep === 'multi-crop' && sourceImage) {\n      return (\n        <ImageCropEditor\n          imageSrc={sourceImage.src}\n          title=\"预裁剪整页题目\"\n          confirmLabel={saving ? '正在加入后台…' : '后台识别并保存'}\n          onCancel={() => setMobileStep('mode')}\n          onConfirm={(crop) => void confirmMultiPreCrop(crop)}\n        />\n      );\n    }\n",
    "mobileStep === 'multi-crop'",
    'NoteDrop multi crop view',
  );
  content = replaceOnce(
    content,
    "<button className=\"ai\" type=\"button\" onClick={() => void startMultiQuestion()}>",
    "<button className=\"ai\" type=\"button\" onClick={() => setMobileStep('multi-crop')}>",
    'NoteDrop multi button',
  );
  content = replaceOnce(
    content,
    '<small>AI 识别多个题目并自动裁剪</small>',
    '<small>先预裁剪整页，再由 AI 后台拆题、保存和命名</small>',
    'NoteDrop multi copy',
  );
  write('src/components/NoteDropApp.tsx', content);
}

function patchAiRouter() {
  let content = read('scripts/ai-router.cjs');
  content = insertBefore(
    content,
    "  note_classification: Object.freeze({ difficulty: 'medium', capabilities: ['text', 'vision', 'json'] }),",
    "  question_splitting: Object.freeze({ difficulty: 'medium', capabilities: ['text', 'vision', 'json'] }),\n",
    'question_splitting: Object.freeze({ difficulty:',
    'AI profile',
  );

  const parameterAnchor = '  note_enrichment: Object.freeze([';
  const parameterBlock = "  question_splitting: Object.freeze([\n"
    + "    Object.freeze({ id: 'maxQuestions', group: '识别范围', type: 'number', label: '最多识别题目数', description: '一张整页图片最多拆分出的题目数量。', default: 24, min: 1, max: 24, step: 1, unit: '道' }),\n"
    + "    Object.freeze({ id: 'includeQuestionNumber', group: '题目完整性', type: 'boolean', label: '保留题号', description: '裁剪区域必须包含题号或题目标识。', default: true }),\n"
    + "    Object.freeze({ id: 'includeOptions', group: '题目完整性', type: 'boolean', label: '保留全部选项', description: '选择题必须包含完整选项。', default: true }),\n"
    + "    Object.freeze({ id: 'includeDiagram', group: '题目完整性', type: 'boolean', label: '保留公式与配图', description: '题目相关公式、表格和配图必须与题干一起裁剪。', default: true }),\n"
    + "    Object.freeze({ id: 'edgePaddingPercent', group: '裁剪质量', type: 'number', label: '边缘留白比例', description: '在 AI 边界外增加少量留白，避免切掉题号和公式。', default: 1.2, min: 0, max: 8, step: 0.2, unit: '%' }),\n"
    + "    Object.freeze({ id: 'minimumRegionPercent', group: '裁剪质量', type: 'number', label: '最小题目区域', description: '过滤过小的误识别区域。', default: 3.5, min: 1, max: 20, step: 0.5, unit: '%' }),\n"
    + "    Object.freeze({ id: 'maxTokens', group: '运行限制', type: 'number', label: '最大输出 Token', description: '用于支持返回多个题目边界的结构化结果。', default: 1600, min: 500, max: 4000, step: 100, unit: 'tokens' }),\n"
    + "  ]),\n";
  content = insertBefore(content, parameterAnchor, parameterBlock, "id: 'maxQuestions', group: '识别范围'", 'AI task parameters');

  const definitionAnchor = '  note_enrichment: Object.freeze({';
  const definitionBlock = "  question_splitting: Object.freeze({\n"
    + "    label: '多题识别与自动裁剪',\n"
    + "    description: '对预裁剪后的整页题目识别多个完整题目区域，并交给后台批量保存。',\n"
    + "    active: true,\n"
    + "    defaultTimeoutMs: 90_000,\n"
    + "  }),\n";
  content = insertBefore(content, definitionAnchor, definitionBlock, "label: '多题识别与自动裁剪'", 'AI task definition');
  write('scripts/ai-router.cjs', content);
}

function patchCloudDeleteUi() {
  let shell = read('src/components/WebAppShell.tsx');
  shell = replaceOnce(
    shell,
    "<div className={`${collapsed || active === 'notes' ? 'web-app-frame is-collapsed' : 'web-app-frame'}${active === 'notes' ? ' is-canvas-active' : ''}`}>",
    "<div className={`${IS_CLOUD_RUNTIME ? 'is-cloud-runtime ' : ''}${collapsed || active === 'notes' ? 'web-app-frame is-collapsed' : 'web-app-frame'}${active === 'notes' ? ' is-canvas-active' : ''}`}>",
    'cloud runtime shell class',
  );
  write('src/components/WebAppShell.tsx', shell);

  let css = read('src/learning-center.css');
  if (!css.includes('CLOUD_DELETE_DISABLED_UI')) {
    css += "\n/* CLOUD_DELETE_DISABLED_UI: permanent deletion exists only in the Windows local app. */\n"
      + ".is-cloud-runtime .lc-heading-actions > button.danger,\n"
      + ".is-cloud-runtime .lc-card-controls > button.danger { display: none !important; }\n";
  }
  write('src/learning-center.css', css);
}

patchNoteDrop();
patchAiRouter();
patchCloudDeleteUi();
