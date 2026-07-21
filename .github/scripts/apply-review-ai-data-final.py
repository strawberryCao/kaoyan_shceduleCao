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


path, text = load('scripts/organize-notes.cjs')
text = replace_once(
    text,
    "  const questionType = keepsManualClassification ? previousLearning.questionType || null : analysis.questionType;\n  const wrongReason = keepsManualClassification ? previousLearning.wrongReason || null : analysis.wrongReason;\n",
    "  const userEditedFields = new Set(Array.isArray(previousLearning.userEditedFields) ? previousLearning.userEditedFields : []);\n  const questionType = userEditedFields.has('questionType')\n    ? previousLearning.questionType || null\n    : keepsManualClassification && previousLearning.questionType ? previousLearning.questionType : analysis.questionType;\n  const explicitRemarkReason = Array.isArray(parsed.wrongReasons) ? String(parsed.wrongReasons[0] || '').trim().slice(0, 500) : '';\n  const keepsUserWrongReason = userEditedFields.has('wrongReason');\n  const wrongReason = keepsUserWrongReason\n    ? previousLearning.wrongReason || null\n    : explicitRemarkReason || analysis.wrongReason || null;\n  const wrongReasonSource = keepsUserWrongReason\n    ? previousLearning.wrongReasonSource || (wrongReason ? 'manual' : 'manual_deleted')\n    : explicitRemarkReason\n      ? 'explicit_remark'\n      : analysis.wrongReasonSource || (wrongReason ? 'ai_inferred' : 'none');\n  const wrongReasonConfidence = keepsUserWrongReason\n    ? (wrongReason ? 1 : null)\n    : explicitRemarkReason\n      ? 1\n      : Number.isFinite(Number(analysis.wrongReasonConfidence)) ? Number(analysis.wrongReasonConfidence) : null;\n",
    'learning wrong reason policy',
)
text = replace_once(
    text,
    "    wrongReason,\n    organizationStatus: keepsManualClassification || !isDefaultBucket(subject.name) ? 'confirmed' : 'pending',\n",
    "    wrongReason,\n    wrongReasonSource,\n    wrongReasonConfidence,\n    userEditedFields: [...userEditedFields],\n    organizationStatus: keepsManualClassification || !isDefaultBucket(subject.name) ? 'confirmed' : 'pending',\n",
    'learning provenance persisted',
)
text = replace_once(
    text,
    "            wrongReason: analysis.wrongReason,\n            memoryCard: analysis.memoryCard,\n",
    "            wrongReason: analysis.wrongReason,\n            wrongReasonSource: analysis.wrongReasonSource,\n            wrongReasonConfidence: analysis.wrongReasonConfidence,\n            memoryCard: analysis.memoryCard,\n",
    'organizer provenance',
)
text = replace_once(
    text,
    "    if (!dryRun && !options.force && Number.isFinite(lastSuccessfulAt) && Date.now() - lastSuccessfulAt < cadenceMs) {\n",
    "    if (!dryRun && !options.force && !options.noteUid && Number.isFinite(lastSuccessfulAt) && Date.now() - lastSuccessfulAt < cadenceMs) {\n",
    'targeted cadence bypass',
)
text = replace_once(
    text,
    "    const notes = discoverNotes(notesRoot);\n    report.discovered = notes.length;\n",
    "    const targetNoteUid = typeof options.noteUid === 'string' ? options.noteUid.trim() : '';\n    const notes = discoverNotes(notesRoot).filter((note) => !targetNoteUid || note.metadata?.noteUid === targetNoteUid);\n    report.discovered = notes.length;\n",
    'targeted note filter',
)
text = replace_once(
    text,
    "  const report = await organizeNotes({\n    analyzeNote: analyzer,\n",
    "  const noteUidFlag = [...flags].find((flag) => flag.startsWith('--note-uid='));\n  const report = await organizeNotes({\n    analyzeNote: analyzer,\n    noteUid: noteUidFlag ? noteUidFlag.slice('--note-uid='.length) : '',\n",
    'targeted CLI flag',
)
save(path, text)

