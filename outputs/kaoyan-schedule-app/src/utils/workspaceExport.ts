import type { LearningAutoNote } from './learningData';

export interface WorkspaceExportAsset {
  id: string;
  name: string;
  kind: string;
  url: string;
  sizeLabel: string;
}

const FACET_LABELS: Record<string, string> = {
  quick: '速记',
  mistake: '错题',
  good: '好题',
  memory: '背诵',
  knowledge: '知识',
};

export const safeExportName = (value: string): string => (
  String(value || '学习记录')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80) || '学习记录'
);

export const escapeExportHtml = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const metadataLines = (note: LearningAutoNote): string[] => [
  note.subject ? `科目：${note.subject}` : '',
  note.knowledgePath.length > 1 ? `知识点：${note.knowledgePath.slice(1).join('、')}` : '',
  note.facets.length > 0 ? `归类：${note.facets.map((item) => FACET_LABELS[item] || item).join('、')}` : '',
  note.capturedDate ? `记录日期：${note.capturedDate}` : '',
].filter(Boolean);

const downloadBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

export async function exportWorkspaceDocx(
  note: LearningAutoNote,
  assets: WorkspaceExportAsset[],
): Promise<void> {
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import('docx');
  const children = [
    new Paragraph({ text: note.title || '未命名学习记录', heading: HeadingLevel.TITLE }),
    ...metadataLines(note).map((line) => new Paragraph({
      children: [new TextRun({ text: line, color: '555555' })],
    })),
  ];

  if (note.remark) {
    children.push(new Paragraph({ text: '备注', heading: HeadingLevel.HEADING_1 }));
    for (const line of note.remark.split(/\r?\n/)) {
      children.push(new Paragraph({ text: line || ' ' }));
    }
  }

  if (note.tags.length > 0) {
    children.push(new Paragraph({ text: '标签', heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ text: note.tags.join('、') }));
  }

  if (note.items.length > 0) {
    children.push(new Paragraph({ text: '识别内容', heading: HeadingLevel.HEADING_1 }));
    note.items.forEach((item, index) => {
      children.push(new Paragraph({
        children: [
          new TextRun({
            text: `${index + 1}. ${item.title || item.knowledgePoint || '内容'}`,
            bold: true,
          }),
          ...(item.summary ? [new TextRun({ text: ` — ${item.summary}` })] : []),
        ],
      }));
    });
  }

  if (note.studyNotes.length > 0) {
    children.push(new Paragraph({ text: '学习想法', heading: HeadingLevel.HEADING_1 }));
    note.studyNotes.forEach((thought) => children.push(new Paragraph({
      text: thought.text,
      bullet: { level: 0 },
    })));
  }

  if (assets.length > 0) {
    children.push(new Paragraph({ text: '资料附件', heading: HeadingLevel.HEADING_1 }));
    assets.forEach((asset) => children.push(new Paragraph({
      text: `${asset.name}（${asset.kind.toUpperCase()} · ${asset.sizeLabel}）`,
      bullet: { level: 0 },
    })));
  }

  const documentFile = new Document({
    sections: [{ properties: {}, children }],
  });
  const blob = await Packer.toBlob(documentFile);
  downloadBlob(blob, `${safeExportName(note.title)}.docx`);
}

export function exportWorkspacePdf(
  note: LearningAutoNote,
  assets: WorkspaceExportAsset[],
): void {
  const popup = window.open('', '_blank', 'popup=yes,width=980,height=820');
  if (!popup) {
    throw new Error('浏览器阻止了导出窗口，请允许当前站点打开弹窗。');
  }
  popup.opener = null;

  const imageHtml = assets
    .filter((asset) => asset.kind === 'image')
    .map((asset) => (
      `<figure><img src="${escapeExportHtml(asset.url)}" alt="${escapeExportHtml(asset.name)}">`
      + `<figcaption>${escapeExportHtml(asset.name)}</figcaption></figure>`
    )).join('');
  const fileHtml = assets
    .filter((asset) => asset.kind !== 'image')
    .map((asset) => (
      `<li><strong>${escapeExportHtml(asset.name)}</strong>`
      + `<span>${escapeExportHtml(asset.kind.toUpperCase())} · ${escapeExportHtml(asset.sizeLabel)}</span></li>`
    )).join('');
  const itemHtml = note.items.map((item, index) => (
    `<li><strong>${index + 1}. ${escapeExportHtml(item.title || item.knowledgePoint || '内容')}</strong>`
    + (item.summary ? `<p>${escapeExportHtml(item.summary)}</p>` : '')
    + '</li>'
  )).join('');
  const thoughtHtml = note.studyNotes
    .map((thought) => `<li>${escapeExportHtml(thought.text)}</li>`)
    .join('');

  popup.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapeExportHtml(note.title || '学习记录')}</title><style>
@page{size:A4;margin:16mm}*{box-sizing:border-box}body{margin:0;color:#222;font:14px/1.7 system-ui,-apple-system,"Microsoft YaHei",sans-serif}h1{font-size:25px;margin:0 0 8px}h2{font-size:16px;margin:22px 0 8px;border-bottom:1px solid #ddd;padding-bottom:5px}.meta{color:#666}.remark{white-space:pre-wrap;padding:12px 14px;background:#f5f5f3;border-radius:8px}ul,ol{padding-left:22px}li{break-inside:avoid;margin:5px 0}li span{display:block;color:#777;font-size:12px}figure{margin:16px 0;break-inside:avoid}img{display:block;max-width:100%;max-height:245mm;margin:auto;object-fit:contain}figcaption{text-align:center;color:#777;font-size:11px;margin-top:5px}.tags{display:flex;flex-wrap:wrap;gap:5px}.tags span{padding:3px 7px;border:1px solid #ddd;border-radius:999px;font-size:11px}
</style></head><body>
<h1>${escapeExportHtml(note.title || '未命名学习记录')}</h1>
<div class="meta">${metadataLines(note).map(escapeExportHtml).join(' · ')}</div>
${note.remark ? `<h2>备注</h2><div class="remark">${escapeExportHtml(note.remark)}</div>` : ''}
${note.tags.length ? `<h2>标签</h2><div class="tags">${note.tags.map((tag) => `<span>${escapeExportHtml(tag)}</span>`).join('')}</div>` : ''}
${itemHtml ? `<h2>识别内容</h2><ol>${itemHtml}</ol>` : ''}
${thoughtHtml ? `<h2>学习想法</h2><ul>${thoughtHtml}</ul>` : ''}
${imageHtml ? `<h2>图片资料</h2>${imageHtml}` : ''}
${fileHtml ? `<h2>其他附件</h2><ul>${fileHtml}</ul>` : ''}
</body></html>`);
  popup.document.close();

  let printed = false;
  const print = () => {
    if (printed || popup.closed) return;
    printed = true;
    popup.focus();
    popup.print();
  };
  popup.addEventListener('load', () => window.setTimeout(print, 450), { once: true });
  window.setTimeout(print, 1200);
}
