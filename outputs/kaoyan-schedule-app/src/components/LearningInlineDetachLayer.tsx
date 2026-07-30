import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Lock, Maximize2, Unlock, X } from 'lucide-react';
import { WorkspaceAssetPreview, type WorkspaceAssetPreviewItem } from './WorkspaceAssetPreview';

type FloatingMaterial = {
  id: string;
  asset: WorkspaceAssetPreviewItem;
  assets: WorkspaceAssetPreviewItem[];
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  locked: boolean;
  intrinsicFitted: boolean;
  onRecovered: (item: WorkspaceAssetPreviewItem) => void;
};

type Guides = { vertical: number | null; horizontal: number | null };

export interface LearningInlineDetachLayerHandle {
  begin: (
    event: ReactPointerEvent<HTMLElement>,
    asset: WorkspaceAssetPreviewItem,
    assets: WorkspaceAssetPreviewItem[],
    options?: {
      onSelect?: () => void;
      onRecovered?: (item: WorkspaceAssetPreviewItem) => void;
    },
  ) => void;
  spawnAt: (
    asset: WorkspaceAssetPreviewItem,
    assets: WorkspaceAssetPreviewItem[],
    clientX: number,
    clientY: number,
    options?: {
      onRecovered?: (item: WorkspaceAssetPreviewItem) => void;
    },
  ) => void;
}

