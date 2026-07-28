import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Download, File, FileCode2, FileImage, FileText, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import * as mammoth from 'mammoth';
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import '../learning-record-workspace-preview.css';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type WorkspacePreviewKind = 'image' | 'pdf' | 'word' | 'html' | 'file';

export interface WorkspaceAssetPreviewItem {
  id: string;
  kind: WorkspacePreviewKind;
  name: string;
  mimeType: string;
  filePath: string;
  fallbackPath: string;
  url: string;
  fallbackUrl: string;
  posterUrl: string;
  label: string;
  sizeLabel: string;
}

interface WorkspaceAssetPreviewProps {
  item: WorkspaceAssetPreviewItem;
  assets: WorkspaceAssetPreviewItem[];
  onRecovered: (item: WorkspaceAssetPreviewItem) => void;
}

const extensionOf = (name: string): string => name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
const resourceKey = (value: string): string => value
  .split('\\').join('/')
  .replace(/^\.\//, '')
  .split('/')
  .filter(Boolean)
  .at(-1)
  ?.toLowerCase() || '';

async function fetchAsset(
  item: WorkspaceAssetPreviewItem,
  signal: AbortSignal,
  onRecovered: (item: WorkspaceAssetPreviewItem) => void,
): Promise<Response> {
  let response = await fetch(item.url, { signal, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok && item.fallbackUrl) {
    response = await fetch(item.fallbackUrl, { signal, credentials: 'same-origin', cache: 'no-store' });
    if (response.ok) onRecovered(item);
  }
  if (!response.ok) throw new Error(`资料读取失败（${response.status}）`);
  const canonicalPath = response.headers.get('x-kaoyan-canonical-path')?.trim() || '';
  if (canonicalPath && canonicalPath !== item.filePath) {
    onRecovered({ ...item, fallbackPath: canonicalPath });
  }
  return response;
}

function ErrorPreview({ item, message }: { item: WorkspaceAssetPreviewItem; message: string }) {
  return (
    <div className="lrp-preview-error">
      <FileText size={28} />
      <strong>{message}</strong>
      <a href={item.fallbackUrl || item.url} download={item.name}>下载原文件</a>
    </div>
  );
}

function RecoverableImage({
  item,
  onRecovered,
  className = 'lrp-real-image',
}: {
  item: WorkspaceAssetPreviewItem;
  onRecovered: (item: WorkspaceAssetPreviewItem) => void;
  className?: string;
}) {
  const [src, setSrc] = useState(item.url);
  const usingFallback = Boolean(item.fallbackUrl) && src === item.fallbackUrl;
  const [failed, setFailed] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    setSrc(item.url);
    setFailed(false);
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [item.url]);

  if (failed) return <ErrorPreview item={item} message="图片文件不存在或无法读取" />;
  return (
    <div
      className={`lrp-image-viewer${scale > 1 ? ' is-zoomed' : ''}`}
      title="滚轮缩放，放大后按住拖动；双击恢复"
      onDoubleClick={() => {
        setScale((value) => value > 1 ? 1 : 2);
        setOffset({ x: 0, y: 0 });
      }}
      onWheel={(event) => {
        event.preventDefault();
        const next = Math.max(.5, Math.min(6, Math.round((scale + (event.deltaY < 0 ? .2 : -.2)) * 10) / 10));
        setScale(next);
        if (next <= 1) setOffset({ x: 0, y: 0 });
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || scale <= 1) return;
        const start = { x: offset.x, y: offset.y };
        const clientX = event.clientX;
        const clientY = event.clientY;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.classList.add('is-panning');
        const move = (next: PointerEvent) => {
          setOffset({
            x: start.x + next.clientX - clientX,
            y: start.y + next.clientY - clientY,
          });
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          window.removeEventListener('pointercancel', stop);
          event.currentTarget.classList.remove('is-panning');
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop, { once: true });
        window.addEventListener('pointercancel', stop, { once: true });
      }}
    >
      <img
        className={className}
        src={src}
        alt={item.name}
        draggable={false}
        style={{ transform: `translate3d(${offset.x}px,${offset.y}px,0) scale(${scale})` }}
        onError={() => {
          if (!usingFallback && item.fallbackUrl) setSrc(item.fallbackUrl);
          else setFailed(true);
        }}
        onLoad={() => {
          if (usingFallback) onRecovered(item);
        }}
      />
      {scale !== 1 && <span className="lrp-image-zoom-level">{Math.round(scale * 100)}%</span>}
    </div>
  );
}

