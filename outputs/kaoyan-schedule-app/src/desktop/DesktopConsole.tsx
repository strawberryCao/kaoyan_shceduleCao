import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppWindow,
  Check,
  ExternalLink,
  LayoutGrid,
  Plus,
  Power,
  RotateCcw,
  Save,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { closeNoteCaptureApp, openNoteCaptureApp, openNoteCaptureAppSilently } from '../components/NoteDock';
import { getDefaultLayout, getWidgetDefinition, WIDGET_DEFINITIONS } from './registry';
import {
  fetchDesktopLayoutFromServer,
  loadDesktopLayout,
  saveDesktopLayoutLocally,
  saveDesktopLayoutToServer,
} from './storage';
import type { WidgetLayout, WidgetType } from './types';
import { DesktopWorkspace } from './DesktopWorkspace';

const AI_WIDGET_URL = 'http://127.0.0.1:5174/ai/widget';

const isNoteAppEnabled = (layout: WidgetLayout[]) => layout.some(
  (widget) => widget.type === 'noteDock' && widget.visible,
);

const syncNoteAppState = (layout: WidgetLayout[]) => {
  if (isNoteAppEnabled(layout)) {
    void openNoteCaptureAppSilently();
  } else {
    void closeNoteCaptureApp();
  }
};

const syncNoteAppTransition = (current: WidgetLayout[], next: WidgetLayout[]) => {
  if (isNoteAppEnabled(current) !== isNoteAppEnabled(next)) {
    syncNoteAppState(next);
  }
};

type AiWidgetResponse = {
  ok?: boolean;
  error?: string;
  model?: string;
  widget?: {
    title?: string;
    width?: number;
    height?: number;
    html?: string;
    css?: string;
    js?: string;
  };
};

interface PendingLayoutSync {
  layout: WidgetLayout[];
  successText: string;
  localSaved: boolean;
  sequence: number;
}

type ConsoleSection = 'layout' | 'add' | 'ai' | 'settings';

const CONSOLE_SECTIONS: Array<{
  value: ConsoleSection;
  label: string;
  icon: typeof LayoutGrid;
}> = [
  { value: 'layout', label: '布局', icon: LayoutGrid },
  { value: 'add', label: '添加', icon: Plus },
  { value: 'ai', label: 'AI 创建', icon: Sparkles },
  { value: 'settings', label: '设置', icon: Settings2 },
];

