const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const endpoint = process.env.KAOYAN_NOTE_SERVER_URL || 'http://127.0.0.1:5174';
const heicDataUrl = /^data:image\/(?:heic|heif);base64,([A-Za-z0-9+/=\s]+)$/i;

async function request(url, init) {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || `${response.status} ${response.statusText}`);
  return payload;
}

function convertDataUrl(src, tempRoot, imageId) {
  const match = heicDataUrl.exec(src);
  if (!match) return null;
  const safeId = String(imageId || 'image').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  const inputPath = path.join(tempRoot, `${safeId}.heic`);
  const outputPath = path.join(tempRoot, `${safeId}.jpg`);
  fs.writeFileSync(inputPath, Buffer.from(match[1], 'base64'));
  const result = spawnSync(
    process.platform === 'win32' ? 'heif-convert.cmd' : 'heif-convert',
    ['--quiet', '-q', '94', inputPath, outputPath],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  );
  if (result.status !== 0 || !fs.existsSync(outputPath)) {
    throw new Error((result.stderr || result.stdout || 'HEIC converter failed').trim());
  }
  return `data:image/jpeg;base64,${fs.readFileSync(outputPath).toString('base64')}`;
}

async function main() {
  const list = await request(`${endpoint}/canvas-projects`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-heic-repair-'));
  let repairedProjects = 0;
  let repairedImages = 0;
  try {
    for (const summary of list.projects || []) {
      const loaded = await request(`${endpoint}/canvas-projects/${encodeURIComponent(summary.id)}`);
      const document = loaded.document;
      let changed = 0;
      const images = document.images.map((image) => {
        const converted = convertDataUrl(image.src, tempRoot, image.id);
        if (!converted) return image;
        changed += 1;
        return {
          ...image,
          src: converted,
          name: String(image.name || '图片').replace(/\.(?:heic|heif)$/i, '.jpg'),
        };
      });
      if (changed === 0) continue;
      await request(`${endpoint}/canvas-projects/${encodeURIComponent(document.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          document: { ...document, images },
          expectedRevision: document.syncRevision || 0,
          clientId: 'canvas-heic-repair',
        }),
      });
      repairedProjects += 1;
      repairedImages += changed;
    }
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    const resolvedSystemTemp = `${path.resolve(os.tmpdir())}${path.sep}`;
    if (resolvedTemp.startsWith(resolvedSystemTemp) && path.basename(resolvedTemp).startsWith('kaoyan-heic-repair-')) {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, repairedProjects, repairedImages }));
}

main().catch((error) => {
  const cause = error instanceof Error && error.cause ? `: ${error.cause.message || String(error.cause)}` : '';
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}${cause}\n`);
  process.exitCode = 1;
});
