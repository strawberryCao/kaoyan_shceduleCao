import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronRight,
  ImageOff,
  Maximize2,
  RotateCw,
  Scan,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  clampImageViewerPan,
  clampImageViewerScale,
  fitImageViewerScale,
  normalizeImageViewerRotation,
  zoomImageViewerAtPoint,
  type ImageViewerPoint,
  type ImageViewerSize,
} from '../utils/imageViewer';
import '../image-viewer.css';

export interface ImageViewerItem {
  id: string;
  src: string;
  alt?: string;
}

export interface ImageViewerProps {
  items: readonly ImageViewerItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  ariaLabel?: string;
}

type ViewMode = 'fit' | 'actual' | 'custom';

interface ViewerState {
  scale: number;
  pan: ImageViewerPoint;
  rotation: number;
  mode: ViewMode;
}

interface NaturalImageSize extends ImageViewerSize {
  key: string;
}

interface PointerPosition extends ImageViewerPoint {
  id: number;
}

type Gesture = {
  kind: 'drag';
  startPoint: ImageViewerPoint;
  startPan: ImageViewerPoint;
} | {
  kind: 'pinch';
  startDistance: number;
  startMidpoint: ImageViewerPoint;
  startState: ViewerState;
};

const INITIAL_STATE: ViewerState = {
  scale: 1,
  pan: { x: 0, y: 0 },
  rotation: 0,
  mode: 'fit',
};

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const midpoint = (first: PointerPosition, second: PointerPosition): ImageViewerPoint => ({
  x: (first.x + second.x) / 2,
  y: (first.y + second.y) / 2,
});

const distance = (first: PointerPosition, second: PointerPosition): number => Math.hypot(
  second.x - first.x,
  second.y - first.y,
);

const activeItemKey = (item: ImageViewerItem | undefined): string => item
  ? `${item.id}\u0000${item.src}`
  : '';