const GAP = 10;
const SNAP = 7;
const MIN_WIDTH = 220;
const MIN_HEIGHT = 150;
const EMPTY_GUIDES: Guides = { vertical: null, horizontal: null };
const DEFAULT_SIZE: Record<WorkspaceAssetPreviewItem['kind'], [number, number]> = {
  image: [440, 330],
  pdf: [760, 560],
  word: [560, 500],
  html: [520, 420],
  file: [360, 270],
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function fit(item: FloatingMaterial, width: number, height: number): FloatingMaterial {
  const nextWidth = Math.min(item.width, Math.max(MIN_WIDTH, width - GAP * 2));
  const nextHeight = Math.min(item.height, Math.max(MIN_HEIGHT, height - 48));
  return {
    ...item,
    width: nextWidth,
    height: nextHeight,
    x: clamp(item.x, GAP, Math.max(GAP, width - nextWidth - GAP)),
    y: clamp(item.y, 38, Math.max(38, height - nextHeight - GAP)),
  };
}

const overlaps = (left: FloatingMaterial, right: FloatingMaterial, gap = GAP) => !(
  left.x + left.width + gap <= right.x
  || right.x + right.width + gap <= left.x
  || left.y + left.height + gap <= right.y
  || right.y + right.height + gap <= left.y
);

function nearestFreePosition(
  item: FloatingMaterial,
  others: FloatingMaterial[],
  width: number,
  height: number,
): FloatingMaterial {
  let base = fit(item, width, height);
  if (!others.some((other) => overlaps(base, other))) return base;

  for (let shrink = 0; shrink < 5; shrink += 1) {
    const candidates = [
      base,
      ...others.flatMap((other) => [
        { ...base, x: other.x + other.width + GAP, y: other.y },
        { ...base, x: other.x - base.width - GAP, y: other.y },
        { ...base, x: other.x, y: other.y + other.height + GAP },
        { ...base, x: other.x, y: other.y - base.height - GAP },
      ]),
    ]
      .map((candidate) => fit(candidate, width, height))
      .sort((left, right) => (
        Math.hypot(left.x - base.x, left.y - base.y)
        - Math.hypot(right.x - base.x, right.y - base.y)
      ));
    const adjacent = candidates.find((candidate) => !others.some((other) => overlaps(candidate, other)));
    if (adjacent) return adjacent;

    for (let y = 38; y <= height - base.height - GAP; y += 28) {
      for (let x = GAP; x <= width - base.width - GAP; x += 28) {
        const candidate = { ...base, x, y };
        if (!others.some((other) => overlaps(candidate, other))) return candidate;
      }
    }
    base = fit({
      ...base,
      width: Math.max(MIN_WIDTH, Math.round(base.width * .88)),
      height: Math.max(MIN_HEIGHT, Math.round(base.height * .88)),
    }, width, height);
  }
  return base;
}

function snap(
  item: FloatingMaterial,
  others: FloatingMaterial[],
  width: number,
  height: number,
): { item: FloatingMaterial; guides: Guides; snapped: boolean } {
  const base = fit(item, width, height);
  let x = base.x;
  let y = base.y;
  let bestX = SNAP + 1;
  let bestY = SNAP + 1;
  let vertical: number | null = null;
  let horizontal: number | null = null;
  const tryX = (candidate: number, guide: number) => {
    const distance = Math.abs(candidate - base.x);
    if (distance <= SNAP && distance < bestX) {
      x = candidate;
      vertical = guide;
      bestX = distance;
    }
  };
  const tryY = (candidate: number, guide: number) => {
    const distance = Math.abs(candidate - base.y);
    if (distance <= SNAP && distance < bestY) {
      y = candidate;
      horizontal = guide;
      bestY = distance;
    }
  };
  tryX(GAP, GAP);
  tryX(width - base.width - GAP, width - GAP);
  tryY(38, 38);
  tryY(height - base.height - GAP, height - GAP);
  others.forEach((other) => {
    const sharesVerticalArea = !(
      base.y + base.height + 24 < other.y
      || other.y + other.height + 24 < base.y
    );
    const sharesHorizontalArea = !(
      base.x + base.width + 24 < other.x
      || other.x + other.width + 24 < base.x
    );
    if (sharesVerticalArea) {
      tryX(other.x + other.width + GAP, other.x + other.width + GAP / 2);
      tryX(other.x - base.width - GAP, other.x - GAP / 2);
      tryX(other.x, other.x);
    }
    if (sharesHorizontalArea) {
      tryY(other.y, other.y);
      tryY(other.y + other.height + GAP, other.y + other.height + GAP / 2);
      tryY(other.y - base.height - GAP, other.y - GAP / 2);
    }
  });
  return {
    item: fit({ ...base, x, y }, width, height),
    guides: { vertical, horizontal },
    snapped: vertical !== null || horizontal !== null,
  };
}

export const LearningInlineDetachLayer = forwardRef<
  LearningInlineDetachLayerHandle,
  object
>(function LearningInlineDetachLayer(_props, ref) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [floating, setFloating] = useState<FloatingMaterial[]>([]);
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  const [guides, setGuides] = useState<Guides>(EMPTY_GUIDES);
  const [interactingId, setInteractingId] = useState('');
  const [snappingId, setSnappingId] = useState('');
  const [spawningIds, setSpawningIds] = useState<Set<string>>(() => new Set());

  const spawn = (
    asset: WorkspaceAssetPreviewItem,
    assets: WorkspaceAssetPreviewItem[],
    clientX: number,
    clientY: number,
    onRecovered: (item: WorkspaceAssetPreviewItem) => void,
  ) => {
    const layer = layerRef.current;
    if (!layer || layer.clientWidth < 820) return;
    const rect = layer.getBoundingClientRect();
    const [defaultWidth, defaultHeight] = DEFAULT_SIZE[asset.kind];
    const id = `${asset.id}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    setFloating((current) => {
      const scale = Math.max(0.76, 1 - current.length * 0.045);
      const candidate: FloatingMaterial = {
        id,
        asset,
        assets,
        x: clientX - rect.left - defaultWidth / 2,
        y: clientY - rect.top - 30,
        width: Math.round(defaultWidth * scale),
        height: Math.round(defaultHeight * scale),
        z: current.reduce((highest, item) => Math.max(highest, item.z), 120) + 1,
        locked: false,
        intrinsicFitted: false,
        onRecovered,
      };
      const lightlySnapped = snap(candidate, current, layer.clientWidth, layer.clientHeight).item;
      return [...current, nearestFreePosition(lightlySnapped, current, layer.clientWidth, layer.clientHeight)];
    });
    setSpawningIds((current) => new Set(current).add(id));
    window.setTimeout(() => {
      setSpawningIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }, 240);
  };

  useImperativeHandle(ref, () => ({
    spawnAt(asset, assets, clientX, clientY, options = {}) {
      spawn(asset, assets, clientX, clientY, options.onRecovered || (() => undefined));
    },
    begin(event, asset, assets, options = {}) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const source = event.currentTarget;
      const pointerId = event.pointerId;
      try {
        source.setPointerCapture(pointerId);
      } catch {
        // The full-screen drag shield below is the fallback for embedded viewers.
      }
      const startX = event.clientX;
      const startY = event.clientY;
      let moved = false;
      const move = (next: PointerEvent) => {
        if (!moved && Math.hypot(next.clientX - startX, next.clientY - startY) > 7) moved = true;
        if (moved) setGhost({ x: next.clientX, y: next.clientY, label: asset.name });
      };
      const clear = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        try {
          if (source.hasPointerCapture(pointerId)) source.releasePointerCapture(pointerId);
        } catch {
          // The source may have unmounted while the material was being detached.
        }
        setGhost(null);
      };
      const up = (next: PointerEvent) => {
        clear();
        if (moved && window.innerWidth >= 820) {
          spawn(asset, assets, next.clientX, next.clientY, options.onRecovered || (() => undefined));
        } else {
          options.onSelect?.();
        }
      };
      const cancel = () => clear();
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up, { once: true });
      window.addEventListener('pointercancel', cancel, { once: true });
    },
  }));

  const startMove = (
    event: ReactPointerEvent<HTMLElement>,
    original: FloatingMaterial,
    resizing = false,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (original.locked) return;
    const layer = layerRef.current;
    if (!layer) return;
    const startX = event.clientX;
    const startY = event.clientY;
    setInteractingId(original.id);
    const move = (next: PointerEvent) => {
      const dx = next.clientX - startX;
      const dy = next.clientY - startY;
      setFloating((current) => {
        if (resizing) {
          setGuides(EMPTY_GUIDES);
          setSnappingId('');
          return current.map((item) => item.id === original.id ? fit({
            ...item,
            width: Math.max(MIN_WIDTH, original.width + dx),
            height: Math.max(MIN_HEIGHT, original.height + dy),
          }, layer.clientWidth, layer.clientHeight) : item);
        }
        const nextItem = fit({
          ...original,
          x: original.x + dx,
          y: original.y + dy,
        }, layer.clientWidth, layer.clientHeight);
        setGuides(EMPTY_GUIDES);
        setSnappingId('');
        return current.map((item) => item.id === original.id ? nextItem : item);
      });
    };
    const clear = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      setGuides(EMPTY_GUIDES);
      setSnappingId('');
      setInteractingId('');
    };
    const up = () => {
      if (!resizing) {
        setFloating((current) => current.map((item) => {
          if (item.id !== original.id) return item;
          const snapped = snap(
            item,
            current.filter((entry) => entry.id !== item.id),
            layer.clientWidth,
            layer.clientHeight,
          );
          if (snapped.snapped) {
            setGuides(snapped.guides);
            setSnappingId(item.id);
            window.setTimeout(() => {
              setGuides(EMPTY_GUIDES);
              setSnappingId('');
            }, 260);
          }
          return snapped.item;
        }));
      }
      clear();
    };
    const cancel = () => clear();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', cancel, { once: true });
  };

  return createPortal((
    <>
      <div className="lc-detach-layer" ref={layerRef} aria-live="polite">
        {floating.map((item) => (
          <section
            className={[
              'lc-detached-material',
              `is-${item.asset.kind}`,
              item.locked ? 'is-locked' : '',
              interactingId === item.id ? 'is-interacting' : '',
              snappingId === item.id ? 'is-snapping' : '',
              spawningIds.has(item.id) ? 'is-spawning' : '',
            ].filter(Boolean).join(' ')}
            key={item.id}
            style={{ left: item.x, top: item.y, width: item.width, height: item.height, zIndex: item.z }}
            onPointerDown={() => setFloating((current) => current.map((entry) => entry.id === item.id
              ? { ...entry, z: Math.max(...current.map((value) => value.z), 120) + 1 }
              : entry))}
            onWheel={(event) => event.stopPropagation()}
          >
            <header onPointerDown={(event) => startMove(event, item)}>
              <strong>{item.asset.name}</strong>
              <button
                type="button"
                aria-label="全屏查看资料"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  const section = event.currentTarget.closest('section');
                  if (section && !document.fullscreenElement) void section.requestFullscreen();
                  else if (document.fullscreenElement) void document.exitFullscreen();
                }}
              ><Maximize2 size={12} /></button>
              <button
                type="button"
                aria-label={item.locked ? '解除锁定' : '锁定资料'}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setFloating((current) => current.map((entry) => entry.id === item.id
                  ? { ...entry, locked: !entry.locked }
                  : entry))}
              >{item.locked ? <Lock size={12} /> : <Unlock size={12} />}</button>
              <button
                type="button"
                aria-label="收回资料"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setFloating((current) => current.filter((entry) => entry.id !== item.id))}
              ><X size={13} /></button>
            </header>
            <div>
              <WorkspaceAssetPreview
                item={item.asset}
                assets={item.assets}
                onRecovered={item.onRecovered}
                onIntrinsicSize={(width, height) => {
                  if (item.intrinsicFitted || width <= 0 || height <= 0) return;
                  setFloating((current) => current.map((entry) => {
                    if (entry.id !== item.id || entry.intrinsicFitted) return entry;
                    const isImage = item.asset.kind === 'image';
                    const ratio = Math.max(.25, Math.min(4.5, width / height));
                    const nextWidth = isImage
                      ? Math.min(760, Math.max(300, entry.width))
                      : Math.min(820, Math.max(300, Math.round(width + 12)));
                    const documentScale = isImage ? 1 : Math.min(1, Math.max(.25, (nextWidth - 12) / width));
                    const nextHeight = isImage
                      ? Math.max(150, Math.min(620, Math.round(nextWidth / ratio)))
                      : Math.min(700, Math.max(180, Math.round(height * documentScale + 12)));
                    return fit({
                      ...entry,
                      width: nextWidth,
                      height: nextHeight,
                      intrinsicFitted: true,
                    }, layerRef.current?.clientWidth || window.innerWidth, layerRef.current?.clientHeight || window.innerHeight);
                  }));
                }}
              />
            </div>
            {!item.locked && (
              <button
                className="lc-detached-resize"
                type="button"
                aria-label="调整资料大小"
                onPointerDown={(event) => startMove(event, item, true)}
              />
            )}
          </section>
        ))}
      </div>
      {ghost && (
        <>
          <div className="lc-detach-drag-shield" aria-hidden="true" />
          <div className="lc-detach-ghost" style={{ left: ghost.x, top: ghost.y }}>
            {ghost.label}
          </div>
        </>
      )}
      {guides.vertical !== null && (
        <i className="lc-detach-guide is-vertical" style={{ left: guides.vertical }} />
      )}
      {guides.horizontal !== null && (
        <i className="lc-detach-guide is-horizontal" style={{ top: guides.horizontal }} />
      )}
    </>
  ), document.body);
});
