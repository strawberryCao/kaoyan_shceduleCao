const WORLD_WIDTH = 4200;
const WORLD_HEIGHT = 3000;

const CANVAS_ORGANIZATION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'layouts'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 500 },
    layouts: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'x', 'y'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 120 },
          x: { type: 'number', minimum: 0, maximum: WORLD_WIDTH },
          y: { type: 'number', minimum: 0, maximum: WORLD_HEIGHT },
          width: { type: 'number', minimum: 120, maximum: 1800 },
          height: { type: 'number', minimum: 58, maximum: 1400 },
          z: { type: 'integer', minimum: 1, maximum: 100000 },
        },
      },
    },
  },
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function cardHeight(item, base) {
  if (Number.isFinite(item?.height)) return item.height;
  const width = Number.isFinite(item?.width) ? item.width : 280;
  const text = String(item?.text || '');
  const charsPerLine = Math.max(8, Math.floor((width - 32) / 15));
  const lines = Math.max(1, text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0));
  return Math.max(base, 54 + lines * 24);
}

function compactCanvas(document) {
  const nodes = [
    ...(document.images || []).map((item, index) => ({
      id: item.id,
      kind: 'image',
      label: item.name || `图片 ${index + 1}`,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      aspectRatio: item.width / Math.max(1, item.height),
      z: item.z,
    })),
    ...(document.texts || []).map((item) => ({
      id: item.id,
      kind: 'text',
      text: String(item.text || '').slice(0, 1000),
      x: item.x,
      y: item.y,
      width: item.width,
      height: cardHeight(item, 58),
      z: item.z,
    })),
    ...(document.annotations || []).map((item) => ({
      id: item.id,
      kind: item.kind === 'relation' ? 'relation-card' : 'annotation',
      text: String(item.text || '').slice(0, 1000),
      relationType: item.relationType || null,
      linkedAnchorCount: Array.isArray(item.anchorIds) ? item.anchorIds.length : 0,
      x: item.x,
      y: item.y,
      width: item.width,
      height: cardHeight(item, 90),
      z: item.z,
    })),
  ];
  const strokeBounds = (document.strokes || []).flatMap((stroke) => {
    if (!Array.isArray(stroke.points) || stroke.points.length === 0) return [];
    const xs = stroke.points.map((point) => point.x).filter(Number.isFinite);
    const ys = stroke.points.map((point) => point.y).filter(Number.isFinite);
    if (xs.length === 0 || ys.length === 0) return [];
    return [{ left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }];
  });
  return {
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT, preferredCenter: { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 } },
    title: String(document.title || '未命名画布').slice(0, 200),
    nodes,
    fixedHandwriting: strokeBounds.length ? {
      strokeCount: (document.strokes || []).length,
      bounds: {
        left: Math.min(...strokeBounds.map((item) => item.left)),
        top: Math.min(...strokeBounds.map((item) => item.top)),
        right: Math.max(...strokeBounds.map((item) => item.right)),
        bottom: Math.max(...strokeBounds.map((item) => item.bottom)),
      },
    } : null,
  };
}

function normalizeCanvasOrganizationResult(value) {
  let root = value;
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    for (const key of ['result', 'data', 'output']) {
      const candidate = root[key];
      if (candidate && typeof candidate === 'object'
        && (Array.isArray(candidate) || candidate.layouts || candidate.layout || candidate.positions || candidate.nodes)) {
        root = candidate;
        break;
      }
    }
  }
  const rawLayouts = Array.isArray(root)
    ? root
    : root && typeof root === 'object'
      ? (root.layouts || root.layout || root.positions || root.nodes)
      : null;
  const layouts = (Array.isArray(rawLayouts) ? rawLayouts : []).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const id = String(item.id ?? item.nodeId ?? item.node_id ?? '').trim().slice(0, 120);
    const position = item.position && typeof item.position === 'object' ? item.position : {};
    const x = Number(item.x ?? position.x);
    const y = Number(item.y ?? position.y);
    if (!id || !Number.isFinite(x) || !Number.isFinite(y)) return [];
    const layout = {
      id,
      x: clamp(x, 0, WORLD_WIDTH),
      y: clamp(y, 0, WORLD_HEIGHT),
    };
    const width = Number(item.width ?? item.size?.width);
    const height = Number(item.height ?? item.size?.height);
    const z = Number(item.z ?? item.zIndex ?? item.z_index);
    if (Number.isFinite(width)) layout.width = clamp(width, 120, 1800);
    if (Number.isFinite(height)) layout.height = clamp(height, 58, 1400);
    if (Number.isFinite(z)) layout.z = Math.round(clamp(z, 1, 100000));
    return [layout];
  }).slice(0, 500);
  const source = root && typeof root === 'object' && !Array.isArray(root) ? root : {};
  const summary = String(source.summary ?? source.description ?? source.reason ?? '').trim().slice(0, 500)
    || `已规划 ${layouts.length} 个画布节点的空间布局。`;
  return { summary, layouts };
}

