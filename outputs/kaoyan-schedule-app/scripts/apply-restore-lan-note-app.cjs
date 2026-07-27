'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const appPath = path.join(root, 'src/components/NoteDropApp.tsx');
const mobileCssPath = path.join(root, 'src/note-drop-mobile.css');
const quickCssPath = path.join(root, 'src/quick-material-composer.css');
const learningCenterPath = path.join(root, 'src/components/LearningCenter.tsx');
const testPath = path.join(root, 'scripts/lan-note-app-quick-entry.test.cjs');

const replaceOnce = (source, before, after, label) => {
  if (!source.includes(before)) throw new Error(`Patch target not found: ${label}`);
  return source.replace(before, after);
};
const replaceRegex = (source, pattern, after, label) => {
  const next = source.replace(pattern, after);
  if (next === source) throw new Error(`Patch target not found: ${label}`);
  return next;
};

let app = fs.readFileSync(appPath, 'utf8');
app = replaceOnce(app,
`  useEffect(() => {
    const disposeResumer = installCaptureUploadResumer();
    const disposeSubscription = subscribeCaptureUploads(setUploadSummary);
    return () => {
      disposeSubscription();
      disposeResumer();
    };
  }, []);`,
`  useEffect(() => {
    if (!IS_CLOUD_RUNTIME) return undefined;
    const disposeResumer = installCaptureUploadResumer();
    const disposeSubscription = subscribeCaptureUploads(setUploadSummary);
    return () => {
      disposeSubscription();
      disposeResumer();
    };
  }, []);`,
'cloud-only upload queue');

app = replaceOnce(app,
`  useEffect(() => {
    const mode = pendingImage ? 'remark' : 'compact';
    if (window.kaoyanDesktop?.setNoteAppMode) void window.kaoyanDesktop.setNoteAppMode(mode);
  }, [pendingImage]);`,
`  useEffect(() => {
    const mode = pendingImage || materialOpen ? 'remark' : 'compact';
    if (window.kaoyanDesktop?.setNoteAppMode) void window.kaoyanDesktop.setNoteAppMode(mode);
  }, [materialOpen, pendingImage]);`,
'quick composer expands note window');

const saveSingle = `  const saveSingle = async () => {
    if (!pendingImage || saving) return;
    const payload = {
      imageDataUrl: pendingImage.src,
      kind: 'single' as const,
      noteUid: pendingImage.noteUid,
      remark,
      sourceType: 'single-capture',
    };
    try {
      setSaving(true);
      setSaved(false);
      setDialogError('');
      if (IS_CLOUD_RUNTIME) {
        await enqueueCaptureUpload([payload]);
        setPendingImage(null);
        setRemark('');
        setSaved(true);
        setStatus('已安全保存在本机；可以关闭页面，重新打开后会自动续传');
        if (isMobileCapture) setMobileStep('success');
        return;
      }
      const result = await saveImageReliably(payload, setStatus);
      if (result.learningData) saveLearningDataCache(result.learningData);
      setPendingImage(null);
      setRemark('');
      setDialogError('');
      setSaved(true);
      const aiMessage = result.aiStatus === 'complete'
        ? 'AI 整理完成'
        : result.aiStatus === 'failed' ? 'AI 将在稍后整理' : 'AI 正在后台整理';
      setStatus(\`已保存 · \${aiMessage}\`);
    } catch (error) {
      const message = error instanceof Error
        ? \`保存失败：\${error.message}\`
        : IS_CLOUD_RUNTIME ? '无法写入本机后台队列，请释放浏览器存储后重试。' : '保存失败，请确认笔记服务已启动。';
      setDialogError(message);
      setStatus(message);
    } finally {
      setSaving(false);
    }
  };

  const confirmSingleCrop`;
app = replaceRegex(app, /  const saveSingle = async \(\) => \{[\s\S]*?\n  \};\n\n  const confirmSingleCrop/, saveSingle, 'restore LAN single save');

const saveBatch = `  const saveBatch = async () => {
    const selected = batchImages.filter((item) => item.enabled);
    if (selected.length === 0 || saving) {
      setDialogError('请至少保留一道题。');
      return;
    }
    const payloads = selected.map((item, index) => ({
      imageDataUrl: item.src,
      kind: 'single' as const,
      noteUid: item.noteUid,
      subject: batchSubject,
      remark: batchRemark,
      sourceType: 'ai-multi-question',
      sourceBatchId: sourceImage?.noteUid || '',
      sourceSplitIndex: index + 1,
      tags: ['AI多题拆分'],
    }));
    try {
      setSaving(true);
      setDialogError('');
      if (IS_CLOUD_RUNTIME) {
        await enqueueCaptureUpload(payloads);
        setSaved(true);
        setStatus(\`\${selected.length} 道题已安全保存在本机，后台自动续传\`);
        setBatchProgress('');
        setMobileStep('success');
        return;
      }
      const result = await saveBatchReliably(payloads, setBatchProgress);
      if (result.learningData) saveLearningDataCache(result.learningData);
      setSaved(true);
      setStatus(\`已保存 \${selected.length} 道题，AI 正在后台按局域网规则整理\`);
      setBatchProgress('');
      setMobileStep('success');
    } catch (error) {
      setDialogError(error instanceof Error ? \`批量保存失败：\${error.message}\` : '批量保存失败，请重试。');
      setBatchProgress('');
    } finally {
      setSaving(false);
    }
  };

  const cancelPending`;
