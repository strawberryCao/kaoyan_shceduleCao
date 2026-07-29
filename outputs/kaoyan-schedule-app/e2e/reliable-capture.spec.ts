import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Packer, Paragraph } from 'docx';
import sharp from 'sharp';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const notesRoot = path.join(projectRoot, '.e2e-runtime', 'notes');
const noteOrigin = 'http://127.0.0.1:15174';
const workerOrigin = 'http://localhost:18787';
const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xf0fWQAAAABJRU5ErkJggg==';
const makeTinyPdf = (): Buffer => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 45 >>\nstream\nBT /F1 24 Tf 72 760 Td (PDF preview E2E) Tj ET\nendstream',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'utf8'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, 'utf8');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'utf8');
};

test('desktop drag saves the image and sidecar before reporting success', async ({ page }) => {
  await page.goto('/?noteApp=1');
  await expect(page.getByText('笔记小 App')).toBeVisible();

  const transfer = await page.evaluateHandle(({ png }) => {
    const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([bytes], 'drag-save-e2e.png', { type: 'image/png' }));
    return dataTransfer;
  }, { png: tinyPngBase64 });
  await page.locator('main.note-drop-app').dispatchEvent('drop', { dataTransfer: transfer });

  const dialog = page.getByRole('dialog', { name: '备注' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: '备注' }).fill('Playwright 拖放落盘验收');
  await dialog.getByRole('button', { name: '保存笔记' }).click();
  await expect(page.getByText('已保存到本地；正在后台识别标题和科目，可立即继续记录')).toBeVisible();

  const sidecars = fs.readdirSync(path.join(notesRoot, '默认文件夹', '.metadata'))
    .filter((name) => name.endsWith('.note.json'));
  const images = fs.readdirSync(path.join(notesRoot, '默认文件夹'))
    .filter((name) => name.endsWith('.png'));
  expect(sidecars).toHaveLength(1);
  expect(images).toHaveLength(1);

  const sidecar = JSON.parse(fs.readFileSync(path.join(notesRoot, '默认文件夹', '.metadata', sidecars[0]), 'utf8'));
  expect(sidecar.noteUid).toBeTruthy();
  expect(sidecar.subject).toBe('默认文件夹');
  expect(sidecar.remark).toBe('Playwright 拖放落盘验收');

  await page.reload();
  await expect(page.getByText('笔记小 App')).toBeVisible();
  const response = await page.request.get(`${noteOrigin}/learning-data`);
  expect(response.ok()).toBeTruthy();
  const snapshot = await response.json();
  const notes = Object.values(snapshot.days as Record<string, { autoNotes?: Array<{ noteUid?: string }> }>)
    .flatMap((day) => day.autoNotes || []);
  expect(notes.some((note) => note.noteUid === sidecar.noteUid)).toBeTruthy();
});

test('LAN multi-question capture confirms the original on disk and keeps an idempotent recovery job', async ({ request }) => {
  const payload = {
    imageDataUrl: `data:image/png;base64,${tinyPngBase64}`,
    batchId: 'batch-e2e-lan-0001',
    subject: '默认文件夹',
    remark: '局域网多题原图验收',
  };
  const first = await request.post(`${noteOrigin}/capture-batches`, { data: payload });
  expect(first.status()).toBe(202);
  const created = await first.json();
  expect(created.accepted).toBe(true);
  expect(created.job.status).toBe('needs_review');
  expect(created.job.configurationHash).toMatch(/^[a-f0-9]{64}$/);
  expect(created.job.workflowHash).toMatch(/^[a-f0-9]{64}$/);

  const sidecar = fs.readdirSync(path.join(notesRoot, '默认文件夹', '.metadata'))
    .filter((name) => name.endsWith('.note.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(notesRoot, '默认文件夹', '.metadata', name), 'utf8')))
    .find((item) => item.noteUid === created.entryId);
  expect(sidecar).toBeTruthy();
  expect(sidecar.sourceType).toBe('multi-capture-original');
  expect(sidecar.sourceBatchId).toBe(payload.batchId);
  expect(fs.existsSync(sidecar.filePath)).toBe(true);

  const jobResponse = await request.get(`${noteOrigin}/jobs/${created.jobId}`);
  expect(jobResponse.status()).toBe(200);
  expect((await jobResponse.json()).job.entryId).toBe(created.entryId);

  const replay = await request.post(`${noteOrigin}/capture-batches`, { data: payload });
  expect(replay.status()).toBe(200);
  expect((await replay.json()).accepted).toBe(false);
});

test('mobile quick note needs one text field and one save action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?noteApp=1');
  await page.getByRole('button', { name: /速记/ }).click();

  await expect(page.locator('.quick-material-composer > header').getByText('速记', { exact: true })).toBeVisible();
  await expect(page.getByText('标题会自动生成')).toBeVisible();
  await expect(page.getByLabel(/科目/)).toHaveCount(0);
  await expect(page.getByText('记录身份')).toHaveCount(0);

  const body = page.getByPlaceholder('直接写下想法、结论、错因或待解决问题……');
  await body.fill('移动端一次输入一次点击完成的速记');
  await page.getByRole('button', { name: '保存速记' }).click();
  await expect(page.getByRole('heading', { name: '记录完成' })).toBeVisible();

  const response = await page.request.get(`${noteOrigin}/learning-data`);
  const snapshot = await response.json();
  const notes = Object.values(snapshot.days as Record<string, { autoNotes?: Array<{ remark?: string; subject?: string; facets?: string[] }> }>)
    .flatMap((day) => day.autoNotes || []);
  const note = notes.find((item) => item.remark === '移动端一次输入一次点击完成的速记');
  expect(note).toBeTruthy();
  expect(note.subject).toBe('默认文件夹');
  expect(note.facets).toContain('quick');
});

