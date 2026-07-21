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


path, text = load('src/utils/aiConfig.ts')
text = replace_once(
    text,
    "  lastError?: string | null;\n  settings?: {\n",
    "  lastError?: string | null;\n  runningAction?: 'push' | 'pull' | 'automatic' | null;\n  phase?: string;\n  progress?: number;\n  message?: string;\n  settings?: {\n",
    'review status progress types',
)
text = replace_once(
    text,
    "export async function pushReviewData(): Promise<{ ok: boolean; changed?: boolean; count?: number; skipped?: boolean; reason?: string }> {\n",
    "export async function pushReviewData(): Promise<{ ok: boolean; accepted?: boolean; running?: boolean; action?: string; changed?: boolean; count?: number; skipped?: boolean; reason?: string }> {\n",
    'push response type',
)
text = replace_once(
    text,
    "export async function pullReviewPdfs(): Promise<{ ok: boolean; downloaded?: number; outputDirectory?: string; skipped?: boolean; reason?: string }> {\n",
    "export async function pullReviewPdfs(): Promise<{ ok: boolean; accepted?: boolean; running?: boolean; action?: string; downloaded?: number; outputDirectory?: string; skipped?: boolean; reason?: string }> {\n",
    'pull response type',
)
text += "\nexport async function analyzeLearningNoteWrongReason(noteUid: string): Promise<{ ok: boolean; queued: boolean; noteUid: string }> {\n  return readReviewResponse(await fetch(`${NOTE_SERVER_URL}/learning-data/notes/${encodeURIComponent(noteUid)}/analyze-wrong-reason`, { method: 'POST' }));\n}\n"
save(path, text)

