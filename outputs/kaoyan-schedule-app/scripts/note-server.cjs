const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadQwenConfig } = require('./qwen-config.cjs');

const PORT = Number(process.env.KAOYAN_NOTE_PORT || 5174);
const NOTES_ROOT = process.env.KAOYAN_NOTES_ROOT || path.join(os.homedir(), 'Desktop', '笔记');
const ASSISTANT_ROOT = process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手');
const LAYOUT_PATH = path.join(ASSISTANT_ROOT, 'desktop-layout.json');
const DEFAULT_SUBJECT = '默认文件夹';
const qwen = loadQwenConfig();

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sanitizeSegment(input, fallback = DEFAULT_SUBJECT, maxLength = 80) {
  return String(input || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._\s]+|[._\s]+$/g, '')
    .slice(0, maxLength) || fallback;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 80 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function decodeDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!match) {
    throw new Error('Invalid image data URL');
  }

  const mime = match[1].toLowerCase();
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
  return {
    buffer: Buffer.from(match[2], 'base64'),
    ext,
    mime,
    dataUrl: String(dataUrl),
  };
}

function metadataDir(subjectDir) {
  return path.join(subjectDir, '.metadata');
}

function metadataIndexPath(subjectDir) {
  return path.join(metadataDir(subjectDir), 'metadata.json');
}

function sidecarPathForId(subjectDir, id) {
  return path.join(metadataDir(subjectDir), `${id}.note.json`);
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function appendMetadata(subjectDir, metadata) {
  const metaDir = metadataDir(subjectDir);
  fs.mkdirSync(metaDir, { recursive: true });
  const indexPath = metadataIndexPath(subjectDir);
  const legacyIndexPath = path.join(subjectDir, 'metadata.json');
  const existing = readJson(indexPath, readJson(legacyIndexPath, []));
  const list = Array.isArray(existing)
    ? existing.filter((item) => item?.id !== metadata.id && item?.fileName !== metadata.fileName)
    : [];
  list.push(metadata);
  fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), 'utf8');
}

