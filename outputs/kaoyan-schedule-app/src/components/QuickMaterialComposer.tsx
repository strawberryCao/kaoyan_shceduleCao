import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, FilePlus2, LoaderCircle, Paperclip, Save, Trash2, X } from 'lucide-react';
import { saveLearningMaterial, type LearningRecordFacet } from '../utils/notes';
import { saveLearningDataCache } from '../utils/learningData';
import '../quick-material-composer.css';

const SUBJECTS = ['默认文件夹', '高等数学', '线性代数', '概率论', '英语', '政治', '数据结构', '计算机组成', '操作系统', '计算机网络'];
const FACETS: Array<{ id: LearningRecordFacet; label: string }> = [
  { id: 'quick', label: '速记' },
  { id: 'mistake', label: '错题' },
  { id: 'good', label: '好题' },
  { id: 'memory', label: '背诵' },
  { id: 'knowledge', label: '知识点' },
];
const MAX_FILES = 8;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

interface QuickMaterialComposerProps {
  onClose: () => void;
  onSaved: (message: string) => void;
}

const formatBytes = (bytes: number): string => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function QuickMaterialComposer({ onClose, onSaved }: QuickMaterialComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [remark, setRemark] = useState('');
  const [subject, setSubject] = useState('默认文件夹');
  const [facets, setFacets] = useState<LearningRecordFacet[]>(['quick']);
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const next = [...files];
    for (const file of Array.from(incoming)) {
      if (next.length >= MAX_FILES) break;
      if (file.size > MAX_FILE_BYTES) {
        setError(file.name + ' 超过 8 MB，未加入。');
        continue;
      }
      if (!next.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) next.push(file);
    }
    const size = next.reduce((sum, file) => sum + file.size, 0);
    if (size > MAX_TOTAL_BYTES) {
      setError('全部资料合计不能超过 16 MB。');
      return;
    }
    setFiles(next);
    setError('');
  };

  const toggleFacet = (facet: LearningRecordFacet) => {
    setFacets((current) => current.includes(facet)
      ? current.filter((item) => item !== facet)
      : [...current, facet]);
  };

  const submit = async () => {
    if (saving) return;
    if (!title.trim() && !remark.trim() && files.length === 0) {
      setError('至少写一点文字，或加入一个资料文件。');
      return;
    }
    try {
      setSaving(true);
      setError('');
      const result = await saveLearningMaterial({ title: title.trim(), remark: remark.trim(), subject, facets, files });
      if (result.learningData) saveLearningDataCache(result.learningData);
      setSaved(true);
      onSaved('已保存' + (files.length ? ' · ' + files.length + ' 个资料' : '文字速记'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  };

  if (saved) {
    return (
      <main className="quick-material-composer is-saved">
        <CheckCircle2 size={42} />
        <h1>记录完成</h1>
        <p>文字和资料已经写入学习中心。</p>
        <button className="primary" type="button" onClick={onClose}>返回笔记小 App</button>
      </main>
    );
  }

  return (
    <main className="quick-material-composer">
      <header>
        <button type="button" onClick={onClose} aria-label="返回"><ArrowLeft size={20} /></button>
        <strong>速记</strong>
        <button type="button" onClick={onClose} aria-label="关闭"><X size={20} /></button>
      </header>
      <section className="quick-material-form">
        <label><span>标题 <small>可选</small></span><input value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} placeholder="例如：拉格朗日中值定理的构造思路" /></label>
        <label><span>正文 / 备注 <small>可只写文字</small></span><textarea value={remark} maxLength={8000} onChange={(event) => setRemark(event.target.value)} placeholder="直接记下想法、错因、结论或待解决问题……" /></label>
        <label><span>科目</span><select value={subject} onChange={(event) => setSubject(event.target.value)}>{SUBJECTS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <fieldset><legend>记录身份 <small>可多选</small></legend><div className="quick-material-facets">{FACETS.map((facet) => <button className={facets.includes(facet.id) ? 'active' : ''} key={facet.id} type="button" onClick={() => toggleFacet(facet.id)}>{facet.label}</button>)}</div></fieldset>
        <div className="quick-material-files">
          <div><span>资料附件</span><small>{files.length}/{MAX_FILES} · {formatBytes(totalBytes)}/16 MB</small></div>
          <button type="button" onClick={() => inputRef.current?.click()}><FilePlus2 size={17} />加入图片、PDF、Word、HTML、网页资源或文本</button>
          <input ref={inputRef} type="file" multiple hidden accept="image/*,.pdf,.doc,.docx,.html,.htm,.css,.js,.mjs,.json,.svg,.txt,.md" onChange={(event) => { addFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
          {files.length > 0 && <ul>{files.map((file, index) => <li key={[file.name, file.size, file.lastModified].join(':')}><Paperclip size={15} /><span><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span><button type="button" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={'移除 ' + file.name}><Trash2 size={15} /></button></li>)}</ul>}
        </div>
        {error && <p className="quick-material-error" role="alert">{error}</p>}
        <footer><button type="button" onClick={onClose} disabled={saving}>取消</button><button className="primary" type="button" onClick={() => void submit()} disabled={saving}>{saving ? <LoaderCircle size={17} /> : <Save size={17} />}{saving ? '正在保存…' : '保存到学习中心'}</button></footer>
      </section>
    </main>
  );
}