app = replaceRegex(app, /  const saveBatch = async \(\) => \{[\s\S]*?\n  \};\n\n  const cancelPending/, saveBatch, 'restore LAN batch save');

app = replaceOnce(app,
`  if (materialOpen) {
    return <QuickMaterialComposer onClose={() => setMaterialOpen(false)} onSaved={(message) => { setSaved(true); setStatus(message); }} />;
  }`,
`  if (materialOpen && isMobileCapture) {
    return <QuickMaterialComposer onClose={() => setMaterialOpen(false)} onSaved={(message) => { setSaved(true); setStatus(message); }} />;
  }`,
'mobile composer route only');

app = replaceOnce(app,
`            <button type="button" onClick={() => setMaterialOpen(true)}><FilePlus2 size={15} /><span>速记</span></button>
          </div>
        </div>`,
`          </div>
          <button className="note-drop-quick-entry" type="button" onClick={() => setMaterialOpen(true)}>
            <FilePlus2 size={16} /><span><strong>速记</strong><small>文字 · 图片 · PDF · Word · HTML</small></span>
          </button>
        </div>`,
'prominent desktop quick entry');

app = replaceOnce(app,
`      {hiddenInputs}

      {pendingImage && (`,
`      {hiddenInputs}

      {materialOpen && (
        <div className="note-drop-quick-overlay" role="presentation">
          <QuickMaterialComposer
            onClose={() => setMaterialOpen(false)}
            onSaved={(message) => { setSaved(true); setStatus(message); }}
          />
        </div>
      )}

      {pendingImage && (`,
'embedded quick composer');
fs.writeFileSync(appPath, app, 'utf8');

let mobileCss = fs.readFileSync(mobileCssPath, 'utf8');
if (!mobileCss.includes('/* LAN quick entry restoration */')) {
  mobileCss += `\n\n/* LAN quick entry restoration */
.note-drop-app .note-drop-capture {
  grid-template-rows: minmax(0, 1fr) 27px 34px;
}
.note-drop-quick-entry {
  display: grid;
  min-height: 34px;
  grid-template-columns: 24px minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  border: 1px solid rgba(230, 195, 142, 0.45);
  border-radius: 9px;
  background: rgba(230, 195, 142, 0.17);
  color: rgba(255, 250, 240, 0.96);
  padding: 4px 8px;
  text-align: left;
}
.note-drop-quick-entry > svg { color: var(--dh-gold); }
.note-drop-quick-entry > span { display: grid; min-width: 0; gap: 1px; }
.note-drop-quick-entry strong { font-size: 10px; font-weight: 950; }
.note-drop-quick-entry small { overflow: hidden; color: var(--dh-muted); font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
.note-drop-quick-entry:hover,
.note-drop-quick-entry:focus-visible { background: rgba(230, 195, 142, 0.26); }
.note-drop-quick-overlay {
  position: fixed;
  inset: 0;
  z-index: 30;
  overflow: auto;
  border-radius: 15px;
  background: rgba(53, 39, 29, 0.44);
  backdrop-filter: blur(12px) saturate(0.92);
  padding: 10px;
}
`;
}
fs.writeFileSync(mobileCssPath, mobileCss, 'utf8');

