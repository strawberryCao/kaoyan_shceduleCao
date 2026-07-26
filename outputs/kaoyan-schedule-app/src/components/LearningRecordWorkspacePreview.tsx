import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowLeft,
  Download,
  File,
  FileCode2,
  FileDown,
  FileImage,
  FileText,
  LayoutGrid,
  Lock,
  Printer,
  RotateCcw,
  Unlock,
  X,
} from 'lucide-react';
import type { LearningAttachment, LearningAutoNote, LearningDataSnapshot } from '../utils/learningData';
import {
  fetchLearningData,
  readLearningDataCache,
  subscribeLearningDataCache,
  subscribeLearningDataFromServer,
  subscribeLearningDataPolling,
} from '../utils/learningData';
import {
  exportWorkspaceDocx,
  exportWorkspacePdf,
  type WorkspaceExportAsset,
} from '../utils/workspaceExport';
import { IS_CLOUD_RUNTIME, NOTE_SERVER_URL } from '../utils/notes';
import '../learning-record-workspace-preview.css';

type AssetKind = 'image' | 'pdf' | 'word' | 'html' | 'file';
type Asset = LearningAttachment & {
  kind: AssetKind;
  label: string;
  url: string;
  previewUrl: string;
  posterUrl: string;
  sizeLabel: string;
};
type FloatingAsset = {
  id: string;
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  locked: boolean;
};
type Bounds = { width: number; height: number; left: number; top: number; bottom: number };

const KIND_SIZE: Record<AssetKind, [number, number]> = {
  image: [430, 300],
  pdf: [390, 440],
  word: [380, 400],
  html: [420, 320],
  file: [340, 260],
};
const GAP = 12;
const MIN_W = 220;
const MIN_H = 160;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const noteFileUrl = (filePath: string, preview = false) => (
  `${NOTE_SERVER_URL}/note-file?path=${encodeURIComponent(filePath)}${preview ? '&preview=1' : ''}`
);
const overlap = (a: FloatingAsset, b: FloatingAsset) => !(
  a.x + a.width + GAP <= b.x || b.x + b.width + GAP <= a.x
  || a.y + a.height + GAP <= b.y || b.y + b.height + GAP <= a.y
);

const formatBytes = (size: number | null): string => {
  if (!size || size < 1) return '大小未知';
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
};

const attachmentLabel = (kind: AssetKind): string => {
  if (kind === 'image') return 'IMG';
  if (kind === 'pdf') return 'PDF';
  if (kind === 'word') return 'DOC';
  if (kind === 'html') return 'HTML';
  return 'FILE';
};

const locateNote = (snapshot: LearningDataSnapshot, noteUid: string): LearningAutoNote | null => {
  for (const day of Object.values(snapshot.days)) {
    const note = day.autoNotes.find((item) => item.noteUid === noteUid);
    if (note) return note;
  }
  return null;
};

function boundsOf(node: HTMLElement): Bounds {
  const compact = node.clientWidth < 820;
  return {
    width: node.clientWidth,
    height: node.clientHeight,
    left: compact ? GAP : Math.min(330, Math.max(270, node.clientWidth * 0.22)),
    top: compact ? 72 : 78,
    bottom: compact ? 72 : 18,
  };
}

function findSlot(item: FloatingAsset, placed: FloatingAsset[], bounds: Bounds): FloatingAsset {
  let width = Math.min(item.width, Math.max(MIN_W, bounds.width - bounds.left - GAP * 2));
  let height = Math.min(item.height, Math.max(MIN_H, bounds.height - bounds.top - bounds.bottom - GAP));
  for (let shrink = 0; shrink < 5; shrink += 1) {
    const maxX = Math.max(bounds.left, bounds.width - width - GAP);
    const maxY = Math.max(bounds.top, bounds.height - height - bounds.bottom);
    for (let y = bounds.top; y <= maxY; y += Math.max(90, height + GAP)) {
      for (let x = bounds.left; x <= maxX; x += Math.max(110, width + GAP)) {
        const candidate = { ...item, x, y, width, height };
        if (!placed.some((other) => overlap(candidate, other))) return candidate;
      }
    }
    width = Math.max(MIN_W, Math.round(width * 0.87));
    height = Math.max(MIN_H, Math.round(height * 0.87));
  }
  return {
    ...item,
    x: clamp(item.x, bounds.left, Math.max(bounds.left, bounds.width - width - GAP)),
    y: clamp(item.y, bounds.top, Math.max(bounds.top, bounds.height - height - bounds.bottom)),
    width,
    height,
  };
}

function pack(items: FloatingAsset[], bounds: Bounds): FloatingAsset[] {
  const result: FloatingAsset[] = [];
  [...items].sort((a, b) => a.z - b.z).forEach((item) => result.push(findSlot(item, result, bounds)));
  return result;
}