path, text = load('scripts/learning-data-store.cjs')
text = replace_once(
    text,
    "    wrongReason: asString(value.wrongReason),\n    organizationStatus: inferredFromFile && organizationStatus === 'pending' ? 'confirmed' : organizationStatus,\n",
    "    wrongReason: asString(value.wrongReason),\n    wrongReasonSource: asString(value.wrongReasonSource),\n    wrongReasonConfidence: Number.isFinite(Number(value.wrongReasonConfidence))\n      ? Math.min(1, Math.max(0, Number(value.wrongReasonConfidence)))\n      : null,\n    organizationStatus: inferredFromFile && organizationStatus === 'pending' ? 'confirmed' : organizationStatus,\n",
    'normalize provenance',
)
text = replace_once(
    text,
    "      wrongReason: existingNote?.classificationSource === 'manual'\n        ? existingNote.wrongReason\n        : enrichment.wrongReason ?? existingNote?.wrongReason,\n      organizationStatus: resolveOrganizationStatus(\n",
    "      wrongReason: userEditedFields.has('wrongReason')\n        ? existingNote?.wrongReason\n        : enrichment.wrongReason ?? existingNote?.wrongReason,\n      wrongReasonSource: userEditedFields.has('wrongReason')\n        ? existingNote?.wrongReasonSource || (existingNote?.wrongReason ? 'manual' : 'manual_deleted')\n        : enrichment.wrongReasonSource ?? existingNote?.wrongReasonSource,\n      wrongReasonConfidence: userEditedFields.has('wrongReason')\n        ? (existingNote?.wrongReason ? 1 : null)\n        : enrichment.wrongReasonConfidence ?? existingNote?.wrongReasonConfidence,\n      userEditedFields: [...userEditedFields],\n      organizationStatus: resolveOrganizationStatus(\n",
    'apply sync ownership',
)
text = replace_once(
    text,
    "        userEditedFields: [\n          'title',\n          'remark',\n          'tags',\n          'noteType',\n          ...(typeof input.goodQuestion === 'boolean' ? ['goodQuestion'] : []),\n        ],\n        goodQuestion: typeof input.goodQuestion === 'boolean' ? input.goodQuestion : null,\n",
    "        userEditedFields: [\n          'title',\n          'remark',\n          'tags',\n          'noteType',\n          ...(asString(input.wrongReason).trim() ? ['wrongReason'] : []),\n          ...(typeof input.goodQuestion === 'boolean' ? ['goodQuestion'] : []),\n        ],\n        wrongReasonSource: asString(input.wrongReason).trim() ? 'manual' : '',\n        wrongReasonConfidence: asString(input.wrongReason).trim() ? 1 : null,\n        goodQuestion: typeof input.goodQuestion === 'boolean' ? input.goodQuestion : null,\n",
    'create note ownership',
)
text = replace_once(
    text,
    "          const userEditedFields = new Set(note.userEditedFields);\n          contentKeys.forEach((key) => {\n            if (Object.hasOwn(patch, key)) userEditedFields.add(key);\n          });\n",
    "          const userEditedFields = new Set(note.userEditedFields);\n          const normalizedPatchValue = (key) => {\n            if (key === 'knowledgePath' || key === 'tags') return JSON.stringify(uniqueStrings(patch[key]));\n            if (key === 'goodQuestion') return String(patch[key] === true);\n            return asString(patch[key]).trim();\n          };\n          const normalizedNoteValue = (key) => {\n            if (key === 'knowledgePath' || key === 'tags') return JSON.stringify(note[key] || []);\n            if (key === 'goodQuestion') return String(note[key] === true);\n            return asString(note[key]).trim();\n          };\n          const changedEditableKeys = editableKeys.filter((key) => (\n            Object.hasOwn(patch, key) && normalizedPatchValue(key) !== normalizedNoteValue(key)\n          ));\n          changedEditableKeys.forEach((key) => userEditedFields.add(key));\n",
    'changed field ownership',
)
text = replace_once(
    text,
    "            ...(Object.hasOwn(patch, 'wrongReason') ? { wrongReason: asString(patch.wrongReason).slice(0, 500) } : {}),\n            organizationStatus: hasOrganizationStatus\n",
    "            ...(Object.hasOwn(patch, 'wrongReason') ? {\n              wrongReason: asString(patch.wrongReason).slice(0, 500),\n              ...(changedEditableKeys.includes('wrongReason') ? {\n                wrongReasonSource: asString(patch.wrongReason).trim() ? 'manual' : 'manual_deleted',\n                wrongReasonConfidence: asString(patch.wrongReason).trim() ? 1 : null,\n              } : {}),\n            } : {}),\n            organizationStatus: hasOrganizationStatus\n",
    'update note provenance',
)
text = replace_once(
    text,
    "            classificationSource: editsClassification ? 'manual' : note.classificationSource,\n",
    "            classificationSource: changedEditableKeys.some((key) => classificationKeys.includes(key)) ? 'manual' : note.classificationSource,\n",
    'classification source on actual change',
)
save(path, text)