function PdfPageCanvas({
  document,
  pageNumber,
  scale,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    setError('');
    void document.getPage(pageNumber).then((page) => {
      if (cancelled || !canvasRef.current) return;
      const viewport = page.getViewport({ scale });
      const outputScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('浏览器无法创建 PDF 画布');
      canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
      canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.style.height = `${Math.round(viewport.height)}px`;
      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      });
      return renderTask.promise;
    }).catch((reason: unknown) => {
      if (!cancelled && (reason as { name?: string })?.name !== 'RenderingCancelledException') {
        setError(reason instanceof Error ? reason.message : 'PDF 页面渲染失败');
      }
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, pageNumber, scale]);

  return (
    <section className="lrp-pdf-page" aria-label={`PDF 第 ${pageNumber} 页`}>
      <canvas ref={canvasRef} />
      {error && <span>{error}</span>}
    </section>
  );
}

function PdfPreview({ item, onRecovered }: Omit<WorkspaceAssetPreviewProps, 'assets'>) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    setDocument(null);
    setZoom(1);
    setError('');
    void fetchAsset(item, abort.signal, onRecovered)
      .then((response) => response.arrayBuffer())
      .then((arrayBuffer) => {
        if (abort.signal.aborted) return;
        loadingTask = getDocument({ data: new Uint8Array(arrayBuffer) });
        return loadingTask.promise;
      })
      .then((pdf) => {
        if (!pdf || abort.signal.aborted) return;
        setDocument(pdf);
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'PDF 读取失败');
      });
    return () => {
      abort.abort();
      loadingTask?.destroy();
    };
  }, [item.url, item.fallbackUrl, onRecovered]);

  useEffect(() => {
    if (!document || !viewportRef.current) return undefined;
    let cancelled = false;
    const viewport = viewportRef.current;
    const resize = async () => {
      const page = await document.getPage(1);
      if (cancelled) return;
      const natural = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(180, viewport.clientWidth - 28);
      setFitScale(Math.max(.25, Math.min(3, availableWidth / natural.width)));
    };
    void resize();
    const observer = new ResizeObserver(() => { void resize(); });
    observer.observe(viewport);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [document]);

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !viewportRef.current) return;
    const viewport = viewportRef.current;
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = viewport.scrollLeft;
    const startTop = viewport.scrollTop;
    let moved = false;
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('is-panning');
    const move = (next: PointerEvent) => {
      if (Math.hypot(next.clientX - startX, next.clientY - startY) > 3) moved = true;
      viewport.scrollLeft = startLeft - (next.clientX - startX);
      viewport.scrollTop = startTop - (next.clientY - startY);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      viewport.classList.remove('is-panning');
      if (moved) window.getSelection()?.removeAllRanges();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
  };

  if (error) return <ErrorPreview item={item} message={error} />;
  if (!document) return <div className="lrp-preview-loading">正在读取 PDF…</div>;
  const scale = fitScale * zoom;
  return (
    <div className="lrp-pdf-preview">
      <div className="lrp-pdf-toolbar">
        <button type="button" onClick={() => setZoom((value) => Math.max(.5, Math.round((value - .2) * 10) / 10))} aria-label="缩小 PDF"><ZoomOut size={14} /></button>
        <button type="button" onClick={() => setZoom(1)} title="适合窗口"><Maximize2 size={13} /><span>{Math.round(zoom * 100)}%</span></button>
        <button type="button" onClick={() => setZoom((value) => Math.min(4, Math.round((value + .2) * 10) / 10))} aria-label="放大 PDF"><ZoomIn size={14} /></button>
        <em>{document.numPages} 页</em>
      </div>
      <div
        className="lrp-pdf-scroll"
        ref={viewportRef}
        onPointerDown={beginPan}
        onWheel={(event) => {
          if (!event.ctrlKey) return;
          event.preventDefault();
          setZoom((value) => Math.max(.5, Math.min(4, value + (event.deltaY < 0 ? .2 : -.2))));
        }}
      >
        <div className="lrp-pdf-pages">
          {Array.from({ length: document.numPages }, (_, index) => (
            <PdfPageCanvas document={document} pageNumber={index + 1} scale={scale} key={index + 1} />
          ))}
        </div>
      </div>
    </div>
  );
}

