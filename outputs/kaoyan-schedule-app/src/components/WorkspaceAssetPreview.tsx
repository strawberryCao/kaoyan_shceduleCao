import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Download, File, FileCode2, FileImage, FileText, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import * as mammoth from 'mammoth';
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';
import '../learning-record-workspace-preview.css';

// Keep PDF rendering independent from the static server's asset hashes and MIME
// table. A bundled worker also survives rebuilding `dist` while the LAN page is
// still open, instead of leaving that page pointed at a deleted hashed module.
GlobalWorkerOptions.workerPort = new PdfWorker();

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
  onIntrinsicSize?: (width: number, height: number) => void;
}

const extensionOf = (name: string): string => name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
const resourceKey = (value: string): string => value
  .split('\\').join('/')
  .replace(/^\.\//, '')
  .split('/')
  .filter(Boolean)
  .at(-1)
  ?.toLowerCase() || '';

function usePreviewSizeBridge(onIntrinsicSize?: (width: number, height: number) => void) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const tokenRef = useRef(`kaoyan-preview-${Math.random().toString(36).slice(2)}-${Date.now()}`);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const payload = event.data;
      if (
        event.source !== frameRef.current?.contentWindow
        || payload?.type !== 'kaoyan-preview-intrinsic-size'
        || payload?.token !== tokenRef.current
      ) return;
      const width = Number(payload.width);
      const height = Number(payload.height);
      if (width > 0 && height > 0) onIntrinsicSize?.(width, height);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [onIntrinsicSize]);
  return { frameRef, token: tokenRef.current };
}

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
  onIntrinsicSize,
  className = 'lrp-real-image',
}: {
  item: WorkspaceAssetPreviewItem;
  onRecovered: (item: WorkspaceAssetPreviewItem) => void;
  onIntrinsicSize?: (width: number, height: number) => void;
  className?: string;
}) {
  const [src, setSrc] = useState(item.url);
  const usingFallback = Boolean(item.fallbackUrl) && src === item.fallbackUrl;
  const [failed, setFailed] = useState(false);
  const [scale, setScale] = useState(1);
  const [zoomActive, setZoomActive] = useState(false);
  const viewerRef = useRef<HTMLDivElement | null>(null);

  const updateScale = useCallback((next: number | ((current: number) => number)) => {
    setScale((current) => {
      const resolved = Math.max(.5, Math.min(6, typeof next === 'function' ? next(current) : next));
      return Math.round(resolved * 100) / 100;
    });
  }, []);

  useEffect(() => {
    setSrc(item.url);
    setFailed(false);
    setScale(1);
    setZoomActive(false);
    viewerRef.current?.scrollTo({ left: 0, top: 0 });
  }, [item.url]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return undefined;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      setZoomActive(true);
      const nextScale = Math.round(Math.max(.5, Math.min(6, scale * Math.exp(-event.deltaY * .0022))) * 100) / 100;
      const rect = viewer.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      const contentX = (viewer.scrollLeft + localX) / scale;
      const contentY = (viewer.scrollTop + localY) / scale;
      setScale(nextScale);
      requestAnimationFrame(() => {
        viewer.scrollLeft = Math.max(0, contentX * nextScale - localX);
        viewer.scrollTop = Math.max(0, contentY * nextScale - localY);
      });
    };
    viewer.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewer.removeEventListener('wheel', handleWheel);
  }, [scale]);

  if (failed) return <ErrorPreview item={item} message="图片文件不存在或无法读取" />;
  return (
    <div
      ref={viewerRef}
      className={`lrp-image-viewer${scale > 1 ? ' is-zoomed' : ''}${zoomActive ? ' is-zoom-active' : ''}`}
      title={zoomActive
        ? '滚轮上下查看；Ctrl + 滚轮缩放；放大后可按住拖动'
        : '点击图片启用 Ctrl + 滚轮缩放'}
      tabIndex={0}
      onClick={() => setZoomActive(true)}
      onFocus={() => setZoomActive(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setZoomActive(false);
      }}
      onDoubleClick={(event) => {
        updateScale((value) => value > 1 ? 1 : 2);
        event.currentTarget.scrollTo({ left: 0, top: 0 });
      }}
      onPointerDown={(event) => {
        const viewer = event.currentTarget;
        if (
          event.button !== 0
          || (viewer.scrollWidth <= viewer.clientWidth && viewer.scrollHeight <= viewer.clientHeight)
        ) return;
        const clientX = event.clientX;
        const clientY = event.clientY;
        const startLeft = viewer.scrollLeft;
        const startTop = viewer.scrollTop;
        viewer.setPointerCapture(event.pointerId);
        viewer.classList.add('is-panning');
        const move = (next: PointerEvent) => {
          viewer.scrollLeft = startLeft - (next.clientX - clientX);
          viewer.scrollTop = startTop - (next.clientY - clientY);
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          window.removeEventListener('pointercancel', stop);
          viewer.classList.remove('is-panning');
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
        style={{ width: `${scale * 100}%` }}
        onError={() => {
          if (!usingFallback && item.fallbackUrl) setSrc(item.fallbackUrl);
          else setFailed(true);
        }}
        onLoad={(event) => {
          if (usingFallback) onRecovered(item);
          const image = event.currentTarget;
          if (image.naturalWidth > 0 && image.naturalHeight > 0) {
            onIntrinsicSize?.(image.naturalWidth, image.naturalHeight);
          }
        }}
      />
      <div className="lrp-image-zoom-controls" onDoubleClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          onClick={() => updateScale((value) => value - .25)}
          aria-label="缩小图片"
        >
          <ZoomOut size={14} />
        </button>
        <button
          type="button"
          onClick={() => {
            setScale(1);
            viewerRef.current?.scrollTo({ left: 0, top: 0 });
          }}
          title="适合窗口"
        >
          <Maximize2 size={13} /><span>{Math.round(scale * 100)}%</span>
        </button>
        <button
          type="button"
          onClick={() => updateScale((value) => value + .25)}
          aria-label="放大图片"
        >
          <ZoomIn size={14} />
        </button>
      </div>
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

function PdfPreview({ item, onRecovered, onIntrinsicSize }: Omit<WorkspaceAssetPreviewProps, 'assets'>) {
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
      const preferredWidth = Math.min(760, Math.max(420, natural.width + 28));
      const preferredHeight = Math.min(680, Math.max(300, (preferredWidth - 28) * (natural.height / natural.width) + 62));
      onIntrinsicSize?.(preferredWidth, preferredHeight);
    };
    void resize();
    const observer = new ResizeObserver(() => { void resize(); });
    observer.observe(viewport);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [document, onIntrinsicSize]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const preventBrowserZoom = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
    };
    viewport.addEventListener('wheel', preventBrowserZoom, { passive: false });
    return () => viewport.removeEventListener('wheel', preventBrowserZoom);
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

function WordPreview({ item, onRecovered, onIntrinsicSize }: Omit<WorkspaceAssetPreviewProps, 'assets'>) {
  const [documentHtml, setDocumentHtml] = useState('');
  const [error, setError] = useState('');
  const { frameRef, token } = usePreviewSizeBridge(onIntrinsicSize);

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
          html,body{width:100%;max-width:100%;min-width:0;margin:0;overflow:auto;overscroll-behavior:contain}
          body{font:16px/1.75 system-ui,sans-serif;padding:clamp(14px,4vw,28px);color:#202124;overflow-wrap:anywhere}
          body>*{max-width:100%}
          img,svg,video,canvas,iframe{max-width:100%;height:auto}
          table{width:max-content;max-width:100%;display:block;overflow:auto;border-collapse:collapse}
          td,th{border:1px solid #bbb;padding:6px}p{white-space:normal}
          pre,code{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere}
        </style></head><body>${result.value}${warningHtml}<script>
          (()=>{addEventListener('wheel',(event)=>{if(event.ctrlKey)event.preventDefault()},{passive:false});const send=()=>parent.postMessage({type:'kaoyan-preview-intrinsic-size',token:${JSON.stringify(token)},width:Math.min(760,Math.max(320,document.documentElement.scrollWidth)),height:Math.min(700,Math.max(180,document.documentElement.scrollHeight))},'*');addEventListener('load',()=>setTimeout(send,180),{once:true});setTimeout(send,600)})()
        </script></body></html>`);
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'Word 读取失败');
      });
    return () => abort.abort();
  }, [item.url, item.fallbackUrl, onRecovered, token]);

  if (error) return <ErrorPreview item={item} message={error} />;
  if (!documentHtml) return <div className="lrp-preview-loading">正在解析 Word 文档…</div>;
  return <iframe ref={frameRef} className="lrp-document-frame" sandbox="allow-scripts" srcDoc={documentHtml} title={item.name} />;
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
  sizeToken: string,
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
    html,body{width:max-content;max-width:none;min-width:0;height:auto;min-height:0;margin:0;overflow:auto;overscroll-behavior:contain}
    #kaoyan-fit-root{display:inline-block;width:max-content;min-width:0;height:auto;min-height:0;transform-origin:0 0}
    img,video,svg{height:auto}
    table{max-width:100%;display:block;overflow:auto}
    pre,code{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere}
  `;
  document.head.append(responsiveStyle);

  const fitRoot = document.createElement('div');
  fitRoot.id = 'kaoyan-fit-root';
  while (document.body.firstChild) fitRoot.append(document.body.firstChild);
  document.body.append(fitRoot);
  const fitScript = document.createElement('script');
  fitScript.textContent = `
    (() => {
      const root = document.getElementById('kaoyan-fit-root');
      if (!root) return;
      addEventListener('wheel', (event) => {
        if (event.ctrlKey) event.preventDefault();
      }, { passive: false });
      const sizeToken = ${JSON.stringify(sizeToken)};
      let fitting = false;
      const fit = () => {
        if (fitting) return;
        fitting = true;
        requestAnimationFrame(() => {
          root.style.zoom = '1';
          const rect = root.getBoundingClientRect();
          const children = [...root.children].map((child) => child.getBoundingClientRect());
          const naturalWidth = Math.max(
            root.scrollWidth,
            rect.width,
            ...children.map((child) => child.right - rect.left),
            1
          );
          const naturalHeight = Math.max(
            root.scrollHeight,
            rect.height,
            ...children.map((child) => child.bottom - rect.top),
            1
          );
          const widthScale = Math.max(.25, (innerWidth - 2) / naturalWidth);
          const scale = Math.min(1, widthScale);
          root.style.zoom = String(scale);
          parent.postMessage({
            type: 'kaoyan-preview-intrinsic-size',
            token: sizeToken,
            width: Math.ceil(naturalWidth),
            height: Math.ceil(naturalHeight),
          }, '*');
          fitting = false;
        });
      };
      addEventListener('resize', fit, { passive: true });
      addEventListener('load', () => setTimeout(fit, 60), { once: true });
      new MutationObserver(fit).observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      if (document.fonts?.ready) document.fonts.ready.then(fit);
      setTimeout(fit, 80);
      setTimeout(fit, 500);
    })();
  `;
  document.body.append(fitScript);

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

function HtmlPreview({ item, assets, onRecovered, onIntrinsicSize }: WorkspaceAssetPreviewProps) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const { frameRef, token } = usePreviewSizeBridge(onIntrinsicSize);

  useEffect(() => {
    const abort = new AbortController();
    let objectUrls: string[] = [];
    setHtml('');
    setError('');
    void loadHtmlProject(item, assets, abort.signal, onRecovered, token)
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
  }, [item.url, item.fallbackUrl, assets, onRecovered, token]);

  if (error) return <ErrorPreview item={item} message={error} />;
  if (!html) return <div className="lrp-preview-loading">正在装载 HTML / Web 资料…</div>;
  return (
    <div className="lrp-html-preview">
      <iframe
        ref={frameRef}
        className="lrp-document-frame"
        sandbox="allow-scripts allow-forms allow-modals allow-downloads"
        srcDoc={html}
        title={item.name}
      />
    </div>
  );
}

function TextPreview({ item, onRecovered, onIntrinsicSize }: Omit<WorkspaceAssetPreviewProps, 'assets'>) {
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

  useEffect(() => {
    if (!text) return;
    const lines = text.split(/\r?\n/);
    const longest = lines.reduce((length, line) => Math.max(length, line.length), 0);
    onIntrinsicSize?.(
      Math.min(760, Math.max(340, longest * 7.5 + 40)),
      Math.min(700, Math.max(200, lines.length * 22 + 40)),
    );
  }, [onIntrinsicSize, text]);

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

export function WorkspaceAssetPreview({ item, assets, onRecovered, onIntrinsicSize }: WorkspaceAssetPreviewProps) {
  const onRecoveredRef = useRef(onRecovered);
  useEffect(() => {
    onRecoveredRef.current = onRecovered;
  }, [onRecovered]);
  const stableOnRecovered = useCallback((recoveredItem: WorkspaceAssetPreviewItem) => {
    onRecoveredRef.current(recoveredItem);
  }, []);

  if (item.kind === 'image') return <RecoverableImage item={item} onRecovered={stableOnRecovered} onIntrinsicSize={onIntrinsicSize} />;
  if (item.kind === 'pdf') return <PdfPreview item={item} onRecovered={stableOnRecovered} onIntrinsicSize={onIntrinsicSize} />;
  if (item.kind === 'word') return <WordPreview item={item} onRecovered={stableOnRecovered} onIntrinsicSize={onIntrinsicSize} />;
  if (item.kind === 'html') return <HtmlPreview item={item} assets={assets} onRecovered={stableOnRecovered} onIntrinsicSize={onIntrinsicSize} />;
  if (/\.(?:txt|md|css|js|mjs|json|svg)$/i.test(item.name)) return <TextPreview item={item} onRecovered={stableOnRecovered} onIntrinsicSize={onIntrinsicSize} />;
  if (item.posterUrl) {
    return <RecoverableImage item={{ ...item, url: item.posterUrl, fallbackUrl: '', fallbackPath: '' }} onRecovered={stableOnRecovered} onIntrinsicSize={onIntrinsicSize} className="lrp-real-image lrp-preview-poster" />;
  }
  return <GenericPreview item={item} />;
}
