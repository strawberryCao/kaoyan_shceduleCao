'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(path.join(root, relative), value, 'utf8');

function replaceOnce(source, search, replacement, label) {
  if (source.includes(replacement)) return source;
  const next = typeof search === 'string' ? source.replace(search, replacement) : source.replace(search, replacement);
  if (next === source) throw new Error(`Patch target not found: ${label}`);
  return next;
}

function appendOnce(source, marker, value) {
  return source.includes(marker) ? source : `${source.trimEnd()}\n\n${value.trim()}\n`;
}

// Expand the速记 material package to common web project resources.
{
  const file = 'src/components/QuickMaterialComposer.tsx';
  let source = read(file);
  source = source.replace('<strong>文字 / 多资料速记</strong>', '<strong>速记</strong>');
  source = source.replace('加入图片、PDF、Word、HTML 或文本', '加入图片、PDF、Word、HTML、网页资源或文本');
  source = source.replace('accept="image/*,.pdf,.doc,.docx,.html,.htm,.txt,.md"', 'accept="image/*,.pdf,.doc,.docx,.html,.htm,.css,.js,.mjs,.json,.svg,.txt,.md"');
  write(file, source);
}

// Local file service: allow web resources and recover historical absolute paths by basename.
{
  const file = 'scripts/note-file-access.cjs';
  let source = read(file);
  source = replaceOnce(source,
    "  ['.md', 'text/markdown; charset=utf-8'],\n]);",
    "  ['.md', 'text/markdown; charset=utf-8'],\n  ['.css', 'text/css; charset=utf-8'],\n  ['.js', 'text/javascript; charset=utf-8'],\n  ['.mjs', 'text/javascript; charset=utf-8'],\n  ['.json', 'application/json; charset=utf-8'],\n  ['.svg', 'image/svg+xml'],\n]);",
    'local note MIME extensions');
  source = replaceOnce(source,
    "  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {\n    const error = new Error('笔记文件不存在');\n    error.code = 'NOTE_FILE_NOT_FOUND';\n    throw error;\n  }\n\n  return { filePath, mime, extension, inline: mime.startsWith('image/') };",
    `  let canonicalPath = normalized;\n  let recovered = false;\n  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {\n    const baseName = path.basename(normalized);\n    const safeBaseName = /^[^\\\\/:*?\"<>|\\u0000-\\u001f]{1,240}$/.test(baseName) ? baseName : '';\n    const assetCandidate = safeBaseName ? path.join(cloneRoot, 'data', 'assets', safeBaseName) : '';\n    if (assetCandidate && fs.existsSync(assetCandidate) && fs.statSync(assetCandidate).isFile()) {\n      filePath = path.resolve(assetCandidate);\n      allowedRoot = path.join(cloneRoot, 'data', 'assets');\n      canonicalPath = \`github://data/assets/\${baseName}\`;\n      recovered = true;\n    } else {\n      const error = new Error('笔记文件不存在');\n      error.code = 'NOTE_FILE_NOT_FOUND';\n      throw error;\n    }\n  }\n\n  return { filePath, mime, extension, inline: mime.startsWith('image/'), canonicalPath, recovered };`,
    'local path recovery');
  write(file, source);
}

// Local material save accepts web resource files.
{
  const file = 'scripts/note-server.cjs';
  let source = read(file);
  source = replaceOnce(source,
    "    ['.html', 'text/html'], ['.htm', 'text/html'], ['.txt', 'text/plain'], ['.md', 'text/markdown'],\n  ]);",
    "    ['.html', 'text/html'], ['.htm', 'text/html'], ['.css', 'text/css'], ['.js', 'text/javascript'], ['.mjs', 'text/javascript'],\n    ['.json', 'application/json'], ['.svg', 'image/svg+xml'], ['.txt', 'text/plain'], ['.md', 'text/markdown'],\n  ]);",
    'local material MIME map');
  write(file, source);
}