function buildCanvasOrganizationPrompt(document, options = {}) {
  const context = compactCanvas(document);
  const direction = {
    auto: '根据内容语义自动选择最清晰的阅读方向',
    top_down: '整体以从上到下为主阅读方向',
    left_to_right: '整体以从左到右为主阅读方向',
    grid: '优先使用对齐规整的网格布局',
  }[options.layoutDirection] || '根据内容语义自动选择最清晰的阅读方向';
  const density = {
    compact: '紧凑，减少无效空白但仍不得重叠',
    balanced: '均衡，兼顾可读性与空间利用',
    spacious: '宽松，明显增加分组之间的留白',
  }[options.density] || '均衡，兼顾可读性与空间利用';
  const nodeSpacing = Math.max(16, Math.min(240, Number(options.nodeSpacing) || 56));
  const resizeRule = {
    none: '不得改变任何节点的 width/height，只规划位置与层级',
    text_only: '可以调整文字与批注尺寸，但图片保持原尺寸',
    all: '可以为可读性调整节点尺寸，图片必须保持原宽高比',
  }[options.resizeMode] || '可以为可读性调整节点尺寸，图片必须保持原宽高比';
  return [
    '你是专业的无限画布信息架构师。请整理当前画布的空间布局，而不是改写任何内容。',
    '这是复杂任务：先理解预览图和节点文本的语义，再规划清晰的阅读顺序、分组、留白与层级。',
    '硬性规则：',
    '1. 只能返回输入中已有节点的 id；不得新增、删除、合并或改写节点。',
    `2. ${resizeRule}；文字与批注要保证可读，任何节点不得重叠。`,
    '3. 关系紧密的内容靠近；题目→分析→答案、错因→改法等应按自然阅读方向排列。',
    `4. 主要方向：${direction}；布局密度：${density}；节点至少保留 ${nodeSpacing} 像素间距。`,
    options.centerLayout === false ? '4.1 不强制围绕世界中心，可按当前内容所在区域就近整理。' : '4.1 整体布局尽量围绕世界中心。',
    options.avoidHandwriting === false ? '4.2 手写区域可作为普通背景参考，不要求强制避让。' : '4.2 必须避免覆盖 fixedHandwriting 区域。',
    '5. layouts 给出需要整理的每个节点的左上角 x/y，可按需要给 width/height/z。',
    '6. 只输出严格 JSON，不要 Markdown。根对象必须且只能包含 summary 和 layouts；summary 用一句话说明布局思路，layouts 必须是数组。',
    '7. 输出格式示例：{"summary":"按题目到结论的阅读顺序排列","layouts":[{"id":"必须复制输入节点的原始 id","x":1600,"y":900,"width":600,"height":300,"z":1}]}',
    `画布结构：${JSON.stringify(context)}`,
  ].join('\n');
}

