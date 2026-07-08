import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { GripHorizontal, Trash2 } from 'lucide-react';
import { getDefaultLayout } from './registry';
import { loadDesktopLayout, saveDesktopLayout } from './storage';
import type { WidgetLayout } from './types';
import { renderDesktopWidget } from './DesktopWidgets';

interface DesktopWorkspaceProps {
  editable: boolean;
  layout?: WidgetLayout[];
  onLayoutChange?: (layout: WidgetLayout[]) => void;
}

type DragState =
  | { mode: 'move'; id: string; startX: number; startY: number; originX: number; originY: number }
  | { mode: 'resize'; id: string; startX: number; startY: number; originWidth: number; originHeight: number };

export function DesktopWorkspace({ editable, layout: controlledLayout, onLayoutChange }: DesktopWorkspaceProps) {
  const [internalLayout, setInternalLayout] = useState<WidgetLayout[]>(() => loadDesktopLayout());
  const [dragState, setDragState] = useState<DragState | null>(null);
  const layout = controlledLayout ?? internalLayout;

  useEffect(() => {
    if (controlledLayout) {
      return;
    }
    saveDesktopLayout(internalLayout);
  }, [controlledLayout, internalLayout]);

  const visibleLayout = useMemo(() => layout.filter((widget) => widget.visible), [layout]);

  const updateLayout = (updater: (layout: WidgetLayout[]) => WidgetLayout[]) => {
    const next = updater(layout);
    if (onLayoutChange) {
      onLayoutChange(next);
    } else {
      setInternalLayout(next);
    }
  };

  const bringToFront = (id: string) => {
    const maxZ = Math.max(...layout.map((widget) => widget.zIndex), 1);
    updateLayout((current) => current.map((widget) => widget.id === id ? { ...widget, zIndex: maxZ + 1 } : widget));
  };

  const handleMove = (event: ReactMouseEvent<HTMLElement>) => {
    if (!dragState || !editable) {
      return;
    }
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;

    if (dragState.mode === 'move') {
      updateLayout((current) => current.map((widget) => widget.id === dragState.id
        ? { ...widget, x: Math.max(0, dragState.originX + dx), y: Math.max(0, dragState.originY + dy) }
        : widget));
    }

    if (dragState.mode === 'resize') {
      updateLayout((current) => current.map((widget) => widget.id === dragState.id
        ? { ...widget, width: Math.max(220, dragState.originWidth + dx), height: Math.max(120, dragState.originHeight + dy) }
        : widget));
    }
  };

  const removeWidget = (id: string) => {
    updateLayout((current) => current.map((widget) => widget.id === id ? { ...widget, visible: false } : widget));
  };

  return (
    <main
      className={`lively-wallpaper-page desktop-workspace-page ${editable ? 'editing' : 'viewing'}`}
      onMouseMove={handleMove}
      onMouseUp={() => setDragState(null)}
      onMouseLeave={() => setDragState(null)}
    >
      <div className="desktop-wallpaper-ribbon one" />
      <div className="desktop-wallpaper-ribbon two" />
      <div className="desktop-wallpaper-ribbon three" />

      {visibleLayout.map((widget) => (
        <section
          className={`desktop-widget desktop-widget-${widget.type}`}
          key={widget.id}
          style={{
            left: widget.x,
            top: widget.y,
            width: widget.width,
            height: widget.height,
            zIndex: widget.zIndex,
          }}
          onMouseDown={() => bringToFront(widget.id)}
        >
          <header
            className="desktop-widget-header"
            onMouseDown={(event) => {
              if (!editable) {
                return;
              }
              event.preventDefault();
              setDragState({ mode: 'move', id: widget.id, startX: event.clientX, startY: event.clientY, originX: widget.x, originY: widget.y });
            }}
          >
            <span><GripHorizontal size={13} aria-hidden="true" /> {widget.title}</span>
            {editable && (
              <button type="button" onClick={(event) => { event.stopPropagation(); removeWidget(widget.id); }} aria-label="隐藏组件">
                <Trash2 size={13} aria-hidden="true" />
              </button>
            )}
          </header>

          <div className="desktop-widget-body">
            {renderDesktopWidget(widget.type)}
          </div>

          {editable && (
            <span
              className="desktop-widget-resize"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDragState({ mode: 'resize', id: widget.id, startX: event.clientX, startY: event.clientY, originWidth: widget.width, originHeight: widget.height });
              }}
            />
          )}
        </section>
      ))}

      {visibleLayout.length === 0 && editable && (
        <div className="desktop-empty-state">
          <h2>桌面还是空的</h2>
          <p>从左侧功能库添加组件，或者恢复默认模板。</p>
          <button type="button" onClick={() => updateLayout(() => getDefaultLayout())}>恢复默认模板</button>
        </div>
      )}
    </main>
  );
}
