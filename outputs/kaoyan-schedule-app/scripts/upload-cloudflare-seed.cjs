const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_BUCKET = 'kaoyan-study-private';
const DEFAULT_SEED_ROOT = path.resolve(process.cwd(), 'cloudflare', '.seed');
const BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const LIVE_CANVAS_KEY_PATTERN = /^canvases\//;
const CONTENT_TYPES = Object.freeze({
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
});

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readManifest(seedRoot) {
  const manifestPath = path.join(seedRoot, 'manifest.json');
  let content;
  try {
    content = fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read seed manifest: ${error.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Unable to parse seed manifest: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.files)) {
    throw new Error('Seed manifest must contain a files array');
  }
  return manifest;
}

function assertBucket(bucket) {
  if (typeof bucket !== 'string' || !BUCKET_PATTERN.test(bucket)) {
    throw new Error('Bucket must be a 3-63 character lowercase R2 bucket name');
  }
  return bucket;
}

function contentTypeForKey(r2Key) {
  // Never serve SVG seed objects as executable image markup.
  return CONTENT_TYPES[path.posix.extname(r2Key).toLowerCase()] || 'application/octet-stream';
}

function resolveObjectPath(objectsRoot, r2Key) {
  if (
    typeof r2Key !== 'string'
    || !r2Key
    || r2Key.startsWith('/')
    || r2Key.includes('\\')
    || r2Key.includes('\0')
  ) {
    throw new Error('Seed manifest contains an invalid R2 key');
  }
  const segments = r2Key.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Seed manifest contains an unsafe R2 key: ${r2Key}`);
  }
  const resolved = path.resolve(objectsRoot, ...segments);
  if (!resolved.startsWith(`${objectsRoot}${path.sep}`)) {
    throw new Error(`Seed manifest R2 key escapes the objects directory: ${r2Key}`);
  }
  return resolved;
}

function verifySeed(seedRoot, manifest) {
  const objectsRoot = path.resolve(seedRoot, 'objects');
  const seenKeys = new Set();
  const verified = [];
  for (const record of manifest.files) {
    if (!record || typeof record !== 'object') {
      throw new Error('Seed manifest contains an invalid file record');
    }
    const { r2Key, bytes, sha256: expectedHash } = record;
    if (seenKeys.has(r2Key)) throw new Error(`Seed manifest contains duplicate R2 key: ${r2Key}`);
    seenKeys.add(r2Key);
    if (LIVE_CANVAS_KEY_PATTERN.test(r2Key)) {
      throw new Error(`Seed upload refuses to overwrite a live canvas object: ${r2Key}`);
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`Seed manifest has invalid byte count for ${r2Key}`);
    }
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new Error(`Seed manifest has invalid SHA-256 for ${r2Key}`);
    }
    const filePath = resolveObjectPath(objectsRoot, r2Key);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw new Error(`Seed object is missing: ${r2Key}`);
    }
    if (!stat.isFile()) throw new Error(`Seed object is not a file: ${r2Key}`);
    if (stat.size !== bytes) throw new Error(`Seed object byte count does not match manifest: ${r2Key}`);
    const actualHash = sha256(fs.readFileSync(filePath));
    if (actualHash !== expectedHash) throw new Error(`Seed object SHA-256 does not match manifest: ${r2Key}`);
    const contentType = contentTypeForKey(r2Key);
    if (record.contentType !== undefined && record.contentType !== contentType) {
      throw new Error(`Seed object has unsafe or mismatched content type: ${r2Key}`);
    }
    verified.push({ r2Key, bytes, filePath, contentType });
  }
  return verified;
}

function defaultCommandRunner(command, args, options) {
  return spawnSync(command, args, options);
}

function uploadCloudflareSeed(options = {}) {
  const seedRoot = path.resolve(options.seedRoot || DEFAULT_SEED_ROOT);
  const bucket = assertBucket(options.bucket || DEFAULT_BUCKET);
  const dryRun = options.dryRun === true;
  const logger = options.logger || console;
  const commandRunner = options.commandRunner || defaultCommandRunner;
  const manifest = readManifest(seedRoot);
  const files = verifySeed(seedRoot, manifest);
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);

  if (dryRun) {
    logger.log(`Seed verified: ${files.length} objects, ${totalBytes} bytes; no upload performed.`);
    return { bucket, seedRoot, dryRun, uploaded: 0, objectCount: files.length, totalBytes };
  }

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const target = `${bucket}/${file.r2Key}`;
    const result = commandRunner(
      'npx.cmd',
      [
        'wrangler', 'r2', 'object', 'put', target,
        '--file', file.filePath,
        '--content-type', file.contentType,
        '--remote',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    if (result?.error) {
      throw new Error(`Wrangler could not upload ${file.r2Key}: ${result.error.message}`);
    }
    if (!result || result.status !== 0) {
      const status = Number.isInteger(result?.status) ? result.status : 'unknown';
      throw new Error(`Wrangler failed to upload ${file.r2Key} (exit ${status})`);
    }
    logger.log(`Uploaded ${index + 1}/${files.length}: ${file.r2Key}`);
  }

  logger.log(`Upload complete: ${files.length} objects, ${totalBytes} bytes.`);
  return {
    bucket,
    seedRoot,
    dryRun,
    uploaded: files.length,
    objectCount: files.length,
    totalBytes,
  };
}

function readFlag(argv, name) {
  const prefix = `--${name}=`;
  const inline = argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
}

function parseCliOptions(argv = process.argv.slice(2)) {
  return {
    seedRoot: readFlag(argv, 'seed-root'),
    bucket: readFlag(argv, 'bucket'),
    dryRun: argv.includes('--dry-run'),
  };
}

function runCli() {
  try {
    uploadCloudflareSeed(parseCliOptions());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) runCli();

module.exports = {
  DEFAULT_BUCKET,
  DEFAULT_SEED_ROOT,
  parseCliOptions,
  readManifest,
  uploadCloudflareSeed,
  verifySeed,
};
