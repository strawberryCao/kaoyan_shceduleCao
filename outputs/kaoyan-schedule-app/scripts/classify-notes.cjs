const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { loadQwenConfig } = require('./qwen-config.cjs');

const NOTES_ROOT = process.env.KAOYAN_NOTES_ROOT || path.join(os.homedir(), 'Desktop', '笔记');
const ASSISTANT_ROOT = process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手');
const DEFAULT_SUBJECT = '默认文件夹';
const DEFAULT_DIR = path.join(NOTES_ROOT, DEFAULT_SUBJECT);
const LOG_PATH = path.join(ASSISTANT_ROOT, 'classify-notes.log');
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SUBJECTS = ['高等数学', '线性代数', '概率论', '数据结构', '计算机组成', '操作系统', '计算机网络', '英语', DEFAULT_SUBJECT];
const SUBJECT_ALIASES = new Map([
  ['高数', '高等数学'],
  ['数学', '高等数学'],
  ['线代', '线性代数'],
  ['组成原理', '计算机组成'],
  ['计组', '计算机组成'],
  ['计网', '计算机网络'],
  ['网络', '计算机网络'],
  ['OS', '操作系统'],
  ['默认', DEFAULT_SUBJECT],
]);

const qwen = loadQwenConfig();

function log(message) {
  fs.mkdirSync(ASSISTANT_ROOT, { recursive: true });
  const line = `[${new Date().toISOString()}] ${message}`;
  fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
  console.log(line);
}

function sanitizeSegment(input, fallback = '未命名', maxLength = 80) {
  return String(input || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._\s]+|[._\s]+$/g, '')
    .slice(0, maxLength) || fallback;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function timestampFromDate(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function getMimeByExt(ext) {
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function fileToDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return `data:${getMimeByExt(ext)};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function metadataDir(dir) {
  return path.join(dir, '.metadata');
}

function metadataIndexPath(dir) {
  return path.join(metadataDir(dir), 'metadata.json');
}

function sidecarPathForImage(imagePath) {
  const parsed = path.parse(imagePath);
  return path.join(metadataDir(parsed.dir), `${parsed.name}.note.json`);
}

function legacySidecarPathForImage(imagePath) {
  const parsed = path.parse(imagePath);
  return path.join(parsed.dir, `${parsed.name}.note.json`);
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function loadMetadataList(dir) {
  const newData = readJson(metadataIndexPath(dir), null);
  if (Array.isArray(newData)) return newData;
  const legacyData = readJson(path.join(dir, 'metadata.json'), []);
  return Array.isArray(legacyData) ? legacyData : [];
}

function writeMetadataList(dir, list) {
  writeJson(metadataIndexPath(dir), list);
}

function removeFromMetadata(dir, metadata) {
  const list = loadMetadataList(dir);
  const next = list.filter((item) => item?.id !== metadata.id && item?.fileName !== metadata.fileName && item?.filePath !== metadata.filePath);
  writeMetadataList(dir, next);
}

function appendToMetadata(dir, metadata) {
  const list = loadMetadataList(dir).filter((item) => item?.id !== metadata.id && item?.fileName !== metadata.fileName);
  list.push(metadata);
  writeMetadataList(dir, list);
}

function postJson(urlString, headers, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);
    const request = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 443,
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
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP ${response.statusCode}: ${data.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid response JSON: ${data.slice(0, 500)}`));
          }
        });
      },
    );

    request.on('timeout', () => request.destroy(new Error('request timeout')));
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeSubject(subjectText, fallback = DEFAULT_SUBJECT) {
  const raw = String(subjectText || '').trim();
  if (SUBJECTS.includes(raw)) return raw;
  if (SUBJECT_ALIASES.has(raw)) return SUBJECT_ALIASES.get(raw);
  for (const subject of SUBJECTS) {
    if (raw.includes(subject) || subject.includes(raw)) return subject;
  }
  return fallback;
}

async function classifyImage({ imageDataUrl, remark }) {
  if (!qwen.apiKey) {
    throw new Error(`Qwen API key is empty. configPath=${qwen.configPath}`);
  }

  const prompt = [
    '你是考研笔记整理助手。请根据图片内容和备注判断这张学习笔记应放入哪个科目文件夹，并生成简短中文标题。',
    `科目只能从以下列表选择：${SUBJECTS.join('、')}。`,
    'title 用 8 到 22 个中文字符概括核心内容，不要包含“截图、图片、笔记、默认文件夹、日期、文件后缀”。',
    '不要使用 Windows 文件名非法字符：<>:"/\\|?*。',
    '只输出 JSON：{"subject":"科目","title":"标题","reason":"一句话依据"}',
    `用户备注：${remark || '无'}`,
  ].join('\n');

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
      temperature: 0.1,
    },
  );

  const content = response?.choices?.[0]?.message?.content;
  const parsed = extractJsonObject(Array.isArray(content) ? JSON.stringify(content) : content);
  if (!parsed) throw new Error('model did not return valid JSON');

  return {
    subject: normalizeSubject(parsed.subject),
    title: sanitizeSegment(parsed.title, '未命名内容', 42),
    reason: String(parsed.reason || '').slice(0, 160),
  };
}