let quickCss = fs.readFileSync(quickCssPath, 'utf8');
if (!quickCss.includes('/* Dunhuang note app embedded composer */')) {
  quickCss += `\n/* Dunhuang note app embedded composer */
.note-drop-quick-overlay .quick-material-composer {
  min-height: 100%;
  border: 1px solid rgba(255,247,226,.2);
  border-radius: 18px;
  background: linear-gradient(145deg,rgba(255,249,232,.12),rgba(20,18,18,.08)),rgba(91,74,60,.97);
  color: rgba(255,250,240,.94);
  overflow: hidden;
}
.note-drop-quick-overlay .quick-material-composer>header { position: static; height: 46px; border-color: rgba(255,247,226,.12); background: rgba(255,248,232,.05); }
.note-drop-quick-overlay .quick-material-composer>header button { color: rgba(255,245,226,.78); }
.note-drop-quick-overlay .quick-material-form { width: 100%; padding: 12px; gap: 11px; }
.note-drop-quick-overlay .quick-material-form label>span,
.note-drop-quick-overlay .quick-material-files>div>span,
.note-drop-quick-overlay .quick-material-form legend { color: rgba(255,250,240,.92); font-size: 12px; }
.note-drop-quick-overlay .quick-material-form small { color: rgba(255,245,226,.6); }
.note-drop-quick-overlay .quick-material-form input,
.note-drop-quick-overlay .quick-material-form textarea,
.note-drop-quick-overlay .quick-material-form select,
.note-drop-quick-overlay .quick-material-files { border-color: rgba(255,247,226,.16); background: rgba(255,248,232,.07); color: rgba(255,250,240,.94); }
.note-drop-quick-overlay .quick-material-form textarea { min-height: 92px; }
.note-drop-quick-overlay .quick-material-form option { color: #2d2724; }
.note-drop-quick-overlay .quick-material-facets button,
.note-drop-quick-overlay .quick-material-files>button,
.note-drop-quick-overlay .quick-material-form>footer button { border-color: rgba(255,247,226,.16); background: rgba(255,248,232,.07); color: rgba(255,250,240,.88); }
.note-drop-quick-overlay .quick-material-facets button.active,
.note-drop-quick-overlay .quick-material-form>footer .primary { border-color: rgba(230,195,142,.48); background: rgba(230,195,142,.22); color: #fffaf0; }
.note-drop-quick-overlay .quick-material-files li { background: rgba(34,28,25,.24); }
`;
}
fs.writeFileSync(quickCssPath, quickCss, 'utf8');

let center = fs.readFileSync(learningCenterPath, 'utf8');
center = center.replace("type CenterView = 'review' | 'mistakes' | 'good' | 'memory' | 'quick' | 'library' | 'uncategorized' | 'inbox' | 'weekly';", "type CenterView = 'review' | 'mistakes' | 'good' | 'memory' | 'quick' | 'library' | 'inbox' | 'weekly';");
center = center.replace(" || requested === 'uncategorized'", '');
center = replaceRegex(center, /  const uncategorizedNotes = useMemo\([\s\S]*?\n  \)\), \[indexedNotes\]\);\n/, '', 'remove uncategorized notes');
center = center.replace("  const visibleUncategorized = useMemo(() => rankNotesForQuery(uncategorizedNotes, query), [query, uncategorizedNotes]);\n", '');
center = replaceOnce(center,
`    : view === 'quick'
        ? visibleQuick
        : view === 'uncategorized'
          ? visibleUncategorized
        : visibleLibrary;`,
`    : view === 'quick'
        ? visibleQuick
        : visibleLibrary;`,
'remove uncategorized selection');
center = replaceRegex(center, /\n  const renderUncategorized = \(\) => \([\s\S]*?\n  \);\n\n  const renderInbox/, '\n  const renderInbox', 'remove ordinary notes renderer');
center = center.replace("    { id: 'uncategorized', label: '普通笔记', icon: ClipboardCheck, count: uncategorizedNotes.length },\n", '');
center = center.replace("        {view === 'uncategorized' && renderUncategorized()}\n", '');
fs.writeFileSync(learningCenterPath, center, 'utf8');

fs.writeFileSync(testPath, `'use strict';\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst root = path.join(__dirname, '..');\nconst app = fs.readFileSync(path.join(root, 'src/components/NoteDropApp.tsx'), 'utf8');\nconst center = fs.readFileSync(path.join(root, 'src/components/LearningCenter.tsx'), 'utf8');\nconst mobileCss = fs.readFileSync(path.join(root, 'src/note-drop-mobile.css'), 'utf8');\nconst quickCss = fs.readFileSync(path.join(root, 'src/quick-material-composer.css'), 'utf8');\nconst assert = require('node:assert/strict');\nassert.match(app, /if \(!IS_CLOUD_RUNTIME\) return undefined;[\\s\\S]*installCaptureUploadResumer/);\nassert.match(app, /if \(IS_CLOUD_RUNTIME\) \{[\\s\\S]*enqueueCaptureUpload\(\[payload\]\)[\\s\\S]*return;[\\s\\S]*saveImageReliably\(payload/);\nassert.match(app, /className=\"note-drop-quick-entry\"[\\s\\S]*<strong>速记<\\/strong>/);\nassert.match(app, /className=\"note-drop-quick-overlay\"/);\nassert.doesNotMatch(center, /label: '普通笔记'/);\nassert.doesNotMatch(center, /view === 'uncategorized'/);\nassert.match(mobileCss, /LAN quick entry restoration/);\nassert.match(quickCss, /Dunhuang note app embedded composer/);\nconsole.log('LAN note app, quick entry and default-folder navigation checks passed.');\n`, 'utf8');

console.log('Integrated LAN note app restoration patch applied.');