async function analyzeCanvasOrganization({ document, previewDataUrl, router, onAttempt }) {
  if (!router) throw new Error('AI router is unavailable');
  const taskOptions = typeof router.getTaskOptions === 'function' ? router.getTaskOptions('canvas_organization') : {};
  const nodeCount = compactCanvas(document).nodes.length;
  const configuredMaxTokens = Number(taskOptions.maxTokens) || 4096;
  // A layout response is compact. Bounding completion size prevents reasoning
  // models from occupying the queue for many minutes on a small canvas.
  const effectiveMaxTokens = taskOptions.tokenBudgetMode === 'fixed'
    ? configuredMaxTokens
    : Math.min(configuredMaxTokens, Math.max(1800, 1400 + nodeCount * 100));
  const networkRetries = Math.round(Math.min(2, Math.max(0, Number(taskOptions.networkRetries) || 0)));
  const jsonRepairRetries = Math.round(Math.min(2, Math.max(0, Number(taskOptions.jsonRepairRetries) || 0)));
  const content = [{ type: 'text', text: buildCanvasOrganizationPrompt(document, taskOptions) }];
  if (typeof previewDataUrl === 'string' && previewDataUrl.startsWith('data:image/')) {
    content.push({ type: 'image_url', image_url: { url: previewDataUrl } });
  }
  const response = await router.complete({
    task: 'canvas_organization',
    messages: [{ role: 'user', content }],
    responseSchema: CANVAS_ORGANIZATION_SCHEMA,
    normalizeJson: normalizeCanvasOrganizationResult,
    timeoutMs: 90_000,
    networkRetries,
    jsonRepairRetries,
    ...(taskOptions.allowStandardVisionFallback === false ? { requiredCapabilities: ['longContext'] } : {}),
    maxTokens: effectiveMaxTokens,
    onAttempt,
  });
  const normalized = normalizeCanvasOrganizationResult(response.json);
  return {
    summary: normalized.summary,
    layouts: normalized.layouts,
    provider: response.provider,
    model: response.model,
    taskOptions,
    effectiveMaxTokens,
  };
}

function applyCanvasOrganization(document, plan, options = plan?.taskOptions || {}) {
  const resizeMode = options.resizeMode || 'all';
  const next = {
    ...document,
    images: (document.images || []).map((item) => ({ ...item })),
    texts: (document.texts || []).map((item) => ({ ...item })),
    annotations: (document.annotations || []).map((item) => ({ ...item, anchorIds: [...(item.anchorIds || [])] })),
    anchors: (document.anchors || []).map((item) => ({ ...item })),
    relations: (document.relations || []).map((item) => ({ ...item })),
    strokes: [...(document.strokes || [])],
    viewport: { ...(document.viewport || {}) },
  };
  const layoutById = new Map((Array.isArray(plan?.layouts) ? plan.layouts : []).map((item) => [item?.id, item]));
  let movedCount = 0;
  let nextZ = 1;

  const applyCommon = (item, layout, minimumHeight) => {
    if (!layout || !Number.isFinite(layout.x) || !Number.isFinite(layout.y)) return false;
    if (resizeMode !== 'none' && Number.isFinite(layout.width)) item.width = clamp(layout.width, 120, 1800);
    if (resizeMode !== 'none' && Number.isFinite(layout.height)) item.height = clamp(layout.height, minimumHeight, 1400);
    const height = Number.isFinite(item.height) ? item.height : minimumHeight;
    item.x = clamp(layout.x, 0, Math.max(0, WORLD_WIDTH - item.width));
    item.y = clamp(layout.y, 0, Math.max(0, WORLD_HEIGHT - height));
    item.z = Number.isInteger(layout.z) ? clamp(layout.z, 1, 100000) : nextZ;
    nextZ = Math.max(nextZ + 1, item.z + 1);
    movedCount += 1;
    return true;
  };

  next.images.forEach((item) => {
    const layout = layoutById.get(item.id);
    if (!layout || !Number.isFinite(layout.x) || !Number.isFinite(layout.y)) return;
    const aspect = item.width / Math.max(1, item.height);
    if (resizeMode === 'all' && Number.isFinite(layout.width)) {
      item.width = clamp(layout.width, 120, 1800);
      item.height = item.width / aspect;
    }
    item.x = clamp(layout.x, 0, Math.max(0, WORLD_WIDTH - item.width));
    item.y = clamp(layout.y, 0, Math.max(0, WORLD_HEIGHT - item.height));
    item.z = Number.isInteger(layout.z) ? clamp(layout.z, 1, 100000) : nextZ;
    nextZ = Math.max(nextZ + 1, item.z + 1);
    movedCount += 1;
  });
  next.texts.forEach((item) => applyCommon(item, layoutById.get(item.id), 58));
  next.annotations.forEach((item) => applyCommon(item, layoutById.get(item.id), 90));

  if (movedCount === 0) throw new Error('AI 没有返回任何可应用的画布位置');
  return { document: next, movedCount };
}

module.exports = {
  CANVAS_ORGANIZATION_SCHEMA,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  analyzeCanvasOrganization,
  applyCanvasOrganization,
  buildCanvasOrganizationPrompt,
  compactCanvas,
  normalizeCanvasOrganizationResult,
};