path, text = load('scripts/note-server.cjs')
text = replace_once(
    text,
    "let aiNamingQueue = Promise.resolve();\nconst aiNamingJobs = new Map();\n",
    "let aiNamingQueue = Promise.resolve();\nconst aiNamingJobs = new Map();\nlet noteEnrichmentQueue = Promise.resolve();\nconst noteEnrichmentJobs = new Map();\n",
    'enrichment queue state',
)
text = replace_once(
    text,
    "    wrongReason: parsed.wrongReasons?.[0] || '',\n    intent,\n",
    "    wrongReason: parsed.wrongReasons?.[0] || '',\n    wrongReasonSource: parsed.wrongReasons?.[0] ? 'explicit_remark' : 'none',\n    wrongReasonConfidence: parsed.wrongReasons?.[0] ? 1 : null,\n    userEditedFields: [],\n    intent,\n",
    'initial wrong reason provenance',
)
text = replace_once(
    text,
    "  const knowledgePoint = knowledgePath[1] || null;\n\n  const taxonomy = loadTaxonomy(NOTE_TAXONOMY_PATH);\n",
    "  const knowledgePoint = knowledgePath[1] || null;\n  const previousUserEditedFields = new Set(Array.isArray(currentLearning.userEditedFields) ? currentLearning.userEditedFields : []);\n  const changedFields = [];\n  const currentQuestionType = String(currentLearning.questionType || '').trim();\n  const currentWrongReason = String(currentLearning.wrongReason || '').trim();\n  if (Object.hasOwn(patch, 'subject') && subject !== String(currentLearning.subject || saved.metadata.subject || '').trim()) changedFields.push('subject');\n  if (Object.hasOwn(patch, 'knowledgePath') && JSON.stringify(knowledgePath) !== JSON.stringify(currentLearning.knowledgePath || [])) changedFields.push('knowledgePath');\n  if (Object.hasOwn(patch, 'questionType') && String(patch.questionType || '').trim() !== currentQuestionType) changedFields.push('questionType');\n  if (Object.hasOwn(patch, 'wrongReason') && String(patch.wrongReason || '').trim() !== currentWrongReason) changedFields.push('wrongReason');\n  changedFields.forEach((field) => previousUserEditedFields.add(field));\n  const nextWrongReason = Object.hasOwn(patch, 'wrongReason')\n    ? String(patch.wrongReason || '').trim().slice(0, 500)\n    : currentWrongReason;\n\n  const taxonomy = loadTaxonomy(NOTE_TAXONOMY_PATH);\n",
    'manual field change detection',
)
text = replace_once(
    text,
    "      ...(Object.hasOwn(patch, 'wrongReason') ? { wrongReason: String(patch.wrongReason || '').trim().slice(0, 500) } : {}),\n      organizationStatus: 'confirmed',\n",
    "      ...(Object.hasOwn(patch, 'wrongReason') ? {\n        wrongReason: nextWrongReason,\n        ...(changedFields.includes('wrongReason') ? {\n          wrongReasonSource: nextWrongReason ? 'manual' : 'manual_deleted',\n          wrongReasonConfidence: nextWrongReason ? 1 : null,\n        } : {}),\n      } : {}),\n      userEditedFields: [...previousUserEditedFields],\n      organizationStatus: 'confirmed',\n",
    'manual provenance persistence',
)
text = replace_once(
    text,
    "function queueAiNamingJob(noteUid) {\n",
    "function queueNoteEnrichment(noteUid) {\n  if (!noteUid || noteEnrichmentJobs.has(noteUid)) return false;\n  const job = noteEnrichmentQueue.then(() => new Promise((resolve) => {\n    const child = spawn(process.execPath, [path.join(__dirname, 'organize-notes.cjs'), '--force', `--note-uid=${noteUid}`], {\n      cwd: PROJECT_ROOT,\n      windowsHide: true,\n      stdio: 'ignore',\n      env: process.env,\n    });\n    child.once('error', resolve);\n    child.once('close', resolve);\n  }));\n  noteEnrichmentJobs.set(noteUid, job);\n  noteEnrichmentQueue = job.catch(() => undefined);\n  void job.finally(() => noteEnrichmentJobs.delete(noteUid)).catch(() => undefined);\n  return true;\n}\n\nfunction queueAiNamingJob(noteUid) {\n",
    'targeted enrichment queue',
)
text = replace_once(
    text,
    "      await runAiNamingJob(noteUid);\n",
    "      await runAiNamingJob(noteUid);\n      queueNoteEnrichment(noteUid);\n",
    'enrichment after naming',
)
text = replace_once(
    text,
    "  const cardMatch = /^\\/learning-data\\/cards\\/([^/]+)$/.exec(pathname);\n  const noteMatch = /^\\/learning-data\\/notes\\/([^/]+)$/.exec(pathname);\n",
    "  const cardMatch = /^\\/learning-data\\/cards\\/([^/]+)$/.exec(pathname);\n  const noteMatch = /^\\/learning-data\\/notes\\/([^/]+)$/.exec(pathname);\n  const noteAnalyzeMatch = /^\\/learning-data\\/notes\\/([^/]+)\\/analyze-wrong-reason$/.exec(pathname);\n  if (noteAnalyzeMatch && req.method === 'POST') {\n    const noteUid = decodeURIComponent(noteAnalyzeMatch[1]);\n    const queued = queueNoteEnrichment(noteUid);\n    sendJson(res, 202, { ok: true, queued, noteUid });\n    return true;\n  }\n",
    'wrong reason endpoint',
)
text = replace_once(
    text,
    "  if (req.method === 'POST' && pathname === '/ai/review/push') {\n    const result = await reviewSync.push();\n    sendJson(res, 200, { ...result, status: reviewSync.status() });\n    return true;\n  }\n  if (req.method === 'POST' && pathname === '/ai/review/pull') {\n    const result = await reviewSync.pull();\n    sendJson(res, 200, { ...result, status: reviewSync.status() });\n    return true;\n  }\n",
    "  if (req.method === 'POST' && pathname === '/ai/review/push') {\n    const result = reviewSync.startPush();\n    sendJson(res, result.accepted ? 202 : 200, { ...result, status: reviewSync.status() });\n    return true;\n  }\n  if (req.method === 'POST' && pathname === '/ai/review/pull') {\n    const result = reviewSync.startPull();\n    sendJson(res, result.accepted ? 202 : 200, { ...result, status: reviewSync.status() });\n    return true;\n  }\n",
    'nonblocking review routes',
)
save(path, text)

print('Applied final wrong-reason data changes.')
