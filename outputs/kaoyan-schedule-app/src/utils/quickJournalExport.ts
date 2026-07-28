import type { LearningAutoNote } from './learningData';
import type { WorkspaceAssetPreviewItem } from '../components/WorkspaceAssetPreview';

export interface QuickJournalExportRecord {
  date: string;
  note: LearningAutoNote;
  assets: WorkspaceAssetPreviewItem[];
}

const escapeHtml = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const safeSegment = (value: string, fallback: string): string => (
  value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120)
  || fallback
);

const localUrl = (path: string): string => path
  .split('/')
  .map((part) => encodeURIComponent(part))
  .join('/');

const fetchAsset = async (asset: WorkspaceAssetPreviewItem): Promise<Blob> => {
  let response = await fetch(asset.url, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok && asset.fallbackUrl) {
    response = await fetch(asset.fallbackUrl, { credentials: 'same-origin', cache: 'no-store' });
  }
  if (!response.ok) throw new Error(`${asset.name} 读取失败（${response.status}）`);
  return response.blob();
};

const secureHtmlDocument = (source: string): string => {
  const documentFile = new DOMParser().parseFromString(source, 'text/html');
  const csp = documentFile.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src 'self' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'self' data: blob:; frame-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'";
  documentFile.head.prepend(csp);
  if (!documentFile.querySelector('meta[name="viewport"]')) {
    const viewport = documentFile.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1';
    documentFile.head.append(viewport);
  }
  const responsive = documentFile.createElement('style');
  responsive.textContent = '*,*::before,*::after{box-sizing:border-box}html,body{max-width:100%;min-height:100%;margin:0;overflow:auto}img,video,svg{max-width:100%;height:auto}table{max-width:100%;display:block;overflow:auto}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}';
  documentFile.head.append(responsive);
  return `<!doctype html>${documentFile.documentElement.outerHTML}`;
};

