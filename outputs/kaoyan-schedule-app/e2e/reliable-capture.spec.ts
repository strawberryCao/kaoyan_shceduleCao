import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Packer, Paragraph } from 'docx';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const notesRoot = path.join(projectRoot, '.e2e-runtime', 'notes');
const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xf0fWQAAAABJRU5ErkJggg==';

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
  await expect(page.getByText('图片和学习中心条目已写入本地磁盘')).toBeVisible();

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
  const response = await page.request.get('http://127.0.0.1:5174/learning-data');
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
  const first = await request.post('http://127.0.0.1:5174/capture-batches', { data: payload });
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

  const jobResponse = await request.get(`http://127.0.0.1:5174/jobs/${created.jobId}`);
  expect(jobResponse.status()).toBe(200);
  expect((await jobResponse.json()).job.entryId).toBe(created.entryId);

  const replay = await request.post('http://127.0.0.1:5174/capture-batches', { data: payload });
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

  const response = await page.request.get('http://127.0.0.1:5174/learning-data');
  const snapshot = await response.json();
  const notes = Object.values(snapshot.days as Record<string, { autoNotes?: Array<{ remark?: string; subject?: string; facets?: string[] }> }>)
    .flatMap((day) => day.autoNotes || []);
  const note = notes.find((item) => item.remark === '移动端一次输入一次点击完成的速记');
  expect(note).toBeTruthy();
  expect(note.subject).toBe('默认文件夹');
  expect(note.facets).toContain('quick');
});

test('PDF, DOCX and HTML survive upload and reopen in the desktop reader', async ({ page }) => {
  const docx = await Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph('Playwright Word 预览正文')] }],
  }));
  await page.goto('/?noteApp=1');
  await page.getByRole('button', { name: '速记' }).click();
  await page.getByPlaceholder('例如：拉格朗日中值定理的构造思路').fill('三种文档浏览器验收');
  await page.getByPlaceholder('直接写下想法、结论、错因或待解决问题……').fill('附件必须可重新打开');
  await page.locator('.quick-material-files input[type="file"]').setInputFiles([
    {
      name: 'e2e.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF', 'utf8'),
    },
    {
      name: 'e2e.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: docx,
    },
    {
      name: 'e2e.html',
      mimeType: 'text/html',
      buffer: Buffer.from('<!doctype html><h1>HTML 安全预览</h1><script>document.body.dataset.scriptRan="yes"</script>', 'utf8'),
    },
  ]);
  await page.getByRole('button', { name: '保存到学习中心' }).click();
  await expect(page.getByRole('heading', { name: '记录完成' })).toBeVisible();

  const response = await page.request.get('http://127.0.0.1:5174/learning-data');
  const snapshot = await response.json();
  const notes = Object.values(snapshot.days as Record<string, { autoNotes?: Array<{
    noteUid?: string;
    title?: string;
    attachments?: Array<{ name?: string }>;
  }> }>).flatMap((day) => day.autoNotes || []);
  const note = notes.find((item) => item.title === '三种文档浏览器验收');
  expect(note).toBeTruthy();
  expect(note?.attachments?.map((item) => item.name).sort()).toEqual(['e2e.docx', 'e2e.html', 'e2e.pdf']);

  await page.goto(`/?workspaceNote=${encodeURIComponent(note?.noteUid || '')}`);
  await page.getByRole('button', { name: /e2e\.docx/ }).click();
  const wordFrame = page.frameLocator('iframe[title="e2e.docx"]');
  await expect(wordFrame.getByText('Playwright Word 预览正文')).toBeVisible();

  await page.getByRole('button', { name: /e2e\.html/ }).click();
  await expect(page.getByText('脚本已禁用')).toBeVisible();
  const htmlFrame = page.locator('iframe[title="e2e.html"]');
  await expect(page.frameLocator('iframe[title="e2e.html"]').getByText('HTML 安全预览')).toBeVisible();
  await expect(htmlFrame).toHaveAttribute('sandbox', '');
  await page.getByRole('button', { name: '隔离运行' }).click();
  await expect(htmlFrame).toHaveAttribute('sandbox', /allow-scripts/);

  await page.getByRole('button', { name: /e2e\.pdf/ }).click();
  await expect(page.locator('iframe[title="e2e.pdf"]')).toBeVisible();
});

test('cloud session cookie protects APIs and cloud delete stays disabled', async ({ request }) => {
  const origin = 'http://localhost:8787';
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