path, text = load('src/components/AiConfigPage.tsx')
text = replace_once(
    text,
    "  note_enrichment: '例如：错因必须写成可执行的改进动作；不要把单纯计算量大的题判断为好题。',\n",
    "  note_enrichment: '例如：错因必须写成可执行的改进动作；不要把单纯计算量大的题判断为好题。',\n  note_image_understanding: '无备注时优先使用高质量视觉模型；只依据图片可见内容，不猜测缺失信息。',\n",
    'image task instruction',
)
text = replace_once(
    text,
    "  useEffect(() => {\n    if (selectedTaskId !== 'weekly_review_pdf') return undefined;\n    let cancelled = false;\n    void fetchReviewSyncStatus()\n      .then((next) => { if (!cancelled) setReviewStatus(next); })\n      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });\n    return () => { cancelled = true; };\n  }, [selectedTaskId, savedMessage]);\n",
    "  useEffect(() => {\n    if (selectedTaskId !== 'weekly_review_pdf') return undefined;\n    let cancelled = false;\n    let timer = 0;\n    const refresh = async () => {\n      try {\n        const next = await fetchReviewSyncStatus();\n        if (!cancelled) setReviewStatus(next);\n      } catch (reason) {\n        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));\n      }\n    };\n    void refresh();\n    timer = window.setInterval(() => void refresh(), 2_000);\n    return () => { cancelled = true; window.clearInterval(timer); };\n  }, [selectedTaskId]);\n",
    'review polling',
)
text = replace_once(
    text,
    "        const result = await pushReviewData();\n        setSavedMessage(result.skipped ? result.reason || '本次同步已跳过。' : `已同步 ${result.count ?? 0} 条已确认内容${result.changed ? '并推送到 GitHub' : '；仓库内容没有变化'}。`);\n",
    "        const result = await pushReviewData();\n        setSavedMessage(result.skipped\n          ? result.reason || '本次同步已跳过。'\n          : result.accepted === false\n            ? '已有综合复习任务在后台运行。'\n            : '同步已转入后台；你可以离开此页面，状态会自动刷新。');\n",
    'push feedback',
)
text = replace_once(
    text,
    "        const result = await pullReviewPdfs();\n        setSavedMessage(result.skipped ? result.reason || '本次下载已跳过。' : `已检查最新 PDF，下载 ${result.downloaded ?? 0} 个文件。`);\n",
    "        const result = await pullReviewPdfs();\n        setSavedMessage(result.skipped\n          ? result.reason || '本次下载已跳过。'\n          : result.accepted === false\n            ? '已有综合复习任务在后台运行。'\n            : 'PDF 检查已转入后台；下载完成后状态会自动更新。');\n",
    'pull feedback',
)
text = replace_once(
    text,
    "                {reviewStatus?.lastError && <p className=\"ai-review-last-error\">{reviewStatus.lastError}</p>}\n                <div className=\"ai-review-actions\">\n                  <button disabled={dirty || saving || reviewAction !== ''} type=\"button\" onClick={() => void runReviewAction('push')}>\n                    {reviewAction === 'push' ? <LoaderCircle className=\"is-spinning\" size={16} /> : <UploadCloud size={16} />} 立即同步已确认内容\n                  </button>\n                  <button disabled={dirty || saving || reviewAction !== ''} type=\"button\" onClick={() => void runReviewAction('pull')}>\n                    {reviewAction === 'pull' ? <LoaderCircle className=\"is-spinning\" size={16} /> : <Download size={16} />} 下载最新两份 PDF\n                  </button>\n",
    "                {reviewStatus?.running && (\n                  <div className=\"ai-review-progress\">\n                    <div><span>{reviewStatus.message || '后台任务正在运行…'}</span><strong>{Math.round(reviewStatus.progress || 0)}%</strong></div>\n                    <progress max=\"100\" value={reviewStatus.progress || 0} />\n                  </div>\n                )}\n                {reviewStatus?.lastError && <p className=\"ai-review-last-error\">{reviewStatus.lastError}</p>}\n                <div className=\"ai-review-actions\">\n                  <button disabled={dirty || saving || reviewAction !== '' || reviewStatus?.running === true} type=\"button\" onClick={() => void runReviewAction('push')}>\n                    {reviewAction === 'push' || reviewStatus?.runningAction === 'push' ? <LoaderCircle className=\"is-spinning\" size={16} /> : <UploadCloud size={16} />} 立即同步已确认内容\n                  </button>\n                  <button disabled={dirty || saving || reviewAction !== '' || reviewStatus?.running === true} type=\"button\" onClick={() => void runReviewAction('pull')}>\n                    {reviewAction === 'pull' || reviewStatus?.runningAction === 'pull' ? <LoaderCircle className=\"is-spinning\" size={16} /> : <Download size={16} />} 下载最新两份 PDF\n                  </button>\n",
    'review progress UI',
)
save(path, text)

path, text = load('src/ai-config.css')
text += "\n.ai-review-progress { display: grid; gap: 7px; padding: 11px 13px; border: 1px solid #cbdde4; border-radius: 11px; background: #f3f8fa; }\n.ai-review-progress > div { display: flex; justify-content: space-between; gap: 14px; color: #466675; font-size: 12px; }\n.ai-review-progress strong { color: #2f6074; }\n.ai-review-progress progress { width: 100%; height: 7px; overflow: hidden; border: 0; border-radius: 999px; accent-color: #3e7185; }\n"
save(path, text)

path, text = load('src/utils/learningData.ts')
text = replace_once(
    text,
    "  wrongReason: string;\n  organizationStatus: LearningNoteOrganizationStatus;\n",
    "  wrongReason: string;\n  wrongReasonSource: string;\n  wrongReasonConfidence: number | null;\n  organizationStatus: LearningNoteOrganizationStatus;\n",
    'learning note provenance type',
)
text = replace_once(
    text,
    "    wrongReason: typeof value.wrongReason === 'string' ? value.wrongReason : '',\n    organizationStatus: inferredFromFile && value.organizationStatus !== 'ignored'\n",
    "    wrongReason: typeof value.wrongReason === 'string' ? value.wrongReason : '',\n    wrongReasonSource: typeof value.wrongReasonSource === 'string' ? value.wrongReasonSource : '',\n    wrongReasonConfidence: Number.isFinite(Number(value.wrongReasonConfidence))\n      ? Math.min(1, Math.max(0, Number(value.wrongReasonConfidence)))\n      : null,\n    organizationStatus: inferredFromFile && value.organizationStatus !== 'ignored'\n",
    'learning provenance normalize',
)
save(path, text)

