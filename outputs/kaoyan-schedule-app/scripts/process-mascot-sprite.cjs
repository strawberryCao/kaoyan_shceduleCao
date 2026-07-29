'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const inputPath = path.resolve(process.argv[2] || '');
const outputDir = path.resolve(process.argv[3] || path.join(__dirname, '..', 'src', 'assets', 'quick-mascots'));

if (!inputPath || !fs.existsSync(inputPath)) {
  throw new Error('Usage: node scripts/process-mascot-sprite.cjs <sprite.png> [output-dir]');
}

const COLUMNS = 4;
const ROWS = 3;
const OUTPUT_SIZE = 192;

function isChromaBackground(r, g, b) {
  return g >= 105
    && g - Math.max(r, b) >= 26
    && g >= r * 1.18
    && g >= b * 1.14;
}

function removeConnectedGreenBackground(data, width, height) {
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const enqueue = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (seen[index]) return;
    const offset = index * 4;
    if (!isChromaBackground(data[offset], data[offset + 1], data[offset + 2])) return;
    seen[index] = 1;
    queue[tail++] = index;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    data[index * 4 + 3] = 0;
    enqueue(x - 1, y);
    enqueue(x + 1, y);
    enqueue(x, y - 1);
    enqueue(x, y + 1);
  }
  return data;
}

async function main() {
  const metadata = await sharp(inputPath).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Sprite dimensions are unavailable.');
  const cellWidth = Math.floor(metadata.width / COLUMNS);
  const cellHeight = Math.floor(metadata.height / ROWS);
  fs.mkdirSync(outputDir, { recursive: true });

  for (let index = 0; index < COLUMNS * ROWS; index += 1) {
    const column = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    const { data, info } = await sharp(inputPath)
      .extract({
        left: column * cellWidth + 8,
        top: row * cellHeight + 8,
        width: cellWidth - 16,
        height: cellHeight - 40,
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    removeConnectedGreenBackground(data, info.width, info.height);
    const destination = path.join(outputDir, `mascot-${String(index + 1).padStart(2, '0')}.png`);
    await sharp(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: 4,
      },
    })
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .resize(166, 166, { fit: 'contain', withoutEnlargement: false })
      .extend({
        top: 13,
        bottom: 13,
        left: 13,
        right: 13,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: 'contain' })
      .png({ compressionLevel: 9 })
      .toFile(destination);
  }
  console.log(`Wrote ${COLUMNS * ROWS} mascots to ${outputDir}`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
