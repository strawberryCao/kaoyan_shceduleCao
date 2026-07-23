import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, RotateCcw, X } from 'lucide-react';
import { clampCrop, DEFAULT_CROP, type NormalizedCrop } from '../utils/imageCrop';

interface ImageCropEditorProps {
  imageSrc: string;
  initialCrop?: NormalizedCrop;
  title?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (crop: NormalizedCrop) => void;
}

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se';

interface DragState {
  pointerId: number;
  mode: DragMode;
  startX: number;
  startY: number;
  origin: NormalizedCrop;
}

interface ImageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const MIN_CROP = 0.08;

export function ImageCropEditor({
  imageSrc,
  initialCrop = DEFAULT_CROP,
  title = '裁剪题目',
  confirmLabel = '使用裁剪',
  onCancel,
  onConfirm,
}: ImageCropEditorProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [crop, setCrop] = useState<NormalizedCrop>(() => clampCrop(initialCrop, MIN_CROP));
  const [naturalSize, setNaturalSize] = useState({ width: 1, height: 1 });
  const [frameSize, setFrameSize] = useState({ width: 1, height: 1 });
  const [drag, setDrag] = useState<DragState | null>(null);

  useEffect(() => setCrop(clampCrop(initialCrop, MIN_CROP)), [imageSrc, initialCrop.x, initialCrop.y, initialCrop.width, initialCrop.height]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const update = () => {
      const rect = frame.getBoundingClientRect();
      setFrameSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(frame);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const imageBox = useMemo<ImageBox>(() => {
    const imageRatio = naturalSize.width / naturalSize.height;
    const frameRatio = frameSize.width / frameSize.height;
    if (imageRatio >= frameRatio) {
      const width = frameSize.width;
      const height = width / imageRatio;
      return { left: 0, top: (frameSize.height - height) / 2, width, height };
    }
    const height = frameSize.height;
    const width = height * imageRatio;
    return { left: (frameSize.width - width) / 2, top: 0, width, height };
  }, [frameSize, naturalSize]);

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, mode: DragMode) => {
    event.preventDefault();
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Safari may decline capture. */ }
    setDrag({
      pointerId: event.pointerId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      origin: crop,
    });
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = (event.clientX - drag.startX) / Math.max(1, imageBox.width);
    const dy = (event.clientY - drag.startY) / Math.max(1, imageBox.height);
    const origin = drag.origin;
    if (drag.mode === 'move') {
      setCrop(clampCrop({ ...origin, x: origin.x + dx, y: origin.y + dy }, MIN_CROP));
      return;
    }

    let left = origin.x;
    let top = origin.y;
    let right = origin.x + origin.width;
    let bottom = origin.y + origin.height;
    if (drag.mode.includes('w')) left = Math.min(right - MIN_CROP, Math.max(0, origin.x + dx));
    if (drag.mode.includes('e')) right = Math.max(left + MIN_CROP, Math.min(1, origin.x + origin.width + dx));
    if (drag.mode.includes('n')) top = Math.min(bottom - MIN_CROP, Math.max(0, origin.y + dy));
    if (drag.mode.includes('s')) bottom = Math.max(top + MIN_CROP, Math.min(1, origin.y + origin.height + dy));
    setCrop({ x: left, y: top, width: right - left, height: bottom - top });
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag?.pointerId === event.pointerId) setDrag(null);
  };

  const overlayStyle = {
    left: imageBox.left + crop.x * imageBox.width,
    top: imageBox.top + crop.y * imageBox.height,
    width: crop.width * imageBox.width,
    height: crop.height * imageBox.height,
  };

  return (
    <section className="mobile-crop-editor" aria-label={title}>
      <header>
        <button type="button" onClick={onCancel} aria-label="取消裁剪"><X size={21} /></button>
        <strong>{title}</strong>
        <button type="button" onClick={() => setCrop(DEFAULT_CROP)} aria-label="重置裁剪"><RotateCcw size={19} /></button>
      </header>

      <div
        className="mobile-crop-stage"
        ref={frameRef}
        onPointerMove={moveDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <img
          src={imageSrc}
          alt="待裁剪题目"
          draggable={false}
          onLoad={(event) => setNaturalSize({
            width: Math.max(1, event.currentTarget.naturalWidth),
            height: Math.max(1, event.currentTarget.naturalHeight),
          })}
        />
        <div className="mobile-crop-shade" aria-hidden="true" />
        <div
          className="mobile-crop-box"
          style={overlayStyle}
          onPointerDown={(event) => beginDrag(event, 'move')}
        >
          {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => (
            <span
              className={`mobile-crop-handle is-${handle}`}
              key={handle}
              onPointerDown={(event) => beginDrag(event, handle)}
              aria-hidden="true"
            />
          ))}
          <i /><i /><i /><i />
        </div>
      </div>

      <footer>
        <p>拖动边框裁出完整题目，四角可调整范围。</p>
        <button type="button" onClick={() => onConfirm(clampCrop(crop, MIN_CROP))}>
          <Check size={18} />{confirmLabel}
        </button>
      </footer>
    </section>
  );
}
