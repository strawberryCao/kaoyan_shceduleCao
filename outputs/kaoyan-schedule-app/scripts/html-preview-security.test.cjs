'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('GeoGebra network profile requires the exact official runtime element and initializer', () => {
  const preview = read('src/components/WorkspaceAssetPreview.tsx');
  assert.match(preview, /querySelectorAll<HTMLScriptElement>\('script\[src\]'\)/);
  assert.match(preview, /runtimeUrl\.hostname === 'www\.geogebra\.org'/);
  assert.match(preview, /runtimeUrl\.pathname === '\/apps\/deployggb\.js'/);
  assert.match(preview, /officialGeoGebraRuntime && initializesGeoGebra/);
  assert.match(preview, /runtimeProfile: usesGeoGebraRuntime \? 'geogebra' : 'offline'/);
  assert.match(preview, /createGeoGebraPreviewSession/);
  assert.match(preview, /frameUrl\.origin === window\.location\.origin/);
  assert.match(preview, /sandbox="allow-scripts allow-same-origin"/);
  assert.match(preview, /src=\{documentSource\.frameUrl\}/);
  assert.match(preview, /srcDoc=\{documentSource\.html\}/);
  assert.doesNotMatch(preview, /srcDoc=\{documentSource\.html\}[\s\S]{0,240}allow-same-origin/);
  assert.doesNotMatch(preview, /test\(entryHtml\)/);
  assert.doesNotMatch(preview, /allow-forms|allow-modals|allow-downloads/);
  assert.match(preview, /referrerPolicy="no-referrer"/);
  assert.match(preview, /const projectSignature =/);
  assert.match(preview, /\[projectSignature, reloadNonce, token\]/);
  assert.match(preview, /Promise\.allSettled/);
  assert.match(preview, /kaoyan-preview-runtime/);
  assert.match(preview, /GeoGebra 在 15 秒内没有完成绘制/);
  assert.doesNotMatch(preview, /characterData: true, attributes: true/);
  assert.match(preview, /method: 'DELETE'/);
  const server = read('scripts/note-server.cjs');
  assert.match(server, /htmlPreviewCleanupTimer/);
  assert.match(server, /req\.method === 'DELETE' && htmlPreviewMatch/);
});

test('AI HTML wrapper strips navigation attributes and disables workers', () => {
  const safeHtml = read('src/utils/safeHtmlArtifact.ts');
  const composer = read('src/components/QuickMaterialComposer.tsx');
  const studio = read('src/components/QuickHtmlStudio.tsx');
  assert.match(safeHtml, /href\|src\|srcset\|xlink:href\|action\|formaction\|poster\|ping/);
  assert.match(safeHtml, /worker-src 'none'/);
  assert.match(safeHtml, /export const safeHtmlArtifactFileName/);
  assert.match(studio, /export type QuickHtmlAttachOutcome/);
  assert.match(studio, /onAttach: \(file: File, operationId: string\) => Promise<QuickHtmlAttachOutcome>/);
  assert.match(studio, /hashSafeHtmlArtifact\(source\)/);
  assert.match(studio, /HTML 预览与操作编号仍保留/);
  assert.match(studio, /prepared\.contextSignature !== currentContextSignature/);
  assert.match(studio, /sandbox="allow-scripts"/);
  assert.match(studio, /referrerPolicy="no-referrer"/);
  assert.match(studio, /!IS_CLOUD_RUNTIME && <button/);
  assert.doesNotMatch(composer, /generateQuickHtmlNote|quick-material-ai-html|AI 创建 HTML 交互笔记/);
});