const wordPreviewDocument = (body: string, title: string): string => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
*,*::before,*::after{box-sizing:border-box}body{max-width:900px;margin:0 auto;padding:24px;color:#292723;font:15px/1.8 system-ui,-apple-system,"Microsoft YaHei",sans-serif}
img,svg,video{max-width:100%;height:auto}table{max-width:100%;display:block;overflow:auto;border-collapse:collapse}td,th{padding:6px;border:1px solid #d8d4cc}
</style></head><body>${body}</body></html>`;

const mimeExtension = (asset: WorkspaceAssetPreviewItem): string => {
  const extension = asset.name.match(/\.[A-Za-z0-9]+$/)?.[0];
  if (extension) return extension;
  if (asset.kind === 'image') return '.jpg';
  if (asset.kind === 'pdf') return '.pdf';
  if (asset.kind === 'word') return '.docx';
  if (asset.kind === 'html') return '.html';
  return '';
};

export async function exportQuickJournalPackage(records: QuickJournalExportRecord[]): Promise<void> {
  if (records.length === 0) throw new Error('当前没有可导出的速记');
  const [{ default: JSZip }, mammoth] = await Promise.all([
    import('jszip'),
    import('mammoth'),
  ]);
  const zip = new JSZip();
  const recordMarkup: string[] = [];
  const failures: string[] = [];

  for (const [recordIndex, record] of records.entries()) {
    const folder = `assets/${String(recordIndex + 1).padStart(3, '0')}-${safeSegment(record.note.noteUid, 'record')}`;
    const attachmentMarkup: string[] = [];
    for (const [assetIndex, asset] of record.assets.entries()) {
      const fileName = `${String(assetIndex + 1).padStart(2, '0')}-${safeSegment(asset.name, `asset${mimeExtension(asset)}`)}`;
      const path = `${folder}/${fileName}`;
      try {
        const blob = await fetchAsset(asset);
        zip.file(path, blob);
        const href = localUrl(path);
        if (asset.kind === 'image') {
          attachmentMarkup.push(`<figure class="attachment image"><img src="${href}" alt="${escapeHtml(asset.name)}"><figcaption>${escapeHtml(asset.name)}</figcaption></figure>`);
        } else if (asset.kind === 'html') {
          const html = secureHtmlDocument(await blob.text());
          zip.file(path, html);
          attachmentMarkup.push(`<figure class="attachment document"><iframe src="${href}" sandbox="allow-scripts allow-forms allow-modals allow-downloads" title="${escapeHtml(asset.name)}"></iframe><figcaption>${escapeHtml(asset.name)}</figcaption></figure>`);
        } else if (asset.kind === 'word') {
          const result = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
          const previewPath = `${folder}/${fileName}.preview.html`;
          zip.file(previewPath, wordPreviewDocument(result.value, asset.name));
          attachmentMarkup.push(`<figure class="attachment document"><iframe src="${localUrl(previewPath)}" sandbox="" title="${escapeHtml(asset.name)}"></iframe><figcaption><a href="${href}">${escapeHtml(asset.name)}</a></figcaption></figure>`);
        } else if (asset.kind === 'pdf') {
          attachmentMarkup.push(`<figure class="attachment document"><object data="${href}" type="application/pdf"><a href="${href}">${escapeHtml(asset.name)}</a></object><figcaption>${escapeHtml(asset.name)}</figcaption></figure>`);
        } else {
          attachmentMarkup.push(`<p class="attachment file"><a href="${href}">${escapeHtml(asset.name)}</a></p>`);
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : `${asset.name} 读取失败`);
        attachmentMarkup.push(`<p class="attachment missing">${escapeHtml(asset.name)}（未能打包）</p>`);
      }
    }

    recordMarkup.push(`<article class="record">
      <header><time>${escapeHtml(record.date)}</time>${record.note.subject ? `<span>${escapeHtml(record.note.subject)}</span>` : ''}<h1>${escapeHtml(record.note.title || '未命名速记')}</h1></header>
      ${record.note.remark ? `<div class="copy">${escapeHtml(record.note.remark).replace(/\r?\n/g, '<br>')}</div>` : ''}
      ${attachmentMarkup.length ? `<section class="attachments">${attachmentMarkup.join('')}</section>` : ''}
    </article>`);
  }

  const generatedAt = new Date().toLocaleString('zh-CN');
  const indexHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>考研速记日记</title><style>
@page{size:A4;margin:14mm 15mm}*{box-sizing:border-box}html{background:#e9e7e2}body{margin:0;color:#292723;font:14px/1.75 system-ui,-apple-system,"Microsoft YaHei",sans-serif}.cover,.record{width:min(210mm,calc(100% - 32px));min-height:260mm;margin:18px auto;padding:17mm 16mm;background:#fff;box-shadow:0 12px 36px #2c28221a}.cover{display:grid;place-content:center;text-align:center}.cover h1{margin:0;font:700 34px/1.3 "Songti SC",SimSun,serif}.cover p{color:#777}.record header{padding-bottom:10mm;border-bottom:1px solid #ddd7cd}.record header time,.record header span{margin-right:8px;color:#7b7268;font-size:11px}.record header span{padding:3px 7px;border-radius:5px;background:#f1ebe2}.record h1{margin:7px 0 0;font:700 27px/1.4 "Songti SC",SimSun,serif;overflow-wrap:anywhere}.copy{padding:9mm 0;color:#37322c;font:16px/1.9 "Songti SC",SimSun,serif}.attachments{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5mm;padding-top:7mm;border-top:1px solid #e2ddd5}.attachment{min-width:0;margin:0;break-inside:avoid}.attachment.image img,.attachment.document iframe,.attachment.document object{width:100%;height:90mm;display:block;border:1px solid #ddd8d0;background:#faf9f6;object-fit:contain}.attachment figcaption{padding:5px 2px;color:#70685f;font-size:10px;overflow-wrap:anywhere}.attachment a{color:#76502d}.missing{padding:10px;border:1px dashed #c9b8a5;color:#8b5a4e}.file{padding:12px;border:1px solid #ddd8d0}
@media(max-width:760px){.cover,.record{width:100%;min-height:0;margin:0;padding:28px 20px;box-shadow:none}.attachments{grid-template-columns:1fr}.attachment.image img,.attachment.document iframe,.attachment.document object{height:62vh}}
@media print{html,body{background:#fff}.cover,.record{width:auto;min-height:0;margin:0;padding:0;box-shadow:none}.cover{height:267mm;break-after:page}.record{break-before:page}.record h1{font-size:24px}.attachment.image img,.attachment.document iframe,.attachment.document object{height:92mm}.attachments{gap:4mm}.attachment{break-inside:avoid-page}}
</style></head><body><section class="cover"><h1>考研速记日记</h1><p>${records.length} 条记录 · 导出于 ${escapeHtml(generatedAt)}</p></section>${recordMarkup.join('')}${failures.length ? `<aside class="record"><h1>打包提示</h1><ul>${failures.map((failure) => `<li>${escapeHtml(failure)}</li>`).join('')}</ul></aside>` : ''}</body></html>`;
  zip.file('index.html', indexHtml);
  zip.file('README.txt', '解压整个文件夹后打开 index.html。浏览时每条速记独立成页；打印或另存为 PDF 时按 A4 自动分页。请勿只移动 index.html，否则附件会丢失。');

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `考研速记日记_${new Date().toISOString().slice(0, 10)}.kaoyan-journal.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

