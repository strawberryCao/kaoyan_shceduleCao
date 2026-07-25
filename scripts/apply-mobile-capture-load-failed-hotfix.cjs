'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const appRoot = path.join(root, 'outputs', 'kaoyan-schedule-app');
const componentPath = path.join(appRoot, 'src', 'components', 'NoteDropApp.tsx');
const testPath = path.join(appRoot, 'scripts', 'note-capture-foreground.test.cjs');

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) {
    if (source.includes(after)) return source;
    throw new Error(`Missing hotfix anchor: ${label}`);
  }
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Ambiguous hotfix anchor: ${label}`);
  }
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

let source = fs.readFileSync(componentPath, 'utf8');

source = replaceOnce(
  source,
  "import { enqueueMultiQuestionJob, resumeMultiQuestionJobs } from '../utils/noteBackgroundJobs';",
  "import { resumeMultiQuestionJobs } from '../utils/noteBackgroundJobs';",
  'remove browser background enqueue import',
);

source = replaceOnce(
  source,
  "  const saveSingle = async () => {",
  `  const saveImageReliably = async (\n    payload: Parameters<typeof saveNoteImage>[0],\n    onRetry: (message: string) => void,\n  ) => {\n    try {\n      return await saveNoteImage(payload);\n    } catch (error) {\n      const message = error instanceof Error ? error.message : String(error);\n      const retryable = IS_CLOUD_RUNTIME\n        && /load failed|failed to fetch|network|暂未确认|请求超时/i.test(message);\n      if (!retryable) throw error;\n      onRetry('连接中断，正在自动确认保存结果…');\n      await new Promise((resolve) => window.setTimeout(resolve, 1200));\n      return saveNoteImage(payload);\n    }\n  };\n\n  const saveSingle = async () => {`,
  'insert idempotent foreground retry',
);

source = replaceOnce(
  source,
  `      const result = await saveNoteImage({\n        imageDataUrl: pendingImage.src,\n        kind: 'single',\n        noteUid: pendingImage.noteUid,\n        remark,\n      });`,
  `      const result = await saveImageReliably({\n        imageDataUrl: pendingImage.src,\n        kind: 'single',\n        noteUid: pendingImage.noteUid,\n        remark,\n      }, setStatus);`,
  'single capture reliable save',
);

source = replaceOnce(
  source,
  `  const confirmMultiPreCrop = async (crop: NormalizedCrop) => {\n    if (!sourceImage || saving) return;\n    try {\n      setSaving(true);\n      setDialogError('');\n      const src = await cropImageDataUrl(sourceImage.src, crop, 2200);\n      await enqueueMultiQuestionJob(src);\n      setSaved(true);\n      setStatus('已保存到后台队列，可以直接离开；系统会自动拆题、保存并命名');\n      setMobileStep('success');\n      setSourceImage(null);\n    } catch (error) {\n      setDialogError(error instanceof Error ? error.message : '后台任务创建失败，请重试。');\n    } finally {\n      setSaving(false);\n    }\n  };`,
  `  const confirmMultiPreCrop = async (crop: NormalizedCrop) => {\n    if (!sourceImage || saving) return;\n    try {\n      setSaving(true);\n      setSaved(false);\n      setDialogError('');\n      setMobileStep('detecting');\n      setBatchProgress('正在预裁剪整页…');\n      const src = await cropImageDataUrl(sourceImage.src, crop, 2200);\n      setSourceImage({ src, noteUid: sourceImage.noteUid });\n      setBatchProgress('AI 正在识别题目边界…');\n      const detection = await detectQuestionRegions(src);\n      setBatchProgress(\`已识别 \${detection.regions.length} 道题，正在裁剪…\`);\n      const images = await cropManyImages(src, detection.regions);\n      setBatchImages(images.map((imageSrc) => ({ imageSrc, src: imageSrc, noteUid: createNoteUid(), enabled: true })).map(({ imageSrc: _imageSrc, ...item }) => item));\n      setBatchProgress('');\n      setMobileStep('batch');\n    } catch (error) {\n      setDialogError(error instanceof Error ? error.message : 'AI 多题识别失败，请调整范围后重试。');\n      setBatchProgress('');\n      setMobileStep('mode');\n    } finally {\n      setSaving(false);\n    }\n  };`,
  'move multi-question detection to foreground',
);

source = replaceOnce(
  source,
  `        const result = await saveNoteImage({\n          imageDataUrl: item.src,\n          kind: 'single',\n          noteUid: item.noteUid,\n          subject: '普通笔记',\n          remark: '',\n        });`,
  `        const result = await saveImageReliably({\n          imageDataUrl: item.src,\n          kind: 'single',\n          noteUid: item.noteUid,\n          subject: '普通笔记',\n          remark: '',\n        }, setBatchProgress);`,
  'batch reliable save',
);

fs.writeFileSync(componentPath, source, 'utf8');

const testSource = `'use strict';\n\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst path = require('node:path');\n\nconst source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'NoteDropApp.tsx'), 'utf8');\n\ntest('mobile multi-question capture stays in the foreground', () => {\n  const start = source.indexOf('const confirmMultiPreCrop');\n  const end = source.indexOf('const startMultiQuestion', start);\n  assert.ok(start >= 0 && end > start);\n  const block = source.slice(start, end);\n  assert.match(block, /detectQuestionRegions\\(src\\)/);\n  assert.match(block, /cropManyImages\\(src, detection\\.regions\\)/);\n  assert.doesNotMatch(block, /enqueueMultiQuestionJob/);\n  assert.match(block, /setMobileStep\\('batch'\\)/);\n});\n\ntest('single and batch image saves retry idempotently after mobile network loss', () => {\n  assert.match(source, /const saveImageReliably/);\n  assert.match(source, /load failed\\|failed to fetch\\|network/);\n  assert.equal((source.match(/await saveImageReliably\\(/g) || []).length, 2);\n  assert.match(source, /连接中断，正在自动确认保存结果/);\n});\n`;
fs.writeFileSync(testPath, testSource, 'utf8');

console.log('Applied mobile capture Load failed hotfix.');
