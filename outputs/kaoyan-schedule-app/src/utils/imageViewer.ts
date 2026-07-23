export const IMAGE_VIEWER_MIN_SCALE = 0.1;
export const IMAGE_VIEWER_MAX_SCALE = 8;

export interface ImageViewerPoint {
  x: number;
  y: number;
}

export interface ImageViewerSize {
  width: number;
  height: number;
}

export interface ImageViewerTransform {
  scale: number;
  pan: ImageViewerPoint;
}

export const clampImageViewerScale = (scale: number): number => Math.min(
  IMAGE_VIEWER_MAX_SCALE,
  Math.max(IMAGE_VIEWER_MIN_SCALE, Number.isFinite(scale) ? scale : 1),
);

export const normalizeImageViewerRotation = (rotation: number): number => (
  ((Math.round(rotation / 90) * 90) % 360) + 360
) % 360;

export const rotatedImageViewerSize = (
  image: ImageViewerSize,
  rotation: number,
): ImageViewerSize => {
  const normalizedRotation = normalizeImageViewerRotation(rotation);
  return normalizedRotation % 180 === 0
    ? image
    : { width: image.height, height: image.width };
};

export const fitImageViewerScale = (
  image: ImageViewerSize,
  viewport: ImageViewerSize,
  rotation = 0,
): number => {
  const rotated = rotatedImageViewerSize(image, rotation);
  if (rotated.width <= 0 || rotated.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return 1;
  }

  return clampImageViewerScale(Math.min(
    1,
    viewport.width / rotated.width,
    viewport.height / rotated.height,
  ));
};

export const zoomImageViewerAtPoint = (
  transform: ImageViewerTransform,
  requestedScale: number,
  anchor: ImageViewerPoint,
  viewport: ImageViewerSize,
): ImageViewerTransform => {
  const scale = clampImageViewerScale(requestedScale);
  if (Math.abs(scale - transform.scale) < 0.0001) return transform;

  const ratio = scale / transform.scale;
  const centeredAnchor = {
    x: anchor.x - viewport.width / 2,
    y: anchor.y - viewport.height / 2,
  };

  return {
    scale,
    pan: {
      x: centeredAnchor.x - (centeredAnchor.x - transform.pan.x) * ratio,
      y: centeredAnchor.y - (centeredAnchor.y - transform.pan.y) * ratio,
    },
  };
};

export const clampImageViewerPan = (
  pan: ImageViewerPoint,
  image: ImageViewerSize,
  viewport: ImageViewerSize,
  scale: number,
  rotation = 0,
  overscroll = 36,
): ImageViewerPoint => {
  const rotated = rotatedImageViewerSize(image, rotation);
  const displayedWidth = rotated.width * scale;
  const displayedHeight = rotated.height * scale;
  const horizontalRange = displayedWidth <= viewport.width
    ? 0
    : (displayedWidth - viewport.width) / 2 + overscroll;
  const verticalRange = displayedHeight <= viewport.height
    ? 0
    : (displayedHeight - viewport.height) / 2 + overscroll;

  return {
    x: horizontalRange === 0 ? 0 : Math.min(horizontalRange, Math.max(-horizontalRange, pan.x)),
    y: verticalRange === 0 ? 0 : Math.min(verticalRange, Math.max(-verticalRange, pan.y)),
  };
};