test('an existing quick note can edit its text and add or remove attachments', async ({ page, request }) => {
  const noteUid = 'e2e_quick_edit_001';
  const createResponse = await request.post(`${noteOrigin}/save-material-note`, {
    headers: { 'x-kaoyan-lan-proxy': '1' },
    data: {
      noteUid,
      title: '待修改速记',
      remark: '原始正文',
      subject: '默认文件夹',
      facets: ['quick'],
      files: [],
    },
  });
  expect(createResponse.status()).toBe(201);

  await page.goto('/?panel=learning&view=quick');
  await page.getByText('待修改速记', { exact: true }).first().click();
  const record = page.locator('.lc-quick-record');
  await record.getByRole('button', { name: '编辑' }).click();
  const editor = page.getByRole('dialog', { name: '编辑学习内容' });
  await editor.getByLabel('标题').fill('已经修改的速记');
  await editor.getByLabel('内容').fill('修改后的第一段\n\n修改后的第二段');
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(record.getByRole('heading', { name: '已经修改的速记' })).toBeVisible();
  await expect(record).toContainText('修改后的第二段');

  await record.locator('.lc-quick-attach input[type="file"]').setInputFiles({
    name: '后续补充.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('后续补充资料', 'utf8'),
  });
  await expect(record.getByRole('button', { name: /后续补充\.txt/ })).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await record.getByRole('button', { name: '移除附件' }).click();
  await expect(record.getByRole('button', { name: /后续补充\.txt/ })).toHaveCount(0);

  const snapshotResponse = await request.get(`${noteOrigin}/learning-data`);
  const snapshot = await snapshotResponse.json();
  const stored = Object.values(snapshot.days as Record<string, { autoNotes?: Array<{
    noteUid: string;
    title: string;
    remark: string;
    attachments: unknown[];
  }> }>).flatMap((day) => day.autoNotes || []).find((note) => note.noteUid === noteUid);
  expect(stored?.title).toBe('已经修改的速记');
  expect(stored?.remark).toContain('修改后的第二段');
  expect(stored?.attachments).toHaveLength(0);
});

