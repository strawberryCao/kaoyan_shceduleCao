import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { GripHorizontal, Plus, Settings, Trash2 } from 'lucide-react';
import { getDefaultLayout } from './registry';
import {
  fetchDesktopLayoutFromServer,
  loadDesktopLayout,
  saveDesktopLayout,
  subscribeDesktopLayoutChanged,
  subscribeDesktopLayoutFromServer,
} from './storage';
import type { WidgetLayout } from './types';
import { renderDesktopWidget } from './DesktopWidgets';
import { DunhuangBackdrop } from './DunhuangBackdrop';
import { AiCodeWidget } from './AiCodeWidget';

interface DesktopWorkspaceProps {
  editable: boolean;
  layout?: WidgetLayout[];
  onLayoutChange?: (layout: WidgetLayout[]) => void;
}

type DragState =
  | { mode: 'move'; id: string; pointerId: number; startX: number; startY: number; originX: number; originY: number }
  | { mode: 'resize'; id: string; pointerId: number; startX: number; startY: number; originWidth: number; originHeight: number };

const sameLayout = (a: WidgetLayout[], b: WidgetLayout[]) => JSON.stringify(a) === JSON.stringify(b);

export function DesktopWorkspace({ editable, layout: controlledLayout, onLayoutChange }: DesktopWorkspaceProps) {
  const [internalLayout, setInternalLayout] = useState<WidgetLayout[]>(() => loadDesktopLayout());
  const [previewLayout, setPreviewLayout] = useState<WidgetLayout[] | null>(null);
  const layout = controlledLayout ?? internalLayout;
  const layoutRef = useRef(layout);
  const dragStateRef = useRef<DragState | null>(null);
  const interactionOriginLayoutRef = useRef<WidgetLayout[]>([]);
  const previewLayoutRef = useRef<WidgetLayout[] | null>(null);
  const pendingPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const lastPreviewPublishRef = useRef(0);
  layoutRef.current = layout;

  useEffect(() => {
    if (controlledLayout || !editable) {
      return;
    }
    void saveDesktopLayout(internalLayout);
  }, [controlledLayout, editable, internalLayout]);

  useEffect(() => {
    if (controlledLayout || editable) {
      return;
    }
    return subscribeDesktopLayoutChanged((nextLayout) => {
      setInternalLayout(nextLayout);
    });
  }, [controlledLayout, editable]);

  useEffect(() => {
    if (controlledLayout || editable) {
      return;
    }

    let cancelled = false;
    let pollTimer: number | null = null;
    let syncInFlight = false;
    const applyServerLayout = (serverLayout: WidgetLayout[]) => {
      if (!cancelled) {
        setInternalLayout((current) => sameLayout(current, serverLayout) ? current : serverLayout);
      }
    };
    const unsubscribeServer = subscribeDesktopLayoutFromServer(applyServerLayout);
    const sync = async () => {
      if (cancelled || syncInFlight) {
        return;
      }
      syncInFlight = true;
      const serverLayout = await fetchDesktopLayoutFromServer();
      if (serverLayout) {
        applyServerLayout(serverLayout);
      }
      syncInFlight = false;
      if (!cancelled) {
        pollTimer = window.setTimeout(sync, 2500);
      }
    };

    void sync();
    return () => {
      cancelled = true;
      unsubscribeServer();
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
      }
    };
  }, [controlledLayout, editable]);

  // noteDock is now the persisted on/off state for the independent Electron
  // app. Rendering its old wallpaper card as well would bring back the surface
  // that cannot accept native file drops and would duplicate the small app.
  const updateLayout = (updater: (layout: WidgetLayout[]) => WidgetLayout[]) => {
    const next = updater(layoutRef.current);
    layoutRef.current = next;
    if (onLayoutChange) {
      onLayoutChange(next);
    } else {
      setInternalLayout(next);
    }
  };

  const effectiveLayout = previewLayout ?? layout;
  const visibleLayout = useMemo(
    () => effectiveLayout.filter((widget) => widget.visible && widget.type !== 'noteDock'),
    [effectiveLayout],
  );

  const setInteraction = (next: DragState | null) => {
    dragStateRef.current = next;
  };

  const computeInteractionLayout = (clientX: number, clientY: number): WidgetLayout[] | null => {
    const current = dragStateRef.current;
    if (!current) {
      return null;
    }
    const dx = clientX - current.startX;
    const dy = clientY - current.startY;
    return interactionOriginLayoutRef.current.map((widget) => {
      if (widget.id !== current.id) {
        return widget;
      }
      if (current.mode === 'move') {
        return {
          ...widget,
          x: Math.max(0, current.originX + dx),
          y: Math.max(0, current.originY + dy),
        };
      }
      return {
        ...widget,
        width: Math.max(220, current.originWidth + dx),
        height: Math.max(120, current.originHeight + dy),
      };
    });
  };

  const renderPendingPreview = () => {
    previewFrameRef.current = null;
    const pending = pendingPointerRef.current;
    if (!pending) {
      return;
    }
    const next = computeInteractionLayout(pending.clientX, pending.clientY);
    if (!next) {
      return;
    }
    previewLayoutRef.current = next;
    setPreviewLayout(next);
    const now = performance.now();
    if (onLayoutChange && now - lastPreviewPublishRef.current >= 100) {
      lastPreviewPublishRef.current = now;
      layoutRef.current = next;
      onLayoutChange(next);
    }
  };

  const schedulePreview = (clientX: number, clientY: number) => {
    pendingPointerRef.current = { clientX, clientY };
    if (previewFrameRef.current !== null) {
      return;
    }
    previewFrameRef.current = window.requestAnimationFrame(renderPendingPreview);
  };

  const clearPreviewFrame = () => {
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
  };

  const cancelInteraction = () => {
    clearPreviewFrame();
    pendingPointerRef.current = null;
    previewLayoutRef.current = null;
    setPreviewLayout(null);
    setInteraction(null);
  };

  const finishInteraction = (pointerId: number, clientX: number, clientY: number) => {
    const current = dragStateRef.current;
    if (!current || current.pointerId !== pointerId) {
      return;
    }
    clearPreviewFrame();
    const next = computeInteractionLayout(clientX, clientY) ?? previewLayoutRef.current;
    pendingPointerRef.current = null;
    previewLayoutRef.current = null;
    setPreviewLayout(null);
    setInteraction(null);
    if (next && !sameLayout(layoutRef.current, next)) {
      updateLayout(() => next);
    }
  };

  const beginInteraction = (event: ReactPointerEvent<HTMLElement>, next: DragState) => {
    if (!editable || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail if Chromium has already cancelled the pointer.
    }
    const currentLayout = layoutRef.current;
    const maxZ = Math.max(...currentLayout.map((widget) => widget.zIndex), 1);
    const origin = currentLayout.map((widget) => widget.id === next.id && widget.zIndex < maxZ
      ? { ...widget, zIndex: maxZ + 1 }
      : widget);
    interactionOriginLayoutRef.current = origin;
    lastPreviewPublishRef.current = 0;
    previewLayoutRef.current = origin;
    pendingPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    setPreviewLayout(origin);
    setInteraction(next);
  };

  useEffect(() => {
    const handleWindowBlur = () => cancelInteraction();
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
      clearPreviewFrame();
    };
  }, []);

  const bringToFront = (id: string) => {
    if (!editable) {
      return;
    }
    const currentLayout = layoutRef.current;
    const maxZ = Math.max(...currentLayout.map((widget) => widget.zIndex), 1);
    const target = currentLayout.find((widget) => widget.id === id);
    if (!target || target.zIndex >= maxZ) {
      return;
    }
    updateLayout((current) => current.map((widget) => widget.id === id ? { ...widget, zIndex: maxZ + 1 } : widget));
  };

  const removeWidget = (id: string) => {
    updateLayout((current) => current.filter((widget) => widget.id !== id));
  };

  return (
    <main
      className={`lively-wallpaper-page desktop-workspace-page ${editable ? 'editing' : 'viewing'}`}
      onPointerMove={(event) => {
        const current = dragStateRef.current;
        if (!current || current.pointerId !== event.pointerId) {
          return;
        }
        event.preventDefault();
        schedulePreview(event.clientX, event.clientY);
      }}
      onPointerUp={(event) => finishInteraction(event.pointerId, event.clientX, event.clientY)}
      onPointerCancel={(event) => {
        if (dragStateRef.current?.pointerId === event.pointerId) {
          cancelInteraction();
        }
      }}
    >
      <DunhuangBackdrop />

      {!editable && (
        <nav className="desktop-control-dock" aria-label="桌面壁纸控制">
          <a href="?console=1" target="_blank" rel="noopener noreferrer">
            <Settings size={15} aria-hidden="true" />
            控制台
            <span><Plus size={12} aria-hidden="true" /> 添加模块</span>
          </a>
        </nav>
      )}

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
          onPointerDown={() => bringToFront(widget.id)}
        >
          <header
            className="desktop-widget-header"
            onPointerDown={(event) => beginInteraction(event, {
              mode: 'move',
              id: widget.id,
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              originX: widget.x,
              originY: widget.y,
            })}
          >
            <span><GripHorizontal size={13} aria-hidden="true" /> {widget.title}</span>
            {editable && (
              <button type="button" onClick={(event) => { event.stopPropagation(); removeWidget(widget.id); }} aria-label="删除组件" title="从桌面删除">
                <Trash2 size={13} aria-hidden="true" />
              </button>
            )}
          </header>

          <div className="desktop-widget-body">
            {widget.type === 'customCode' ? <AiCodeWidget widget={widget} /> : renderDesktopWidget(widget)}
          </div>

          {editable && (
            <span
              className="desktop-widget-resize"
              onPointerDown={(event) => beginInteraction(event, {
                mode: 'resize',
                id: widget.id,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                originWidth: widget.width,
                originHeight: widget.height,
              })}
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
