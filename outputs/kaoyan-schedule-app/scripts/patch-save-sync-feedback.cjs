const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function file(relative) {
  return path.join(root, relative);
}

function replaceOnce(relative, before, after) {
  const target = file(relative);
  const source = fs.readFileSync(target, 'utf8');
  if (!source.includes(before)) {
    throw new Error(`Patch target was not found in ${relative}: ${before.slice(0, 120)}`);
  }
  const next = source.replace(before, after);
  fs.writeFileSync(target, next, 'utf8');
}

// Cloud asset URLs must never create an "assets" top-level subject.
replaceOnce(
  'src/utils/learningData.ts',
  `  const confidence = Number(value.confidence);\n  const filePath = typeof value.filePath === 'string' ? value.filePath : '';\n  const rawSubject = typeof value.subject === 'string' ? value.subject : '默认文件夹';\n  const pathParts = filePath.split(/[\\\\/]/).filter(Boolean);\n  const fileSubject = pathParts.length > 1 ? pathParts[pathParts.length - 2].trim() : '';\n  const inferredFromFile = value.classificationSource !== 'manual'\n    && DEFAULT_SUBJECT_NAMES.has(rawSubject)\n    && fileSubject\n    && !DEFAULT_SUBJECT_NAMES.has(fileSubject)\n    && fileSubject !== '.metadata'\n    && fileSubject !== '笔记';\n  const subject = inferredFromFile ? fileSubject : rawSubject;\n  const rawKnowledgePath = strings(value.knowledgePath);`,
  `  const confidence = Number(value.confidence);\n  const filePath = typeof value.filePath === 'string' ? value.filePath : '';\n  const normalizedFilePath = filePath.replaceAll('\\\\', '/');\n  const isCloudAssetPath = /^(?:github:\\/\\/)?data\\/assets\\//i.test(normalizedFilePath)\n    || /^r2:\\/\\/note-assets\\//i.test(normalizedFilePath);\n  const storedSubject = typeof value.subject === 'string' ? value.subject : '默认文件夹';\n  const rawSubject = isCloudAssetPath && storedSubject.trim().toLowerCase() === 'assets'\n    ? '默认文件夹'\n    : storedSubject;\n  const pathParts = normalizedFilePath.split('/').filter(Boolean);\n  const fileSubject = !isCloudAssetPath && pathParts.length > 1 ? pathParts[pathParts.length - 2].trim() : '';\n  const inferredFromFile = value.classificationSource !== 'manual'\n    && DEFAULT_SUBJECT_NAMES.has(rawSubject)\n    && fileSubject\n    && !DEFAULT_SUBJECT_NAMES.has(fileSubject)\n    && fileSubject !== '.metadata'\n    && fileSubject !== '笔记'\n    && fileSubject.toLowerCase() !== 'assets';\n  const subject = inferredFromFile ? fileSubject : rawSubject;\n  const rawKnowledgePath = strings(value.knowledgePath)\n    .filter((item) => !(isCloudAssetPath && item.trim().toLowerCase() === 'assets'));`,
);

