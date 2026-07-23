export interface NormalizedCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const clampCrop = (crop: NormalizedCrop, minimum = 0.04): NormalizedCrop => {
  const width = clamp(Number(crop.width) || 0, minimum, 1);
  const height = clamp(Number(crop.height) || 0, minimum, 1);
  const x = clamp(Number(crop.x) || 0, 0, 1 - width);
  const y = clamp(Number(crop.y) || 0, 0, 1 - height);
  return { x, y, width, height };
};

export const DEFAULT_CROP: NormalizedCrop = {
  x: 0.035,
  y: 0.035,
  width: 0.93,
  height: 0.93,
};

const loadImageElement = (src: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const image = new Image();
  image.decoding = 'async';
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('图片加载失败，请重新选择。'));
  image.src = src;
});

export const cropImageDataUrl = async (
  src: string,
  rawCrop: NormalizedCrop,
  maxDimension = 2600,
): Promise<string> => {
  const image = await loadImageElement(src);
  const crop = clampCrop(rawCrop, 0.015);
  const sourceX = Math.round(crop.x * image.naturalWidth);
  const sourceY = Math.round(crop.y * image.naturalHeight);
  const sourceWidth = Math.max(1, Math.round(crop.width * image.naturalWidth));
  const sourceHeight = Math.max(1, Math.round(crop.height * image.naturalHeight));
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const outputWidth = Math.max(1, Math.round(sourceWidth * scale));
  const outputHeight = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('当前浏览器无法裁剪图片。');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, outputWidth, outputHeight);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    outputWidth,
    outputHeight,
  );
  return canvas.toDataURL('image/jpeg', 0.94);
};

export const cropManyImages = async (
  src: string,
  crops: NormalizedCrop[],
): Promise<string[]> => {
  const results: string[] = [];
  for (const crop of crops) results.push(await cropImageDataUrl(src, crop));
  return results;
};