export function ImageViewer({
  items,
  index,
  onIndexChange,
  onClose,
  ariaLabel = '图片查看器',
}: ImageViewerProps) {
  const safeIndex = items.length > 0 ? Math.min(items.length - 1, Math.max(0, index)) : 0;
  const activeItem = items[safeIndex];
  const isOpen = Boolean(activeItem);
  const itemKey = activeItemKey(activeItem);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, PointerPosition>());
  const gestureRef = useRef<Gesture | null>(null);
  const preloadedSourcesRef = useRef(new Set<string>());
  const [view, setView] = useState<ViewerState>(INITIAL_STATE);
  const viewRef = useRef(view);
  const [naturalSize, setNaturalSize] = useState<NaturalImageSize | null>(null);
  const [loadedKey, setLoadedKey] = useState('');
  const [failedKey, setFailedKey] = useState('');

  const currentNaturalSize = naturalSize?.key === itemKey ? naturalSize : null;
  const imageReady = Boolean(currentNaturalSize && loadedKey === itemKey && failedKey !== itemKey);

  const commitView = useCallback((update: ViewerState | ((current: ViewerState) => ViewerState)) => {
    setView((current) => {
      const next = typeof update === 'function' ? update(current) : update;
      viewRef.current = next;
      return next;
    });
  }, []);

  const viewportSize = useCallback((): ImageViewerSize => {
    const rect = stageRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  }, []);

  const constrainView = useCallback((next: ViewerState, image = currentNaturalSize): ViewerState => {
    if (!image) return next;
    const viewport = viewportSize();
    return {
      ...next,
      pan: clampImageViewerPan(next.pan, image, viewport, next.scale, next.rotation),
    };
  }, [currentNaturalSize, viewportSize]);

  const fitImage = useCallback(() => {
    if (!currentNaturalSize) return;
    const current = viewRef.current;
    commitView({
      scale: fitImageViewerScale(currentNaturalSize, viewportSize(), current.rotation),
      pan: { x: 0, y: 0 },
      rotation: current.rotation,
      mode: 'fit',
    });
  }, [commitView, currentNaturalSize, viewportSize]);

  const showActualSize = useCallback(() => {
    const current = viewRef.current;
    commitView(constrainView({
      ...current,
      scale: 1,
      pan: { x: 0, y: 0 },
      mode: 'actual',
    }));
  }, [commitView, constrainView]);

  const zoomBy = useCallback((factor: number, anchor?: ImageViewerPoint) => {
    if (!currentNaturalSize) return;
    const viewport = viewportSize();
    const current = viewRef.current;
    const zoomed = zoomImageViewerAtPoint(
      current,
      current.scale * factor,
      anchor ?? { x: viewport.width / 2, y: viewport.height / 2 },
      viewport,
    );
    if (
      Math.abs(zoomed.scale - current.scale) < 0.0001
      && Math.abs(zoomed.pan.x - current.pan.x) < 0.01
      && Math.abs(zoomed.pan.y - current.pan.y) < 0.01
    ) return;
    commitView(constrainView({ ...current, ...zoomed, mode: 'custom' }));
  }, [commitView, constrainView, currentNaturalSize, viewportSize]);

  const rotateImage = useCallback(() => {
    if (!currentNaturalSize) return;
    const current = viewRef.current;
    const rotation = normalizeImageViewerRotation(current.rotation + 90);
    if (current.mode === 'fit') {
      commitView({
        ...current,
        rotation,
        scale: fitImageViewerScale(currentNaturalSize, viewportSize(), rotation),
        pan: { x: 0, y: 0 },
      });
      return;
    }
    commitView(constrainView({ ...current, rotation }));
  }, [commitView, constrainView, currentNaturalSize, viewportSize]);

  const changeIndex = useCallback((nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= items.length || nextIndex === safeIndex) return;
    onIndexChange(nextIndex);
  }, [items.length, onIndexChange, safeIndex]);

  useLayoutEffect(() => {
    viewRef.current = INITIAL_STATE;
    setView(INITIAL_STATE);
    setLoadedKey('');
    setFailedKey('');
    pointersRef.current.clear();
    gestureRef.current = null;
  }, [itemKey]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!activeItem || index === safeIndex) return;
    onIndexChange(safeIndex);
  }, [activeItem, index, onIndexChange, safeIndex]);

  useEffect(() => {
    const sources = [items[safeIndex - 1]?.src, items[safeIndex + 1]?.src].filter(
      (source): source is string => Boolean(source),
    );
    sources.forEach((source) => {
      if (preloadedSourcesRef.current.has(source)) return;
      preloadedSourcesRef.current.add(source);
      const image = new Image();
      image.decoding = 'async';
      image.src = source;
    });
  }, [items, safeIndex]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !currentNaturalSize) return undefined;

    const resize = () => {
      const current = viewRef.current;
      if (current.mode === 'fit') {
        commitView({
          ...current,
          scale: fitImageViewerScale(currentNaturalSize, viewportSize(), current.rotation),
          pan: { x: 0, y: 0 },
        });
      } else {
        commitView(constrainView(current));
      }
    };

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(stage);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [commitView, constrainView, currentNaturalSize, viewportSize]);

  const handleImageLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    const nextNaturalSize: NaturalImageSize = {
      key: itemKey,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
    const current = viewRef.current;
    setNaturalSize(nextNaturalSize);
    setLoadedKey(itemKey);
    setFailedKey('');
    commitView({
      ...current,
      scale: fitImageViewerScale(nextNaturalSize, viewportSize(), current.rotation),
      pan: { x: 0, y: 0 },
      mode: 'fit',
    });
  }, [commitView, itemKey, viewportSize]);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (!currentNaturalSize) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    zoomBy(Math.exp(-event.deltaY * 0.002), {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  }, [currentNaturalSize, zoomBy]);

  const beginPinch = useCallback(() => {
    const points = [...pointersRef.current.values()];
    if (points.length < 2) return;
    gestureRef.current = {
      kind: 'pinch',
      startDistance: Math.max(1, distance(points[0], points[1])),
      startMidpoint: midpoint(points[0], points[1]),
      startState: viewRef.current,
    };
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!currentNaturalSize || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    const point = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
    pointersRef.current.set(event.pointerId, point);

    if (pointersRef.current.size === 1) {
      gestureRef.current = {
        kind: 'drag',
        startPoint: point,
        startPan: viewRef.current.pan,
      };
    } else {
      beginPinch();
    }
  }, [beginPinch, currentNaturalSize]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId) || !currentNaturalSize) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
    pointersRef.current.set(event.pointerId, point);
    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.kind === 'drag' && pointersRef.current.size === 1) {
      const current = viewRef.current;
      const next = constrainView({
        ...current,
        pan: {
          x: gesture.startPan.x + point.x - gesture.startPoint.x,
          y: gesture.startPan.y + point.y - gesture.startPoint.y,
        },
        mode: 'custom',
      });
      if (
        Math.abs(next.pan.x - current.pan.x) >= 0.01
        || Math.abs(next.pan.y - current.pan.y) >= 0.01
      ) commitView(next);
      return;
    }

    const points = [...pointersRef.current.values()];
    if (gesture.kind !== 'pinch' || points.length < 2) return;
    const currentMidpoint = midpoint(points[0], points[1]);
    const scale = clampImageViewerScale(
      gesture.startState.scale * distance(points[0], points[1]) / gesture.startDistance,
    );
    const viewport = viewportSize();
    const worldAtStart = {
      x: (gesture.startMidpoint.x - viewport.width / 2 - gesture.startState.pan.x) / gesture.startState.scale,
      y: (gesture.startMidpoint.y - viewport.height / 2 - gesture.startState.pan.y) / gesture.startState.scale,
    };
    commitView(constrainView({
      ...gesture.startState,
      scale,
      pan: {
        x: currentMidpoint.x - viewport.width / 2 - worldAtStart.x * scale,
        y: currentMidpoint.y - viewport.height / 2 - worldAtStart.y * scale,
      },
      mode: 'custom',
    }));
  }, [commitView, constrainView, currentNaturalSize, viewportSize]);

  const endPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const remaining = [...pointersRef.current.values()];
    if (remaining.length === 1) {
      gestureRef.current = {
        kind: 'drag',
        startPoint: remaining[0],
        startPan: viewRef.current.pan,
      };
    } else if (remaining.length >= 2) {
      beginPinch();
    } else {
      gestureRef.current = null;
    }
  }, [beginPinch]);

  const panWithKeyboard = useCallback((x: number, y: number) => {
    if (!currentNaturalSize) return;
    const current = viewRef.current;
    const fitScale = fitImageViewerScale(currentNaturalSize, viewportSize(), current.rotation);
    if (current.scale <= fitScale + 0.001) return;
    commitView(constrainView({
      ...current,
      pan: { x: current.pan.x + x, y: current.pan.y + y },
      mode: 'custom',
    }));
  }, [commitView, constrainView, currentNaturalSize, viewportSize]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])]
        .filter((element) => element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault();
      changeIndex(safeIndex - 1);
      return;
    }
    if (event.altKey && event.key === 'ArrowRight') {
      event.preventDefault();
      changeIndex(safeIndex + 1);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const actions: Record<string, () => void> = {
      '0': fitImage,
      '1': showActualSize,
      '+': () => zoomBy(1.25),
      '=': () => zoomBy(1.25),
      '-': () => zoomBy(0.8),
      ArrowLeft: () => panWithKeyboard(-64, 0),
      ArrowRight: () => panWithKeyboard(64, 0),
      ArrowUp: () => panWithKeyboard(0, -64),
      ArrowDown: () => panWithKeyboard(0, 64),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  }, [changeIndex, fitImage, onClose, panWithKeyboard, safeIndex, showActualSize, zoomBy]);

  const imageCanvasStyle = useMemo(() => currentNaturalSize ? {
    width: `${currentNaturalSize.width}px`,
    height: `${currentNaturalSize.height}px`,
    marginLeft: `${-currentNaturalSize.width / 2}px`,
    marginTop: `${-currentNaturalSize.height / 2}px`,
    transform: `translate3d(${view.pan.x}px, ${view.pan.y}px, 0)`,
  } : undefined, [currentNaturalSize, view.pan.x, view.pan.y]);

  const imageStyle = useMemo(() => ({
    transform: `rotate(${view.rotation}deg) scale(${view.scale})`,
  }), [view.rotation, view.scale]);

  if (!activeItem || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="image-viewer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="image-viewer__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="image-viewer__counter" aria-live="polite">
          {safeIndex + 1} / {items.length}
        </div>

        <button
          ref={closeButtonRef}
          className="image-viewer__close"
          type="button"
          onClick={onClose}
          aria-label="关闭图片查看器"
          title="关闭 (Esc)"
        >
          <X size={22} />
        </button>

        <button
          className="image-viewer__page image-viewer__page--previous"
          type="button"
          onClick={() => changeIndex(safeIndex - 1)}
          aria-disabled={safeIndex === 0}
          aria-label="上一张图片"
          title="上一张 (Alt + ←)"
        >
          <ChevronLeft size={28} />
        </button>
        <button
          className="image-viewer__page image-viewer__page--next"
          type="button"
          onClick={() => changeIndex(safeIndex + 1)}
          aria-disabled={safeIndex >= items.length - 1}
          aria-label="下一张图片"
          title="下一张 (Alt + →)"
        >
          <ChevronRight size={28} />
        </button>

        <div
          ref={stageRef}
          className={`image-viewer__stage${view.mode !== 'fit' ? ' is-zoomed' : ''}`}
          onWheel={handleWheel}
          onDoubleClick={() => {
            if (view.mode === 'fit') showActualSize();
            else fitImage();
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          {failedKey === itemKey && (
            <div className="image-viewer__error" role="status" aria-label="图片加载失败">
              <ImageOff size={42} />
            </div>
          )}
          <div
            className={`image-viewer__canvas${imageReady ? ' is-ready' : ''}`}
            style={imageCanvasStyle}
          >
            <img
              key={itemKey}
              src={activeItem.src}
              alt={activeItem.alt ?? ''}
              draggable={false}
              decoding="async"
              style={imageStyle}
              onLoad={handleImageLoad}
              onError={() => setFailedKey(itemKey)}
            />
          </div>
        </div>

        <div className="image-viewer__toolbar" role="toolbar" aria-label="图片缩放工具">
          <button type="button" onClick={() => zoomBy(0.8)} disabled={!currentNaturalSize} aria-label="缩小图片" title="缩小 (-)">
            <ZoomOut size={19} />
          </button>
          <output className="image-viewer__scale" aria-label={`缩放 ${Math.round(view.scale * 100)}%`}>
            {Math.round(view.scale * 100)}%
          </output>
          <button type="button" onClick={() => zoomBy(1.25)} disabled={!currentNaturalSize} aria-label="放大图片" title="放大 (+)">
            <ZoomIn size={19} />
          </button>
          <span className="image-viewer__separator" aria-hidden="true" />
          <button type="button" onClick={fitImage} disabled={!currentNaturalSize} aria-label="图片适合窗口" title="适合窗口 (0)">
            <Maximize2 size={18} />
          </button>
          <button type="button" onClick={showActualSize} disabled={!currentNaturalSize} aria-label="显示图片原始大小" title="原始大小 (1)">
            <Scan size={18} />
          </button>
          <button type="button" onClick={rotateImage} disabled={!currentNaturalSize} aria-label="顺时针旋转图片" title="顺时针旋转">
            <RotateCw size={18} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