// Cloud material save and file reads accept web resources and historical absolute paths.
{
  const file = 'cloudflare/media.js';
  let source = read(file);
  source = replaceOnce(source,
    "  ['text/markdown', 'md'],\n]);",
    "  ['text/markdown', 'md'],\n  ['text/css', 'css'],\n  ['text/javascript', 'js'],\n  ['application/javascript', 'js'],\n  ['application/json', 'json'],\n  ['image/svg+xml', 'svg'],\n]);",
    'cloud material MIME map');
  source = replaceOnce(source,
    "    } else if (normalized.startsWith(SOURCE_NOTES_ROOT)) {\n      prefix = SOURCE_NOTES_ROOT;\n      repoPath = assertRepoPath(normalized, prefix);\n    }",
    "    } else if (normalized.startsWith(SOURCE_NOTES_ROOT)) {\n      prefix = SOURCE_NOTES_ROOT;\n      repoPath = assertRepoPath(normalized, prefix);\n    } else {\n      const baseName = normalized.split('/').filter(Boolean).at(-1) || '';\n      if (/^[^\\\\/:*?\"<>|\\u0000-\\u001f]{1,240}$/.test(baseName)) {\n        prefix = ASSET_ROOT;\n        repoPath = assertRepoPath(\`\${ASSET_ROOT}\${baseName}\`, prefix);\n      }\n    }",
    'cloud absolute path recovery');
  write(file, source);
}

