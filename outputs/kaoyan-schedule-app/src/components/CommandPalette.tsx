import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpenCheck,
  BrainCircuit,
  CalendarDays,
  Clipboard,
  FileImage,
  Home,
  LayoutDashboard,
  Search,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import { openNoteCaptureApp } from './NoteDock';
import {
  readLearningDataCache,
  subscribeLearningDataCache,
  type LearningDataSnapshot,
} from '../utils/learningData';
import { fuzzySearchScore } from '../utils/fuzzySearch';
import { selectKnowledgeEligibleNotes } from '../utils/noteReview';
import { learningViewForNote } from '../utils/learningNavigation';
import { navigateApp } from '../utils/appNavigation';
import {
  IS_CLOUD_RUNTIME,
  searchLearningRecords,
  type LearningSearchResult,
} from '../utils/notes';

type PaletteCommand = {
  id: string;
  label: string;
  description: string;
  keywords: string;
  icon: typeof Search;
  run: () => void;
  meta?: string;
};

const navigate = (path: string) => {
  navigateApp(path);
};

const pageReferenceText = (pageRefs: Array<{ raw: string; page?: number; question?: string }>) => pageRefs
  .map((item) => item.raw || [item.page ? `p${item.page}` : '', item.question ?? ''].filter(Boolean).join(' '))
  .filter(Boolean)
  .join(' ');