function postJson(urlString, headers, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);
    const transport = url.protocol === 'http:' ? http : https;
    const request = transport.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Qwen HTTP ${response.statusCode}: ${data.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid Qwen response: ${data.slice(0, 500)}`));
          }
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('Qwen request timeout'));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function qwenContentToText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item === 'string' ? item : item?.text || item?.content || '')
      .filter(Boolean)
      .join('\n');
  }
  return String(content || '');
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function guessSubjectFromText(text) {
  const content = String(text || '');
  const rules = [
    ['高等数学', ['高等数学', '高数', '极限', '导数', '积分', '微分', '级数', '中值定理', '曲线积分', '多元函数']],
    ['线性代数', ['线性代数', '线代', '矩阵', '行列式', '特征值', '特征向量', '线性方程组', '秩']],
    ['概率论', ['概率论', '概率', '随机变量', '分布', '期望', '方差', '大数定律', '中心极限定理']],
    ['数据结构', ['数据结构', '链表', '栈', '队列', '树', '图', '排序', '查找', '堆', '哈希']],
    ['计算机组成', ['计算机组成', '组成原理', '计组', 'CPU', 'Cache', '存储器', '指令', '流水线', '总线']],
    ['操作系统', ['操作系统', '进程', '线程', '死锁', '分页', '段页', '文件系统', '调度']],
    ['计算机网络', ['计算机网络', '计网', '网络', 'TCP', 'UDP', 'IP', 'HTTP', 'DNS', '路由', '拥塞', '流量控制']],
    ['英语', ['英语', '单词', '阅读', '翻译', '作文', '长难句']],
  ];
  for (const [subject, keywords] of rules) {
    if (keywords.some((keyword) => content.toLowerCase().includes(String(keyword).toLowerCase()))) {
      return subject;
    }
  }
  return DEFAULT_SUBJECT;
}

function makeFallbackName({ kind, remark, subject }) {
  const text = remark && remark.trim() ? remark : kind === 'canvas' ? '画布拼接笔记' : '图片笔记';
  const safeSubject = sanitizeSegment(subject || guessSubjectFromText(text), DEFAULT_SUBJECT, 24);
  const safeTitle = sanitizeSegment(text, kind === 'canvas' ? '画布拼接笔记' : '图片笔记', 42);
  return {
    subject: safeSubject,
    title: safeTitle,
    reason: 'fallback',
  };
}

async function generateNameWithQwen({ imageDataUrl, kind, remark }) {
  if (!qwen.apiKey) {
    return {
      ...makeFallbackName({ kind, remark }),
      modelUsed: null,
      error: `Qwen API key is not set. configPath=${qwen.configPath}`,
    };
  }

  const prompt = [
    '你是考研学习笔记整理助手。请结合图片内容和用户备注，为这张学习截图生成适合 Windows 文件名的中文标题。',
    '要求：',
    '1. 识别所属科目，只能从：高等数学、线性代数、概率论、数据结构、计算机组成、操作系统、计算机网络、英语、默认文件夹 中选择。',
    '2. title 用 8 到 22 个中文字符概括图片核心内容，不要出现“截图”“图片”“笔记”这类空泛词。',
    '3. 不要输出随机数，不要输出日期，不要输出文件后缀。',
    '4. 不要使用 Windows 非法字符：<>:"/\\|?*。',
    '5. 只输出 JSON：{"subject":"科目","title":"标题","reason":"一句话依据"}',
    `保存类型：${kind === 'canvas' ? '多图画布' : '单图'}`,
    `用户备注：${remark || '无'}`,
  ].join('\n');

  try {
    const response = await postJson(
      qwen.baseUrl,
      { Authorization: `Bearer ${qwen.apiKey}` },
      {
        model: qwen.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        temperature: 0.2,
      },
    );

    const text = qwenContentToText(response?.choices?.[0]?.message?.content);
    const parsed = extractJsonObject(text);
    if (!parsed) {
      throw new Error('Qwen did not return valid JSON');
    }

    const subject = sanitizeSegment(parsed.subject || guessSubjectFromText(`${parsed.title || ''} ${remark || ''}`), DEFAULT_SUBJECT, 24);
    const allowedSubjects = ['高等数学', '线性代数', '概率论', '数据结构', '计算机组成', '操作系统', '计算机网络', '英语', DEFAULT_SUBJECT];
    const title = sanitizeSegment(parsed.title, kind === 'canvas' ? '画布拼接笔记' : '图片笔记', 42);

    return {
      subject: allowedSubjects.includes(subject) ? subject : guessSubjectFromText(`${subject} ${title} ${remark || ''}`),
      title,
      reason: String(parsed.reason || '').slice(0, 120),
      modelUsed: qwen.model,
      error: null,
    };
  } catch (error) {
    return {
      ...makeFallbackName({ kind, remark }),
      modelUsed: qwen.model,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function generateWidgetWithQwen(userPrompt) {
  if (!qwen.apiKey) {
    throw new Error(`千问 API 尚未配置，配置文件：${qwen.configPath}`);
  }

  const prompt = [
    '你是“考研桌面助手”的前端模块生成器。根据用户需求生成一个可独立运行的小组件。',
    '只输出一个 JSON 对象，不要 Markdown，不要解释。',
    'JSON 格式：',
    '{"title":"模块标题","width":360,"height":260,"html":"...","css":"...","js":"..."}',
    '严格要求：',
    '1. 只使用原生 HTML、CSS、JavaScript，不引用外部库、网址、字体或图片。',
    '2. 禁止 fetch、XMLHttpRequest、WebSocket、EventSource、window.open、跳转、表单提交和跨页面通信。',
    '3. 不访问 cookie、localStorage、sessionStorage、indexedDB、父页面或顶层窗口。',
    '4. 所有交互仅操作当前模块 DOM；按钮必须可用，界面适合深色半透明桌面卡片。',
    '5. HTML 不包含 script/style 标签；CSS 和 JS 分别放入对应字段。',
    '6. width 取 240-720，height 取 150-620。内容精简，中文界面。',
    `用户需求：${userPrompt}`,
  ].join('\n');

  const response = await postJson(
    qwen.baseUrl,
    { Authorization: `Bearer ${qwen.apiKey}` },
    {
      model: qwen.model,
      messages: [
        { role: 'system', content: '你只返回符合指定结构的 JSON。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.35,
    },
    45000,
  );

  const text = qwenContentToText(response?.choices?.[0]?.message?.content);
  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error('千问没有返回有效的模块 JSON');
  }

  const html = String(parsed.html || '').slice(0, 40000);
  if (!html.trim()) {
    throw new Error('千问返回的模块缺少 HTML');
  }

  return {
    title: String(parsed.title || 'AI 代码模块').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 30) || 'AI 代码模块',
    width: clampNumber(parsed.width, 360, 240, 720),
    height: clampNumber(parsed.height, 260, 150, 620),
    html,
    css: String(parsed.css || '').slice(0, 30000),
    js: String(parsed.js || '').slice(0, 30000),
  };
}

function ensureUniquePath(dir, baseName, ext) {
  let filename = `${baseName}.${ext}`;
  let filePath = path.join(dir, filename);
  let counter = 2;
  while (fs.existsSync(filePath)) {
    filename = `${baseName}_${counter}.${ext}`;
    filePath = path.join(dir, filename);
    counter += 1;
  }
  return { filename, filePath };
}

function readLayoutFile() {
  if (!fs.existsSync(LAYOUT_PATH)) {
    return null;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf8'));
    if (Array.isArray(payload?.layout)) {
      return payload;
    }
  } catch {
    return null;
  }
  return null;
}

async function handleLayoutSave(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || '{}');
  if (!Array.isArray(payload.layout)) {
    throw new Error('Invalid desktop layout payload');
  }
  fs.mkdirSync(ASSISTANT_ROOT, { recursive: true });
  const nextPayload = {
    ok: true,
    updatedAt: new Date().toISOString(),
    layout: payload.layout,
  };
  fs.writeFileSync(LAYOUT_PATH, JSON.stringify(nextPayload, null, 2), 'utf8');
  sendJson(res, 200, {
    ...nextPayload,
    layoutPath: LAYOUT_PATH,
  });
}

async function handleGenerateWidget(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || '{}');
  const prompt = String(payload.prompt || '').trim().slice(0, 1200);
  if (prompt.length < 3) {
    sendJson(res, 400, { ok: false, error: '请至少用一句话描述模块需求' });
    return;
  }
  const widget = await generateWidgetWithQwen(prompt);
  sendJson(res, 200, {
    ok: true,
    model: qwen.model,
    widget,
  });
}

async function handleSave(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || '{}');
  const requestedSubject = sanitizeSegment(payload.subject || DEFAULT_SUBJECT, DEFAULT_SUBJECT, 24);
  const kind = payload.kind === 'canvas' ? 'canvas' : 'single';
  const remark = typeof payload.remark === 'string' ? payload.remark : '';
  const image = decodeDataUrl(payload.imageDataUrl);

  const naming = await generateNameWithQwen({ imageDataUrl: image.dataUrl, kind, remark });
  const subject = naming.subject === DEFAULT_SUBJECT && requestedSubject !== DEFAULT_SUBJECT
    ? requestedSubject
    : sanitizeSegment(naming.subject, DEFAULT_SUBJECT, 24);
  const subjectDir = path.join(NOTES_ROOT, subject);
  fs.mkdirSync(subjectDir, { recursive: true });

  const createdStamp = timestamp();
  const safeTitle = sanitizeSegment(naming.title, kind === 'canvas' ? '画布拼接笔记' : '图片笔记', 42);
  const baseName = sanitizeSegment(`${subject}_${safeTitle}_${createdStamp}`, `${subject}_图片笔记_${createdStamp}`, 110);
  const { filename, filePath } = ensureUniquePath(subjectDir, baseName, image.ext);
  const id = path.basename(filename, path.extname(filename));
  const sidecarPath = sidecarPathForId(subjectDir, id);

  fs.writeFileSync(filePath, image.buffer);

  const metadata = {
    id,
    kind,
    subject,
    requestedSubject,
    title: safeTitle,
    remark,
    createdAt: new Date().toISOString(),
    fileName: filename,
    filePath,
    mime: image.mime,
    naming: {
      provider: 'qwen',
      model: naming.modelUsed,
      baseUrl: qwen.baseUrl,
      source: qwen.source,
      reason: naming.reason,
      error: naming.error,
    },
    classifier: {
      status: naming.error ? 'fallback_named' : 'named',
      provider: 'qwen',
      scheduledAt: '24:00',
    },
  };

  fs.mkdirSync(metadataDir(subjectDir), { recursive: true });
  fs.writeFileSync(sidecarPath, JSON.stringify(metadata, null, 2), 'utf8');
  appendMetadata(subjectDir, metadata);

  sendJson(res, 200, {
    ok: true,
    filePath,
    fileName: filename,
    metadata,
    notesRoot: NOTES_ROOT,
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        ok: true,
        notesRoot: NOTES_ROOT,
        assistantRoot: ASSISTANT_ROOT,
        layoutPath: LAYOUT_PATH,
        defaultSubject: DEFAULT_SUBJECT,
        metadataPlacement: 'subject/.metadata',
        aiWidgetEndpoint: '/ai/widget',
        qwen: {
          enabled: Boolean(qwen.apiKey),
          model: qwen.model,
          baseUrl: qwen.baseUrl,
          configPath: qwen.configPath,
          source: qwen.source,
        },
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/layout') {
      const layoutPayload = readLayoutFile();
      sendJson(res, 200, layoutPayload ?? { ok: true, updatedAt: null, layout: null, layoutPath: LAYOUT_PATH });
      return;
    }

    if (req.method === 'POST' && req.url === '/layout') {
      await handleLayoutSave(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/save-note') {
      await handleSave(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/ai/widget') {
      await handleGenerateWidget(req, res);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Kaoyan note server running at http://127.0.0.1:${PORT}`);
  console.log(`Notes root: ${NOTES_ROOT}`);
  console.log(`Assistant root: ${ASSISTANT_ROOT}`);
  console.log(`Layout file: ${LAYOUT_PATH}`);
  console.log(`Metadata placement: subject/.metadata`);
  console.log(`AI widget endpoint: http://127.0.0.1:${PORT}/ai/widget`);
  console.log(`Qwen: ${qwen.apiKey ? `enabled (${qwen.model})` : `disabled, configPath=${qwen.configPath}`}`);
});