// Rewrite the preview layer: persistent path recovery, DOCX rendering and isolated HTML execution.
{
  const file = 'src/components/LearningRecordWorkspacePreview.tsx';
  let source = read(file);
  source = replaceOnce(source,
    "import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';",
    "import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';\nimport * as mammoth from 'mammoth';",
    'mammoth import');
  source = replaceOnce(source,
    "  fetchLearningData,\n  readLearningDataCache,",
    "  fetchLearningData,\n  patchLearningNote,\n  readLearningDataCache,\n  saveLearningDataCache,",
    'learning data repair imports');
  source = replaceOnce(source,
    "  sizeLabel: string;\n};",
    "  sizeLabel: string;\n  fallbackPath: string;\n  fallbackUrl: string;\n};",
    'asset fallback fields');
  source = replaceOnce(source,
    "const noteFileUrl = (filePath: string, preview = false) => (\n  `${NOTE_SERVER_URL}/note-file?path=${encodeURIComponent(filePath)}${preview ? '&preview=1' : ''}`\n);",
    `const noteFileUrl = (filePath: string, preview = false) => (\n  \`${NOTE_SERVER_URL}/note-file?path=\${encodeURIComponent(filePath)}\${preview ? '&preview=1' : ''}\`\n);\nconst storedAssetPath = (value: string): boolean => {\n  const normalized = value.trim().replaceAll('\\\\', '/').toLowerCase();\n  return normalized.startsWith('github://data/assets/') || normalized.startsWith('data/assets/') || normalized.startsWith('r2://note-assets/');\n};\nconst fallbackAssetPath = (value: string): string => {\n  if (!value || storedAssetPath(value)) return '';\n  const name = value.replaceAll('\\\\', '/').split('/').filter(Boolean).at(-1) || '';\n  return /^[^\\\\/:*?\"<>|\\u0000-\\u001f]{1,240}$/.test(name) ? \`github://data/assets/\${name}\` : '';\n};\n\nasync function fetchAssetResponse(item: Asset, signal: AbortSignal, onRecovered: (item: Asset) => void): Promise<Response> {\n  let response = await fetch(item.url, { signal, credentials: 'same-origin' });\n  if (!response.ok && item.fallbackUrl) {\n    response = await fetch(item.fallbackUrl, { signal, credentials: 'same-origin' });\n    if (response.ok) onRecovered(item);\n  }\n  if (!response.ok) throw new Error(\`资料读取失败（\${response.status}）\`);\n  return response;\n}`,
    'asset fallback helpers');

  const previewStart = source.indexOf('function SafeHtmlPreview');
  const previewEnd = source.indexOf('export function LearningRecordWorkspacePreview', previewStart);
  if (previewStart < 0 || previewEnd < 0) throw new Error('Preview component block not found');
  const previewBlock = String.raw`function RecoverableImage({ item, onRecovered, className = 'lrp-real-image' }: { item: Asset; onRecovered: (item: Asset) => void; className?: string }) {
  const [src, setSrc] = useState(item.url);
  const usingFallback = src === item.fallbackUrl && Boolean(item.fallbackUrl);
  useEffect(() => setSrc(item.url), [item.url]);
  return (
    <img
      className={className}
      src={src}
      alt={item.name}
      draggable={false}
      onError={() => { if (!usingFallback && item.fallbackUrl) setSrc(item.fallbackUrl); }}
      onLoad={() => { if (usingFallback) onRecovered(item); }}
    />
  );
}

function BlobDocumentPreview({ item, onRecovered }: { item: Asset; onRecovered: (item: Asset) => void }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    let objectUrl = '';
    setUrl('');
    setError('');
    void fetchAssetResponse(item, abort.signal, onRecovered)
      .then((response) => response.blob())
      .then((blob) => {
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((reason) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'PDF 读取失败'); });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [item.url, item.fallbackUrl, onRecovered]);
  if (error) return <div className="lrp-preview-error"><FileText size={28} /><strong>{error}</strong><a href={item.fallbackUrl || item.url} download={item.name}>下载原文件</a></div>;
  if (!url) return <div className="lrp-preview-loading">正在读取 PDF…</div>;
  return <iframe className="lrp-document-frame" src={url} title={item.name} />;
}

function WordPreview({ item, onRecovered }: { item: Asset; onRecovered: (item: Asset) => void }) {
  const [html, setHtml] = useState('');
  const [messages, setMessages] = useState<string[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    setHtml('');
    setMessages([]);
    setError('');
    void fetchAssetResponse(item, abort.signal, onRecovered)
      .then((response) => response.arrayBuffer())
      .then((arrayBuffer) => mammoth.convertToHtml({ arrayBuffer }, {
        convertImage: mammoth.images.imgElement((image) => image.read('base64').then((value) => ({ src: `data:${image.contentType};base64,${value}` }))),
      }))
      .then((result) => {
        if (abort.signal.aborted) return;
        setHtml(result.value);
        setMessages(result.messages.map((entry) => entry.message).filter(Boolean).slice(0, 6));
      })
      .catch((reason) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'Word 读取失败'); });
    return () => abort.abort();
  }, [item.url, item.fallbackUrl, onRecovered]);
  if (error) return <div className="lrp-preview-error"><FileText size={28} /><strong>{error}</strong><a href={item.fallbackUrl || item.url} download={item.name}>下载原文件</a></div>;
  if (!html) return <div className="lrp-preview-loading">正在解析 Word 文档…</div>;
  const document = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px/1.75 system-ui,sans-serif;padding:24px;max-width:900px;margin:auto;color:#202124}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #bbb;padding:6px}p{white-space:normal}</style></head><body>${html}${messages.length ? `<hr><small>${messages.join('；')}</small>` : ''}</body></html>`;
  return <iframe className="lrp-document-frame" sandbox="" srcDoc={document} title={item.name} />;
}

