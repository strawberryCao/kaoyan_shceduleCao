import { useEffect, useState } from 'react';
import { Download, File, FileCode2, FileImage, FileText } from 'lucide-react';
import * as mammoth from 'mammoth';

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
  .replaceAll('\\', '/')
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

  useEffect(() => {
    setSrc(item.url);
    setFailed(false);
  }, [item.url]);

  if (failed) return <ErrorPreview item={item} message="图片文件不存在或无法读取" />;
  return (
    <img
      className={className}
      src={src}
      alt={item.name}
      draggable={false}
      onError={() => {
        if (!usingFallback && item.fallbackUrl) setSrc(item.fallbackUrl);
        else setFailed(true);
      }}
      onLoad={() => {
        if (usingFallback) onRecovered(item);
      }}
    />
  );
}

function PdfPreview({ item, onRecovered }: Omit<WorkspaceAssetPreviewProps, 'assets'>) {
  const [objectUrl, setObjectUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    let nextObjectUrl = '';
    setObjectUrl('');
    setError('');
    void fetchAsset(item, abort.signal, onRecovered)
      .then((response) => response.blob())
      .then((blob) => {
        if (abort.signal.aborted) return;
        nextObjectUrl = URL.createObjectURL(blob);
        setObjectUrl(nextObjectUrl);
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'PDF 读取失败');
      });
    return () => {
      abort.abort();
      if (nextObjectUrl) URL.revokeObjectURL(nextObjectUrl);
    };
  }, [item.url, item.fallbackUrl, onRecovered]);

  if (error) return <ErrorPreview item={item} message={error} />;
  if (!objectUrl) return <div className="lrp-preview-loading">正在读取 PDF…</div>;
  return <iframe className="lrp-document-frame" src={objectUrl} title={item.name} />;
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
        setDocumentHtml(`<!doctype html><html><head><meta charset="utf-8"><style>
          body{font:16px/1.75 system-ui,sans-serif;padding:24px;max-width:900px;margin:auto;color:#202124}
          img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}
          td,th{border:1px solid #bbb;padding:6px}p{white-space:normal}
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
  const [mode, setMode] = useState<'safe' | 'run'>('safe');
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
      <div className="lrp-html-mode">
        <button type="button" className={mode === 'safe' ? 'active' : ''} onClick={() => setMode('safe')}>安全查看</button>
        <button type="button" className={mode === 'run' ? 'active' : ''} onClick={() => setMode('run')}>隔离运行</button>
        <span>{mode === 'run' ? '脚本在无同源权限且禁止联网的沙箱中运行' : '脚本已禁用'}</span>
      </div>
      <iframe
        className="lrp-document-frame"
        sandbox={mode === 'run' ? 'allow-scripts allow-forms allow-modals allow-downloads' : ''}
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
  if (item.kind === 'image') return <RecoverableImage item={item} onRecovered={onRecovered} />;
  if (item.kind === 'pdf') return <PdfPreview item={item} onRecovered={onRecovered} />;
  if (item.kind === 'word') return <WordPreview item={item} onRecovered={onRecovered} />;
  if (item.kind === 'html') return <HtmlPreview item={item} assets={assets} onRecovered={onRecovered} />;
  if (/\.(?:txt|md|css|js|mjs|json|svg)$/i.test(item.name)) return <TextPreview item={item} onRecovered={onRecovered} />;
  if (item.posterUrl) {
    return <RecoverableImage item={{ ...item, url: item.posterUrl, fallbackUrl: '', fallbackPath: '' }} onRecovered={onRecovered} className="lrp-real-image lrp-preview-poster" />;
  }
  return <GenericPreview item={item} />;
}