const createWidget = (
  type: WidgetType,
  index: number,
  overrides?: Partial<Pick<WidgetLayout, 'title' | 'content' | 'width' | 'height'>>,
): WidgetLayout => {
  const definition = getWidgetDefinition(type);
  return {
    id: `${type}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type,
    title: overrides?.title?.trim() || definition.title,
    content: overrides?.content ?? '',
    x: 92 + (index % 7) * 34,
    y: 76 + (index % 7) * 34,
    width: overrides?.width ?? definition.defaultWidth,
    height: overrides?.height ?? definition.defaultHeight,
    visible: true,
    zIndex: 20 + index,
  };
};

const clampDimension = (value: number | undefined, fallback: number, min: number, max: number) => {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value as number)));
};

const conciseSaveStatus = (value: string) => {
  if (/失败|不足/.test(value)) return '保存失败';
  if (/正在|同步最新/.test(value)) return '正在同步';
  if (/暂未同步/.test(value)) return '仅保存在本机';
  if (/读取/.test(value)) return '布局已读取';
  if (/打开|关闭|隐藏|显示|添加|更新|删除/.test(value)) return '布局已更新';
  return '已同步';
};

export function DesktopConsole() {
  const [layout, setLayout] = useState<WidgetLayout[]>(() => loadDesktopLayout());
  const [activeSection, setActiveSection] = useState<ConsoleSection>('layout');
  const [savedText, setSavedText] = useState('布局已从本机读取，拖动后会实时同步');
  const [customTitle, setCustomTitle] = useState('');
  const [customContent, setCustomContent] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiStatus, setAiStatus] = useState('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const layoutRef = useRef(layout);
  const localEditsRef = useRef(false);
  const syncSequenceRef = useRef(0);
  const syncTimerRef = useRef<number | null>(null);
  const syncInFlightRef = useRef(false);
  const pendingSyncRef = useRef<PendingLayoutSync | null>(null);
  layoutRef.current = layout;

  const flushPendingSync = async () => {
    if (syncInFlightRef.current) {
      return;
    }
    const pending = pendingSyncRef.current;
    if (!pending) {
      return;
    }
    pendingSyncRef.current = null;
    syncInFlightRef.current = true;
    const serverSaved = await saveDesktopLayoutToServer(pending.layout);
    syncInFlightRef.current = false;

    if (pending.sequence === syncSequenceRef.current && !pendingSyncRef.current) {
      if (pending.localSaved && serverSaved) {
        setSavedText(pending.successText);
      } else if (pending.localSaved) {
        setSavedText('已保存到本机；本地服务暂未同步，稍后操作时会重试');
      } else if (serverSaved) {
        setSavedText('已同步到本地服务，但浏览器本机存储写入失败');
      } else {
        setSavedText('布局保存失败，请检查浏览器存储和本地服务');
      }
    }

    if (pendingSyncRef.current) {
      void flushPendingSync();
    }
  };

  const queueLayoutSync = (nextLayout: WidgetLayout[], successText: string, delay = 140) => {
    localEditsRef.current = true;
    const localSaved = saveDesktopLayoutLocally(nextLayout);
    const sequence = ++syncSequenceRef.current;
    pendingSyncRef.current = {
      layout: nextLayout,
      successText,
      localSaved,
      sequence,
    };
    setSavedText(localSaved ? '已保存到本机，正在同步布局…' : '本机存储写入失败，正在尝试同步服务…');
    if (syncTimerRef.current === null) {
      syncTimerRef.current = window.setTimeout(() => {
        syncTimerRef.current = null;
        void flushPendingSync();
      }, delay);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const loadServerLayout = async () => {
      const serverLayout = await fetchDesktopLayoutFromServer();
      if (cancelled) {
        return;
      }
      if (serverLayout) {
        if (localEditsRef.current) {
          setSavedText('已保留刚才的本机编辑，正在同步最新布局');
        } else {
          syncNoteAppState(serverLayout);
          layoutRef.current = serverLayout;
          setLayout(serverLayout);
          const cached = saveDesktopLayoutLocally(serverLayout);
          setSavedText(cached ? '已读取本地服务保存的布局' : '已读取服务布局，但本机缓存写入失败');
        }
      } else {
        syncNoteAppState(layoutRef.current);
      }
    };
    void loadServerLayout();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    const pending = pendingSyncRef.current;
    if (pending) {
      pendingSyncRef.current = null;
      void saveDesktopLayoutToServer(pending.layout);
    }
  }, []);

  const commitLayout = (nextLayout: WidgetLayout[], text = '已实时同步到壁纸') => {
    syncNoteAppTransition(layoutRef.current, nextLayout);
    layoutRef.current = nextLayout;
    setLayout(nextLayout);
    queueLayoutSync(nextLayout, text);
  };

  const addWidget = (type: WidgetType) => {
    const existing = layout.find((widget) => widget.type === type);
    if (existing) {
      if (existing.visible) {
        if (type === 'noteDock') {
          void openNoteCaptureApp();
        }
        setSavedText('这个模块已经在桌面上');
      } else {
        const next = layout.map((widget) => widget.id === existing.id ? { ...widget, visible: true } : widget);
        commitLayout(next, type === 'noteDock' ? '笔记小 App 已恢复到桌面' : '模块已恢复到桌面');
      }
      return;
    }
    commitLayout([...layout, createWidget(type, layout.length)], '组件已添加并同步');
  };

  const addCustomWidget = () => {
    const title = customTitle.trim() || '自定义便签';
    const nextWidget = createWidget('customText', layout.length, {
      title,
      content: customContent,
    });
    commitLayout([...layout, nextWidget], `已添加自定义模块「${title}」`);
    setCustomTitle('');
    setCustomContent('');
  };

  const generateAiWidget = async () => {
    const prompt = aiPrompt.trim();
    if (!prompt) {
      setAiStatus('先写清楚模块要显示什么、可以进行哪些操作。');
      return;
    }

    setAiGenerating(true);
    setAiStatus('千问正在设计界面和交互代码……');
    try {
      const response = await fetch(AI_WIDGET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const payload = await response.json() as AiWidgetResponse;
      if (!response.ok || !payload.ok || !payload.widget) {
        throw new Error(payload.error || `AI 服务返回 ${response.status}`);
      }

      const definition = getWidgetDefinition('customCode');
      const title = String(payload.widget.title || 'AI 代码模块').slice(0, 30);
      const nextWidget = createWidget('customCode', layout.length, {
        title,
        width: clampDimension(payload.widget.width, definition.defaultWidth, 240, 720),
        height: clampDimension(payload.widget.height, definition.defaultHeight, 150, 620),
        content: JSON.stringify({
          html: String(payload.widget.html || ''),
          css: String(payload.widget.css || ''),
          js: String(payload.widget.js || ''),
        }),
      });
      commitLayout([...layout, nextWidget], `AI 模块「${title}」已生成并同步`);
      setAiStatus(`已由 ${payload.model || '千问'} 生成「${title}」，可在右侧拖动和缩放。`);
      setAiPrompt('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAiStatus(`生成失败：${message}。请确认本地服务已启动且千问 API 已配置。`);
    } finally {
      setAiGenerating(false);
    }
  };

  const save = () => {
    const currentLayout = layoutRef.current;
    syncNoteAppState(currentLayout);
    queueLayoutSync(currentLayout, '布局已保存并通知壁纸更新', 0);
  };

  const reset = () => {
    const confirmed = window.confirm('确定恢复默认桌面模板吗？当前布局会被覆盖。');
    if (!confirmed) {
      return;
    }
    const defaults = getDefaultLayout();
    commitLayout(defaults, '已恢复默认模板并同步');
  };

  const openWallpaper = () => {
    window.open(`${window.location.origin}/?wallpaper=1`, '_blank', 'noopener,noreferrer');
  };

  const removePermanently = (id: string) => {
    const widget = layout.find((item) => item.id === id);
    const confirmed = window.confirm(`确定彻底删除「${widget?.title ?? '这个模块'}」吗？`);
    if (!confirmed) {
      return;
    }
    const next = layout.filter((item) => item.id !== id);
    if (widget?.type === 'noteDock') {
      void closeNoteCaptureApp();
    }
    commitLayout(next, widget?.type === 'noteDock' ? '笔记小 App 已删除并关闭' : '组件已删除并同步');
  };

  const renameWidget = (id: string, title: string) => {
    const next = layout.map((widget) => widget.id === id ? { ...widget, title } : widget);
    commitLayout(next, '模块名称已同步');
  };

  const openManagedNoteApp = (id: string) => {
    const widget = layout.find((item) => item.id === id);
    if (!widget) {
      return;
    }
    if (!widget.visible) {
      const next = layout.map((item) => item.id === id ? { ...item, visible: true } : item);
      commitLayout(next, '笔记小 App 已显示并打开');
      return;
    }
    void openNoteCaptureApp();
    setSavedText('笔记小 App 已打开');
  };

  const noteAppEnabled = isNoteAppEnabled(layout);
  const noteAppWidget = layout.find((widget) => widget.type === 'noteDock' && widget.visible)
    ?? layout.find((widget) => widget.type === 'noteDock');

  const enableManagedNoteApp = () => {
    if (!noteAppWidget) {
      addWidget('noteDock');
      return;
    }
    openManagedNoteApp(noteAppWidget.id);
  };

  const disableManagedNoteApp = () => {
    if (noteAppEnabled) {
      const next = layout.map((widget) => widget.type === 'noteDock' ? { ...widget, visible: false } : widget);
      commitLayout(next, '笔记小 App 已隐藏并关闭');
      return;
    }
    void closeNoteCaptureApp();
    setSavedText('笔记小 App 已关闭');
  };

  const standardDefinitions = useMemo(
    () => WIDGET_DEFINITIONS.filter((definition) => !['customText', 'customCode'].includes(definition.type)),
    [],
  );
  const visibleWidgets = layout.filter((widget) => widget.visible);

  return (
    <main className="desktop-console-shell">
      <aside className="desktop-console-sidebar">
        <header className="console-topbar">
          <div className="console-brand">
            <span className="console-brand-mark"><AppWindow size={19} aria-hidden="true" /></span>
            <div>
              <h1>桌面控制台</h1>
              <span className="console-sync-label" role="status" aria-live="polite" title={savedText}>{conciseSaveStatus(savedText)}</span>
            </div>
          </div>
          <div className="console-toolbar" aria-label="布局工具">
            <button className="is-primary" type="button" onClick={save} title="立即保存并同步">
              <Save size={16} aria-hidden="true" /> 保存
            </button>
            <button type="button" onClick={openWallpaper} title="在新窗口预览桌面">
              <ExternalLink size={16} aria-hidden="true" /> 预览
            </button>
          </div>
        </header>

        <nav className="console-nav" role="tablist" aria-label="控制台分区">
          {CONSOLE_SECTIONS.map((section) => {
            const Icon = section.icon;
            const active = activeSection === section.value;
            return (
              <button
                key={section.value}
                id={`console-tab-${section.value}`}
                className={active ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`console-panel-${section.value}`}
                onClick={() => setActiveSection(section.value)}
              >
                <Icon size={16} aria-hidden="true" />
                {section.label}
              </button>
            );
          })}
        </nav>

        <div className="desktop-console-scroll">
          {activeSection === 'layout' && (
            <section
              className="console-pane"
              id="console-panel-layout"
              role="tabpanel"
              aria-labelledby="console-tab-layout"
            >
              <header className="console-pane-heading">
                <div>
                  <h2>当前布局</h2>
                  <p>在右侧直接拖动或缩放组件，松手后自动保存。</p>
                </div>
                <span>{visibleWidgets.length} 个模块</span>
              </header>

              <div className="placed-widget-list console-widget-list">
                {visibleWidgets.length === 0 ? (
                  <div className="console-empty-state">
                    <p>桌面还没有组件。</p>
                    <button type="button" onClick={() => setActiveSection('add')}><Plus size={16} /> 添加第一个组件</button>
                  </div>
                ) : visibleWidgets.map((widget) => (
                  <article
                    key={widget.id}
                    className={`${widget.visible ? '' : 'is-hidden'} ${widget.type === 'noteDock' ? 'is-desktop-app' : ''}`.trim()}
                  >
                    <span className="console-widget-icon" aria-hidden="true">
                      {widget.type === 'noteDock' ? <AppWindow size={16} /> : <LayoutGrid size={16} />}
                    </span>
                    <input
                      aria-label={`修改“${widget.title || '未命名模块'}”名称`}
                      value={widget.title}
                      onChange={(event) => renameWidget(widget.id, event.target.value)}
                    />
                    <div className="console-widget-actions">
                      {widget.type === 'noteDock' && (
                        <button type="button" title="打开笔记小 App" aria-label="打开笔记小 App" onClick={() => openManagedNoteApp(widget.id)}>
                          <ExternalLink size={15} aria-hidden="true" />
                        </button>
                      )}
                      <button
                        className="is-danger"
                        type="button"
                        title="彻底删除模块"
                        aria-label={`彻底删除“${widget.title}”`}
                        onClick={() => removePermanently(widget.id)}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {activeSection === 'add' && (
            <section
              className="console-pane"
              id="console-panel-add"
              role="tabpanel"
              aria-labelledby="console-tab-add"
            >
              <header className="console-pane-heading">
                <div>
                  <h2>添加组件</h2>
                  <p>选择一个功能，它会立即出现在右侧桌面中。</p>
                </div>
              </header>

              <div className="widget-library console-add-list">
                {standardDefinitions.map((definition) => {
                  const isAdded = layout.some((widget) => widget.type === definition.type && widget.visible);
                  return (
                    <button
                      disabled={isAdded}
                      key={definition.type}
                      type="button"
                      onClick={() => addWidget(definition.type)}
                    >
                      <span>
                        <strong>{definition.title}</strong>
                        <small>{definition.description}</small>
                      </span>
                      {isAdded ? (
                        <span className="console-added-state"><Check size={16} aria-hidden="true" /> 已添加</span>
                      ) : (
                        <Plus size={17} aria-hidden="true" />
                      )}
                    </button>
                  );
                })}
              </div>

              <section className="custom-widget-creator console-subsection">
                <h3>新建文字便签</h3>
                <label>
                  名称
                  <input
                    maxLength={30}
                    placeholder="例如：英语单词、今日提醒"
                    value={customTitle}
                    onChange={(event) => setCustomTitle(event.target.value)}
                  />
                </label>
                <label>
                  初始内容
                  <textarea
                    placeholder="可以留空，添加后继续编辑"
                    value={customContent}
                    onChange={(event) => setCustomContent(event.target.value)}
                  />
                </label>
                <button className="custom-widget-add" type="button" onClick={addCustomWidget}>
                  <Plus size={16} aria-hidden="true" /> 添加文字便签
                </button>
              </section>
            </section>
          )}

          {activeSection === 'ai' && (
            <section
              className="console-pane ai-widget-creator"
              id="console-panel-ai"
              role="tabpanel"
              aria-labelledby="console-tab-ai"
            >
              <header className="console-pane-heading">
                <div>
                  <h2>AI 创建组件</h2>
                  <p>描述它要显示的内容和操作方式，生成后可直接拖动、缩放。</p>
                </div>
              </header>
              <label>
                组件需求
                <textarea
                  maxLength={1200}
                  placeholder="例如：做一个可勾选的英语单词复习清单，顶部显示完成进度，并提供清空按钮。"
                  value={aiPrompt}
                  onChange={(event) => setAiPrompt(event.target.value)}
                />
              </label>
              <button
                className="ai-widget-generate"
                type="button"
                disabled={aiGenerating}
                onClick={() => void generateAiWidget()}
              >
                <Sparkles size={16} aria-hidden="true" /> {aiGenerating ? '正在生成…' : '生成并添加到桌面'}
              </button>
              {aiStatus && <p className="ai-widget-status" role="status" aria-live="polite">{aiStatus}</p>}
            </section>
          )}

          {activeSection === 'settings' && (
            <section
              className="console-pane"
              id="console-panel-settings"
              role="tabpanel"
              aria-labelledby="console-tab-settings"
            >
              <header className="console-pane-heading">
                <div>
                  <h2>设置</h2>
                  <p>管理独立小应用和桌面布局。</p>
                </div>
              </header>

              <div className="console-settings-list">
                <section className="console-setting-row desktop-app-manager">
                  <div>
                    <h3>笔记小 App</h3>
                    <p>{noteAppEnabled ? '已启用，可以直接拖入图片。' : noteAppWidget ? '当前已隐藏。' : '尚未加入桌面助手。'}</p>
                  </div>
                  <div className="desktop-app-manager-actions">
                    <button type="button" onClick={enableManagedNoteApp}>
                      <ExternalLink size={15} aria-hidden="true" /> {noteAppEnabled ? '打开' : '添加并打开'}
                    </button>
                    <button type="button" onClick={disableManagedNoteApp}>
                      <Power size={15} aria-hidden="true" /> 关闭
                    </button>
                  </div>
                </section>

                <section className="console-setting-row is-danger-zone">
                  <div>
                    <h3>恢复默认布局</h3>
                    <p>覆盖当前组件位置和尺寸，操作前会再次确认。</p>
                  </div>
                  <button type="button" onClick={reset}><RotateCcw size={16} aria-hidden="true" /> 恢复默认</button>
                </section>
              </div>
            </section>
          )}
        </div>
      </aside>

      <section className="desktop-console-preview">
        <DesktopWorkspace
          editable
          layout={layout}
          onLayoutChange={(nextLayout) => {
            commitLayout(nextLayout);
          }}
        />
      </section>
    </main>
  );
}
