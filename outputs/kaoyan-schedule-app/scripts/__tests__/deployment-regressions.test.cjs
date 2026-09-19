const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Windows LAN, wallpaper and Tailscale AI administration stay available without opening Cloudflare administration', () => {
  const app = read('src/App.tsx');
  const shell = read('src/components/WebAppShell.tsx');
  const runtime = read('src/utils/runtime.ts');
  const launcher = read('scripts/start-local-services-hidden.ps1');

  assert.match(runtime, /IS_TAILSCALE_RUNTIME[\s\S]*endsWith\('\.ts\.net'\)/);
  assert.match(runtime, /IS_CLOUD_RUNTIME[\s\S]*protocol !== 'file:'[\s\S]*!isLoopbackHostname/);
  assert.match(runtime, /IS_AUTHENTICATED_REMOTE_RUNTIME[\s\S]*protocol === 'https:'/);
  assert.match(app, /isAiConfigMode && !IS_TAILSCALE_RUNTIME/);
  assert.doesNotMatch(app, /isWallpaperMode && !window\.kaoyanDesktop\?\.isElectron/);
  assert.match(shell, /item\.id !== 'ai-config' \|\| IS_TAILSCALE_RUNTIME/);
  assert.match(launcher, /KAOYAN_WEB_HOST = '0\.0\.0\.0'/);
});

test('opening the Windows Electron note window starts the lightweight client services in development and packaged builds', () => {
  const main = read('electron/main.cjs');
  const packageJson = JSON.parse(read('package.json'));
  const resources = packageJson.build.extraResources || [];

  assert.match(main, /function ensureWindowsClientServices\(\)/);
  assert.match(main, /KAOYAN_NODE_EXECUTABLE: process\.execPath/);
  assert.match(main, /ELECTRON_RUN_AS_NODE: '1'/);
  assert.match(main, /ensureWindowsClientServices\(\);[\s\S]{0,120}createNoteWindow\(\)/);
  assert.ok(resources.some((entry) => entry.from === 'dist' && entry.to === 'runtime/dist'));
  assert.ok(resources.some((entry) => entry.from === 'scripts' && entry.to === 'runtime/scripts'));
  assert.ok(resources.some((entry) => entry.from === 'shared' && entry.to === 'runtime/shared'));
});