test('all common formats adapt, scroll and detach as borderless floating material', async ({ page }) => {
  const docx = await Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph('Playwright Word 预览正文')] }],
  }));
  const longPng = await sharp({
    create: {
      width: 420,
      height: 2400,
      channels: 4,
      background: { r: 248, g: 246, b: 241, alpha: 1 },
    },
  }).png().toBuffer();
  await page.goto('/?noteApp=1');
  await page.getByRole('button', { name: '速记' }).click();
  await page.getByPlaceholder('例如：拉格朗日中值定理的构造思路').fill('三种文档浏览器验收');
  await page.getByPlaceholder('直接写下想法、结论、错因或待解决问题……').fill('附件必须可重新打开');
  await page.locator('.quick-material-files input[type="file"]').setInputFiles([
    {
      name: 'e2e.pdf',
      mimeType: 'application/pdf',
      buffer: makeTinyPdf(),
    },
    {
      name: 'e2e.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: docx,
    },
    {
      name: 'e2e.html',
      mimeType: 'text/html',
      buffer: Buffer.from(`<!doctype html>
        <meta name="viewport" content="width=device-width">
        <style>
          *{box-sizing:border-box}html,body{margin:0}
          .wrap{width:430px;margin:0 auto;padding:8px}
          .box{height:270px;padding:12px;border-radius:13px;background:#faf7f1}
          svg{display:block;width:100%;height:190px}
        </style>
        <div class="wrap"><div class="box"><h1>HTML 自适应预览</h1><svg viewBox="0 0 390 190"><path d="M20 150L370 30" stroke="#222"/></svg></div></div>
        <script>document.body.dataset.scriptRan="yes"</script>`, 'utf8'),
    },
    {
      name: 'e2e-image.png',
      mimeType: 'image/png',
      buffer: longPng,
    },
    {
      name: 'e2e-text.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Playwright 文本资料预览', 'utf8'),
    },
    {
      name: 'e2e-notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Markdown 资料', 'utf8'),
    },
    {
      name: 'e2e-data.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"preview":"JSON 资料"}', 'utf8'),
    },
    {
      name: 'e2e-style.css',
      mimeType: 'text/css',
      buffer: Buffer.from('body { color: #222; }', 'utf8'),
    },
  ]);
  await page.getByRole('button', { name: '保存到学习中心' }).click();
  await expect(page.getByRole('heading', { name: '记录完成' })).toBeVisible();

  const response = await page.request.get(`${noteOrigin}/learning-data`);
  const snapshot = await response.json();
  const notes = Object.values(snapshot.days as Record<string, { autoNotes?: Array<{
    noteUid?: string;
    title?: string;
    attachments?: Array<{ name?: string }>;
  }> }>).flatMap((day) => day.autoNotes || []);
  const note = notes.find((item) => item.title === '三种文档浏览器验收');
  expect(note).toBeTruthy();
  expect(note?.attachments).toHaveLength(8);

  await page.goto('/?panel=learning&view=quick');
  await page.getByText('三种文档浏览器验收', { exact: true }).first().click();
  const record = page.locator('.lc-quick-record').filter({ hasText: '三种文档浏览器验收' });
  await expect(record).toBeVisible();
  const chipScroller = record.locator('.lc-quick-asset-row > div');
  await expect(chipScroller).toBeVisible();
  expect(await chipScroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

  await record.getByRole('button', { name: /e2e\.docx/ }).click();
  const wordFrame = page.frameLocator('iframe[title="e2e.docx"]');
  await expect(wordFrame.getByText('Playwright Word 预览正文')).toBeVisible();
  expect(await wordFrame.locator('html').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

  await record.getByRole('button', { name: /e2e\.html/ }).click();
  const htmlFrame = page.locator('iframe[title="e2e.html"]');
  const htmlFrameContent = page.frameLocator('iframe[title="e2e.html"]');
  await expect(htmlFrameContent.getByText('HTML 自适应预览')).toBeVisible();
  await expect(htmlFrame).toHaveAttribute('sandbox', /allow-scripts/);
  expect(await htmlFrameContent.locator('html').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

  await record.getByRole('button', { name: /e2e-image\.png/ }).click();
  const inlineImage = record.locator('.lrp-image-viewer img');
  await expect(inlineImage).toBeVisible();
  await expect.poll(() => inlineImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const imageViewer = record.locator('.lrp-image-viewer');
  await imageViewer.hover();
  expect(await imageViewer.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const initialImageWidth = await inlineImage.evaluate((image) => image.getBoundingClientRect().width);
  await page.mouse.wheel(0, 320);
  await expect.poll(() => imageViewer.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await imageViewer.click();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -260);
  await page.keyboard.up('Control');
  await expect.poll(() => inlineImage.evaluate((image) => image.getBoundingClientRect().width)).toBeGreaterThan(initialImageWidth);

  await record.getByRole('button', { name: /e2e-text\.txt/ }).click();
  await expect(record.locator('.lrp-text-preview')).toContainText('Playwright 文本资料预览');

  const pdfChip = record.getByRole('button', { name: /e2e\.pdf/ });
  await pdfChip.click();
  await expect(record.locator('.lrp-pdf-preview')).toBeVisible();
  await expect(record.locator('.lrp-pdf-page canvas')).toBeVisible();
  await expect.poll(() => record.locator('.lrp-pdf-page canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(100);
  const pdfZoomLabel = record.locator('.lrp-pdf-toolbar button').nth(1);
  await expect(pdfZoomLabel).toContainText('100%');
  await record.locator('.lrp-pdf-scroll').hover();
  await page.mouse.wheel(0, 480);
  await expect(pdfZoomLabel).toContainText('100%');

  const chipBox = await pdfChip.boundingBox();
  expect(chipBox).toBeTruthy();
  await page.mouse.move(chipBox!.x + chipBox!.width / 2, chipBox!.y + chipBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(1180, 250, { steps: 8 });
  await page.mouse.up();

  const detached = page.locator('.lc-detached-material.is-pdf').last();
  await expect(detached).toBeVisible();
  await expect(detached.locator('.lrp-pdf-page canvas')).toBeVisible();
  const detachedContent = detached.locator(':scope > div');
  expect(await detachedContent.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      border: style.borderTopWidth,
      radius: style.borderRadius,
      background: style.backgroundColor,
    };
  })).toEqual({
    border: '0px',
    radius: '15px',
    background: 'rgba(0, 0, 0, 0)',
  });

  const beforeMove = await detached.boundingBox();
  const headerTitle = detached.locator(':scope > header strong');
  const headerBox = await headerTitle.boundingBox();
  expect(beforeMove && headerBox).toBeTruthy();
  await page.mouse.move(headerBox!.x + headerBox!.width / 2, headerBox!.y + headerBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(headerBox!.x - 80, headerBox!.y + 70, { steps: 6 });
  await page.mouse.up();
  const afterMove = await detached.boundingBox();
  expect(Math.abs(afterMove!.x - beforeMove!.x) + Math.abs(afterMove!.y - beforeMove!.y)).toBeGreaterThan(50);
  await detached.locator(':scope > header button').last().click();
  await expect(detached).toHaveCount(0);

  const htmlChip = record.getByRole('button', { name: /e2e\.html/ });
  await htmlChip.evaluate((element) => element.scrollIntoView({ block: 'nearest', inline: 'center' }));
  const htmlChipBox = await htmlChip.boundingBox();
  expect(htmlChipBox).toBeTruthy();
  await page.mouse.move(htmlChipBox!.x + htmlChipBox!.width / 2, htmlChipBox!.y + htmlChipBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(690, 300, { steps: 8 });
  await page.mouse.up();

  const detachedHtml = page.locator('.lc-detached-material.is-html').last();
  await expect(detachedHtml).toBeVisible();
  const detachedHtmlFrame = detachedHtml.frameLocator('iframe[title="e2e.html"]');
  await expect(detachedHtmlFrame.getByText('HTML 自适应预览')).toBeVisible();
  await expect.poll(async () => {
    const box = await detachedHtml.boundingBox();
    return box?.width || 0;
  }).toBeLessThan(500);
  const floatingBox = await detachedHtml.boundingBox();
  const wrapBox = await detachedHtmlFrame.locator('.wrap').boundingBox();
  expect(floatingBox && wrapBox).toBeTruthy();
  expect(wrapBox!.width).toBeGreaterThan(410);
  expect(floatingBox!.height / wrapBox!.height).toBeLessThan(1.5);
});

test('cloud session cookie protects APIs and cloud delete stays disabled', async ({ request }) => {
  const origin = workerOrigin;
  const anonymous = await request.get(`${origin}/api/auth/status`);
  expect(anonymous.status()).toBe(200);
  expect((await anonymous.json()).authenticated).toBe(false);

  const login = await request.post(`${origin}/api/auth/login`, {
    data: { username: 'caobiji', password: 'e2e-password' },
  });
  expect(login.status()).toBe(200);
  expect(login.headers()['set-cookie']).toContain('HttpOnly');
  expect(login.headers()['set-cookie']).toContain('Secure');
  expect(login.headers()['set-cookie']).toContain('SameSite=Strict');

  const authenticated = await request.get(`${origin}/api/auth/status`);
  expect((await authenticated.json()).authenticated).toBe(true);

  const cloudDelete = await request.delete(`${origin}/api/entries/e2e-entry`);
  expect(cloudDelete.status()).toBe(405);
  expect((await cloudDelete.json()).code).toBe('CLOUD_DELETE_DISABLED');
});
