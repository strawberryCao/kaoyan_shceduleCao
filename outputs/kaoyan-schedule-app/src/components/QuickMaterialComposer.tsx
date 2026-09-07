import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent as ReactDragEvent } from 'react';
import { ArrowLeft, BookOpenText, CheckCircle2, FilePlus2, LoaderCircle, Paperclip, Plus, Save, Trash2, X } from 'lucide-react';
import { saveLearningMaterial, type LearningRecordFacet } from '../utils/notes';
import {
  fetchLearningData,
  readLearningDataCache,
  saveLearningDataCache,
  subscribeLearningDataCache,
  subscribeLearningDataFromServer,
  type LearningDataSnapshot,
} from '../utils/learningData';
import {
  clearQuickMaterialDraft,
  loadQuickMaterialDraft,
  saveQuickMaterialDraft,
} from '../utils/quickMaterialDraft';
import '../quick-material-composer.css';
import '../quick-material-compact.css';

const SUBJECTS = ['默认文件夹', '高等数学', '线性代数', '概率论', '英语', '政治', '数据结构', '计算机组成', '操作系统', '计算机网络'];
const FACETS: Array<{ id: LearningRecordFacet; label: string }> = [
  { id: 'quick', label: '速记' },
  { id: 'mistake', label: '错题' },
  { id: 'good', label: '好题' },
  { id: 'memory', label: '背诵' },
  { id: 'knowledge', label: '知识点' },
  { id: 'method', label: '方法' },
];
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const fileIdentity = (file: File): string => [file.name, file.size, file.lastModified].join(':');

const mergeFiles = (current: File[], incoming: File[]): { files: File[]; error: string } => {
  const next = [...current];
  let error = '';
  for (const file of incoming) {
    if (file.size > MAX_FILE_BYTES) {
      error = `${file.name} 超过 8 MB，未加入。`;
      continue;
    }
    if (!next.some((item) => fileIdentity(item) === fileIdentity(file))) next.push(file);
  }
  const size = next.reduce((sum, file) => sum + file.size, 0);
  if (size > MAX_TOTAL_BYTES) return { files: current, error: '全部资料合计不能超过 16 MB。' };
  return { files: next, error };
};

interface QuickMaterialComposerProps {
  compact?: boolean;
  desktop?: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}

