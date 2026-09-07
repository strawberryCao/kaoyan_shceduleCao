const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIRECTORY_NAME = 'KaoyanStudyCenter';
const RUNTIME_LAYOUT_VERSION = 1;
const LEGACY_AI_ENV_PREFIXES = Object.freeze(['QWEN_', 'DASHSCOPE_', 'GEMINI_', 'KIMI_', 'MOONSHOT_', 'DEEPSEEK_']);

function clean(value) {
  return String(value || '').trim();
}

function pathImplementation(platform, override) {
  if (override) return override;
  return platform === 'win32' ? path.win32 : path.posix;
}

function resolveManagedRoot(options) {
  const env = options.env;
  const platform = options.platform;
  const paths = options.pathImpl;
  const homeDir = options.homeDir;
  const explicit = clean(env.KAOYAN_RUNTIME_ROOT);
  if (explicit) return paths.resolve(explicit);

  if (platform === 'darwin') {
    const systemService = clean(env.KAOYAN_SERVICE_MODE).toLowerCase() === 'system';
    return systemService
      ? '/Library/Application Support/KaoyanStudyCenter'
      : paths.join(homeDir, 'Library', 'Application Support', APP_DIRECTORY_NAME);
  }
  if (platform === 'win32') {
    // The Windows replica belongs to the signed-in user. LOCALAPPDATA is both
    // writable without elevation and isolated from other Windows accounts.
    const base = clean(env.LOCALAPPDATA) || clean(env.PROGRAMDATA) || paths.join(homeDir, 'AppData', 'Local');
    return paths.join(base, APP_DIRECTORY_NAME);
  }
  const xdgDataHome = clean(env.XDG_DATA_HOME) || paths.join(homeDir, '.local', 'share');
  return paths.join(xdgDataHome, 'kaoyan-study-center');
}

function resolveRuntimePaths(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const paths = pathImplementation(platform, options.pathImpl);
  const explicitRuntimeRoot = clean(env.KAOYAN_RUNTIME_ROOT);
  const requestedLayout = clean(env.KAOYAN_RUNTIME_LAYOUT).toLowerCase();
  const managed = Boolean(explicitRuntimeRoot)
    || requestedLayout === 'managed'
    || platform === 'darwin';

  if (!managed) {
    const notesRoot = paths.resolve(clean(env.KAOYAN_NOTES_ROOT) || paths.join(homeDir, 'Desktop', '笔记'));
    const assistantRoot = paths.resolve(clean(env.KAOYAN_ASSISTANT_ROOT) || paths.join(homeDir, 'Desktop', '考研桌面助手'));
    return Object.freeze({
      layout: 'legacy',
      platform,
      runtimeRoot: assistantRoot,
      configRoot: assistantRoot,
      secretsRoot: assistantRoot,
      dataRoot: paths.dirname(notesRoot),
      notesRoot,
      assistantRoot,
      assetsRoot: paths.join(notesRoot, '.materials'),
      backupsRoot: paths.join(assistantRoot, 'backups'),
      logsRoot: paths.join(assistantRoot, 'logs'),
      runRoot: paths.join(assistantRoot, 'run'),
      releasesRoot: paths.join(assistantRoot, 'releases'),
      aiConfigPath: paths.resolve(clean(env.KAOYAN_AI_CONFIG_PATH) || paths.join(assistantRoot, 'ai-providers.json')),
      runtimeConfigPath: paths.join(assistantRoot, 'runtime-layout.json'),
    });
  }

  const runtimeRoot = resolveManagedRoot({ env, platform, homeDir, pathImpl: paths });
  const configRoot = paths.join(runtimeRoot, 'config');
  const secretsRoot = paths.join(runtimeRoot, 'secrets');
  const dataRoot = paths.join(runtimeRoot, 'data');
  const notesRoot = paths.resolve(clean(env.KAOYAN_NOTES_ROOT) || paths.join(dataRoot, 'notes'));
  const assistantRoot = paths.resolve(clean(env.KAOYAN_ASSISTANT_ROOT) || paths.join(dataRoot, 'assistant'));

  return Object.freeze({
    layout: 'managed',
    platform,
    runtimeRoot,
    configRoot,
    secretsRoot,
    dataRoot,
    notesRoot,
    assistantRoot,
    assetsRoot: paths.join(dataRoot, 'assets', 'sha256'),
    backupsRoot: paths.join(runtimeRoot, 'backups'),
    logsRoot: paths.join(runtimeRoot, 'logs'),
    runRoot: paths.join(runtimeRoot, 'run'),
    releasesRoot: paths.join(runtimeRoot, 'releases'),
    aiConfigPath: paths.resolve(clean(env.KAOYAN_AI_CONFIG_PATH) || paths.join(secretsRoot, 'ai-providers.json')),
    runtimeConfigPath: paths.join(configRoot, 'runtime-layout.json'),
  });
}