replaceOnce(
  'scripts/learning-data-store.cjs',
  `  const confidence = Number(value.confidence);\n  const filePath = asString(value.filePath);\n  const rawSubject = asString(value.subject, '默认文件夹');\n  const fileSubject = filePath ? path.basename(path.dirname(filePath)).trim() : '';\n  const inferredFromFile = value.classificationSource !== 'manual'\n    && DEFAULT_SUBJECT_NAMES.has(rawSubject)\n    && fileSubject\n    && !DEFAULT_SUBJECT_NAMES.has(fileSubject)\n    && !['.metadata', '笔记'].includes(fileSubject);\n  const subject = inferredFromFile ? fileSubject : rawSubject;\n  const rawKnowledgePath = uniqueStrings(value.knowledgePath);`,
  `  const confidence = Number(value.confidence);\n  const filePath = asString(value.filePath);\n  const normalizedFilePath = filePath.replaceAll('\\\\', '/');\n  const isCloudAssetPath = /^(?:github:\\/\\/)?data\\/assets\\//i.test(normalizedFilePath)\n    || /^r2:\\/\\/note-assets\\//i.test(normalizedFilePath);\n  const storedSubject = asString(value.subject, '默认文件夹');\n  const rawSubject = isCloudAssetPath && storedSubject.trim().toLowerCase() === 'assets'\n    ? '默认文件夹'\n    : storedSubject;\n  const fileSubject = !isCloudAssetPath && filePath ? path.basename(path.dirname(filePath)).trim() : '';\n  const inferredFromFile = value.classificationSource !== 'manual'\n    && DEFAULT_SUBJECT_NAMES.has(rawSubject)\n    && fileSubject\n    && !DEFAULT_SUBJECT_NAMES.has(fileSubject)\n    && !['.metadata', '笔记'].includes(fileSubject)\n    && fileSubject.toLowerCase() !== 'assets';\n  const subject = inferredFromFile ? fileSubject : rawSubject;\n  const rawKnowledgePath = uniqueStrings(value.knowledgePath)\n    .filter((item) => !(isCloudAssetPath && item.trim().toLowerCase() === 'assets'));`,
);

// Rebuilds and note-folder synchronization must preserve per-question thoughts.
replaceOnce(
  'scripts/learning-data-store.cjs',
  `      items: enrichment.items ?? existingNote?.items,\n      confidence: Number.isFinite(confidence) ? confidence : existingNote?.confidence,`,
  `      items: enrichment.items ?? existingNote?.items,\n      studyNotes: enrichment.studyNotes ?? metadata.learning?.studyNotes ?? existingNote?.studyNotes,\n      confidence: Number.isFinite(confidence) ? confidence : existingNote?.confidence,`,
);

// Canonical cloud snapshots also repair already-persisted assets subjects.
replaceOnce(
  'cloudflare/storage.js',
  `function normalizeSnapshot(value, revisionOverride) {\n  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};\n  return {\n    ...source,\n    version: Number.isFinite(Number(source.version)) ? Number(source.version) : 1,\n    revision: Number.isInteger(Number(revisionOverride ?? source.revision))\n      ? Math.max(0, Number(revisionOverride ?? source.revision))\n      : 0,\n    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,\n    days: source.days && typeof source.days === 'object' && !Array.isArray(source.days) ? source.days : {},\n    cards: Array.isArray(source.cards) ? source.cards : [],\n    deletedNotes: source.deletedNotes && typeof source.deletedNotes === 'object' && !Array.isArray(source.deletedNotes)\n      ? source.deletedNotes\n      : {},\n  };\n}`,
  `function isCloudAssetPath(value) {\n  const normalized = typeof value === 'string' ? value.replaceAll('\\\\', '/') : '';\n  return /^(?:github:\\/\\/)?data\\/assets\\//i.test(normalized) || /^r2:\\/\\/note-assets\\//i.test(normalized);\n}\n\nfunction normalizeCloudAssetNote(value) {\n  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;\n  if (!isCloudAssetPath(value.filePath) || value.classificationSource === 'manual') return value;\n  const storedSubject = typeof value.subject === 'string' ? value.subject : '';\n  const fixesAssets = storedSubject.trim().toLowerCase() === 'assets';\n  const knowledgePath = Array.isArray(value.knowledgePath)\n    ? value.knowledgePath.filter((item) => !(typeof item === 'string' && item.trim().toLowerCase() === 'assets'))\n    : value.knowledgePath;\n  return fixesAssets || knowledgePath !== value.knowledgePath\n    ? { ...value, ...(fixesAssets ? { subject: '默认文件夹' } : {}), knowledgePath }\n    : value;\n}\n\nfunction normalizeSnapshot(value, revisionOverride) {\n  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};\n  const rawDays = source.days && typeof source.days === 'object' && !Array.isArray(source.days) ? source.days : {};\n  const days = Object.fromEntries(Object.entries(rawDays).map(([date, day]) => {\n    if (!day || typeof day !== 'object' || Array.isArray(day)) return [date, day];\n    const autoNotes = Array.isArray(day.autoNotes) ? day.autoNotes.map(normalizeCloudAssetNote) : [];\n    return [date, { ...day, autoNotes }];\n  }));\n  return {\n    ...source,\n    version: Number.isFinite(Number(source.version)) ? Number(source.version) : 1,\n    revision: Number.isInteger(Number(revisionOverride ?? source.revision))\n      ? Math.max(0, Number(revisionOverride ?? source.revision))\n      : 0,\n    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,\n    days,\n    cards: Array.isArray(source.cards) ? source.cards : [],\n    deletedNotes: source.deletedNotes && typeof source.deletedNotes === 'object' && !Array.isArray(source.deletedNotes)\n      ? source.deletedNotes\n      : {},\n  };\n}`,
);