const resourceKey = (value: string) => value.replaceAll('\\', '/').replace(/^\.\//, '').split('/').filter(Boolean).at(-1)?.toLowerCase() || '';

async function bundleHtmlProject(item: Asset, assets: Asset[], signal: AbortSignal, onRecovered: (item: Asset) => void) {
  const entry = await fetchAssetResponse(item, signal, onRecovered).then((response) => response.text());
  const loaded: Array<{ asset: Asset; blob: Blob; text: string | null }> = [];
  for (const asset of assets) {
    if (asset.id === item.id) continue;
    try {
      const response = await fetchAssetResponse(asset, signal, onRecovered);
      const extension = asset.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
      const text = ['.css', '.js', '.mjs', '.json', '.svg', '.txt', '.md'].includes(extension) ? await response.clone().text() : null;
      loaded.push({ asset, blob: await response.blob(), text });
    } catch {
      // A missing optional project asset must not block the HTML entry file.
    }
  }
  const urls: string[] = [];
  const map = new Map<string, string>();
  for (const resource of loaded.filter((entry) => !entry.asset.name.toLowerCase().endsWith('.css'))) {
    const blob = resource.text !== null
      ? new Blob([resource.text], { type: resource.asset.mimeType || resource.blob.type || 'application/octet-stream' })
      : resource.blob;
    const url = URL.createObjectURL(blob);
    urls.push(url);
    map.set(resourceKey(resource.asset.name), url);
  }
  for (const resource of loaded.filter((entry) => entry.asset.name.toLowerCase().endsWith('.css'))) {
    const css = (resource.text || '').replace(/url\((['"]?)([^)'"?]+)\1\)/gi, (whole, quote, raw) => {
      const replacement = map.get(resourceKey(String(raw)));
      return replacement ? `url("${replacement}")` : whole;
    });
    const url = URL.createObjectURL(new Blob([css], { type: 'text/css' }));
    urls.push(url);
    map.set(resourceKey(resource.asset.name), url);
  }
  const document = new DOMParser().parseFromString(entry, 'text/html');
  document.querySelectorAll<HTMLElement>('[src],[href]').forEach((element) => {
    for (const attribute of ['src', 'href']) {
      const value = element.getAttribute(attribute);
      if (!value || /^(?:[a-z]+:|#|\/\/)/i.test(value)) continue;
      const replacement = map.get(resourceKey(value));
      if (replacement) element.setAttribute(attribute, replacement);
    }
  });
  if (!document.querySelector('meta[charset]')) {
    const meta = document.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    document.head.prepend(meta);
  }
  return { html: `<!doctype html>${document.documentElement.outerHTML}`, urls };
}

function HtmlPreview({ item, assets, onRecovered }: { item: Asset; assets: Asset[]; onRecovered: (item: Asset) => void }) {
  const [html, setHtml] = useState('');
  const [mode, setMode] = useState<'safe' | 'run'>('safe');
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    let urls: string[] = [];
    setHtml('');
    setError('');
    void bundleHtmlProject(item, assets, abort.signal, onRecovered)
      .then((result) => { if (!abort.signal.aborted) { urls = result.urls; setHtml(result.html.slice(0, 6 * 1024 * 1024)); } })
      .catch((reason) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'HTML 读取失败'); });
    return () => { abort.abort(); urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [item.url, item.fallbackUrl, assets, onRecovered]);
  if (error) return <div className="lrp-preview-error"><FileCode2 size={28} /><strong>{error}</strong><a href={item.fallbackUrl || item.url} download={item.name}>下载原文件</a></div>;
  if (!html) return <div className="lrp-preview-loading">正在装载 HTML / Web 资料…</div>;
  return (
    <div className="lrp-html-preview">
      <div className="lrp-html-mode">
        <button type="button" className={mode === 'safe' ? 'active' : ''} onClick={() => setMode('safe')}>安全查看</button>
        <button type="button" className={mode === 'run' ? 'active' : ''} onClick={() => setMode('run')}>隔离运行</button>
        <span>{mode === 'run' ? '脚本仅在无同源权限沙箱中运行' : '脚本已禁用'}</span>
      </div>
      <iframe
        className="lrp-document-frame"
        sandbox={mode === 'run' ? 'allow-scripts allow-forms allow-modals allow-popups allow-downloads' : ''}
        srcDoc={html}
        title={item.name}
      />
    </div>
  );
}

function TextPreview({ item, onRecovered }: { item: Asset; onRecovered: (item: Asset) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    setText('');
    setError('');
    void fetchAssetResponse(item, abort.signal, onRecovered)
      .then((response) => response.text())
      .then((value) => { if (!abort.signal.aborted) setText(value.slice(0, 2 * 1024 * 1024)); })
      .catch((reason) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '文本读取失败'); });
    return () => abort.abort();
  }, [item.url, item.fallbackUrl, onRecovered]);
  if (error) return <div className="lrp-preview-error"><FileText size={28} /><strong>{error}</strong></div>;
  if (!text) return <div className="lrp-preview-loading">正在读取文本…</div>;
  return <pre className="lrp-text-preview">{text}</pre>;
}