const formatBytes = (bytes: number): string => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function QuickMaterialComposer({ compact = false, desktop = false, onClose, onSaved }: QuickMaterialComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<File[]>([]);
  const draftHydratedRef = useRef(false);
  const [title, setTitle] = useState('');
  const [remark, setRemark] = useState('');
  const [subject, setSubject] = useState('默认文件夹');
  const [facets, setFacets] = useState<LearningRecordFacet[]>(['quick']);
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [snapshot, setSnapshot] = useState<LearningDataSnapshot>(() => readLearningDataCache());
  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const recentNotes = useMemo(() => Object.entries(snapshot.days)
    .flatMap(([date, day]) => day.autoNotes
      .filter((note) => note.noteType === 'quick' || note.facets.includes('quick') || note.sourceType === 'quick-material' || note.sourceType === 'material-note')
      .map((note) => ({ date: note.capturedDate || date, note })))
    .sort((left, right) => right.note.updatedAt.localeCompare(left.note.updatedAt) || right.date.localeCompare(left.date))
    .slice(0, 12), [snapshot.days]);

  useEffect(() => {
    let active = true;
    void loadQuickMaterialDraft().then((draft) => {
      if (!active || !draft) return;
      setTitle((current) => current || draft.title);
      setRemark((current) => current || draft.remark);
      setSubject((current) => current === '默认文件夹' ? draft.subject || current : current);
      setFacets((current) => current.length === 1 && current[0] === 'quick'
        ? [...new Set(draft.facets.length ? draft.facets : current)]
        : current);
      const restored = mergeFiles(filesRef.current, draft.files);
      filesRef.current = restored.files;
      setFiles(restored.files);
      if (restored.error) setError(restored.error);
    }).finally(() => {
      draftHydratedRef.current = true;
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!draftHydratedRef.current || saved) return undefined;
    const timer = window.setTimeout(() => {
      void saveQuickMaterialDraft({
        version: 1,
        title,
        remark,
        subject,
        facets,
        files: filesRef.current,
        updatedAt: new Date().toISOString(),
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [facets, files, remark, saved, subject, title]);

  useEffect(() => {
    if (!desktop) return undefined;
    const abort = new AbortController();
    const releaseCache = subscribeLearningDataCache(setSnapshot);
    const releaseServer = subscribeLearningDataFromServer();
    void fetchLearningData(abort.signal).then(setSnapshot).catch(() => undefined);
    return () => {
      abort.abort();
      releaseCache();
      releaseServer();
    };
  }, [desktop]);

  const addFiles = (incoming: FileList | File[] | null) => {
    if (!incoming) return;
    const result = mergeFiles(filesRef.current, Array.from(incoming));
    filesRef.current = result.files;
    setFiles(result.files);
    setError(result.error);
  };

  const resetDraft = () => {
    filesRef.current = [];
    setTitle('');
    setRemark('');
    setSubject('默认文件夹');
    setFacets(['quick']);
    setFiles([]);
    setError('');
    void clearQuickMaterialDraft();
  };

  const toggleFacet = (facet: LearningRecordFacet) => {
    setFacets((current) => current.includes(facet)
      ? current.filter((item) => item !== facet)
      : [...current, facet]);
  };

  const receiveDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!desktop) return;
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };

  const receivePaste = (event: ClipboardEvent<HTMLElement>) => {
    if (!desktop) return;
    const pastedFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (pastedFiles.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    addFiles(pastedFiles);
  };

  const submit = async () => {
    if (saving) return;
    const submissionFiles = filesRef.current;
    if (!title.trim() && !remark.trim() && submissionFiles.length === 0) {
      setError('至少写一点文字，或加入一个资料文件。');
      return;
    }
    try {
      setSaving(true);
      setError('');
      const result = await saveLearningMaterial({ title: title.trim(), remark: remark.trim(), subject, facets, files: submissionFiles });
      if (result.learningData) {
        saveLearningDataCache(result.learningData);
        setSnapshot(result.learningData);
      }
      await clearQuickMaterialDraft();
      setSaved(true);
      onSaved(result.sync
        ? `已保存到 Windows 本机${submissionFiles.length ? ` · ${submissionFiles.length} 个资料` : ''}；等待 Mac 同步并统一处理 AI`
        : '已保存' + (submissionFiles.length
          ? ' · ' + submissionFiles.length + ' 个资料，AI 正在后台命名速记和资料'
          : title.trim() ? '文字速记' : ' · AI 正在后台命名文字速记'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  };

  if (saved && !showRecent) {
    return (
      <main className={`quick-material-composer is-saved${desktop ? ' is-desktop note-drop-app' : ''}`}>
        <CheckCircle2 size={42} />
        <h1>记录完成</h1>
        <p>文字和资料已经进入速记日记。</p>
        {desktop && <button className="primary" type="button" onClick={() => setShowRecent(true)}><BookOpenText size={16} />查看刚才的速记</button>}
        <button type="button" onClick={() => {
          setSaved(false);
          resetDraft();
        }}><Plus size={16} />继续速记</button>
      </main>
    );
  }

  if (desktop && showRecent) {
    return (
      <main className="quick-material-composer is-desktop is-recent note-drop-app">
        <header className="note-drop-titlebar">
          <div>
            <span className="note-drop-grip" aria-hidden="true"><i /><i /><i /><i /><i /><i /></span>
            <strong>速记日记</strong>
          </div>
          <nav aria-label="速记记录控制">
            <button type="button" onClick={() => {
              setSaved(false);
              setShowRecent(false);
              resetDraft();
            }} title="新速记"><Plus size={15} /></button>
            <button type="button" onClick={onClose} aria-label="返回图片记题"><ArrowLeft size={15} /></button>
          </nav>
        </header>
        <section className="quick-material-recent">
          <header><div><BookOpenText size={18} /><span><strong>最近速记</strong><small>按时间连续记录，完整资料在学习中心查看</small></span></div></header>
          <div>
            {recentNotes.map(({ date, note }) => (
              <article key={note.noteUid}>
                <div className="quick-recent-note">
                  <span><strong>{note.title || note.remark || '未命名速记'}</strong><small>{date} · {note.attachments.length} 个资料</small></span>
                </div>
                {note.attachments.length > 0 && <div className="quick-recent-assets">{note.attachments.map((attachment) => (
                  <span
                    key={attachment.id}
                  ><b>{attachment.kind === 'image' ? 'IMG' : attachment.kind.toUpperCase()}</b><span>{attachment.name}</span></span>
                ))}</div>}
              </article>
            ))}
            {recentNotes.length === 0 && <p className="quick-recent-empty">还没有速记，点右上角 ＋ 写第一条。</p>}
          </div>
          {error && <p className="quick-material-error" role="alert">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main
      className={`quick-material-composer${compact ? ' is-compact' : ''}${desktop ? ' is-desktop note-drop-app' : ''}${dragging ? ' is-dragging' : ''}`}
      onDragEnter={desktop ? (event) => { event.preventDefault(); setDragging(true); } : undefined}
      onDragOver={desktop ? (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } : undefined}
      onDragLeave={desktop ? (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      } : undefined}
      onDrop={receiveDrop}
      onPaste={desktop ? receivePaste : undefined}
    >
      {desktop ? (
        <header className="note-drop-titlebar">
          <div>
            <span className="note-drop-grip" aria-hidden="true"><i /><i /><i /><i /><i /><i /></span>
            <strong>笔记小 App · 速记</strong>
          </div>
          <nav aria-label="速记模式控制">
            <button type="button" onClick={() => setShowRecent(true)} title="查看速记日记"><BookOpenText size={15} /></button>
            <button type="button" onClick={onClose} aria-label="返回图片记题"><ArrowLeft size={15} /></button>
          </nav>
        </header>
      ) : (
        <header>
          <button type="button" onClick={onClose} aria-label="返回"><ArrowLeft size={20} /></button>
          <strong>速记</strong>
          <button type="button" onClick={onClose} aria-label="关闭"><X size={20} /></button>
        </header>
      )}
      <section className="quick-material-form">
        {!compact && <label><span>标题 <small>可选</small></span><input value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} placeholder="例如：拉格朗日中值定理的构造思路" /></label>}
        <label className="quick-material-page"><span>{desktop ? '速记内容' : compact ? '写下这条速记' : '正文 / 备注'} <small>{desktop ? '标题自动生成' : compact ? '标题会自动生成' : '可只写文字'}</small></span><textarea autoFocus={compact} value={remark} maxLength={8000} onChange={(event) => setRemark(event.target.value)} placeholder={desktop ? '直接写文字，或把资料拖进这个窗口……' : '直接写下想法、结论、错因或待解决问题……'} /></label>
        {!compact && <label><span>科目</span><select value={subject} onChange={(event) => setSubject(event.target.value)}>{SUBJECTS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>}
        {!compact && <fieldset><legend>记录身份 <small>可多选</small></legend><div className="quick-material-facets">{FACETS.map((facet) => <button className={facets.includes(facet.id) ? 'active' : ''} key={facet.id} type="button" onClick={() => toggleFacet(facet.id)}>{facet.label}</button>)}</div></fieldset>}
        <div className={`quick-material-files${compact ? ' is-secondary' : ''}`}>
          <div><span>资料附件</span><small>{files.length} 个 · {formatBytes(totalBytes)}/16 MB</small></div>
          {desktop ? (
            <div
              className="quick-material-drop-target"
              role="note"
              tabIndex={0}
              onClick={(event) => event.currentTarget.focus()}
            >
              <Paperclip size={17} />
              <span>{dragging ? '松手加入资料' : '点击窗口后，按 Ctrl+V 直接粘贴截图'}</span>
              <small>也可拖入 PDF、Word、HTML、图片 · 自动识别类型</small>
            </div>
          ) : (
            <button type="button" onClick={() => inputRef.current?.click()}><FilePlus2 size={17} />{compact ? '拍照或选择附件（可选）' : '加入图片、PDF、Word、HTML、网页资源或文本'}</button>
          )}
          <input ref={inputRef} type="file" multiple hidden accept="image/*,.pdf,.doc,.docx,.html,.htm,.css,.js,.mjs,.json,.svg,.txt,.md" onChange={(event) => { addFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
          {files.length > 0 && <ul>{files.map((file, index) => <li key={fileIdentity(file)}><Paperclip size={15} /><span><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span><button type="button" onClick={() => {
            const next = filesRef.current.filter((_, itemIndex) => itemIndex !== index);
            filesRef.current = next;
            setFiles(next);
          }} aria-label={'移除 ' + file.name}><Trash2 size={15} /></button></li>)}</ul>}
        </div>
        {error && <p className="quick-material-error" role="alert">{error}</p>}
        <footer>{!compact && <button type="button" onClick={onClose} disabled={saving}>取消</button>}<button className="primary" type="button" onClick={() => void submit()} disabled={saving}>{saving ? <LoaderCircle size={17} /> : <Save size={17} />}{saving ? '正在保存…' : compact ? '保存速记' : '保存到学习中心'}</button></footer>
      </section>
    </main>
  );
}
