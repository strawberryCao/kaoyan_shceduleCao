const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const distRoot = path.join(projectRoot, 'dist');
const manifestPath = path.join(distRoot, '.runtime-build.json');
const inputRoots = [
  'src',
  'public',
  'index.html',
  'package.json',
  'package-lock.json',
  'scripts/lan-gateway-policy.cjs',
  'tsconfig.json',
  'vite.config.mjs',
];

const collectFiles = (relativePath) => {
  const absolutePath = path.join(projectRoot, relativePath);
  const stats = fs.statSync(absolutePath);
  if (stats.isFile()) return [absolutePath];
  return fs.readdirSync(absolutePath, { withFileTypes: true })
    .flatMap((entry) => collectFiles(path.join(relativePath, entry.name)));
};

const createFingerprint = () => {
  const hash = crypto.createHash('sha256');
  const files = inputRoots.flatMap(collectFiles).sort((left, right) => left.localeCompare(right));
  for (const filePath of files) {
    const relativePath = path.relative(projectRoot, filePath).replaceAll(path.sep, '/');
    const stats = fs.statSync(filePath);
    hash.update(relativePath);
    hash.update('\0');
    hash.update(String(stats.size));
    hash.update('\0');
    hash.update(String(Math.trunc(stats.mtimeMs)));
    hash.update('\0');
  }
  return hash.digest('hex');
};

const readRecordedFingerprint = () => {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return typeof manifest.fingerprint === 'string' ? manifest.fingerprint : null;
  } catch {
    return null;
  }
};

const runNodeTool = (relativeToolPath, args) => {
  const result = spawnSync(process.execPath, [path.join(projectRoot, relativeToolPath), ...args], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const fingerprint = createFingerprint();
if (readRecordedFingerprint() === fingerprint && fs.existsSync(path.join(distRoot, 'index.html'))) {
  process.stdout.write('Production web build is current.\n');
  process.exit(0);
}

process.stdout.write('Building optimized production web assets...\n');
runNodeTool('node_modules/typescript/bin/tsc', ['-p', 'tsconfig.json', '--noEmit']);
runNodeTool('node_modules/vite/bin/vite.js', ['build', '--config', 'vite.config.mjs']);
fs.writeFileSync(manifestPath, `${JSON.stringify({ fingerprint, builtAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
process.stdout.write('Production web build is ready.\n');