function isFilesystemRoot(target, pathImpl = path) {
  const resolved = pathImpl.resolve(target);
  return resolved === pathImpl.parse(resolved).root;
}

function assertSafeRuntimePaths(runtimePaths, options = {}) {
  const paths = options.pathImpl || pathImplementation(runtimePaths.platform);
  const homeDir = paths.resolve(options.homeDir || os.homedir());
  const runtimeRoot = paths.resolve(runtimePaths.runtimeRoot);
  if (!runtimeRoot || isFilesystemRoot(runtimeRoot, paths) || runtimeRoot === homeDir) {
    throw new Error(`Refusing unsafe runtime root: ${runtimeRoot || '(empty)'}`);
  }
  for (const [name, value] of Object.entries(runtimePaths)) {
    if (!name.endsWith('Root') || typeof value !== 'string') continue;
    const resolved = paths.resolve(value);
    if (isFilesystemRoot(resolved, paths)) throw new Error(`Refusing unsafe ${name}: ${resolved}`);
    if (runtimePaths.layout === 'managed' && name !== 'runtimeRoot') {
      const relative = paths.relative(runtimeRoot, resolved);
      if (!relative || relative.startsWith(`..${paths.sep}`) || relative === '..' || paths.isAbsolute(relative)) {
        throw new Error(`Managed ${name} must stay inside the runtime root: ${resolved}`);
      }
    }
  }
  if (runtimePaths.layout === 'managed') {
    const configRelative = paths.relative(runtimeRoot, paths.resolve(runtimePaths.aiConfigPath));
    if (!configRelative || configRelative.startsWith(`..${paths.sep}`) || configRelative === '..' || paths.isAbsolute(configRelative)) {
      throw new Error(`Managed AI config must stay inside the runtime root: ${runtimePaths.aiConfigPath}`);
    }
  }
  return runtimePaths;
}

