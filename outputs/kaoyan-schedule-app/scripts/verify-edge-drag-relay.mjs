import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(projectRoot, 'browser-extension', 'edge-drag-relay');
const proofRoot = path.join(projectRoot, 'test-results');
const transferId = '103d5722-3050-4aee-ab2e-85c24345d796';

let server;
let context;
let profileRoot;

try {
  server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url === '/target') {
      const body = `<!doctype html>
        <html lang="zh-CN">
          <head>
            <meta charset="utf-8">
            <title>Edge 资料接力验证页</title>
            <style>
              body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #493e34; background: linear-gradient(135deg, #f7f2eb, #e8ddd0); font: 16px "Microsoft YaHei", sans-serif; }
              main { width: min(720px, 80vw); padding: 48px; border: 1px solid #d4c3b2; border-radius: 24px; background: rgba(255,255,255,.72); box-shadow: 0 24px 80px rgba(74,54,38,.14); }
              h1 { margin: 0 0 12px; font-size: 28px; }
              p { margin: 0; color: #77685b; }
            </style>
          </head>
          <body><main><h1>Edge 跨窗口资料接力</h1><p>本页用于验证扩展接收、页面磁吸动画与资料落地。</p></main></body>
        </html>`;
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    if (request.url === `/relay-transfers/${transferId}`) {
      const body = JSON.stringify({
        ok: true,
        protocol: 'kaoyan-material-v1',
        transferId,
        expiresAt: Date.now() + 120_000,
        asset: {
          id: 'edge-verification-image',
          kind: 'image',
          name: 'Edge 跨窗口接力验证图.svg',
          mimeType: 'image/svg+xml',
          url: `${origin}/asset.svg`,
          fallbackUrl: `${origin}/asset.svg`,
          posterUrl: `${origin}/asset.svg`,
          label: '验证资料',
          sizeLabel: 'SVG',
        },
      });
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    if (request.url === '/asset.svg') {
      const body = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="560" viewBox="0 0 960 560">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ead8c4"/><stop offset="1" stop-color="#8f6747"/></linearGradient></defs>
        <rect width="960" height="560" rx="36" fill="url(#g)"/>
        <circle cx="480" cy="248" r="112" fill="none" stroke="#fff8ef" stroke-width="18" opacity=".86"/>
        <path d="M330 248h300M480 98v300" stroke="#fff8ef" stroke-width="18" stroke-linecap="round" opacity=".86"/>
        <text x="480" y="470" text-anchor="middle" fill="#fffaf4" font-family="Microsoft YaHei,sans-serif" font-size="42">跨窗口资料接力验证成功</text>
      </svg>`;
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  profileRoot = await mkdtemp(path.join(tmpdir(), 'kaoyan-edge-relay-'));
  context = await chromium.launchPersistentContext(profileRoot, {
    channel: 'msedge',
    headless: false,
    viewport: { width: 1100, height: 720 },
    args: [
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  await page.goto(`${origin}/target`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(450);
  const sourceWindowSuppressed = await page.evaluate(({ relayUrl, transfer }) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-kaoyan-material-v1', JSON.stringify({
      protocol: 'kaoyan-material-v1',
      transferId: transfer,
      relayUrl,
      kind: 'image',
      name: 'Edge 跨窗口接力验证图.svg',
      mimeType: 'image/svg+xml',
      createdAt: Date.now(),
    }));
    document.dispatchEvent(new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }));
    document.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: 500,
      clientY: 320,
      dataTransfer,
    }));
    const suppressed = !document.querySelector('[data-kaoyan-drag-relay]');
    document.dispatchEvent(new DragEvent('dragend', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }));
    return suppressed;
  }, {
    relayUrl: `${origin}/relay-transfers/${transferId}`,
    transfer: transferId,
  });
  if (!sourceWindowSuppressed) {
    throw new Error('Source-window drag was incorrectly handled as an incoming relay');
  }
  await page.evaluate(({ relayUrl, transfer }) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.effectAllowed = 'copy';
    dataTransfer.setData('application/x-kaoyan-material-v1', JSON.stringify({
      protocol: 'kaoyan-material-v1',
      transferId: transfer,
      relayUrl,
      kind: 'image',
      name: 'Edge 跨窗口接力验证图.svg',
      mimeType: 'image/svg+xml',
      createdAt: Date.now(),
    }));
    const dispatch = (type, x, y) => document.dispatchEvent(new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      dataTransfer,
    }));
    dispatch('dragenter', 45, 320);
    dispatch('dragover', 410, 330);
    dispatch('dragover', 620, 350);
    dispatch('drop', 620, 350);
  }, {
    relayUrl: `${origin}/relay-transfers/${transferId}`,
    transfer: transferId,
  });
  const relayHost = page.locator('[data-kaoyan-drag-relay]');
  await relayHost.waitFor({ state: 'attached', timeout: 8_000 });
  await page.waitForFunction(() => (
    document.querySelector('[data-kaoyan-drag-relay]')?.getAttribute('data-card-count') === '1'
  ), undefined, { timeout: 8_000 });
  await page.waitForFunction(() => (
    document.querySelector('[data-kaoyan-drag-relay]')?.getAttribute('data-relay-state') === 'idle'
  ), undefined, { timeout: 8_000 });
  await mkdir(proofRoot, { recursive: true });
  const proofPath = path.join(proofRoot, 'edge-drag-relay-proof.png');
  await page.screenshot({ path: proofPath });
  const result = await relayHost.evaluate((host) => ({
    relayState: host.getAttribute('data-relay-state'),
    captureState: host.getAttribute('data-capture-state'),
    cardCount: host.getAttribute('data-card-count'),
  }));
  console.log(JSON.stringify({
    ok: result.cardCount === '1',
    browser: await context.browser()?.version(),
    proofPath,
    sourceWindowSuppressed,
    ...result,
  }, null, 2));
} finally {
  await context?.close().catch(() => undefined);
  await new Promise((resolve) => server?.close(resolve) || resolve());
  if (profileRoot?.startsWith(path.join(tmpdir(), 'kaoyan-edge-relay-'))) {
    await rm(profileRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}