path, text = load('src/components/LearningCenter.tsx')
text = replace_once(
    text,
    "import { NOTE_SERVER_URL } from '../utils/notes';\n",
    "import { analyzeLearningNoteWrongReason } from '../utils/aiConfig';\nimport { NOTE_SERVER_URL } from '../utils/notes';\n",
    'wrong reason API import',
)
text = replace_once(
    text,
    "  const [thoughtSaving, setThoughtSaving] = useState(false);\n",
    "  const [thoughtSaving, setThoughtSaving] = useState(false);\n  const [wrongReasonEditor, setWrongReasonEditor] = useState<{ noteUid: string; text: string } | null>(null);\n  const [wrongReasonSaving, setWrongReasonSaving] = useState(false);\n",
    'wrong reason editor state',
)
text = replace_once(
    text,
    "    setThoughtEditor(null);\n  }, [selectedNoteUid, selectedInboxKey, selectedCardId, view]);\n",
    "    setThoughtEditor(null);\n    setWrongReasonEditor(null);\n  }, [selectedNoteUid, selectedInboxKey, selectedCardId, view]);\n",
    'editor reset',
)
anchor = "  const splitEditorTags = (value: string): string[] => uniqueText(\n"
functions = """  const wrongReasonSourceLabel = (note: LearningAutoNote): string => ({\n    manual: '手动填写',\n    manual_deleted: '已手动删除',\n    explicit_remark: '从备注明确提取',\n    explicit_image: '从图片明确提取',\n    ai_inferred: 'AI 根据过程推断',\n    none: '尚未识别',\n  }[note.wrongReasonSource] || (note.wrongReason ? '已有记录' : '尚未识别'));\n\n  const saveWrongReason = async (note: LearningAutoNote) => {\n    if (!wrongReasonEditor || wrongReasonSaving) return;\n    try {\n      setWrongReasonSaving(true);\n      setFeedback('');\n      await onPatchNote(note.noteUid, { wrongReason: wrongReasonEditor.text.trim() });\n      setWrongReasonEditor(null);\n      setFeedback(wrongReasonEditor.text.trim() ? '错因已保存，后续 AI 不会覆盖。' : '错因已删除，后续 AI 不会自动补回。');\n    } catch (error) {\n      setFeedback(error instanceof Error ? error.message : '错因没有保存，请稍后重试。');\n    } finally {\n      setWrongReasonSaving(false);\n    }\n  };\n\n  const deleteWrongReason = async (note: LearningAutoNote) => {\n    if (wrongReasonSaving || !window.confirm('确定删除这条错因吗？删除后 AI 不会自动补回，除非你主动重新分析。')) return;\n    try {\n      setWrongReasonSaving(true);\n      setFeedback('');\n      await onPatchNote(note.noteUid, { wrongReason: '' });\n      setWrongReasonEditor(null);\n      setFeedback('错因已删除。');\n    } catch (error) {\n      setFeedback(error instanceof Error ? error.message : '错因删除失败，请稍后重试。');\n    } finally {\n      setWrongReasonSaving(false);\n    }\n  };\n\n  const analyzeWrongReason = async (note: LearningAutoNote) => {\n    if (wrongReasonSaving) return;\n    try {\n      setWrongReasonSaving(true);\n      setFeedback('');\n      const result = await analyzeLearningNoteWrongReason(note.noteUid);\n      setFeedback(result.queued ? '已转入后台分析；完成后错因会自动更新。' : '这条笔记的分析任务已在队列中。');\n    } catch (error) {\n      setFeedback(error instanceof Error ? error.message : '无法启动错因分析。');\n    } finally {\n      setWrongReasonSaving(false);\n    }\n  };\n\n"""
if anchor not in text:
    raise SystemExit('wrong reason function anchor missing')
