const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseCliOptions,
  prepareCloudflareSeed,
} = require('./prepare-cloudflare-seed.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function listFiles(root) {
  const results = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else results.push(path.relative(root, absolute).replaceAll('\\', '/'));
    }
  }
  visit(root);
  return results.sort();
}

test('parses explicit assistant and output roots', () => {
  assert.deepEqual(
    parseCliOptions(['--assistant-root', 'D:\\assistant', '--output=D:\\seed']),
    { assistantRoot: 'D:\\assistant', outputRoot: 'D:\\seed' },
  );
});

test('prepares a deterministic, deduplicated and secret-free Cloudflare seed', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-cloudflare-seed-'));
  const assistantRoot = path.join(temporaryRoot, 'assistant');
  const outputRoot = path.join(temporaryRoot, 'cloudflare', '.seed');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  fs.mkdirSync(assistantRoot, { recursive: true });
  const firstAsset = path.join(temporaryRoot, 'notes', 'first.PNG');
  const duplicateAsset = path.join(temporaryRoot, 'notes', 'duplicate.png');
  const assetContent = Buffer.from('same-image-content');
  fs.mkdirSync(path.dirname(firstAsset), { recursive: true });
  fs.writeFileSync(firstAsset, assetContent);
  fs.writeFileSync(duplicateAsset, assetContent);
  const missingAsset = path.join(temporaryRoot, 'notes', 'missing.jpg');
  const providerConfig = path.join(assistantRoot, 'ai-providers.json');
  const qwenConfig = path.join(assistantRoot, 'qwen-config.json');
  fs.writeFileSync(providerConfig, '{"apiKey":"SUPER_SECRET_PROVIDER"}', 'utf8');
  fs.writeFileSync(qwenConfig, '{"apiKey":"SUPER_SECRET_QWEN"}', 'utf8');

  writeJson(path.join(assistantRoot, 'learning-data.json'), {
    version: 1,
    localOnlyPath: 'C:\\Users\\ASUS\\Desktop\\private.txt',
    apiKey: 'SUPER_SECRET_INLINE',
    notes: [{
      noteUid: 'note-1',
      filePath: firstAsset,
      items: [
        { sourceFilePath: duplicateAsset },
        { sourceFilePath: missingAsset },
      ],
    }, {
      noteUid: 'note-2',
      filePath: qwenConfig,
    }],
    cards: [{ sourceFilePath: firstAsset }],
  });

  const activeCanvasPath = path.join(assistantRoot, 'canvas-projects', 'active-canvas', 'document.json');
  writeJson(activeCanvasPath, {
    id: 'active-canvas',
    title: 'Active canvas',
    syncRevision: 7,
    updatedAt: '2026-07-22T12:00:00.000Z',
    images: [{ id: 'image-1' }],
    nodes: [{ id: 'node-1' }],
    texts: [{ id: 'text-1' }],
    annotations: [],
    relations: [{ id: 'relation-1' }],
    strokes: [],
    groups: [],
  });
  writeJson(path.join(assistantRoot, 'canvas-projects', '.trash', 'deleted-canvas', 'document.json'), {
    id: 'deleted-canvas',
    title: 'Must not be exported',
  });

  const firstRun = prepareCloudflareSeed({ assistantRoot, outputRoot });
  const firstSnapshot = new Map(listFiles(outputRoot).map((file) => [
    file,
    fs.readFileSync(path.join(outputRoot, ...file.split('/'))),
  ]));

  const assetName = `${digest(assetContent)}.png`;
  const assetUri = `r2://note-assets/${assetName}`;
  const migrated = JSON.parse(fs.readFileSync(
    path.join(outputRoot, 'objects', 'bootstrap', 'learning-data.json'),
    'utf8',
  ));
  assert.equal(migrated.notes[0].filePath, assetUri);
  assert.equal(migrated.notes[0].items[0].sourceFilePath, assetUri);
  assert.equal(migrated.notes[0].items[1].sourceFilePath, '');
  assert.equal(migrated.notes[1].filePath, '');
  assert.equal(migrated.cards[0].sourceFilePath, assetUri);
  assert.equal(migrated.localOnlyPath, '');
  assert.equal(Object.hasOwn(migrated, 'apiKey'), false);
  assert.equal(fs.readFileSync(path.join(outputRoot, 'objects', 'note-assets', assetName)).toString(), assetContent.toString());

  const canvasIndex = JSON.parse(fs.readFileSync(
    path.join(outputRoot, 'objects', 'bootstrap', 'canvas-index.json'),
    'utf8',
  ));
  const canvasHash = digest(fs.readFileSync(activeCanvasPath));
  const canvasR2Key = `bootstrap/canvases/active-canvas/${canvasHash}.json`;
  assert.deepEqual(canvasIndex, [{
    id: 'active-canvas',
    title: 'Active canvas',
    revision: 7,
    r2Key: canvasR2Key,
    updatedAt: '2026-07-22T12:00:00.000Z',
    summary: {
      imageCount: 2,
      textCount: 1,
      annotationCount: 0,
      relationCount: 1,
      strokeCount: 0,
      groupCount: 0,
    },
  }]);
  assert.equal(
    fs.existsSync(path.join(outputRoot, 'objects', ...canvasR2Key.split('/'))),
    true,
  );
  assert.equal(fs.existsSync(path.join(outputRoot, 'objects', 'canvases')), false);

  const manifestPath = path.join(outputRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.totals.objectCount, 4);
  assert.equal(manifest.totals.noteAssetCount, 1);
  assert.equal(manifest.totals.canvasCount, 1);
  assert.equal(manifest.totals.bootstrapCount, 2);
  assert.equal(manifest.totals.rewrittenAssetReferences, 3);
  assert.equal(manifest.totals.missingAssetReferences, 1);
  assert.equal(manifest.totals.blockedAssetReferences, 1);
  assert.equal(manifest.files.some((file) => file.r2Key === 'canvases/active-canvas/document.json'), false);
  assert.equal(manifest.files.find((file) => file.r2Key === canvasR2Key).contentType, 'application/json');
  assert.equal(
    manifest.files.find((file) => file.r2Key === `note-assets/${assetName}`).contentType,
    'image/png',
  );
  assert.equal(manifest.totals.objectBytes, manifest.files.reduce((total, file) => total + file.bytes, 0));
  for (const file of manifest.files) {
    const content = fs.readFileSync(path.join(outputRoot, 'objects', ...file.r2Key.split('/')));
    assert.equal(content.length, file.bytes);
    assert.equal(digest(content), file.sha256);
  }
  const reconciliation = manifest.files
    .map((file) => `${file.r2Key}\0${file.sha256}\0${file.bytes}`)
    .join('\n');
  assert.equal(digest(Buffer.from(reconciliation)), manifest.contentSha256);
  assert.equal(firstRun.manifest.contentSha256, manifest.contentSha256);

  const allOutput = listFiles(outputRoot)
    .map((file) => fs.readFileSync(path.join(outputRoot, ...file.split('/')), 'utf8'))
    .join('\n');
  assert.doesNotMatch(allOutput, /[A-Za-z]:[\\/]/);
  assert.doesNotMatch(allOutput, /SUPER_SECRET/);
  assert.doesNotMatch(allOutput, /ai-providers\.json|qwen-config\.json/i);

  const secondRun = prepareCloudflareSeed({ assistantRoot, outputRoot });
  assert.equal(secondRun.manifest.contentSha256, firstRun.manifest.contentSha256);
  assert.deepEqual(listFiles(outputRoot), [...firstSnapshot.keys()]);
  for (const [file, content] of firstSnapshot) {
    assert.deepEqual(fs.readFileSync(path.join(outputRoot, ...file.split('/'))), content);
  }
});
