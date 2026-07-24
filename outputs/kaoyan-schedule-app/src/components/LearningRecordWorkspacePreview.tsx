import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import '../learning-record-workspace-preview.css';

type AssetKind = 'image' | 'pdf' | 'word' | 'html';
type LinkedKind = '错题' | '好题' | '知识' | '背诵';
type Asset = { id: string; kind: AssetKind; label: string; name: string; size: string };
type FloatingAsset = { id: string; assetId: string; x: number; y: number; width: number; height: number; z: number };

type Bounds = { width: number; height: number; left: number; top: number; bottom: number };

const ASSETS: Asset[] = [
  { id: 'img', kind: 'image', label: 'IMG', name: '函数图像标注.png', size: '1.4 MB' },
  { id: 'pdf', kind: 'pdf', label: 'PDF', name: '导数完整推导.pdf', size: '2.8 MB' },
  { id: 'doc', kind: 'word', label: 'DOC', name: '导数复习讲义.docx', size: '186 KB' },
  { id: 'html', kind: 'html', label: 'HTML', name: '参数变化可视化.html', size: '42 KB' },
  { id: 'img2', kind: 'image', label: 'IMG', name: '课堂板书补充.jpg', size: '986 KB' },
  { id: 'pdf2', kind: 'pdf', label: 'PDF', name: '错题解析补充.pdf', size: '1.9 MB' },
  { id: 'doc2', kind: 'word', label: 'DOC', name: '考点清单.docx', size: '94 KB' },
  { id: 'html2', kind: 'html', label: 'HTML', name: '曲率动态演示.html', size: '58 KB' },
];

const KIND_SIZE: Record<AssetKind, [number, number]> = {
  image: [400, 280], pdf: [330, 430], word: [360, 430], html: [390, 280],
};

const GAP = 12;
const MIN_W = 220;
const MIN_H = 160;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const asset = (id: string) => ASSETS.find((item) => item.id === id) ?? ASSETS[0];
const overlap = (a: FloatingAsset, b: FloatingAsset) => !(
  a.x + a.width + GAP <= b.x || b.x + b.width + GAP <= a.x
  || a.y + a.height + GAP <= b.y || b.y + b.height + GAP <= a.y
);

