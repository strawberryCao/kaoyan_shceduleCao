const assert = require('node:assert/strict');
const test = require('node:test');

const {
  analyzeCanvasOrganization,
  applyCanvasOrganization,
  compactCanvas,
  normalizeCanvasOrganizationResult,
} = require('../canvas-ai-organizer.cjs');

function makeDocument() {
  return {
    id: 'canvas-ai-test',
    version: 1,
    title: '极限错题整理',
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    syncRevision: 3,
    images: [{
      id: 'image-a', kind: 'image', src: 'data:image/png;base64,SECRET_IMAGE_BYTES', name: '题目',
      x: 100, y: 100, width: 800, height: 400, naturalWidth: 1600, naturalHeight: 800, z: 1,
    }],
    texts: [{ id: 'text-a', kind: 'text', text: '先检查定义域', x: 1000, y: 100, width: 280, height: 96, fontSize: 18, color: '#333', z: 2 }],
    annotations: [{ id: 'note-a', kind: 'annotation', text: '这里容易漏条件', x: 1000, y: 300, width: 300, height: 120, anchorIds: [], relationType: '解释', color: '#a66', z: 3 }],
    anchors: [],
    relations: [],
    strokes: [{ id: 'stroke-a', kind: 'ink', tool: 'pen', points: [{ x: 2000, y: 1500, pressure: 0.5 }], color: '#222', width: 4, opacity: 1, z: 4 }],
    viewport: { zoom: 0.9, scrollLeft: 0, scrollTop: 0 },
  };
}

test('compacts canvas structure without sending embedded image bytes as text', () => {
  const compact = compactCanvas(makeDocument());
  const serialized = JSON.stringify(compact);
  assert.doesNotMatch(serialized, /SECRET_IMAGE_BYTES/);
  assert.equal(compact.nodes.length, 3);
  assert.equal(compact.fixedHandwriting.strokeCount, 1);
});

test('applies a bounded AI layout while preserving content and image aspect ratio', () => {
  const source = makeDocument();
  const result = applyCanvasOrganization(source, {
    layouts: [
      { id: 'image-a', x: 1600, y: 900, width: 600, height: 900, z: 5 },
      { id: 'text-a', x: 2250, y: 900, width: 320, height: 110, z: 6 },
      { id: 'note-a', x: 2250, y: 1080, width: 340, height: 140, z: 7 },
    ],
  });
  assert.equal(result.movedCount, 3);
  assert.equal(result.document.images[0].width, 600);
  assert.equal(result.document.images[0].height, 300);
  assert.equal(result.document.texts[0].text, source.texts[0].text);
  assert.equal(result.document.annotations[0].text, source.annotations[0].text);
  assert.equal(result.document.strokes[0], source.strokes[0]);
  assert.equal(source.images[0].x, 100);
});

test('honors the canvas task resize policy in program post-processing', () => {
  const source = makeDocument();
  const result = applyCanvasOrganization(source, {
    layouts: [{ id: 'image-a', x: 1500, y: 800, width: 300, height: 900 }],
  }, { resizeMode: 'none' });
  assert.equal(result.document.images[0].x, 1500);
  assert.equal(result.document.images[0].width, 800);
  assert.equal(result.document.images[0].height, 400);
});

test('normalizes common model layout variants and synthesizes a missing summary', () => {
  assert.deepEqual(normalizeCanvasOrganizationResult({
    nodes: [{ node_id: 'image-a', position: { x: '1550', y: '880' }, size: { width: '640', height: '320' }, z_index: '8', explanation: 'unused' }],
    extra: 'ignored',
  }), {
    summary: '已规划 1 个画布节点的空间布局。',
    layouts: [{ id: 'image-a', x: 1550, y: 880, width: 640, height: 320, z: 8 }],
  });
  assert.deepEqual(normalizeCanvasOrganizationResult({
    result: { description: '按阅读顺序排列。', layout: [{ id: 'text-a', x: -20, y: 99999 }] },
  }), {
    summary: '按阅读顺序排列。',
    layouts: [{ id: 'text-a', x: 0, y: 3000 }],
  });
});

test('routes canvas organization as its own structured high-complexity AI task', async () => {
  let request;
  const result = await analyzeCanvasOrganization({
    document: makeDocument(),
    previewDataUrl: 'data:image/png;base64,AAAA',
    router: {
      getTaskOptions() {
        return {
          layoutDirection: 'left_to_right',
          nodeSpacing: 88,
          maxTokens: 6200,
          resizeMode: 'none',
          networkRetries: 1,
          jsonRepairRetries: 1,
          allowStandardVisionFallback: false,
          tokenBudgetMode: 'fixed',
        };
      },
      async complete(input) {
        request = input;
        return {
          json: { summary: '按题目、思路和错因重新排列。', layouts: [{ id: 'image-a', x: 1500, y: 900 }] },
          provider: 'kimi',
          model: 'kimi-k3',
        };
      },
    },
  });
  assert.equal(request.task, 'canvas_organization');
  assert.equal(request.messages[0].content[1].type, 'image_url');
  assert.equal(request.responseSchema.properties.layouts.maxItems, 500);
  assert.equal(typeof request.normalizeJson, 'function');
  assert.equal(request.maxTokens, 6200);
  assert.equal(request.timeoutMs, 90_000);
  assert.equal(request.networkRetries, 1);
  assert.equal(request.jsonRepairRetries, 1);
  assert.deepEqual(request.requiredCapabilities, ['longContext']);
  assert.match(request.messages[0].content[0].text, /从左到右/);
  assert.match(request.messages[0].content[0].text, /88 像素/);
  assert.equal(result.provider, 'kimi');
  assert.equal(result.taskOptions.resizeMode, 'none');
  assert.equal(result.layouts[0].id, 'image-a');
});
