const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('workspace images open the shared in-app viewer without mutating the source file', () => {
  const preview = read('src/components/WorkspaceAssetPreview.tsx');
  assert.match(preview, /className="lrp-image-open"/);
  assert.match(preview, /aria-label=\{onOpen \? `打开图片查看器：\$\{item\.name\}`/);
  assert.match(preview, /<ImageViewer[\s\S]*ariaLabel="资料图片查看器"/);
  assert.match(preview, /src: asset\.id === item\.id \? source : asset\.url/);
  assert.doesNotMatch(preview, /writeFile|renameSync|unlinkSync/);
});

test('image viewer exposes reversible rotate, reset, zoom and close controls', () => {
  const viewer = read('src/components/ImageViewer.tsx');
  assert.match(viewer, /aria-label="逆时针旋转图片"/);
  assert.match(viewer, /aria-label="顺时针旋转图片"/);
  assert.match(viewer, /aria-label="重置图片视图"/);
  assert.match(viewer, /aria-label="图片适合窗口"/);
  assert.match(viewer, /aria-label="显示图片原始大小"/);
  assert.match(viewer, /event\.key === 'Escape'/);
  assert.match(viewer, /previousFocus\?\.focus\(\)/);
});
