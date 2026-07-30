import { NOTE_SERVER_URL } from './notes';

export const KAOYAN_RELAY_MIME = 'application/x-kaoyan-material-v1';
export const KAOYAN_RELAY_TEXT_PREFIX = 'KAOYAN_MATERIAL_V1:';

export interface CrossBrowserRelayAsset {
  id: string;
  kind: 'image' | 'pdf' | 'word' | 'html' | 'file';
  name: string;
  mimeType: string;
  url: string;
  fallbackUrl: string;
  posterUrl: string;
  label: string;
  sizeLabel: string;
}

interface CrossBrowserRelayDescriptor {
  protocol: 'kaoyan-material-v1';
  transferId: string;
  relayUrl: string;
  kind: CrossBrowserRelayAsset['kind'];
  name: string;
  mimeType: string;
  createdAt: number;
}

const absoluteHttpUrl = (value: string): string => {
  if (!value || typeof window === 'undefined') return '';
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
};

const directRelayBase = (): string => {
  if (typeof window === 'undefined') return NOTE_SERVER_URL;
  if (/^https?:\/\//i.test(NOTE_SERVER_URL)) return NOTE_SERVER_URL;
  return new URL(NOTE_SERVER_URL, window.location.href).toString().replace(/\/+$/, '');
};

const compactAsset = (asset: CrossBrowserRelayAsset) => ({
  id: asset.id.slice(0, 180),
  kind: asset.kind,
  name: asset.name.slice(0, 240),
  mimeType: asset.mimeType.slice(0, 160),
  url: absoluteHttpUrl(asset.url),
  fallbackUrl: absoluteHttpUrl(asset.fallbackUrl),
  posterUrl: absoluteHttpUrl(asset.posterUrl),
  label: asset.label.slice(0, 80),
  sizeLabel: asset.sizeLabel.slice(0, 80),
});

const registerRelayTransfer = async (
  transferId: string,
  asset: CrossBrowserRelayAsset,
): Promise<void> => {
  const response = await fetch(`${NOTE_SERVER_URL}/relay-transfers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transferId, asset: compactAsset(asset) }),
    keepalive: true,
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(result?.error || `资料接力登记失败（${response.status}）`);
  }
};

const base64Url = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const makeDragImage = (asset: CrossBrowserRelayAsset): HTMLCanvasElement => {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = 286;
  const height = 58;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  context.scale(ratio, ratio);
  context.shadowColor = 'rgba(36, 29, 22, .2)';
  context.shadowBlur = 18;
  context.shadowOffsetY = 8;
  context.fillStyle = 'rgba(255, 253, 249, .97)';
  context.beginPath();
  context.roundRect(7, 5, width - 14, height - 14, 13);
  context.fill();
  context.shadowColor = 'transparent';
  context.fillStyle = '#eee9e2';
  context.beginPath();
  context.roundRect(18, 16, 42, 28, 8);
  context.fill();
  context.fillStyle = '#7b5736';
  context.font = '700 11px "Segoe UI", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(asset.kind === 'image' ? 'IMG' : asset.kind === 'word' ? 'DOC' : asset.kind.toUpperCase(), 39, 30);
  context.fillStyle = '#3f3a35';
  context.font = '650 13px "Segoe UI", "Microsoft YaHei", sans-serif';
  context.textAlign = 'left';
  const displayName = asset.name.length > 25 ? `${asset.name.slice(0, 24)}…` : asset.name;
  context.fillText(displayName, 72, 27);
  context.fillStyle = '#8b8177';
  context.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
  context.fillText('拖到 Edge 页面以接力', 72, 42);
  return canvas;
};

export const beginCrossBrowserRelayDrag = (
  dataTransfer: DataTransfer,
  asset: CrossBrowserRelayAsset,
): string => {
  const transferId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `relay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
  const relayBase = directRelayBase().replace(/\/+$/, '');
  const descriptor: CrossBrowserRelayDescriptor = {
    protocol: 'kaoyan-material-v1',
    transferId,
    relayUrl: `${relayBase}/relay-transfers/${encodeURIComponent(transferId)}`,
    kind: asset.kind,
    name: asset.name.slice(0, 240),
    mimeType: asset.mimeType.slice(0, 160),
    createdAt: Date.now(),
  };
  const serialized = JSON.stringify(descriptor);

  dataTransfer.effectAllowed = 'copy';
  dataTransfer.setData(KAOYAN_RELAY_MIME, serialized);
  dataTransfer.setData('text/plain', `${KAOYAN_RELAY_TEXT_PREFIX}${base64Url(serialized)}`);
  try {
    dataTransfer.items.add(new File(
      [serialized],
      `kaoyan-relay-${transferId}.json`,
      { type: KAOYAN_RELAY_MIME },
    ));
  } catch {
    // Custom text data remains the primary Chromium-to-Chromium transport.
  }
  const dragImage = makeDragImage(asset);
  dragImage.style.position = 'fixed';
  dragImage.style.zIndex = '-1';
  dragImage.style.left = '0';
  dragImage.style.top = '0';
  dragImage.style.opacity = '0.001';
  dragImage.style.pointerEvents = 'none';
  document.body.append(dragImage);
  dataTransfer.setDragImage(dragImage, 34, 29);
  window.setTimeout(() => dragImage.remove(), 0);

  void registerRelayTransfer(transferId, asset).catch((error) => {
    console.error('[cross-browser-relay] registration failed', error);
  });
  return transferId;
};