function assertNoRuntimeSymlinks(runtimePaths, options = {}) {
  const fsModule = options.fsModule || fs;
  const paths = options.pathImpl || pathImplementation(runtimePaths.platform);
  const runtimeRoot = paths.resolve(runtimePaths.runtimeRoot);
  const candidates = [
    runtimeRoot,
    runtimePaths.configRoot,
    runtimePaths.secretsRoot,
    runtimePaths.dataRoot,
    runtimePaths.notesRoot,
    runtimePaths.assistantRoot,
    runtimePaths.assetsRoot,
    runtimePaths.backupsRoot,
    runtimePaths.logsRoot,
    runtimePaths.runRoot,
    runtimePaths.releasesRoot,
  ];
  for (const candidate of candidates) {
    let current = paths.resolve(candidate);
    while (current.length >= runtimeRoot.length) {
      if (fsModule.existsSync(current) && fsModule.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Refusing a symlink in the managed runtime layout: ${current}`);
      }
      if (current === runtimeRoot) break;
      const parent = paths.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
}

function ensurePrivateDirectory(directory, fsModule = fs) {
  fsModule.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fsModule.chmodSync(directory, 0o700);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

function atomicWriteJson(filePath, payload, options = {}) {
  const fsModule = options.fsModule || fs;
  const paths = options.pathImpl || path;
  ensurePrivateDirectory(paths.dirname(filePath), fsModule);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  let descriptor;
  try {
    descriptor = fsModule.openSync(temporaryPath, 'wx', 0o600);
    fsModule.writeFileSync(descriptor, body, 'utf8');
    fsModule.fsyncSync(descriptor);
    fsModule.closeSync(descriptor);
    descriptor = undefined;
    try {
      fsModule.chmodSync(temporaryPath, 0o600);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
    fsModule.renameSync(temporaryPath, filePath);
  } finally {
    if (descriptor !== undefined) fsModule.closeSync(descriptor);
    try {
      fsModule.rmSync(temporaryPath, { force: true });
    } catch {}
  }
}

function provisionRuntimeLayout(runtimePaths, options = {}) {
  assertSafeRuntimePaths(runtimePaths, options);
  assertNoRuntimeSymlinks(runtimePaths, options);
  const fsModule = options.fsModule || fs;
  const directories = [
    runtimePaths.runtimeRoot,
    runtimePaths.configRoot,
    runtimePaths.secretsRoot,
    runtimePaths.dataRoot,
    runtimePaths.notesRoot,
    runtimePaths.assistantRoot,
    runtimePaths.assetsRoot,
    runtimePaths.backupsRoot,
    runtimePaths.logsRoot,
    runtimePaths.runRoot,
    runtimePaths.releasesRoot,
  ];
  [...new Set(directories)].forEach((directory) => ensurePrivateDirectory(directory, fsModule));

  if (!fsModule.existsSync(runtimePaths.runtimeConfigPath)) {
    atomicWriteJson(runtimePaths.runtimeConfigPath, {
      schemaVersion: RUNTIME_LAYOUT_VERSION,
      layout: runtimePaths.layout,
      createdAt: new Date().toISOString(),
      paths: {
        runtimeRoot: runtimePaths.runtimeRoot,
        dataRoot: runtimePaths.dataRoot,
        notesRoot: runtimePaths.notesRoot,
        assistantRoot: runtimePaths.assistantRoot,
        assetsRoot: runtimePaths.assetsRoot,
        backupsRoot: runtimePaths.backupsRoot,
        logsRoot: runtimePaths.logsRoot,
      },
    }, options);
  }
  return runtimePaths;
}

function createRuntimeEnvironment(runtimePaths, baseEnvironment = {}) {
  const environment = {
    ...baseEnvironment,
    KAOYAN_RUNTIME_LAYOUT: runtimePaths.layout,
    KAOYAN_NOTES_ROOT: runtimePaths.notesRoot,
    KAOYAN_ASSISTANT_ROOT: runtimePaths.assistantRoot,
    KAOYAN_AI_CONFIG_PATH: runtimePaths.aiConfigPath,
  };
  if (runtimePaths.layout === 'managed') environment.KAOYAN_RUNTIME_ROOT = runtimePaths.runtimeRoot;
  else delete environment.KAOYAN_RUNTIME_ROOT;
  return environment;
}

function withoutLegacyAiProviderEnvironment(baseEnvironment = {}) {
  const environment = { ...baseEnvironment };
  for (const key of Object.keys(environment)) {
    if (LEGACY_AI_ENV_PREFIXES.some((prefix) => key.toUpperCase().startsWith(prefix))) delete environment[key];
  }
  return environment;
}

function publicRuntimeSummary(runtimePaths) {
  return {
    layout: runtimePaths.layout,
    platform: runtimePaths.platform,
    runtimeRoot: runtimePaths.runtimeRoot,
    dataRoot: runtimePaths.dataRoot,
    notesRoot: runtimePaths.notesRoot,
    assistantRoot: runtimePaths.assistantRoot,
    assetsRoot: runtimePaths.assetsRoot,
    backupsRoot: runtimePaths.backupsRoot,
    logsRoot: runtimePaths.logsRoot,
    aiConfigPath: runtimePaths.aiConfigPath,
  };
}

module.exports = {
  APP_DIRECTORY_NAME,
  LEGACY_AI_ENV_PREFIXES,
  RUNTIME_LAYOUT_VERSION,
  assertSafeRuntimePaths,
  assertNoRuntimeSymlinks,
  atomicWriteJson,
  createRuntimeEnvironment,
  ensurePrivateDirectory,
  provisionRuntimeLayout,
  publicRuntimeSummary,
  resolveRuntimePaths,
  withoutLegacyAiProviderEnvironment,
};
