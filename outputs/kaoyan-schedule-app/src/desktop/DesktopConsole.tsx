import { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { getDefaultLayout, getWidgetDefinition, WIDGET_DEFINITIONS } from './registry';
import { fetchDesktopLayoutFromServer, loadDesktopLayout, saveDesktopLayout } from './storage';
import type { WidgetLayout, WidgetType } from './types';
import { DesktopWorkspace } from './DesktopWorkspace';

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

export function DesktopConsole() {
  const [layout, setLayout] = useState<WidgetLayout[]>(() => loadDesktopLayout());
  const [savedText, setSavedText] = useState('布局已从本机读取，拖动后会实时同步');
  const [customTitle, setCustomTitle] = useState('');
  const [customContent, setCustomContent] = useState('');

  useEffect(() => {
    let cancelled = false;
    const loadServerLayout = async () => {
      const serverLayout = await fetchDesktopLayoutFromServer();
      if (!cancelled && serverLayout) {
        setLayout(serverLayout);
        setSavedText('已读取本地服务保存的布局');
      }
    };
    void loadServerLayout();
    return () => {
      cancelled = true;
    };
  }, []);

  const commitLayout = (nextLayout: WidgetLayout[], text = '已实时同步到壁纸') => {
    setLayout(nextLayout);
    saveDesktopLayout(nextLayout);
    setSavedText(text);
  };

  const addWidget = (type: WidgetType) => {
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

  const save = () => {
    saveDesktopLayout(layout);
    setSavedText('布局已保存并通知壁纸更新');
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

  const toggleVisibility = (id: string) => {
    const next = layout.map((widget) => widget.id === id ? { ...widget, visible: !widget.visible } : widget);
    commitLayout(next, '组件显示状态已同步');
  };

  const removePermanently = (id: string) => {
    const widget = layout.find((item) => item.id === id);
    const confirmed = window.confirm(`确定彻底删除「${widget?.title ?? '这个模块'}」吗？`);
    if (!confirmed) {
      return;
    }
    commitLayout(layout.filter((item) => item.id !== id), '组件已删除并同步');
  };

  const renameWidget = (id: string, title: string) => {
    const next = layout.map((widget) => widget.id === id ? { ...widget, title } : widget);
    commitLayout(next, '模块名称已同步');
  };

  const standardDefinitions = useMemo(
    () => WIDGET_DEFINITIONS.filter((definition) => definition.type !== 'customText'),
    [],
  );

  return (
    <main className="desktop-console-shell">
      <aside className="desktop-console-sidebar">
        <header>
          <p>考研桌面助手</p>
          <h1>桌面控制台</h1>
          <span>{savedText}</span>
        </header>

        <section className="console-actions">
          <button type="button" onClick={save}><Save size={15} /> 手动保存/同步</button>
          <button type="button" onClick={reset}><RotateCcw size={15} /> 重置模板</button>
          <button type="button" onClick={openWallpaper}>打开壁纸页</button>
        </section>

        <div className="desktop-console-scroll">
          <section className="custom-widget-creator">
            <div className="console-section-heading">
              <div>
                <small>自定义添加</small>
                <h2>新建模块</h2>
              </div>
              <Plus size={17} aria-hidden="true" />
            </div>
            <label>
              模块名称
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
                placeholder="可以留空，添加后在模块里继续编辑"
                value={customContent}
                onChange={(event) => setCustomContent(event.target.value)}
              />
            </label>
            <button className="custom-widget-add" type="button" onClick={addCustomWidget}>
              <Plus size={15} /> 添加自定义模块
            </button>
          </section>

          <section className="widget-library">
            <div className="console-section-heading">
              <div>
                <small>预设功能</small>
                <h2>功能库</h2>
              </div>
              <span>{standardDefinitions.length} 个</span>
            </div>
            {standardDefinitions.map((definition) => (
              <button key={definition.type} type="button" onClick={() => addWidget(definition.type)}>
                <span>
                  <strong>{definition.title}</strong>
                  <small>{definition.description}</small>
                </span>
                <Plus size={15} aria-hidden="true" />
              </button>
            ))}
          </section>

          <section className="placed-widget-list">
            <div className="console-section-heading">
              <div>
                <small>当前布局</small>
                <h2>已添加模块</h2>
              </div>
              <span>{layout.length} 个</span>
            </div>
            {layout.map((widget) => (
              <article key={widget.id} className={widget.visible ? '' : 'is-hidden'}>
                <input
                  aria-label="修改模块名称"
                  value={widget.title}
                  onChange={(event) => renameWidget(widget.id, event.target.value)}
                />
                <div>
                  <button
                    type="button"
                    title={widget.visible ? '隐藏模块' : '显示模块'}
                    onClick={() => toggleVisibility(widget.id)}
                  >
                    {widget.visible ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  <button type="button" title="彻底删除模块" onClick={() => removePermanently(widget.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </article>
            ))}
          </section>
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