// Persist thoughts in cloud source metadata so Windows materialization can carry them.
replaceOnce(
  'cloudflare/source-mirror.js',
  `function sourceType(note, payload = {}) {\n  if (payload.sourceType) return String(payload.sourceType).slice(0, 80);\n  if (note.sourceType) return String(note.sourceType).slice(0, 80);\n  return 'single-capture';\n}`,
  `function sourceType(note, payload = {}) {\n  if (payload.sourceType) return String(payload.sourceType).slice(0, 80);\n  if (note.sourceType) return String(note.sourceType).slice(0, 80);\n  return 'single-capture';\n}\n\nfunction studyNotes(value) {\n  if (!Array.isArray(value)) return [];\n  return value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).slice(-200).map((item, index) => ({\n    id: String(item.id || \`thought-\${index}\`).slice(0, 160),\n    text: String(item.text || '').slice(0, 4000),\n    createdAt: String(item.createdAt || ''),\n    updatedAt: String(item.updatedAt || ''),\n  })).filter((item) => item.text.trim());\n}`,
);
replaceOnce(
  'cloudflare/source-mirror.js',
  `    noteType: String(note.noteType || 'note').slice(0, 40),\n    fileName,`,
  `    noteType: String(note.noteType || 'note').slice(0, 40),\n    studyNotes: studyNotes(note.studyNotes),\n    fileName,`,
);
replaceOnce(
  'cloudflare/source-mirror.js',
  `    noteType: String(note.noteType || 'note').slice(0, 40),\n    updatedAt: String(note.updatedAt || new Date().toISOString()),`,
  `    noteType: String(note.noteType || 'note').slice(0, 40),\n    studyNotes: studyNotes(note.studyNotes),\n    updatedAt: String(note.updatedAt || new Date().toISOString()),`,
);

// Move non-core mirror and receipt writes off the foreground save path.
replaceOnce(
  'cloudflare/media.js',
  `import { mirrorNewCloudImage } from './source-mirror.js';`,
  `import { mirrorNewCloudImage, SOURCE_MIRROR_PATHS } from './source-mirror.js';`,
);
replaceOnce(
  'cloudflare/media.js',
  `export async function saveNote(env, payload) {`,
  `export async function saveNote(env, payload, options = {}) {`,
);
replaceOnce(
  'cloudflare/media.js',
  `  const timestamp = new Date().toISOString();\n  const fileName = \`\${noteUid}.\${image.extension}\`;\n  const note = createSavedImageNote({ ...payload, noteUid }, { repoPath }, timestamp);\n  const sourceMirror = await mirrorNewCloudImage(env, image, note, payload, timestamp);\n  const learningResult = await insertSavedImageNote(env, note);\n  const response = {\n    ok: true,\n    noteUid,\n    filePath: \`github://\${repoPath}\`,\n    fileName,\n    sourceMirrorPath: sourceMirror.imagePath,`,
  `  const timestamp = new Date().toISOString();\n  const fileName = \`\${noteUid}.\${image.extension}\`;\n  const note = createSavedImageNote({ ...payload, noteUid }, { repoPath }, timestamp);\n  const learningResult = await insertSavedImageNote(env, note);\n  const response = {\n    ok: true,\n    noteUid,\n    filePath: \`github://\${repoPath}\`,\n    fileName,\n    sourceMirrorPath: \`\${SOURCE_MIRROR_PATHS.root}/\${fileName}\`,`,
);
replaceOnce(
  'cloudflare/media.js',
  `  await saveReceipt(env, noteUid, requestHash, { ...response, learningData: undefined });\n  return response;`,
  `  const finalize = async () => {\n    const results = await Promise.allSettled([\n      mirrorNewCloudImage(env, image, note, payload, timestamp),\n      saveReceipt(env, noteUid, requestHash, { ...response, learningData: undefined }),\n    ]);\n    for (const result of results) {\n      if (result.status === 'rejected') {\n        console.error(JSON.stringify({\n          event: 'save_note_background_finalize_failed',\n          noteUid,\n          error: result.reason instanceof Error ? result.reason.message : String(result.reason),\n        }));\n      }\n    }\n  };\n  if (typeof options.defer === 'function') options.defer(finalize());\n  else await finalize();\n  return response;`,
);
replaceOnce(
  'cloudflare/worker.js',
  `  if (request.method === 'POST' && pathname === '/save-note') {\n    const result = await saveNote(env, await readJson(request, 28 * 1024 * 1024));\n    return json(result, result.idempotentReplay ? 200 : 202);\n  }`,
  `  if (request.method === 'POST' && pathname === '/save-note') {\n    const payload = await readJson(request, 28 * 1024 * 1024);\n    const result = await saveNote(env, payload, ctx?.waitUntil\n      ? { defer: (task) => ctx.waitUntil(task) }\n      : {});\n    return json(result, result.idempotentReplay ? 200 : 202);\n  }`,
);