function AssetGlyph({ kind }: { kind: AssetKind }) {
  if (kind === 'image') return <FileImage size={22} />;
  if (kind === 'html') return <FileCode2 size={22} />;
  if (kind === 'file') return <File size={22} />;
  return <FileText size={22} />;
}

function SafeHtmlPreview({ item }: { item: Asset }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    setHtml('');
    setError('');
    void fetch(item.url, { signal: abort.signal, credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTML 读取失败（${response.status}）`);
        const value = await response.text();
        setHtml(value.slice(0, 4 * 1024 * 1024));
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'HTML 读取失败');
      });
    return () => abort.abort();
  }, [item.url]);
  if (error) {
    return (
      <div className="lrp-preview-error">
        <FileCode2 size={28} />
        <strong>{error}</strong>
        <a href={item.url} download={item.name}>下载原文件</a>
      </div>
    );
  }
  if (!html) return <div className="lrp-preview-loading">正在安全读取 HTML…</div>;
  return <iframe className="lrp-document-frame" sandbox="" srcDoc={html} title={item.name} />;
}

function AssetPreview({ item }: { item: Asset }) {
  if (item.kind === 'image') {
    return <img className="lrp-real-image" src={item.url} alt={item.name} draggable={false} />;
  }
  if (item.kind === 'pdf') {
    return <iframe className="lrp-document-frame" src={item.previewUrl} title={item.name} />;
  }
  if (item.kind === 'html') return <SafeHtmlPreview item={item} />;
  if (item.posterUrl) {
    return <img className="lrp-real-image lrp-preview-poster" src={item.posterUrl} alt={`${item.name}预览`} draggable={false} />;
  }
  return (
    <article className={`lrp-file-preview is-${item.kind}`}>
      <span><AssetGlyph kind={item.kind} /></span>
      <small>{item.label} · {item.sizeLabel}</small>
      <h2>{item.name}</h2>
      <p>{item.kind === 'word'
        ? '当前资料没有生成预览图，可下载后使用 Word 继续阅读和编辑。'
        : '该资料不支持内嵌预览，可下载到本机打开。'}</p>
      <a href={item.url} download={item.name}><Download size={16} />打开 / 下载</a>
    </article>
  );
}

export function LearningRecordWorkspacePreview({ noteUid }: { noteUid: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [snapshot, setSnapshot] = useState<LearningDataSnapshot>(() => readLearningDataCache());
  const [loadError, setLoadError] = useState('');
  const [activeId, setActiveId] = useState('');
  const [floating, setFloating] = useState<FloatingAsset[]>([]);
  const [compact, setCompact] = useState(() => window.innerWidth < 820);
  const [exporting, setExporting] = useState<'docx' | 'pdf' | ''>('');
  const [actionError, setActionError] = useState('');
  const note = useMemo(() => locateNote(snapshot, noteUid), [noteUid, snapshot]);
  const assets = useMemo<Asset[]>(() => {
    if (!note) return [];
    const source = note.attachments.length > 0
      ? note.attachments
      : note.filePath ? [{
          id: 'legacy-primary',
          kind: 'image' as const,
          name: note.title || '原图',
          mimeType: 'image/jpeg',
          size: null,
          filePath: note.filePath,
          previewPath: '',
          posterPath: '',
          createdAt: note.createdAt,
        }] : [];
    return source.map((attachment) => {
      const kind: AssetKind = ['image', 'pdf', 'word', 'html'].includes(attachment.kind)
        ? attachment.kind as AssetKind
        : 'file';
      return {
        ...attachment,
        kind,
        label: attachmentLabel(kind),
        url: noteFileUrl(attachment.filePath),
        previewUrl: noteFileUrl(attachment.filePath, kind === 'pdf'),
        posterUrl: attachment.posterPath
          ? noteFileUrl(attachment.posterPath)
          : attachment.previewPath ? noteFileUrl(attachment.previewPath) : '',
        sizeLabel: formatBytes(attachment.size),
      };
    });
  }, [note]);
  const activeAsset = assets.find((item) => item.id === activeId) || assets[0] || null;
  const assetKey = assets.map((item) => item.id).join('\u001f');
  const exportAssets = useMemo<WorkspaceExportAsset[]>(() => assets.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    url: item.url,
    sizeLabel: item.sizeLabel,
  })), [assets]);

  useEffect(() => {
    const abort = new AbortController();
    const releaseCache = subscribeLearningDataCache(setSnapshot);
    const releaseServer = IS_CLOUD_RUNTIME ? subscribeLearningDataPolling() : subscribeLearningDataFromServer();
    void fetchLearningData(abort.signal)
      .then((next) => { setSnapshot(next); setLoadError(''); })
      .catch((error) => setLoadError(error instanceof Error ? error.message : '学习数据加载失败'));
    return () => {
      abort.abort();
      releaseCache();
      releaseServer();
    };
  }, []);

  useEffect(() => {
    const validIds = new Set(assetKey ? assetKey.split('\u001f') : []);
    setActiveId((current) => validIds.has(current) ? current : assets[0]?.id || '');
    setFloating((current) => current.filter((item) => validIds.has(item.assetId)));
  }, [assetKey, assets]);

  useEffect(() => {
    const resize = () => {
      const nextCompact = window.innerWidth < 820;
      setCompact(nextCompact);
      const root = rootRef.current;
      if (root) setFloating((current) => nextCompact ? [] : pack(current, boundsOf(root)));
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const returnToLearningCenter = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('workspaceNote');
    url.searchParams.set('panel', 'learning');
    window.location.assign(url.toString());
  };

  const spawn = (item: Asset, clientX: number, clientY: number) => {
    const root = rootRef.current;
    if (!root || compact) {
      setActiveId(item.id);
      return;
    }
    const rect = root.getBoundingClientRect();
    const bounds = boundsOf(root);
    setFloating((current) => {
      const [baseW, baseH] = KIND_SIZE[item.kind];
      const scale = Math.max(0.68, 1 - current.length * 0.07);
      const next: FloatingAsset = {
        id: `${item.id}-${Date.now()}`,
        assetId: item.id,
        x: clientX - rect.left - baseW / 2,
        y: clientY - rect.top - 24,
        width: Math.round(baseW * scale),
        height: Math.round(baseH * scale),
        z: current.reduce((max, value) => Math.max(max, value.z), 20) + 1,
        locked: false,
      };
      return pack([...current, next], bounds);
    });
  };

  const spawnAll = () => {
    const root = rootRef.current;
    if (!root || compact) return;
    const bounds = boundsOf(root);
    const items = assets.map((asset, index) => {
      const [width, height] = KIND_SIZE[asset.kind];
      return {
        id: `all-${asset.id}`,
        assetId: asset.id,
        x: bounds.left,
        y: bounds.top,
        width,
        height,
        z: 30 + index,
        locked: false,
      };
    });
    setFloating(pack(items, bounds));
  };

  const arrangeFloating = () => {
    const root = rootRef.current;
    if (root) setFloating((current) => pack(current, boundsOf(root)));
  };

  const beginDetach = (event: ReactPointerEvent<HTMLButtonElement>, item: Asset) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const move = (next: PointerEvent) => {
      if (Math.hypot(next.clientX - startX, next.clientY - startY) > 8) moved = true;
    };
    const up = (next: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      if (moved) spawn(item, next.clientX, next.clientY);
      else setActiveId(item.id);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const startMove = (event: ReactPointerEvent<HTMLElement>, item: FloatingAsset, resize = false) => {
    event.preventDefault();
    event.stopPropagation();
    if (item.locked) return;
    const root = rootRef.current;
    if (!root) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const bounds = boundsOf(root);
    const move = (next: PointerEvent) => {
      setFloating((current) => current.map((value) => {
        if (value.id !== item.id) return value;
        const dx = next.clientX - startX;
        const dy = next.clientY - startY;
        if (resize) {
          return {
            ...value,
            width: clamp(item.width + dx, MIN_W, Math.max(MIN_W, bounds.width - value.x - GAP)),
            height: clamp(item.height + dy, MIN_H, Math.max(MIN_H, bounds.height - value.y - bounds.bottom)),
          };
        }
        return {
          ...value,
          x: clamp(item.x + dx, bounds.left, Math.max(bounds.left, bounds.width - value.width - GAP)),
          y: clamp(item.y + dy, bounds.top, Math.max(bounds.top, bounds.height - value.height - bounds.bottom)),
        };
      }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      setFloating((current) => pack(current, bounds));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const exportDocx = async () => {
    if (!note || exporting) return;
    setExporting('docx');
    setActionError('');
    try {
      await exportWorkspaceDocx(note, exportAssets);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'DOCX 导出失败');
    } finally {
      setExporting('');
    }
  };

  const exportPdf = () => {
    if (!note || exporting) return;
    setExporting('pdf');
    setActionError('');
    try {
      exportWorkspacePdf(note, exportAssets);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'PDF 导出失败');
    } finally {
      setExporting('');
    }
  };

  if (!note) {
    return (
      <main className="lrp-root lrp-state-page">
        <FileText size={38} />
        <h1>没有找到这条学习记录</h1>
        <p>{loadError || '记录可能已删除，或学习数据尚未同步。'}</p>
        <button type="button" onClick={returnToLearningCenter}><ArrowLeft size={17} />返回学习中心</button>
      </main>
    );
  }

  return (
    <main className="lrp-root" ref={rootRef}>
      <header className="lrp-topbar">
        <button type="button" onClick={returnToLearningCenter}><ArrowLeft size={18} />返回</button>
        <div className="lrp-topbar-title">
          <strong>{note.title || '未命名学习记录'}</strong>
          <small>{note.subject} · {assets.length} 个资料</small>
        </div>
        <div className="lrp-topbar-actions">
          {!compact && assets.length > 0 && (
            <button type="button" onClick={spawnAll}><LayoutGrid size={15} />全部展开</button>
          )}
          <button type="button" disabled={Boolean(exporting)} onClick={exportPdf}>
            <Printer size={15} />{exporting === 'pdf' ? '生成中' : 'PDF'}
          </button>
          <button type="button" disabled={Boolean(exporting)} onClick={() => void exportDocx()}>
            <FileDown size={15} />{exporting === 'docx' ? '生成中' : 'DOCX'}
          </button>
          {activeAsset && <a href={activeAsset.url} download={activeAsset.name}><Download size={15} />下载当前</a>}
        </div>
      </header>

      {actionError && <div className="lrp-action-error" role="alert">{actionError}</div>}

      <section className="lrp-workspace">
        <aside className="lrp-record-panel">
          <div className="lrp-record-copy">
            <span>{note.facets.length > 0 ? note.facets.join(' · ') : note.noteType || '学习记录'}</span>
            <h1>{note.title || '未命名学习记录'}</h1>
            {note.remark && <p>{note.remark}</p>}
            <div>{note.tags.map((tag) => <em key={tag}>{tag}</em>)}</div>
          </div>
          <div className="lrp-asset-list">
            <header><strong>资料</strong><span>{assets.length}</span></header>
            {assets.length === 0 ? <p>这条记录暂时没有附件。</p> : assets.map((item) => (
              <button
                className={activeAsset?.id === item.id ? 'active' : ''}
                key={item.id}
                type="button"
                onPointerDown={(event) => beginDetach(event, item)}
              >
                <b>{item.label}</b>
                <span><strong>{item.name}</strong><small>{item.sizeLabel}</small></span>
              </button>
            ))}
          </div>
        </aside>

        <article className="lrp-reading-panel">
          {activeAsset ? (
            <>
              <header>
                <div><strong>{activeAsset.name}</strong><small>{activeAsset.label} · {activeAsset.sizeLabel}</small></div>
                <a href={activeAsset.url} download={activeAsset.name}><Download size={15} />下载</a>
              </header>
              <section><AssetPreview item={activeAsset} /></section>
              <p className="lrp-hint">电脑端按住左侧资料拖到空白处，可并排阅读；浮窗支持锁定、移动、缩放和自动避让。移动端保持单资料阅读。</p>
            </>
          ) : (
            <div className="lrp-empty"><File size={32} /><strong>暂无可阅读资料</strong><p>纯文字速记仍保留在左侧记录说明中。</p></div>
          )}
        </article>
      </section>

      {!compact && floating.length > 0 && (
        <div className="lrp-floating-toolbar">
          <button type="button" onClick={arrangeFloating}><LayoutGrid size={14} />自动排列</button>
          <button type="button" onClick={() => setFloating([])}><RotateCcw size={14} />全部收回</button>
        </div>
      )}

      {!compact && (
        <div className="lrp-floating">
          {floating.map((item) => {
            const current = assets.find((asset) => asset.id === item.assetId);
            if (!current) return null;
            return (
              <section
                className={`lrp-float ${current.kind} ${item.locked ? 'is-locked' : ''}`}
                key={item.id}
                style={{ left: item.x, top: item.y, width: item.width, height: item.height, zIndex: item.z }}
                onPointerDown={() => setFloating((values) => values.map((value) => value.id === item.id
                  ? { ...value, z: Math.max(...values.map((entry) => entry.z), 20) + 1 }
                  : value))}
              >
                <header onPointerDown={(event) => startMove(event, item)}>
                  <strong>{current.name}</strong>
                  <button
                    type="button"
                    aria-label={item.locked ? '解除锁定' : '锁定资料窗'}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => setFloating((values) => values.map((value) => value.id === item.id
                      ? { ...value, locked: !value.locked }
                      : value))}
                  >{item.locked ? <Lock size={12} /> : <Unlock size={12} />}</button>
                  <button
                    type="button"
                    aria-label="收回资料窗"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => setFloating((values) => values.filter((value) => value.id !== item.id))}
                  ><X size={13} /></button>
                </header>
                <div><AssetPreview item={current} /></div>
                {!item.locked && <button type="button" aria-label="调整大小" onPointerDown={(event) => startMove(event, item, true)} />}
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