text = text.replace(anchor, functions + anchor, 1)
text = replace_once(
    text,
    "          {context === 'mistake' && <div className=\"lc-fact-wide\"><span>错因</span><strong>{wrongReasons.join('；') || '—'}</strong></div>}\n",
    "          {context === 'mistake' && (\n            <div className=\"lc-fact-wide lc-wrong-reason-fact\">\n              <span>错因</span>\n              {wrongReasonEditor?.noteUid === note.noteUid ? (\n                <form onSubmit={(event) => { event.preventDefault(); void saveWrongReason(note); }}>\n                  <textarea autoFocus maxLength={500} rows={3} value={wrongReasonEditor.text} onChange={(event) => setWrongReasonEditor({ noteUid: note.noteUid, text: event.target.value })} />\n                  <div><button className=\"primary\" type=\"submit\" disabled={wrongReasonSaving}><Save size={14} />保存</button><button type=\"button\" disabled={wrongReasonSaving} onClick={() => setWrongReasonEditor(null)}>取消</button></div>\n                </form>\n              ) : (\n                <div className=\"lc-wrong-reason-view\">\n                  <strong>{note.wrongReason || wrongReasons[0] || '尚未分析'}</strong>\n                  <small>{wrongReasonSourceLabel(note)}{note.wrongReasonConfidence !== null ? ` · 可信度 ${Math.round(note.wrongReasonConfidence * 100)}%` : ''}</small>\n                  <div>\n                    <button type=\"button\" disabled={wrongReasonSaving} onClick={() => setWrongReasonEditor({ noteUid: note.noteUid, text: note.wrongReason })}><Pencil size={14} />修改</button>\n                    {note.wrongReason && <button className=\"danger\" type=\"button\" disabled={wrongReasonSaving} onClick={() => void deleteWrongReason(note)}><Trash2 size={14} />删除</button>}\n                    {!note.wrongReason && note.wrongReasonSource !== 'manual_deleted' && <button type=\"button\" disabled={wrongReasonSaving} onClick={() => void analyzeWrongReason(note)}><Brain size={14} />AI 分析</button>}\n                    {note.wrongReasonSource === 'manual_deleted' && <button type=\"button\" disabled={wrongReasonSaving} onClick={() => void analyzeWrongReason(note)}><Brain size={14} />重新分析</button>}\n                  </div>\n                </div>\n              )}\n            </div>\n          )}\n",
    'wrong reason controls',
)
save(path, text)

path, text = load('src/learning-center.css')
text += "\n.lc-wrong-reason-fact { align-items: stretch; }\n.lc-wrong-reason-view { min-width: 0; display: grid; gap: 5px; }\n.lc-wrong-reason-view > strong { white-space: normal; line-height: 1.55; }\n.lc-wrong-reason-view > small { color: #7d7469; font-size: 11px; font-weight: 600; }\n.lc-wrong-reason-view > div, .lc-wrong-reason-fact form > div { display: flex; flex-wrap: wrap; gap: 7px; }\n.lc-wrong-reason-view button, .lc-wrong-reason-fact form button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid #d8d2ca; border-radius: 8px; background: #fff; color: #4f5964; padding: 6px 9px; font: inherit; font-size: 11px; cursor: pointer; }\n.lc-wrong-reason-view button.danger { color: #a04f48; }\n.lc-wrong-reason-fact form { display: grid; gap: 8px; }\n.lc-wrong-reason-fact textarea { width: 100%; resize: vertical; min-height: 72px; border: 1px solid #d8d2ca; border-radius: 9px; padding: 9px 10px; font: inherit; line-height: 1.55; }\n"
save(path, text)

print('Applied final front-end review and wrong-reason controls.')