// Blob creation is independent; parallelizing it speeds canvas and multi-file commits.
replaceOnce(
  'cloudflare/github-store.js',
  `  const tree = [];\n  for (const file of files) {\n    const path = assertRepoPath(file.path);\n    if (file.delete === true) {\n      tree.push({ path, mode: '100644', type: 'blob', sha: null });\n      continue;\n    }\n    const sha = await createBlob(env, toBytes(file.content));\n    tree.push({ path, mode: '100644', type: 'blob', sha });\n  }`,
  `  const tree = await Promise.all(files.map(async (file) => {\n    const path = assertRepoPath(file.path);\n    if (file.delete === true) return { path, mode: '100644', type: 'blob', sha: null };\n    const sha = await createBlob(env, toBytes(file.content));\n    return { path, mode: '100644', type: 'blob', sha };\n  }));`,
);

// Failed multi-question crops become durable pending-review notes with the original image.
replaceOnce(
  'src/utils/noteBackgroundJobs.ts',
  `import { saveLearningDataCache } from './learningData';`,
  `import { patchLearningNote, saveLearningDataCache } from './learningData';`,
);
replaceOnce(
  'src/utils/noteBackgroundJobs.ts',
  `  detectedCount: number;\n  savedNoteUids: string[];`,
  `  detectedCount: number;\n  savedNoteUids: string[];\n  feedbackNoteUid?: string;`,
);
replaceOnce(
  'src/utils/noteBackgroundJobs.ts',
  `const safeJobToken = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);\n\nconst processJob = async (id: string): Promise<void> => {`,
  `const safeJobToken = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);\n\nconst persistFailureFeedback = async (job: MultiQuestionJob, errorText: string): Promise<string> => {\n  const noteUid = job.feedbackNoteUid || \`multi_failed_\${safeJobToken(job.id)}\`.slice(0, 150);\n  const result = await saveNoteImage({\n    imageDataUrl: job.imageDataUrl,\n    kind: 'single',\n    noteUid,\n    subject: '默认文件夹',\n    remark: \`AI 自动裁剪失败：\${errorText}\\n原图已经保留在待确认。请重新尝试自动裁剪，或打开原图后手动裁剪。\`,\n    sourceType: 'ai-multi-question-failed',\n    sourceBatchId: job.id,\n    tags: ['AI裁剪失败', '待确认'],\n  });\n  if (result.learningData) saveLearningDataCache(result.learningData);\n  const storedUid = result.noteUid || noteUid;\n  await patchJob(job.id, { feedbackNoteUid: storedUid });\n  return storedUid;\n};\n\nconst clearFailureFeedback = async (job: MultiQuestionJob): Promise<void> => {\n  if (!job.feedbackNoteUid) return;\n  try {\n    const snapshot = await patchLearningNote(job.feedbackNoteUid, { organizationStatus: 'ignored' });\n    saveLearningDataCache(snapshot);\n  } catch {\n    // The successful child notes are durable; stale feedback can be ignored manually.\n  }\n};\n\nconst processJob = async (id: string): Promise<void> => {`,
);
replaceOnce(
  'src/utils/noteBackgroundJobs.ts',
  `    const completed = await patchJob(id, {\n      imageDataUrl: '',`,
  `    await clearFailureFeedback(initial);\n    const completed = await patchJob(id, {\n      imageDataUrl: '',`,
);
replaceOnce(
  'src/utils/noteBackgroundJobs.ts',
  `  } catch (error) {\n    const current = await readJob(id);\n    await patchJob(id, {\n      status: 'failed',\n      progress: current?.progress || 0,\n      message: current?.attempts && current.attempts >= MAX_AUTO_ATTEMPTS\n        ? '后台处理失败，可重新拍摄或再次打开快速记图重试'\n        : '后台处理暂时失败，下次打开将自动重试',\n      error: error instanceof Error ? error.message : String(error),\n    });`,
  `  } catch (error) {\n    const current = await readJob(id);\n    const errorText = error instanceof Error ? error.message : String(error);\n    const failed = await patchJob(id, {\n      status: 'failed',\n      progress: current?.progress || 0,\n      message: current?.attempts && current.attempts >= MAX_AUTO_ATTEMPTS\n        ? 'AI 自动裁剪失败，原图已写入待确认'\n        : '后台处理暂时失败，下次打开将自动重试',\n      error: errorText,\n    });\n    if (failed.attempts >= MAX_AUTO_ATTEMPTS && failed.imageDataUrl) {\n      try {\n        await persistFailureFeedback(failed, errorText);\n      } catch (feedbackError) {\n        await patchJob(id, {\n          message: 'AI 自动裁剪失败，待确认反馈暂未保存，将在下次打开时重试',\n          error: \`\${errorText}；反馈保存失败：\${feedbackError instanceof Error ? feedbackError.message : String(feedbackError)}\`,\n        });\n      }\n    }`,
);

