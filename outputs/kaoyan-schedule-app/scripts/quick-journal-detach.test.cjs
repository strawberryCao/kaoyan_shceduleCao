const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('quick notes render one selected record with adaptive attachment previews', () => {
  const center = read('src/components/LearningCenter.tsx');
  assert.match(center, /lc-quick-single-reader/);
  assert.match(center, /renderQuickEntry\(selectedNote\)/);
  assert.doesNotMatch(center, /visibleQuick\.map\(renderQuickEntry\)/);
  assert.match(center, /lc-quick-material-workspace is-\$\{quickAssetLayout\}/);
  assert.match(center, /setQuickAssetLayout/);
  assert.match(center, /切换为横向资料标签/);
  assert.match(center, /lc-quick-asset-rail/);
  assert.match(center, /lc-quick-asset-divider/);
  assert.match(center, /beginQuickAssetRailResize/);
  assert.match(center, /QUICK_ASSET_RAIL_WIDTH_STORAGE_KEY/);
  assert.match(center, /lc-quick-active-preview/);
  assert.match(center, /onIntrinsicSize=/);
  assert.match(center, /is-scroll-image/);
  assert.match(center, /加入分栏/);
  assert.match(center, /void deleteNote\(note\)/);
  assert.match(center, /facet: 'method', label: '方法'/);
  assert.doesNotMatch(center, /Windows 桌面|openDetachedLearning|beginDesktopDetach/);
});

test('quick attachment sizing keeps wide images compact and places zoom tools outside the image', () => {
  const center = read('src/components/LearningCenter.tsx');
  const css = read('src/learning-center.css');
  assert.match(center, /activeAssetSize\.height \/ activeAssetSize\.width > \.8/);
  assert.match(css, /\.lc-quick-active-preview\.is-image \.lrp-image-zoom-controls[\s\S]*position: static/);
  assert.match(css, /\.lc-quick-material-workspace \.lc-quick-active-preview\.is-image\.has-intrinsic-size[\s\S]*height: auto/);
  assert.match(css, /\.lc-quick-material-workspace\.is-vertical[\s\S]*var\(--lc-quick-asset-rail-width\)/);
  assert.match(css, /\.lc-quick-asset-divider[\s\S]*cursor: col-resize/);
});

test('attachment chips directly detach inside the current learning center', () => {
  const center = read('src/components/LearningCenter.tsx');
  const layer = read('src/components/LearningInlineDetachLayer.tsx');
  const css = read('src/learning-center.css');
  assert.match(center, /onDragStart=\{\(event\) => beginQuickAssetDrag/);
  assert.match(center, /document\.addEventListener\('drop', handleSourceDrop, true\)/);
  assert.match(center, /detachLayerRef\.current\?\.spawnAt/);
  assert.match(center, /event\.pointerType !== 'mouse'/);
  assert.match(center, /<LearningInlineDetachLayer ref=\{detachLayerRef\}/);
  assert.match(layer, /spawnAt\(asset, assets, clientX, clientY/);
  assert.match(layer, /Math\.hypot\(next\.clientX - startX, next\.clientY - startY\) > 7/);
  assert.match(layer, /WorkspaceAssetPreview/);
  assert.match(layer, /tryX\(other\.x \+ other\.width \+ GAP/);
  assert.match(layer, /tryY\(other\.y \+ other\.height \+ GAP/);
  assert.match(layer, /nearestFreePosition/);
  assert.match(layer, /createPortal/);
  assert.match(layer, /setPointerCapture/);
  assert.match(css, /\.lc-detach-layer[\s\S]*position: fixed/);
  assert.match(css, /\.lc-detach-drag-shield/);
  assert.match(css, /\.lc-detached-resize/);
});

test('mini app keeps quick-note history but does not launch desktop windows', () => {
  const composer = read('src/components/QuickMaterialComposer.tsx');
  assert.match(composer, /最近速记/);
  assert.match(composer, /完整资料在学习中心查看/);
  assert.doesNotMatch(composer, /Windows 桌面|openDetachedLearning|MonitorUp/);
});

test('journal export continuously packs records and only starts a new page when needed', () => {
  const center = read('src/components/LearningCenter.tsx');
  const exporter = read('src/utils/quickJournalExport.ts');
  assert.match(center, /导出日记/);
  assert.match(center, /exportQuickJournalPackage/);
  assert.match(exporter, /\.kaoyan-journal\.zip/);
  assert.doesNotMatch(exporter, /\.record\{break-before:page\}/);
  assert.match(exporter, /body\.scrollHeight>body\.clientHeight/);
  assert.match(exporter, /一页可以连续容纳多条速记/);
  assert.match(exporter, /mammoth\.convertToHtml/);
  assert.match(exporter, /<object data=/);
  assert.match(exporter, /<iframe src=/);
  assert.match(exporter, /<img src=/);
});
