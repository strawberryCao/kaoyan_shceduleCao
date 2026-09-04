const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'cloudflare', 'entries.js'), 'utf8');

test('cloud entry patch preserves the user requested attachment order', () => {
  assert.match(source, /selectedAssets = requestedAssetIds\.map\(\(assetId\) => assetsById\.get\(assetId\)\)/);
  assert.match(source, /INVALID_ASSET_ORDER/);
  assert.doesNotMatch(source, /current\.assets\.filter\(\(asset\) => payload\.assetIds\.includes\(asset\.assetId\)\)/);
});