function AssetPreview({ item, assets, onRecovered }: { item: Asset; assets: Asset[]; onRecovered: (item: Asset) => void }) {
  if (item.kind === 'image') return <RecoverableImage item={item} onRecovered={onRecovered} />;
  if (item.kind === 'pdf') return <BlobDocumentPreview item={item} onRecovered={onRecovered} />;
  if (item.kind === 'word') return <WordPreview item={item} onRecovered={onRecovered} />;
  if (item.kind === 'html') return <HtmlPreview item={item} assets={assets} onRecovered={onRecovered} />;
  if (/\.(?:txt|md|css|js|mjs|json|svg)$/i.test(item.name)) return <TextPreview item={item} onRecovered={onRecovered} />;
  if (item.posterUrl) return <RecoverableImage item={{ ...item, url: item.posterUrl, fallbackUrl: '' }} onRecovered={onRecovered} className="lrp-real-image lrp-preview-poster" />;
  return (
    <article className={`lrp-file-preview is-${item.kind}`}>
      <span><AssetGlyph kind={item.kind} /></span>
      <small>{item.label} · {item.sizeLabel}</small>
      <h2>{item.name}</h2>
      <p>该资料暂不支持内嵌预览，可下载到本机打开。</p>
      <a href={item.fallbackUrl || item.url} download={item.name}><Download size={16} />打开 / 下载</a>
    </article>
  );
}

