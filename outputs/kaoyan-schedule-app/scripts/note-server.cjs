const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.KAOYAN_NOTE_PORT || 5174);
const NOTES_ROOT = process.env.KAOYAN_NOTES_ROOT || path.join(os.homedir(), 'Desktop', '笔记');
const DEFAULT_SUBJECT = '默认文件夹';

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function sanitizeSegment(input) {
  return String(input || DEFAULT_SUBJECT)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 80) || DEFAULT_SUBJECT;
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
  };
}

function appendMetadata(subjectDir, metadata) {
  const indexPath = path.join(subjectDir, 'metadata.json');
  let list = [];
  if (fs.existsSync(indexPath)) {
    try {
      list = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (!Array.isArray(list)) {
        list = [];
      }
    } catch {
      list = [];
    }
  }
  list.push(metadata);
  fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), 'utf8');
}

async function handleSave(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw || '{}');
  const subject = sanitizeSegment(payload.subject || DEFAULT_SUBJECT);
  const kind = payload.kind === 'canvas' ? 'canvas' : 'single';
  const remark = typeof payload.remark === 'string' ? payload.remark : '';
  const image = decodeDataUrl(payload.imageDataUrl);

  const subjectDir = path.join(NOTES_ROOT, subject);
  fs.mkdirSync(subjectDir, { recursive: true });

  const id = `${timestamp()}_${kind}_${Math.random().toString(16).slice(2, 8)}`;
  const filename = `${id}.${image.ext}`;
  const filePath = path.join(subjectDir, filename);
  const sidecarPath = path.join(subjectDir, `${id}.note.json`);

  fs.writeFileSync(filePath, image.buffer);

  const metadata = {
    id,
    kind,
    subject,
    remark,
    createdAt: new Date().toISOString(),
    fileName: filename,
    filePath,
    mime: image.mime,
    classifier: {
      status: 'pending',
      provider: 'qwen',
      scheduledAt: '24:00',
    },
  };

  fs.writeFileSync(sidecarPath, JSON.stringify(metadata, null, 2), 'utf8');
  appendMetadata(subjectDir, metadata);

  sendJson(res, 200, {
    ok: true,
    filePath,
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
        defaultSubject: DEFAULT_SUBJECT,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/save-note') {
      await handleSave(req, res);
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
});