// Carry cloud-side thoughts into local sidecars and local learning-data.
replaceOnce(
  'scripts/windows-note-folder-sync.ps1',
  `function Materialize-CloudNotes([string]$LocalPath, [string]$RemotePath) {\n  $touchedSubjects = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)`,
  `function Materialize-CloudNotes([string]$LocalPath, [string]$RemotePath, [string]$AssistantRoot) {\n  $touchedSubjects = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)\n  $studyNotesByUid = @{}`,
);
replaceOnce(
  'scripts/windows-note-folder-sync.ps1',
  `      if (-not $meta.noteUid -or -not $meta.fileName) { return }\n      $imagePath = Join-Path $subjectDir ([string]$meta.fileName)`,
  `      if (-not $meta.noteUid -or -not $meta.fileName) { return }\n      if ($meta.PSObject.Properties.Name -contains 'studyNotes') {\n        $studyNotesByUid[[string]$meta.noteUid] = @($meta.studyNotes)\n      }\n      $imagePath = Join-Path $subjectDir ([string]$meta.fileName)`,
);
replaceOnce(
  'scripts/windows-note-folder-sync.ps1',
  `          sourceSplitIndex = $meta.sourceSplitIndex\n          organizationStatus = 'confirmed'`,
  `          sourceSplitIndex = $meta.sourceSplitIndex\n          studyNotes = if ($meta.PSObject.Properties.Name -contains 'studyNotes') { @($meta.studyNotes) } else { @() }\n          organizationStatus = 'confirmed'`,
);
replaceOnce(
  'scripts/windows-note-folder-sync.ps1',
  `  foreach ($subjectDir in $touchedSubjects) {`,
  `  $learningDataPath = Join-Path $AssistantRoot 'learning-data.json'\n  if ($studyNotesByUid.Count -gt 0 -and (Test-Path -LiteralPath $learningDataPath)) {\n    try {\n      $learningData = Get-Content -LiteralPath $learningDataPath -Raw -Encoding UTF8 | ConvertFrom-Json\n      $learningChanged = $false\n      foreach ($dayProperty in @($learningData.days.PSObject.Properties)) {\n        foreach ($note in @($dayProperty.Value.autoNotes)) {\n          $uid = [string]$note.noteUid\n          if (-not $studyNotesByUid.ContainsKey($uid)) { continue }\n          $nextThoughts = @($studyNotesByUid[$uid])\n          $before = if ($note.PSObject.Properties.Name -contains 'studyNotes') { $note.studyNotes | ConvertTo-Json -Depth 10 -Compress } else { '[]' }\n          $after = $nextThoughts | ConvertTo-Json -Depth 10 -Compress\n          if ($before -ne $after) {\n            $note | Add-Member -NotePropertyName studyNotes -NotePropertyValue $nextThoughts -Force\n            $learningChanged = $true\n          }\n        }\n      }\n      if ($learningChanged) { Write-JsonAtomic $learningDataPath $learningData }\n    } catch {}\n  }\n  foreach ($subjectDir in $touchedSubjects) {`,
);
replaceOnce(
  'scripts/windows-note-folder-sync.ps1',
  `  Materialize-CloudNotes $localPath $remotePath`,
  `  Materialize-CloudNotes $localPath $remotePath $assistantRoot`,
);