function boundsOf(node: HTMLElement): Bounds {
  const compact = node.clientWidth < 820;
  return {
    width: node.clientWidth,
    height: node.clientHeight,
    left: compact ? GAP : Math.min(350, Math.max(292, node.clientWidth * 0.23)),
    top: compact ? 72 : 116,
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

function AssetPreview({ item }: { item: Asset }) {
  if (item.kind === 'image') return (
    <svg className="lrp-graphic" viewBox="0 0 680 420" aria-label="导数与函数图像关系示意图">
      <rect width="680" height="420" rx="12" fill="#fffdf8" />
      <path d="M75 360H620M120 385V45" stroke="#45484b" strokeWidth="3" />
      <path d="M135 330 C210 300 230 120 320 115 C410 110 435 315 590 75" fill="none" stroke="#95612f" strokeWidth="5" />
      <circle cx="320" cy="115" r="7" fill="#a14239" /><circle cx="435" cy="248" r="7" fill="#315d72" />
      <text x="335" y="95" fill="#a14239" fontSize="19">极值点</text><text x="450" y="272" fill="#315d72" fontSize="19">拐点</text>
    </svg>
  );
  if (item.kind === 'html') return (
    <section className="lrp-html"><header><strong>参数变化可视化</strong><span>HTML 沙箱</span></header><div>{[32, 58, 44, 80, 62].map((h) => <i key={h} style={{ height: `${h}%` }} />)}</div></section>
  );
  return (
    <article className="lrp-document"><h2>{item.kind === 'pdf' ? '闭区间连续函数的性质' : '导数图像复习讲义'}</h2><p>设函数 f(x) 在闭区间 [a,b] 上连续，则函数有界并能够取得最大值与最小值。</p><strong>m ≤ f(x) ≤ M</strong><p>{item.kind === 'pdf' ? 'PDF 保留原始分页和页码定位。' : 'Word 保留讲义结构、图片、公式和批注。'}</p></article>
  );
}

export function LearningRecordWorkspacePreview() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [surface, setSurface] = useState<'learning' | 'noteApp'>('learning');
  const [activeId, setActiveId] = useState('img');
  const [floating, setFloating] = useState<FloatingAsset[]>([]);
  const [linked, setLinked] = useState<LinkedKind[]>(['知识']);
  const [allOpen, setAllOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [compact, setCompact] = useState(window.innerWidth < 820);
  const visible = useMemo(() => ASSETS.slice(0, compact ? 2 : 4), [compact]);

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

  const spawn = (item: Asset, clientX: number, clientY: number) => {
    const root = rootRef.current;
    if (!root || compact) return setActiveId(item.id);
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
      };
      return pack([...current, next], bounds);
    });
  };

  const beginDetach = (event: ReactPointerEvent<HTMLButtonElement>, item: Asset) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const move = (next: PointerEvent) => { if (Math.hypot(next.clientX - startX, next.clientY - startY) > 8) moved = true; };
    const up = (next: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      if (moved) spawn(item, next.clientX, next.clientY); else setActiveId(item.id);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const startMove = (event: ReactPointerEvent<HTMLElement>, item: FloatingAsset, resize = false) => {
    event.preventDefault();
    event.stopPropagation();
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
        if (resize) return {
          ...value,
          width: clamp(item.width + dx, MIN_W, Math.max(MIN_W, bounds.width - value.x - GAP)),
          height: clamp(item.height + dy, MIN_H, Math.max(MIN_H, bounds.height - value.y - bounds.bottom)),
        };
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

  const toggleLink = (kind: LinkedKind) => setLinked((current) => current.includes(kind) ? current.filter((value) => value !== kind) : [...current, kind]);

  return (
    <main className="lrp-root" ref={rootRef}>
      <header className="lrp-switch"><strong>速记多资料工作流</strong><nav><button className={surface === 'learning' ? 'active' : ''} onClick={() => setSurface('learning')}>学习中心</button><button className={surface === 'noteApp' ? 'active' : ''} onClick={() => setSurface('noteApp')}>Electron 小 App</button></nav></header>

      {surface === 'noteApp' ? (
        <section className="lrp-note-scene">
          <article className="lrp-note-card"><header><strong>笔记小 App</strong><button onClick={() => setQuickOpen(!quickOpen)}>速记</button><button>−</button><button>×</button></header><button className="lrp-drop"><b>＋</b><span><strong>拖入学习资料</strong><small>图片 / PDF / Word / HTML，可多选</small></span></button></article>
          {quickOpen && <aside className="lrp-quick"><textarea autoFocus placeholder="直接写下刚想到的内容……" /><footer><button onClick={() => setQuickOpen(false)}>取消</button><button>保存速记</button></footer></aside>}
          <div className="lrp-note-copy"><h1>小 App 只保留必要操作</h1><p>电脑学习中心负责复杂资料整理；移动端和小 App 的速记始终保持一步保存。</p></div>
        </section>
      ) : (
        <section className="lrp-learning">
          <nav className="lrp-tabs">{['今日复习', '错题', '好题', '背诵', '知识', '速记', '待确认', '周复盘'].map((label) => <button className={label === '速记' ? 'active' : ''} key={label}>{label}</button>)}</nav>
          <div className="lrp-layout">
            <aside className="lrp-list"><header><input placeholder="搜索标题、正文、附件名称…" /><button>＋ 新建</button></header><div className="lrp-filters"><button className="active">全部速记</button><button>含附件</button><button>已关联</button></div><strong>高等数学 <span>17</span></strong>{['导数与图像关系整理', '反函数二阶导变量混淆', '复杂极限识别顺序速记'].map((title, index) => <button className={index === 0 ? 'active' : ''} key={title}><b>记</b><span><strong>{title}</strong><small>{index === 0 ? '8 个附件 · 今天更新' : '资料记录 · 昨天'}</small></span></button>)}</aside>
            <article className="lrp-detail"><header><div><h1>速记：导数与图像关系整理</h1><p>8 个附件 · 同一条记录 · 最近更新 7月24日 14:08</p></div><div><button>编辑</button><span className="lrp-anchor"><button onClick={() => setLinkOpen(!linkOpen)}>加入栏目 ▾</button>{linkOpen && <i>{(['错题', '好题', '知识', '背诵'] as LinkedKind[]).map((kind) => <button className={linked.includes(kind) ? 'active' : ''} key={kind} onClick={() => toggleLink(kind)}><span>{kind}</span><small>{linked.includes(kind) ? '已关联' : '点击关联'}</small></button>)}</i>}</span><button className="primary">＋ 添加附件</button></div></header><div className="lrp-tags"><span>速记</span><span>高等数学</span><span>导数应用</span>{linked.map((kind) => <span key={kind}>已关联：{kind}</span>)}</div>
              <section className="lrp-assets"><strong>资料</strong><div>{visible.map((item) => <button className={activeId === item.id ? 'active' : ''} key={item.id} onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => beginDetach(event, item)}><b>{item.label}</b><span>{item.name}</span></button>)}</div><span className="lrp-anchor"><button onClick={() => setAllOpen(!allOpen)}>全部 8 ▾</button>{allOpen && <i>{ASSETS.map((item) => <button key={item.id} onClick={() => { setActiveId(item.id); setAllOpen(false); }}><b>{item.label}</b><span><strong>{item.name}</strong><small>{item.size}</small></span></button>)}</i>}</span></section>
              <p className="lrp-hint">电脑端按住附件拖到屏幕空白处：自动缩放、寻找空位并避开其他资料；移动端只切换阅读。</p><div className="lrp-reader"><section><AssetPreview item={asset(activeId)} /></section><aside><div><h2>核心理解</h2><p>图片用于快速回忆，PDF 保存完整推导，Word 保存讲义，HTML 用于交互观察参数变化。</p></div><div><h2>已关联栏目</h2><p>{linked.join(' · ') || '暂未关联'}</p></div></aside></div>
            </article>
          </div>
        </section>
      )}

      {!compact && surface === 'learning' && <div className="lrp-floating">{floating.map((item) => <section className={`lrp-float ${asset(item.assetId).kind}`} key={item.id} style={{ left: item.x, top: item.y, width: item.width, height: item.height, zIndex: item.z }}><header onPointerDown={(event: ReactPointerEvent<HTMLElement>) => startMove(event, item)}><strong>{asset(item.assetId).name}</strong><button onClick={() => setFloating((current) => current.filter((value) => value.id !== item.id))}>×</button></header><div><AssetPreview item={asset(item.assetId)} /></div><button aria-label="调整大小" onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => startMove(event, item, true)} /></section>)}</div>}
    </main>
  );
}