function ensureUniqueFilePath(dir, baseName, ext) {
  let fileName = `${baseName}${ext}`;
  let filePath = path.join(dir, fileName);
  let counter = 2;
  while (fs.existsSync(filePath)) {
    fileName = `${baseName}_${counter}${ext}`;
    filePath = path.join(dir, fileName);
    counter += 1;
  }
  return { fileName, filePath };
}

function getCandidates() {
  if (!fs.existsSync(DEFAULT_DIR)) return [];
  return fs.readdirSync(DEFAULT_DIR)
    .filter((fileName) => IMAGE_EXTS.has(path.extname(fileName).toLowerCase()))
    .map((fileName) => path.join(DEFAULT_DIR, fileName));
}

function readSidecar(imagePath) {
  const currentSidecarPath = sidecarPathForImage(imagePath);
  const legacySidecarPath = legacySidecarPathForImage(imagePath);
  const metadata = readJson(currentSidecarPath, readJson(legacySidecarPath, null));
  return { sidecarPath: currentSidecarPath, legacySidecarPath, metadata };
}

async function classifyOne(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  const originalName = path.basename(imagePath);
  const stat = fs.statSync(imagePath);
  const { sidecarPath, legacySidecarPath, metadata: sidecarMetadata } = readSidecar(imagePath);
  const baseMetadata = sidecarMetadata && typeof sidecarMetadata === 'object'
    ? sidecarMetadata
    : {
        id: path.parse(imagePath).name,
        kind: 'single',
        remark: '',
        createdAt: stat.birthtime.toISOString(),
        fileName: originalName,
        filePath: imagePath,
        mime: getMimeByExt(ext),
      };

  const result = await classifyImage({ imageDataUrl: fileToDataUrl(imagePath), remark: baseMetadata.remark || '' });
  if (!result.subject || result.subject === DEFAULT_SUBJECT) {
    throw new Error('model kept this note in default folder');
  }

  const destDir = path.join(NOTES_ROOT, result.subject);
  fs.mkdirSync(destDir, { recursive: true });

  const stamp = timestampFromDate(baseMetadata.createdAt ? new Date(baseMetadata.createdAt) : stat.mtime);
  const baseName = sanitizeSegment(`${result.subject}_${result.title}_${stamp}`, `${result.subject}_未命名内容_${stamp}`, 120);
  const { fileName: newFileName, filePath: newImagePath } = ensureUniqueFilePath(destDir, baseName, ext);
  const newId = path.parse(newFileName).name;
  const newSidecarPath = path.join(metadataDir(destDir), `${newId}.note.json`);

  fs.renameSync(imagePath, newImagePath);
  if (fs.existsSync(sidecarPath)) fs.rmSync(sidecarPath, { force: true });
  if (legacySidecarPath !== sidecarPath && fs.existsSync(legacySidecarPath)) fs.rmSync(legacySidecarPath, { force: true });

  const nextMetadata = {
    ...baseMetadata,
    id: newId,
    subject: result.subject,
    title: result.title,
    fileName: newFileName,
    filePath: newImagePath,
    updatedAt: new Date().toISOString(),
    classifier: {
      ...(baseMetadata.classifier || {}),
      status: 'auto_classified',
      provider: 'qwen',
      model: qwen.model,
      baseUrl: qwen.baseUrl,
      source: qwen.source,
      reason: result.reason,
      autoClassifiedAt: new Date().toISOString(),
    },
  };

  writeJson(newSidecarPath, nextMetadata);
  removeFromMetadata(DEFAULT_DIR, baseMetadata);
  appendToMetadata(destDir, nextMetadata);
  log(`OK ${originalName} -> ${result.subject}\\${newFileName}`);
}

async function main() {
  fs.mkdirSync(ASSISTANT_ROOT, { recursive: true });
  log('---- classify default notes start ----');
  log(`notesRoot=${NOTES_ROOT}`);
  log(`defaultDir=${DEFAULT_DIR}`);
  log(`metadataPlacement=subject/.metadata`);
  log(`configPath=${qwen.configPath}`);
  log(`configSource=${qwen.source}`);
  log(`model=${qwen.model}`);
  log(`baseUrl=${qwen.baseUrl}`);

  const candidates = getCandidates();
  if (candidates.length === 0) {
    log('no unclassified image found');
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const imagePath of candidates) {
    try {
      await classifyOne(imagePath);
      ok += 1;
    } catch (error) {
      failed += 1;
      log(`FAIL ${path.basename(imagePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  log(`done ok=${ok} failed=${failed}`);
}

main().catch((error) => {
  log(`FATAL ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