// A focused regression suite for the two data-loss bugs.
const testPath = file('scripts/__tests__/save-sync-regressions.test.cjs');
fs.writeFileSync(testPath, `const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst os = require('node:os');\nconst path = require('node:path');\nconst { createLearningDataStore, normalizeSnapshot } = require('../learning-data-store.cjs');\n\ntest('cloud asset paths never become an assets subject', () => {\n  const snapshot = normalizeSnapshot({\n    version: 1,\n    revision: 1,\n    days: {\n      '2026-07-24': {\n        manual: {},\n        autoNotes: [{\n          noteUid: 'asset-note',\n          subject: 'assets',\n          knowledgePath: ['assets'],\n          classificationSource: 'local',\n          organizationStatus: 'pending',\n          filePath: 'github://data/assets/asset-note.jpg',\n        }],\n      },\n    },\n  });\n  const note = snapshot.days['2026-07-24'].autoNotes[0];\n  assert.equal(note.subject, '默认文件夹');\n  assert.deepEqual(note.knowledgePath, []);\n});\n\ntest('note rebuild preserves appended study thoughts', () => {\n  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-thought-sync-'));\n  const store = createLearningDataStore({ assistantRoot: root });\n  store.restoreSnapshot({\n    version: 1,\n    revision: 0,\n    days: {\n      '2026-07-24': {\n        manual: {},\n        autoNotes: [{\n          noteUid: 'thought-note',\n          capturedDate: '2026-07-24',\n          title: '题目',\n          subject: '高等数学',\n          knowledgePath: ['高等数学'],\n          classificationSource: 'manual',\n          organizationStatus: 'confirmed',\n          reviewStatus: 'corrected',\n          filePath: '高等数学/题目.jpg',\n          studyNotes: [{ id: 'thought-1', text: '第一次追加想法', createdAt: '2026-07-24T01:00:00.000Z', updatedAt: '2026-07-24T01:00:00.000Z' }],\n        }],\n      },\n    },\n    cards: [],\n    deletedNotes: {},\n  });\n  store.syncNote({\n    noteUid: 'thought-note',\n    title: '题目',\n    subject: '高等数学',\n    filePath: '高等数学/题目.jpg',\n    learning: { subject: '高等数学', knowledgePath: ['高等数学'] },\n  });\n  const note = store.getSnapshot().days['2026-07-24'].autoNotes[0];\n  assert.equal(note.studyNotes.length, 1);\n  assert.equal(note.studyNotes[0].text, '第一次追加想法');\n});\n`, 'utf8');

console.log('Applied public save, thought sync, crop feedback, and assets-category fixes.');
