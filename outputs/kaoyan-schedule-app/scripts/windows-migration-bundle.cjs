#!/usr/bin/env node
// Lossless file staging only. Never activates a runtime or starts synchronization.
const fs = require('node:fs');
const path = require('node:path');
const { walk, fileHash, assertSafeSource } = require('./macmini-migration-audit.cjs');

const BUSINESS = new Set(['learning-data.json', 'desktop-layout.json', 'note-taxonomy.json',
  'canvas-projects', 'note-save-receipts', 'material-note-receipts', 'note-artifact-quarantine']);
function sensitive(relative) {
  return /(?:^|\/)(?:secrets|\.git|node_modules)(?:\/|$)/i.test(relative)
    || /(?:^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|[^/]*(?:ai-providers|qwen-config|credentials|token|mobile-access)[^/]*|[^/]+\.(?:pem|key))$/i.test(relative);
}
function safeName(name) {
  if (typeof name !== 'string' || !/^(notes|assistant)\//.test(name)
    || name.split('/').some(s => !s || s === '.' || s === '..' || /[\\:\x00-\x1f]/.test(s)
      || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) {
    throw new Error('Unsafe bundle path');
  }
  return name;
}
function assertNoLinks(target) {
  let current = path.resolve(target);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not allowed');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function inventory(roots) {
  const files = [], excluded = [];
  for (const kind of ['notes', 'assistant']) {
    const root = assertSafeSource(roots[kind]);
    assertNoLinks(root);
    for (const source of walk(root)) {
      const relative = path.relative(root, source).split(path.sep).join('/');
      if (sensitive(relative) || (kind === 'assistant' && !BUSINESS.has(relative.split('/')[0]))) {
        excluded.push({ path: `${kind}/${relative}`, reason: sensitive(relative) ? 'credentials' : 'not-selected-business-data' });
        continue;
      }
      const name = safeName(`${kind}/${relative}`);
      files.push({ path: name, size: fs.statSync(source).size, sha256: fileHash(source) });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const names = new Set();
  for (const f of files) {
    const folded = f.path.normalize('NFC').toLowerCase();
    if (names.has(folded)) throw new Error(`Cross-platform filename collision: ${f.path}`);
    names.add(folded);
  }
  return { files, excluded };
}
function freshDirectory(target) {
  target = path.resolve(target);
  assertNoLinks(target);
  fs.mkdirSync(target, { mode: 0o700 }); // Exclusive: never merge into an existing directory.
  return target;
}
function verify(bundle) {
  assertNoLinks(bundle);
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
  if (manifest.kind !== 'kaoyan-windows-business-bundle' || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid bundle manifest');
  const seen = new Set();
  for (const entry of manifest.files) {
    safeName(entry.path);
    const folded = entry.path.normalize('NFC').toLowerCase();
    if (seen.has(folded) || sensitive(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid bundle entry');
    seen.add(folded);
    const file = path.join(bundle, ...entry.path.split('/'));
    assertNoLinks(file);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size !== entry.size || fileHash(file) !== entry.sha256) throw new Error(`Bundle verification failed: ${entry.path}`);
  }
  const actual = walk(bundle).map(f => path.relative(bundle, f).split(path.sep).join('/')).filter(f => f !== 'manifest.json');
  if (actual.length !== manifest.files.length || actual.some(f => !manifest.files.some(e => e.path === f))) throw new Error('Unlisted files in bundle');
  return manifest;
}
function pathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function rewriteWindowsPath(value, sourceRoots, targetRoots) {
  if (typeof value !== 'string' || !/^[A-Za-z]:[\\/]/.test(value)) return value;
  const normalized = value.replaceAll('\\', '/');
  for (const kind of ['notes', 'assistant']) {
    const source = String(sourceRoots[kind] || '').replaceAll('\\', '/').replace(/\/$/, '');
    if (normalized.toLowerCase() !== source.toLowerCase()
      && !normalized.toLowerCase().startsWith(`${source.toLowerCase()}/`)) continue;
    const relative = normalized.slice(source.length).replace(/^\/+/, '');
    if (relative.split('/').some(segment => segment === '..')) throw new Error(`Unsafe stored path: ${value}`);
    return path.join(targetRoots[kind], ...relative.split('/').filter(Boolean));
  }
  return value;
}
function rewriteJson(value, sourceRoots, targetRoots, state, pointer = '$') {
  if (typeof value === 'string') {
    const rewritten = rewriteWindowsPath(value, sourceRoots, targetRoots);
    if (rewritten !== value) state.rewrittenPaths += 1;
    else if (/^[A-Za-z]:[\\/]/.test(value)) state.unresolvedWindowsPaths.push({ pointer, value });
    return rewritten;
  }
  if (Array.isArray(value)) return value.map((item, index) => rewriteJson(item, sourceRoots, targetRoots, state, `${pointer}[${index}]`));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewriteJson(child, sourceRoots, targetRoots, state, `${pointer}.${key}`)]));
}
function bundlePathForPreparedReference(value, targetRoots) {
  for (const kind of ['notes', 'assistant']) {
    const root = path.resolve(targetRoots[kind]);
    const target = path.resolve(value);
    if (target !== root && !pathInside(root, target)) continue;
    const relative = path.relative(root, target).split(path.sep).join('/');
    return safeName(`${kind}/${relative}`);
  }
  return '';
}
function prepareRuntime(bundle, destination) {
  const manifest = verify(bundle);
  if (pathInside(bundle, destination) || path.resolve(bundle) === path.resolve(destination)) throw new Error('Prepared runtime must be outside the bundle');
  const output = freshDirectory(destination);
  const targetRoots = { notes: path.join(output, 'data', 'notes'), assistant: path.join(output, 'data', 'assistant') };
  const state = { rewrittenPaths: 0, unresolvedWindowsPaths: [] };
  const preparedFiles = [];
  const bundledPaths = new Set(manifest.files.map((entry) => entry.path.normalize('NFC').toLowerCase()));
  try {
    for (const entry of manifest.files) {
      const [kind, ...parts] = entry.path.split('/');
      const source = path.join(bundle, ...entry.path.split('/'));
      const target = path.join(targetRoots[kind], ...parts);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      if (/\.json$/i.test(target)) {
        const parsed = JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, ''));
        const rewritten = rewriteJson(parsed, manifest.sourceRoots, targetRoots, state, `$file:${entry.path}`);
        fs.writeFileSync(target, `${JSON.stringify(rewritten, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      } else {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, 0o600);
      }
      preparedFiles.push({ path: path.relative(output, target).split(path.sep).join('/'), size: fs.statSync(target).size, sha256: fileHash(target) });
    }
    const brokenInternalPaths = [];
    const preexistingMissingPaths = [];
    for (const absolute of walk(path.join(output, 'data')).filter(file => /\.json$/i.test(file))) {
      const visit = (value, pointer = '$') => {
        if (typeof value === 'string') {
          if ((pathInside(output, value) || path.resolve(output) === path.resolve(value)) && !fs.existsSync(value)) {
            const missing = { file: path.relative(output, absolute).split(path.sep).join('/'), pointer, value };
            const expectedBundlePath = bundlePathForPreparedReference(value, targetRoots);
            if (expectedBundlePath && bundledPaths.has(expectedBundlePath.normalize('NFC').toLowerCase())) {
              brokenInternalPaths.push({ ...missing, expectedBundlePath });
            } else {
              preexistingMissingPaths.push({ ...missing, expectedBundlePath: expectedBundlePath || null });
            }
          }
          return;
        }
        if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${pointer}[${index}]`));
        if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => visit(child, `${pointer}.${key}`));
      };
      visit(JSON.parse(fs.readFileSync(absolute, 'utf8')));
    }
    const preparedManifest = {
      kind: 'kaoyan-mac-shadow-runtime', schemaVersion: 1, createdAt: new Date().toISOString(),
      sourceBundleCreatedAt: manifest.createdAt, sourceFiles: manifest.files.length,
      preparedFiles: preparedFiles.sort((a, b) => a.path.localeCompare(b.path)),
      rewrittenPaths: state.rewrittenPaths,
      unresolvedWindowsPaths: state.unresolvedWindowsPaths,
      brokenInternalPaths,
      preexistingMissingPaths,
      preexistingMissingPathsRequireReview: preexistingMissingPaths.length > 0,
      browserStoragePolicy: 'Windows browser caches remain on Windows; pending local writes must be empty before cutover.',
      activationReady: state.unresolvedWindowsPaths.length === 0 && brokenInternalPaths.length === 0,
    };
    fs.writeFileSync(path.join(output, 'migration-manifest.json'), `${JSON.stringify(preparedManifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { ok: preparedManifest.activationReady, prepared: output, verifiedFiles: preparedFiles.length,
      rewrittenPaths: state.rewrittenPaths, unresolvedWindowsPaths: state.unresolvedWindowsPaths.length,
      brokenInternalPaths: brokenInternalPaths.length, preexistingMissingPaths: preexistingMissingPaths.length,
      activationReady: preparedManifest.activationReady };
  } catch (error) {
    fs.writeFileSync(path.join(output, 'PREPARATION-FAILED.txt'), `${error.message}\n`, { flag: 'wx', mode: 0o600 });
    throw error;
  }
}
function exportBundle(roots, destination) {
  for (const root of Object.values(roots)) {
    const relative = path.relative(path.resolve(root), path.resolve(destination));
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Export destination must be outside source directories');
  }
  const before = inventory(roots);
  const output = freshDirectory(destination);
  for (const entry of before.files) {
    const [kind, ...parts] = entry.path.split('/');
    const target = path.join(output, kind, ...parts);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(roots[kind], ...parts), target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
  }
  const after = inventory(roots);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Source changed during export; incomplete directory retained, retry with a new destination after pausing edits');
  const manifest = { kind: 'kaoyan-windows-business-bundle', schemaVersion: 1, createdAt: new Date().toISOString(),
    sourceRoots: roots, ...before, browserStorageIncluded: false, activationReady: false };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  verify(output);
  return { ok: true, bundle: output, files: before.files.length, bytes: before.files.reduce((n, f) => n + f.size, 0), excluded: before.excluded.length, activationReady: false };
}
function stageBundle(bundle, destination) {
  const manifest = verify(bundle);
  const output = freshDirectory(destination);
  // Keep original bytes and Windows paths for audit. Translation is a separate step.
  for (const entry of manifest.files) {
    const target = path.join(output, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(bundle, ...entry.path.split('/')), target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  verify(output);
  return { ok: true, staged: output, verifiedFiles: manifest.files.length, activationReady: false };
}
function main(argv) {
  const [command = 'plan', ...args] = argv;
  const options = {};
  for (const arg of args) {
    const match = /^--(notes|assistant|output|bundle)=(.+)$/.exec(arg);
    if (!match || options[match[1]]) throw new Error('Invalid or duplicate argument');
    options[match[1]] = path.resolve(match[2]);
  }
  if (command === 'plan') return { commands: ['export --notes=... --assistant=... --output=NEW_DIRECTORY', 'verify --bundle=...', 'stage --bundle=... --output=NEW_DIRECTORY', 'prepare --bundle=... --output=NEW_RUNTIME_DIRECTORY'], requiresPausedEditing: true, activationReady: false };
  if (command === 'export' && options.notes && options.assistant && options.output) return exportBundle({ notes: options.notes, assistant: options.assistant }, options.output);
  if (command === 'verify' && options.bundle) return { ok: true, verifiedFiles: verify(options.bundle).files.length };
  if (command === 'stage' && options.bundle && options.output) return stageBundle(options.bundle, options.output);
  if (command === 'prepare' && options.bundle && options.output) return prepareRuntime(options.bundle, options.output);
  throw new Error('Unknown command or missing paths');
}
if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { inventory, exportBundle, verify, stageBundle, prepareRuntime, rewriteWindowsPath, safeName };