const learningTarget = (input: {
  view: string;
  query: string;
  noteUid?: string;
  cardId?: string;
  searchMode?: 'normal' | 'ai';
}): string => {
  const params = new URLSearchParams({ panel: 'learning', view: input.view });
  if (input.query.trim()) params.set('q', input.query.trim());
  if (input.noteUid) params.set('noteUid', input.noteUid);
  if (input.cardId) params.set('cardId', input.cardId);
  if (input.searchMode === 'ai') params.set('searchMode', 'ai');
  return `?${params.toString()}`;
};

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchMode, setSearchMode] = useState<'normal' | 'ai'>('normal');
  const [semanticResults, setSemanticResults] = useState<LearningSearchResult[]>([]);
  const [semanticState, setSemanticState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [learningData, setLearningData] = useState<LearningDataSnapshot | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const semanticRequestRef = useRef(0);

  useEffect(() => {
    if (!open) {
      setLearningData(null);
      return undefined;
    }
    setLearningData(readLearningDataCache());
    return subscribeLearningDataCache(setLearningData);
  }, [open]);

  const baseCommands = useMemo<PaletteCommand[]>(() => [
    {
      id: 'home',
      label: '回到总览',
      description: '查看今日进度、待复习内容和常用入口',
      keywords: '首页 hub 总览 dashboard',
      icon: Home,
      run: () => navigate('?hub=1'),
    },
    {
      id: 'schedule',
      label: '打开今日课表',
      description: '继续今天的学习任务',
      keywords: '今天 课表 日程 schedule',
      icon: CalendarDays,
      run: () => navigate(''),
    },
    {
      id: 'learning',
      label: '进入学习中心',
      description: '复习到期卡片，搜索历史知识笔记',
      keywords: '复习 背诵 卡片 错题 搜索 知识库 learning',
      icon: BookOpenCheck,
      run: () => navigate('?panel=learning'),
    },
    {
      id: 'note-app',
      label: '打开笔记小 App',
      description: '拖入一张图片并快速写备注',
      keywords: '截图 图片 笔记 小app capture',
      icon: Clipboard,
      run: () => void openNoteCaptureApp(),
    },
    {
      id: 'canvas',
      label: '打开关联画布',
      description: '进入多图、文字和精确批注画布',
      keywords: '画布 多图 批注 canvas',
      icon: Sparkles,
      run: () => navigate('?notes=1&mode=canvas'),
    },
    {
      id: 'console',
      label: '桌面控制台',
      description: '管理桌面组件和笔记小 App',
      keywords: '控制台 组件 console widget',
      icon: LayoutDashboard,
      run: () => navigate('?console=1'),
    },
    {
      id: 'service',
      label: '检查本地服务',
      description: '查看保存服务与 AI 路由状态',
      keywords: '服务 健康 api health',
      icon: Settings,
      run: () => window.open('http://127.0.0.1:5174/health', '_blank', 'noopener,noreferrer'),
    },
    {
      id: 'ai-config',
      label: 'AI 任务配置',
      description: '为命名、分类和生成任务选择模型与自定义规则',
      keywords: 'ai 人工智能 模型 提示词 规则 命名 分类 配置 settings',
      icon: BrainCircuit,
      run: () => navigate('?aiConfig=1'),
    },
  ].filter((command) => (
    !IS_CLOUD_RUNTIME || !['console', 'service', 'ai-config'].includes(command.id)
  )), []);

  const resultCommands = useMemo<PaletteCommand[]>(() => {
    if (!query.trim()) return [];
    const notesByUid = new Map(
      Object.values(learningData?.days ?? {}).flatMap((day) => day.autoNotes).map((note) => [note.noteUid, note]),
    );
    if (searchMode === 'ai') {
      return semanticResults.map((result) => ({
        id: `semantic:${result.noteUid}`,
        label: result.title || '未命名学习记录',
        description: [result.capturedDate, result.subject, result.reason].filter(Boolean).join(' · '),
        keywords: result.matchedTerms.join(' '),
        icon: BrainCircuit,
        meta: 'AI 语义',
        run: () => navigate(learningTarget({
          view: learningViewForNote(notesByUid.get(result.noteUid)),
          query,
          noteUid: result.noteUid,
          searchMode: 'ai',
        })),
      }));
    }
    if (!learningData) return [];
    const results: Array<PaletteCommand & { searchScore: number }> = [];
    const eligibleNotes = selectKnowledgeEligibleNotes(
      Object.values(learningData.days).flatMap((day) => day.autoNotes),
    );
    const eligibleNoteUids = new Set(eligibleNotes.map((note) => note.noteUid));

    learningData.cards.filter((card) => card.status === 'active' && eligibleNoteUids.has(card.noteUid)).forEach((card) => {
      const score = fuzzySearchScore(query, [
        { text: card.front, weight: 10 },
        { text: card.sourceTitle, weight: 8 },
        { text: card.back, weight: 6 },
        { text: card.knowledgePath.join(' '), weight: 7 },
        { text: card.tags.join(' '), weight: 5 },
        { text: card.subject, weight: 4 },
        { text: pageReferenceText(card.pageRefs), weight: 3 },
      ]);
      if (score <= 0) return;
      results.push({
        id: `card:${card.id}`,
        label: card.front || card.sourceTitle || '未命名复习卡',
        description: [card.subject, pageReferenceText(card.pageRefs), card.knowledgePath.join(' / ')].filter(Boolean).join(' · ') || '复习卡片',
        keywords: [card.front, card.back, card.subject, card.sourceTitle].join(' '),
        icon: BookOpenCheck,
        meta: card.kind === 'mistake' ? '错题卡' : '背诵卡',
        run: () => navigate(learningTarget({ view: 'review', query, cardId: card.id })),
        searchScore: score,
      });
    });

    eligibleNotes.forEach((note) => {
      const itemText = note.items.flatMap((item) => [item.title, item.knowledgePoint, item.summary, item.wrongReason, ...item.tags]).join(' ');
      const score = fuzzySearchScore(query, [
        { text: note.title, weight: 10 },
        { text: note.knowledgePath.join(' '), weight: 8 },
        { text: note.wrongReason, weight: 8 },
        { text: note.remark, weight: 7 },
        { text: note.studyNotes.map((thought) => thought.text).join(' '), weight: 7 },
        { text: itemText, weight: 6 },
        { text: note.tags.join(' '), weight: 5 },
        { text: `${note.subject} ${note.questionType}`, weight: 4 },
        { text: `${note.capturedDate} ${pageReferenceText(note.pageRefs)}`, weight: 3 },
      ]);
      if (score <= 0) return;
      results.push({
        id: `note:${note.noteUid}`,
        label: note.title || note.remark || '未命名知识笔记',
        description: [note.capturedDate, note.subject, pageReferenceText(note.pageRefs)].filter(Boolean).join(' · '),
        keywords: [note.title, note.subject, note.remark, itemText].join(' '),
        icon: FileImage,
        meta: '知识笔记',
        run: () => navigate(learningTarget({
          view: learningViewForNote(note),
          query,
          noteUid: note.noteUid,
        })),
        searchScore: score,
      });
    });

    return results.sort((left, right) => right.searchScore - left.searchScore).slice(0, 6);
  }, [learningData, query, searchMode, semanticResults]);

  const visibleCommands = useMemo(() => {
    const filteredBase = query.trim()
      ? baseCommands.map((command) => ({
        command,
        score: fuzzySearchScore(query, [
          { text: command.label, weight: 8 },
          { text: command.description, weight: 4 },
          { text: command.keywords, weight: 5 },
        ]),
      })).filter(({ score }) => score > 0).sort((left, right) => right.score - left.score).map(({ command }) => command)
      : baseCommands;
    if (searchMode === 'ai' && query.trim()) return resultCommands.slice(0, 8);
    return [...resultCommands, ...filteredBase].slice(0, 10);
  }, [baseCommands, query, resultCommands, searchMode]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open, searchMode]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
        return;
      }
      if (!open) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((value) => visibleCommands.length ? (value + 1) % visibleCommands.length : 0);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((value) => visibleCommands.length ? (value - 1 + visibleCommands.length) % visibleCommands.length : 0);
      } else if (event.key === 'Enter' && visibleCommands[activeIndex]) {
        event.preventDefault();
        setOpen(false);
        visibleCommands[activeIndex].run();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, open, visibleCommands]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const close = () => {
    semanticRequestRef.current += 1;
    setOpen(false);
    setQuery('');
    setSearchMode('normal');
    setSemanticResults([]);
    setSemanticState('idle');
  };

  const runSemanticSearch = () => {
    const normalized = query.trim();
    if (!normalized || semanticState === 'loading') return;
    const requestId = semanticRequestRef.current + 1;
    semanticRequestRef.current = requestId;
    setSearchMode('ai');
    setSemanticResults([]);
    setSemanticState('loading');
    void searchLearningRecords(normalized, 'ai', 8).then((response) => {
      if (semanticRequestRef.current !== requestId) return;
      setSemanticResults(response.results || []);
      setSemanticState('ready');
    }).catch(() => {
      if (semanticRequestRef.current !== requestId) return;
      setSemanticResults([]);
      setSemanticState('error');
    });
  };

  return (
    <>
      <button className="command-launcher" type="button" onClick={() => setOpen(true)} aria-label="打开快速操作">
        <Search size={15} />
        <span>快速操作</span>
        <kbd>Ctrl K</kbd>
      </button>

      {open && (
        <div className="command-palette-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}>
          <section className="command-palette" role="dialog" aria-modal="true" aria-label="快速操作与搜索">
            <header>
              <Search size={19} aria-hidden="true" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  semanticRequestRef.current += 1;
                  setQuery(event.target.value);
                  setSearchMode('normal');
                  setSemanticResults([]);
                  setSemanticState('idle');
                }}
                placeholder="搜索页面、卡片、知识点或页码…"
                aria-label="搜索快速操作"
              />
              <button
                className={`command-search-mode${searchMode === 'ai' ? ' is-active' : ''}`}
                type="button"
                aria-pressed={searchMode === 'ai'}
                title="理解语义，查找忘记关键词的资料；每次点击只请求一次"
                onClick={runSemanticSearch}
                disabled={!query.trim() || semanticState === 'loading'}
              >
                <BrainCircuit size={15} />
                <span>{semanticState === 'loading' ? 'AI 搜索中' : 'AI 搜索'}</span>
              </button>
              <button type="button" onClick={close} aria-label="关闭快速操作"><X size={17} /></button>
            </header>

            <div className="command-results" role="listbox" aria-label="快速操作结果">
              {visibleCommands.length > 0 ? visibleCommands.map((command, index) => {
                const Icon = command.icon;
                return (
                  <button
                    key={command.id}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    className={index === activeIndex ? 'is-active' : ''}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => {
                      close();
                      command.run();
                    }}
                  >
                    <span className="command-icon"><Icon size={18} /></span>
                    <span className="command-copy"><strong>{command.label}</strong><span className="command-description">{command.description}</span></span>
                    {command.meta && <em>{command.meta}</em>}
                  </button>
                );
              }) : searchMode === 'ai' && semanticState === 'loading' ? (
                <div className="command-empty"><BrainCircuit size={24} /><strong>正在理解你的意思</strong><span>只查找原始资料，不生成总结。</span></div>
              ) : searchMode === 'ai' && semanticState === 'error' ? (
                <div className="command-empty"><Search size={24} /><strong>AI 搜索暂时不可用</strong><span>切回“普通”仍可立即搜索关键词。</span></div>
              ) : (
                <div className="command-empty"><Search size={24} /><strong>没有匹配内容</strong><span>换一个知识点、页码或功能名称试试。</span></div>
              )}
            </div>

            <footer>
              <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
              <span><kbd>Enter</kbd> 打开</span>
              <span><kbd>Esc</kbd> 关闭</span>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
