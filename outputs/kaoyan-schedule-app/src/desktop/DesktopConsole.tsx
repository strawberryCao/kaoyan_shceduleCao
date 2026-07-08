import { useState } from 'react';
import { Plus, RotateCcw, Save } from 'lucide-react';
import { getDefaultLayout, getWidgetDefinition, WIDGET_DEFINITIONS } from './registry';
import { loadDesktopLayout, saveDesktopLayout } from './storage';
import type { WidgetLayout, WidgetType } from './types';
import { DesktopWorkspace } from './DesktopWorkspace';

const createWidget = (type: WidgetType, index: number): WidgetLayout => {
  const definition = getWidgetDefinition(type);
  return {
    id: `${type}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    type,
    title: definition.title,
    x: 120 + (index % 5) * 34,
    y: 120 + (index % 5) * 34,
    width: definition.defaultWidth,
    height: definition.defaultHeight,
    visible: true,
    zIndex: 20 + index,
  };
};

export function DesktopConsole() {
  const [layout, setLayout] = useState<WidgetLayout[]>(() => loadDesktopLayout());
  const [savedText, setSavedText] = useState('布局已从本机读取');

  const addWidget = (type: WidgetType) => {
    setLayout((current) => [...current, createWidget(type, current.length)]);
    setSavedText('有未保存改动');
  };

  const save = () => {
    saveDesktopLayout(layout);
    setSavedText('布局已保存，壁纸刷新后生效');
  };

  const reset = () => {
    const confirmed = window.confirm('确定恢复默认桌面模板吗？当前布局会被覆盖。');
    if (!confirmed) {
      return;
    }
    const defaults = getDefaultLayout();
    setLayout(defaults);
    saveDesktopLayout(defaults);
    setSavedText('已恢复默认模板');
  };

  const openWallpaper = () => {
    window.open(`${window.location.origin}/?wallpaper=1`, '_blank', 'noopener,noreferrer');
  };

  return (
    <main className="desktop-console-shell">
      <aside className="desktop-console-sidebar">
        <header>
          <p>考研桌面助手</p>
          <h1>控制台</h1>
          <span>{savedText}</span>
        </header>

        <section className="console-actions">
          <button type="button" onClick={save}><Save size={15} /> 保存布局</button>
          <button type="button" onClick={reset}><RotateCcw size={15} /> 重置模板</button>
          <button type="button" onClick={openWallpaper}>打开壁纸页</button>
        </section>

        <section className="widget-library">
          <h2>功能库</h2>
          {WIDGET_DEFINITIONS.map((definition) => (
            <button key={definition.type} type="button" onClick={() => addWidget(definition.type)}>
              <span>
                <strong>{definition.title}</strong>
                <small>{definition.description}</small>
              </span>
              <Plus size={15} aria-hidden="true" />
            </button>
          ))}
        </section>
      </aside>

      <section className="desktop-console-preview">
        <DesktopWorkspace
          editable
          layout={layout}
          onLayoutChange={(nextLayout) => {
            setLayout(nextLayout);
            setSavedText('有未保存改动');
          }}
        />
      </section>
    </main>
  );
}