`;
  source = `${source.slice(0, previewStart)}${previewBlock}${source.slice(previewEnd)}`;
  source = replaceOnce(source,
    "  const rootRef = useRef<HTMLDivElement | null>(null);",
    "  const rootRef = useRef<HTMLDivElement | null>(null);\n  const repairingPathsRef = useRef(new Set<string>());",
    'repairing path ref');
  source = replaceOnce(source,
    "        sizeLabel: formatBytes(attachment.size),\n      };",
    "        sizeLabel: formatBytes(attachment.size),\n        fallbackPath: fallbackAssetPath(attachment.filePath),\n        fallbackUrl: fallbackAssetPath(attachment.filePath) ? noteFileUrl(fallbackAssetPath(attachment.filePath)) : '',\n      };",
    'asset fallback mapping');
  source = replaceOnce(source,
    "  const returnToLearningCenter = () => {",
    `  const repairAttachmentPath = async (item: Asset) => {\n    if (!note || !item.fallbackPath || repairingPathsRef.current.has(item.id)) return;\n    repairingPathsRef.current.add(item.id);\n    try {\n      const baseAttachments = note.attachments.length > 0\n        ? note.attachments\n        : assets.map((asset) => ({\n            id: asset.id, kind: asset.kind, name: asset.name, mimeType: asset.mimeType, size: asset.size,\n            filePath: asset.filePath, previewPath: asset.previewPath, posterPath: asset.posterPath, createdAt: asset.createdAt,\n          }));\n      const attachments = baseAttachments.map((attachment) => attachment.id === item.id\n        ? { ...attachment, filePath: item.fallbackPath }\n        : attachment);\n      const next = await patchLearningNote(note.noteUid, { attachments });\n      saveLearningDataCache(next);\n      setSnapshot(next);\n      setActionError('历史附件路径已自动修复');\n    } catch (error) {\n      setActionError(error instanceof Error ? \`附件已通过备用路径显示，但路径写回失败：\${error.message}\` : '附件路径写回失败');\n    } finally {\n      repairingPathsRef.current.delete(item.id);\n    }\n  };\n\n  const returnToLearningCenter = () => {`,
    'persistent attachment repair');
  source = source.replaceAll('<AssetPreview item={activeAsset} />', '<AssetPreview item={activeAsset} assets={assets} onRecovered={(item) => void repairAttachmentPath(item)} />');
  source = source.replaceAll('<AssetPreview item={current} />', '<AssetPreview item={current} assets={assets} onRecovered={(asset) => void repairAttachmentPath(asset)} />');
  write(file, source);
}

// Preview controls and readable document surfaces.
{
  const file = 'src/learning-record-workspace-preview.css';
  let source = read(file);
  source = appendOnce(source, '.lrp-html-mode {', `
.lrp-html-preview { width: 100%; height: 100%; min-height: 260px; display: flex; flex-direction: column; }
.lrp-html-mode { display: flex; gap: 6px; align-items: center; padding: 7px 10px; border-bottom: 1px solid rgba(99, 86, 69, .16); background: rgba(248, 245, 240, .94); }
.lrp-html-mode button { border: 1px solid rgba(99, 86, 69, .2); border-radius: 8px; padding: 5px 9px; background: #fff; color: #51483e; font: inherit; cursor: pointer; }
.lrp-html-mode button.active { background: #2f3742; color: #fff; border-color: #2f3742; }
.lrp-html-mode span { margin-left: auto; color: #746a5e; font-size: 12px; }
.lrp-html-preview .lrp-document-frame { flex: 1; min-height: 240px; }
.lrp-text-preview { box-sizing: border-box; width: 100%; height: 100%; min-height: 260px; margin: 0; padding: 18px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: #fbfaf7; color: #25282d; font: 13px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; }
`);
  write(file, source);
}

// Regression tests for all newly completed paths.
write('scripts/workspace-final-completion.test.cjs', `'use strict';\n\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst os = require('node:os');\nconst path = require('node:path');\nconst test = require('node:test');\n\nconst root = path.resolve(__dirname, '..');\nconst read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');\n\ntest('historical absolute attachment paths recover from the GitHub asset clone', () => {\n  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-path-recovery-'));\n  const cloneRoot = path.join(temporary, 'clone');\n  const notesRoot = path.join(temporary, 'notes');\n  const assetRoot = path.join(cloneRoot, 'data', 'assets');\n  fs.mkdirSync(assetRoot, { recursive: true });\n  fs.mkdirSync(notesRoot, { recursive: true });\n  fs.writeFileSync(path.join(assetRoot, 'same-name.jpg'), Buffer.from([1, 2, 3]));\n  const { resolveNoteFile } = require('./note-file-access.cjs');\n  const resolved = resolveNoteFile(notesRoot, 'C:\\\\Users\\\\ASUS\\\\Desktop\\\\笔记\\\\same-name.jpg', { cloneRoot });\n  assert.equal(resolved.recovered, true);\n  assert.equal(resolved.canonicalPath, 'github://data/assets/same-name.jpg');\n  assert.equal(resolved.filePath, path.join(assetRoot, 'same-name.jpg'));\n});\n\ntest('workspace renders DOCX and offers safe and isolated HTML modes', () => {\n  const source = read('src/components/LearningRecordWorkspacePreview.tsx');\n  assert.match(source, /mammoth\\.convertToHtml/);\n  assert.match(source, /安全查看/);\n  assert.match(source, /隔离运行/);\n  assert.match(source, /allow-scripts allow-forms/);\n  assert.doesNotMatch(source, /allow-same-origin/);\n  assert.match(source, /patchLearningNote\\(note\\.noteUid, \\{ attachments \\}\\)/);\n});\n\ntest('速记 accepts HTML project resources and cloud paths recover by basename', () => {\n  const composer = read('src/components/QuickMaterialComposer.tsx');\n  const media = read('cloudflare/media.js');\n  assert.match(composer, /\\.css,\\.js,\\.mjs,\\.json,\\.svg/);\n  assert.match(media, /text\\/css/);\n  assert.match(media, /ASSET_ROOT\\}\\$\\{baseName/);\n});\n`);

console.log('workspace final completion patch applied');