function WordPreview({ item, onRecovered }: Omit<WorkspaceAssetPreviewProps, 'assets'>) {
  const [documentHtml, setDocumentHtml] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    setDocumentHtml('');
    setError('');
    void fetchAsset(item, abort.signal, onRecovered)
      .then((response) => response.arrayBuffer())
      .then((arrayBuffer) => mammoth.convertToHtml(
        { arrayBuffer },
        {
          convertImage: mammoth.images.imgElement((image) => image.read('base64').then((value) => ({
            src: `data:${image.contentType};base64,${value}`,
          }))),
        },
      ))
      .then((result) => {
        if (abort.signal.aborted) return;
        const warnings = result.messages
          .map((entry) => entry.message)
          .filter(Boolean)
          .slice(0, 6);
        const warningHtml = warnings.length > 0
          ? `<hr><small>${warnings.map((value) => value.replace(/[<>&]/g, '')).join('；')}</small>`
          : '';
        setDocumentHtml(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
          *,*::before,*::after{box-sizing:border-box}
          html,body{width:100%;max-width:100%;min-width:0;margin:0;overflow:auto}
          body{font:16px/1.75 system-ui,sans-serif;padding:clamp(14px,4vw,28px);color:#202124;overflow-wrap:anywhere}
          body>*{max-width:100%}
          img,svg,video,canvas,iframe{max-width:100%;height:auto}
          table{width:max-content;max-width:100%;display:block;overflow:auto;border-collapse:collapse}
          td,th{border:1px solid #bbb;padding:6px}p{white-space:normal}
          pre,code{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere}
        </style></head><body>${result.value}${warningHtml}</body></html>`);
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'Word 读取失败');
      });
    return () => abort.abort();
  }, [item.url, item.fallbackUrl, onRecovered]);

  if (error) return <ErrorPreview item={item} message={error} />;
  if (!documentHtml) return <div className="lrp-preview-loading">正在解析 Word 文档…</div>;
  return <iframe className="lrp-document-frame" sandbox="" srcDoc={documentHtml} title={item.name} />;
}

interface LoadedResource {
  asset: WorkspaceAssetPreviewItem;
  blob: Blob;
  text: string | null;
}

async function loadHtmlProject(
  item: WorkspaceAssetPreviewItem,
  assets: WorkspaceAssetPreviewItem[],
  signal: AbortSignal,
  onRecovered: (item: WorkspaceAssetPreviewItem) => void,
): Promise<{ html: string; objectUrls: string[] }> {
  const entryHtml = await fetchAsset(item, signal, onRecovered).then((response) => response.text());
  const resources: LoadedResource[] = [];

  for (const asset of assets) {
    if (asset.id === item.id) continue;
    try {
      const response = await fetchAsset(asset, signal, onRecovered);
      const extension = extensionOf(asset.name);
      const text = ['.css', '.js', '.mjs', '.json', '.svg', '.txt', '.md'].includes(extension)
        ? await response.clone().text()
        : null;
      resources.push({ asset, blob: await response.blob(), text });
    } catch {
      // Optional resources do not prevent the HTML entry document from opening.
    }
  }

  const objectUrls: string[] = [];
  const urlMap = new Map<string, string>();
  const textMap = new Map<string, string>();

  for (const resource of resources) {
    const key = resourceKey(resource.asset.name);
    if (resource.text !== null) textMap.set(key, resource.text);
    if (extensionOf(resource.asset.name) === '.css' || ['.js', '.mjs'].includes(extensionOf(resource.asset.name))) continue;
    const blob = resource.text === null
      ? resource.blob
      : new Blob([resource.text], { type: resource.asset.mimeType || resource.blob.type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    urlMap.set(key, url);
  }

  const resolveCssUrls = (css: string): string => css.replace(
    /url\((['"]?)([^)'"?]+)\1\)/gi,
    (whole, _quote: string, raw: string) => {
      const replacement = urlMap.get(resourceKey(String(raw)));
      return replacement ? `url("${replacement}")` : whole;
    },
  );

  const document = new DOMParser().parseFromString(entryHtml, 'text/html');
  const csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src 'none'; img-src blob: data:; media-src blob: data:; font-src blob: data:; style-src 'unsafe-inline' blob:; script-src 'unsafe-inline' blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
  document.head.prepend(csp);
  if (!document.querySelector('meta[charset]')) {
    const charset = document.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    document.head.prepend(charset);
  }
  if (!document.querySelector('meta[name="viewport"]')) {
    const viewport = document.createElement('meta');
    viewport.setAttribute('name', 'viewport');
    viewport.setAttribute('content', 'width=device-width, initial-scale=1');
    document.head.append(viewport);
  }
  const responsiveStyle = document.createElement('style');
  responsiveStyle.textContent = `
    *,*::before,*::after{box-sizing:border-box}
    html,body{width:100%;max-width:100%;min-width:0;min-height:100%;margin:0;overflow:auto}
    body>*{max-width:100%}
    img,video,svg{max-width:100%;height:auto}
    canvas,iframe{max-width:100%;height:auto}
    table{max-width:100%;display:block;overflow:auto}
    pre,code{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere}
  `;
  document.head.append(responsiveStyle);

  document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]').forEach((link) => {
    const css = textMap.get(resourceKey(link.getAttribute('href') || ''));
    if (css === undefined) return;
    const style = document.createElement('style');
    style.textContent = resolveCssUrls(css);
    link.replaceWith(style);
  });

  document.querySelectorAll<HTMLScriptElement>('script[src]').forEach((script) => {
    const key = resourceKey(script.getAttribute('src') || '');
    const scriptText = textMap.get(key);
    if (scriptText === undefined) return;
    script.removeAttribute('src');
    script.textContent = scriptText;
  });

  document.querySelectorAll<HTMLElement>('[src],[href]').forEach((element) => {
    for (const attribute of ['src', 'href']) {
      const value = element.getAttribute(attribute);
      if (!value || /^(?:[a-z]+:|#|\/\/)/i.test(value)) continue;
      const replacement = urlMap.get(resourceKey(value));
      if (replacement) element.setAttribute(attribute, replacement);
    }
  });

  return {
    html: `<!doctype html>${document.documentElement.outerHTML}`,
    objectUrls,
  };
}

function HtmlPreview({ item, assets, onRecovered }: WorkspaceAssetPreviewProps) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    let objectUrls: string[] = [];
    setHtml('');
    setError('');
    void loadHtmlProject(item, assets, abort.signal, onRecovered)
      .then((result) => {
        if (abort.signal.aborted) return;
        objectUrls = result.objectUrls;
        setHtml(result.html.slice(0, 8 * 1024 * 1024));
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'HTML 读取失败');
      });
    return () => {
      abort.abort();
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [item.url, item.fallbackUrl, assets, onRecovered]);

  if (error) return <ErrorPreview item={item} message={error} />;
  if (!html) return <div className="lrp-preview-loading">正在装载 HTML / Web 资料…</div>;
  return (
    <div className="lrp-html-preview">
      <iframe
        className="lrp-document-frame"
        sandbox="allow-scripts allow-forms allow-modals allow-downloads"
        srcDoc={html}
        title={item.name}
      />
    </div>
  );
}

function TextPreview({ item, onRecovered }: Omit<WorkspaceAssetPreviewProps, 'assets'>) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    setText('');
    setError('');
    void fetchAsset(item, abort.signal, onRecovered)
      .then((response) => response.text())
      .then((value) => {
        if (!abort.signal.aborted) setText(value.slice(0, 2 * 1024 * 1024));
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '文本读取失败');
      });
    return () => abort.abort();
  }, [item.url, item.fallbackUrl, onRecovered]);

  if (error) return <ErrorPreview item={item} message={error} />;
  if (!text) return <div className="lrp-preview-loading">正在读取文本…</div>;
  return <pre className="lrp-text-preview">{text}</pre>;
}

function GenericPreview({ item }: { item: WorkspaceAssetPreviewItem }) {
  const Glyph = item.kind === 'image' ? FileImage : item.kind === 'html' ? FileCode2 : item.kind === 'file' ? File : FileText;
  return (
    <article className={`lrp-file-preview is-${item.kind}`}>
      <span><Glyph size={22} /></span>
      <small>{item.label} · {item.sizeLabel}</small>
      <h2>{item.name}</h2>
      <p>该资料暂不支持内嵌预览，可下载到本机打开。</p>
      <a href={item.fallbackUrl || item.url} download={item.name}><Download size={16} />打开 / 下载</a>
    </article>
  );
}

export function WorkspaceAssetPreview({ item, assets, onRecovered }: WorkspaceAssetPreviewProps) {
  const onRecoveredRef = useRef(onRecovered);
  useEffect(() => {
    onRecoveredRef.current = onRecovered;
  }, [onRecovered]);
  const stableOnRecovered = useCallback((recoveredItem: WorkspaceAssetPreviewItem) => {
    onRecoveredRef.current(recoveredItem);
  }, []);

  if (item.kind === 'image') return <RecoverableImage item={item} onRecovered={stableOnRecovered} />;
  if (item.kind === 'pdf') return <PdfPreview item={item} onRecovered={stableOnRecovered} />;
  if (item.kind === 'word') return <WordPreview item={item} onRecovered={stableOnRecovered} />;
  if (item.kind === 'html') return <HtmlPreview item={item} assets={assets} onRecovered={stableOnRecovered} />;
  if (/\.(?:txt|md|css|js|mjs|json|svg)$/i.test(item.name)) return <TextPreview item={item} onRecovered={stableOnRecovered} />;
  if (item.posterUrl) {
    return <RecoverableImage item={{ ...item, url: item.posterUrl, fallbackUrl: '', fallbackPath: '' }} onRecovered={stableOnRecovered} className="lrp-real-image lrp-preview-poster" />;
  }
  return <GenericPreview item={item} />;
}
