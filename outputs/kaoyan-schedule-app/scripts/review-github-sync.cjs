const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { loadAiProviderConfigs, resolveTaskOptions } = require('./ai-router.cjs');

const DEFAULT_REPOSITORY = 'strawberryCao/Caobijidata';
const DEFAULT_BRANCH = 'main';
const VALID_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VALID_NOTE_KINDS = new Set(['mistake', 'memory']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function clean(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function removeDirectoryContents(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory)) {
    fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
  }
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = clean(result.stderr || result.stdout, 1200);
    const error = new Error(`Git 命令失败：git ${args.join(' ')}${detail ? `\n${detail}` : ''}`);
    error.code = 'REVIEW_GIT_FAILED';
    throw error;
  }
  return clean(result.stdout, 10000);
}

function taskSettings(configPath) {
  const local = readJson(configPath, {});
  const task = local.tasks?.weekly_review_pdf || {};
  const options = resolveTaskOptions('weekly_review_pdf', task);
  const repository = clean(options.repository, 200) || DEFAULT_REPOSITORY;
  if (!VALID_REPOSITORY.test(repository)) throw new Error('综合复习 PDF 的 GitHub 仓库格式必须是 owner/name');
  const branch = clean(options.branch, 100) || DEFAULT_BRANCH;
  const outputDirectory = clean(options.localOutputDir, 500)
    || path.join(os.homedir(), 'Desktop', '考研复习资料');
  return {
    enabled: task.enabled !== false && options.autoSync !== false,
    repository,
    branch,
    outputDirectory,
    pullOnStartup: options.pullOnStartup !== false,
    pushOnStartup: options.pushOnStartup !== false,
    scheduleDay: clean(options.scheduleDay, 20) || 'sunday',
    scheduleHour: Number.isFinite(Number(options.scheduleHour)) ? Math.round(Number(options.scheduleHour)) : 21,
    mergeSameQuestion: options.mergeSameQuestion !== false,
    groupSimilarTopics: options.groupSimilarTopics !== false,
    maxGroupSize: Number.isFinite(Number(options.maxGroupSize)) ? Math.round(Number(options.maxGroupSize)) : 8,
    includeOriginalImages: options.includeOriginalImages !== false,
    strictNoExpansion: true,
    providerId: clean(task.providerId, 40),
    modelId: clean(task.modelId, 160),
    aiEnabled: task.enabled !== false,
  };
}

function localDateParts(date = new Date(), timeZone = 'Asia/Shanghai') {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday],
    hour: Number(parts.hour),
  };
}

function currentScheduleKey(settings, date = new Date()) {
  const parts = localDateParts(date);
  const configuredDay = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }[settings.scheduleDay] ?? 0;
  let daysBack = (parts.weekday - configuredDay + 7) % 7;
  if (daysBack === 0 && parts.hour < settings.scheduleHour) daysBack = 7;
  const localMidnightUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  const dueDate = new Date(localMidnightUtc - daysBack * 24 * 60 * 60 * 1000);
  return `${dueDate.getUTCFullYear()}-${String(dueDate.getUTCMonth() + 1).padStart(2, '0')}-${String(dueDate.getUTCDate()).padStart(2, '0')}@${String(settings.scheduleHour).padStart(2, '0')}`;
}

function selectWindowsDirectory(initialPath = '') {
  if (process.platform !== 'win32') {
    const error = new Error('目录选择只支持 Windows 主机');
    error.code = 'REVIEW_DIRECTORY_PICKER_UNSUPPORTED';
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "选择综合复习 PDF 保存目录"',
      '$dialog.ShowNewFolderButton = $true',
      'if ($env:KAOYAN_REVIEW_INITIAL_DIR -and (Test-Path -LiteralPath $env:KAOYAN_REVIEW_INITIAL_DIR)) { $dialog.SelectedPath = $env:KAOYAN_REVIEW_INITIAL_DIR }',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $dialog.SelectedPath }',
    ].join('; ');
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, KAOYAN_REVIEW_INITIAL_DIR: clean(initialPath, 1000) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`无法打开目录选择器${clean(stderr, 500) ? `：${clean(stderr, 500)}` : ''}`));
        return;
      }
      const selected = clean(stdout, 1000).split(/\r?\n/).map((item) => item.trim()).filter(Boolean).at(-1) || '';
      resolve(selected);
    });
  });
}

function providerPublicConfig(configPath, settings) {
  try {
    const loaded = loadAiProviderConfigs({ configPath });
    const provider = settings.providerId
      ? loaded.providers.find((item) => item.id === settings.providerId)
      : loaded.providers[0];
    return {
      providerId: provider?.id || settings.providerId || '',
      modelId: settings.modelId || provider?.models?.find((model) => !model.catalogOnly)?.id || '',
      baseUrl: provider?.baseUrl || '',
    };
  } catch {
    return { providerId: settings.providerId, modelId: settings.modelId, baseUrl: '' };
  }
}

function allConfirmedReviewNotes(snapshot) {
  const notes = [];
  for (const day of Object.values(snapshot?.days || {})) {
    for (const note of day?.autoNotes || []) {
      if (note?.organizationStatus !== 'confirmed' || !VALID_NOTE_KINDS.has(note.noteType)) continue;
      notes.push(note);
    }
  }
  return notes.sort((left, right) => String(left.noteUid).localeCompare(String(right.noteUid), 'zh-CN'));
}

function safeAssetName(noteUid, extension) {
  const safeId = clean(noteUid, 160).replace(/[^A-Za-z0-9._-]/g, '_') || hashBuffer(Buffer.from(String(noteUid))).slice(0, 24);
  return `${safeId}${extension}`;
}

function exportReviewData({ learningSnapshot, repositoryRoot, settings, aiConfig }) {
  const assetsRoot = path.join(repositoryRoot, 'data', 'assets');
  ensureDirectory(assetsRoot);
  removeDirectoryContents(assetsRoot);
  const notes = [];
  for (const note of allConfirmedReviewNotes(learningSnapshot)) {
    let imagePath = '';
    let imageSha256 = '';
    let sourceFileName = '';
    const sourcePath = clean(note.filePath, 2000);
    if (sourcePath && fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) {
      const extension = path.extname(sourcePath).toLowerCase();
      if (IMAGE_EXTENSIONS.has(extension)) {
        const buffer = fs.readFileSync(sourcePath);
        const assetName = safeAssetName(note.noteUid, extension);
        fs.writeFileSync(path.join(assetsRoot, assetName), buffer);
        imagePath = `data/assets/${assetName}`;
        imageSha256 = hashBuffer(buffer);
        sourceFileName = path.basename(sourcePath);
      }
    }
    notes.push({
      id: note.noteUid,
      kind: note.noteType,
      title: note.title || '',
      subject: note.subject || '未分类',
      knowledgePath: Array.isArray(note.knowledgePath) ? note.knowledgePath : [],
      tags: Array.isArray(note.tags) ? note.tags : [],
      remark: note.remark || '',
      wrongReason: note.wrongReason || '',
      questionType: note.questionType || '',
      capturedDate: note.capturedDate || '',
      createdAt: note.createdAt || '',
      updatedAt: note.updatedAt || '',
      organizationStatus: 'confirmed',
      imagePath,
      imageSha256,
      sourceFileName,
      items: Array.isArray(note.items) ? note.items : [],
    });
  }
  writeJsonAtomic(path.join(repositoryRoot, 'data', 'index.json'), {
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceRevision: Number.isInteger(learningSnapshot?.revision) ? learningSnapshot.revision : 0,
    notes,
  });
  writeJsonAtomic(path.join(repositoryRoot, 'config', 'review-config.json'), {
    version: 1,
    schedule: {
      timeZone: 'Asia/Shanghai',
      dayOfWeek: { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }[settings.scheduleDay] ?? 0,
      hour: Math.min(23, Math.max(0, settings.scheduleHour)),
    },
    ai: {
      enabled: settings.aiEnabled,
      providerId: aiConfig.providerId,
      modelId: aiConfig.modelId,
      baseUrl: aiConfig.baseUrl,
      temperature: 0.1,
      maxTokens: 2600,
      timeoutMs: 90000,
      includeImages: true,
      maxImageBytesPerNote: 1572864,
      maxNotesPerBatch: 24,
    },
    rules: {
      strictNoExpansion: true,
      mergeSameQuestion: settings.mergeSameQuestion,
      groupSimilarTopics: settings.groupSimilarTopics,
      maxGroupSize: settings.maxGroupSize,
      maxGroupTitleChars: 24,
      includeOriginalImages: settings.includeOriginalImages,
      includeRemarks: true,
      includeWrongReasons: true,
    },
    output: { mistakesFile: '错题综合整理.pdf', memoryFile: '背诵综合整理.pdf' },
  });
  return notes;
}

function rawUrl(repository, branch, repoPath) {
  return `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(branch)}/${repoPath.split('/').map(encodeURIComponent).join('/')}`;
}

async function downloadBuffer(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}：${url}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function createReviewSyncManager(options = {}) {
  const assistantRoot = options.assistantRoot || path.join(os.homedir(), 'Desktop', '考研桌面助手');
  const configPath = options.configPath || path.join(assistantRoot, 'ai-providers.json');
  const getLearningSnapshot = options.getLearningSnapshot;
  const cacheRoot = options.cacheRoot || path.join(assistantRoot, 'review-github-sync');
  const statusPath = path.join(cacheRoot, 'status.json');
  let running = null;
  let startupTimer = null;
  let intervalTimer = null;

  function status() {
    return { ...readJson(statusPath, {}), settings: taskSettings(configPath), running: Boolean(running) };
  }

  function updateStatus(patch) {
    writeJsonAtomic(statusPath, { ...readJson(statusPath, {}), ...patch, updatedAt: new Date().toISOString() });
  }

  async function push(scheduleKey = currentScheduleKey(taskSettings(configPath))) {
    const settings = taskSettings(configPath);
    if (!settings.enabled) return { ok: false, skipped: true, reason: '综合复习 PDF 自动同步已关闭' };
    if (typeof getLearningSnapshot !== 'function') throw new Error('缺少学习数据读取器');
    const workingRoot = path.join(cacheRoot, settings.repository.replace('/', '__'));
    ensureDirectory(cacheRoot);
    if (!fs.existsSync(path.join(workingRoot, '.git'))) {
      fs.rmSync(workingRoot, { recursive: true, force: true });
      runGit(['clone', '--branch', settings.branch, `https://github.com/${settings.repository}.git`, workingRoot], { timeout: 180000 });
    } else {
      runGit(['fetch', 'origin', settings.branch], { cwd: workingRoot });
      runGit(['reset', '--hard', `origin/${settings.branch}`], { cwd: workingRoot });
      runGit(['clean', '-fd', '--', 'data', 'config/review-config.json'], { cwd: workingRoot });
    }
    const aiConfig = providerPublicConfig(configPath, settings);
    const notes = exportReviewData({ learningSnapshot: getLearningSnapshot(), repositoryRoot: workingRoot, settings, aiConfig });
    runGit(['add', 'data', 'config/review-config.json'], { cwd: workingRoot });
    const changed = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: workingRoot, windowsHide: true }).status !== 0;
    if (!changed) {
      updateStatus({ lastPushAt: new Date().toISOString(), lastScheduleKey: scheduleKey, lastPushCount: notes.length, lastPushResult: 'unchanged', lastError: null });
      return { ok: true, changed: false, count: notes.length };
    }
    runGit(['config', 'user.name', 'Kaoyan Review Sync'], { cwd: workingRoot });
    runGit(['config', 'user.email', 'review-sync@local.invalid'], { cwd: workingRoot });
    runGit(['commit', '-m', 'data: sync confirmed review notes'], { cwd: workingRoot });
    runGit(['push', 'origin', `HEAD:${settings.branch}`], { cwd: workingRoot, timeout: 180000 });
    updateStatus({ lastPushAt: new Date().toISOString(), lastScheduleKey: scheduleKey, lastPushCount: notes.length, lastPushResult: 'pushed', lastError: null });
    return { ok: true, changed: true, count: notes.length };
  }

  async function pull() {
    const settings = taskSettings(configPath);
    if (!settings.enabled) return { ok: false, skipped: true, reason: '综合复习 PDF 自动同步已关闭' };
    const manifestBuffer = await downloadBuffer(rawUrl(settings.repository, settings.branch, 'generated/manifest.json'));
    const manifest = JSON.parse(manifestBuffer.toString('utf8'));
    const targets = [manifest?.files?.mistakes, manifest?.files?.memory].filter(Boolean);
    if (targets.length !== 2) return { ok: false, skipped: true, reason: '远程仓库尚未生成两份 PDF' };
    ensureDirectory(settings.outputDirectory);
    let downloaded = 0;
    for (const target of targets) {
      const remotePath = clean(target.path, 500);
      const expectedHash = clean(target.sha256, 64).toLowerCase();
      if (!remotePath || !expectedHash) throw new Error('远程 PDF manifest 缺少路径或哈希');
      const destination = path.join(settings.outputDirectory, path.basename(remotePath));
      if (fs.existsSync(destination) && hashBuffer(fs.readFileSync(destination)) === expectedHash) continue;
      const buffer = await downloadBuffer(rawUrl(settings.repository, settings.branch, remotePath), 60000);
      if (hashBuffer(buffer) !== expectedHash || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error(`远程 PDF 校验失败：${remotePath}`);
      const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporary, buffer);
      fs.renameSync(temporary, destination);
      downloaded += 1;
    }
    updateStatus({ lastPullAt: new Date().toISOString(), lastRemoteGeneratedAt: manifest.generatedAt || null, lastPullResult: downloaded ? 'downloaded' : 'unchanged', lastError: null });
    return { ok: true, downloaded, outputDirectory: settings.outputDirectory, generatedAt: manifest.generatedAt || null };
  }

  function runExclusive(action) {
    if (running) return running;
    running = Promise.resolve().then(action).catch((error) => {
      updateStatus({ lastError: error instanceof Error ? error.message : String(error), lastErrorAt: new Date().toISOString() });
      throw error;
    }).finally(() => { running = null; });
    return running;
  }

  async function runAutomaticCycle() {
    const settings = taskSettings(configPath);
    if (!settings.enabled) return;
    const scheduleKey = currentScheduleKey(settings);
    const previous = readJson(statusPath, {});
    if (settings.pushOnStartup && previous.lastScheduleKey !== scheduleKey) await push(scheduleKey);
    if (settings.pullOnStartup) await pull();
  }

  function start() {
    stop();
    startupTimer = setTimeout(() => {
      runExclusive(runAutomaticCycle).catch((error) => console.warn('Review GitHub startup sync failed:', error.message));
    }, 15000);
    intervalTimer = setInterval(() => {
      runExclusive(runAutomaticCycle).catch((error) => console.warn('Review GitHub periodic sync failed:', error.message));
    }, 60 * 60 * 1000);
    intervalTimer.unref?.();
    startupTimer.unref?.();
  }

  function stop() {
    if (startupTimer) clearTimeout(startupTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    startupTimer = null;
    intervalTimer = null;
  }

  return { status, push: () => runExclusive(push), pull: () => runExclusive(pull), start, stop };
}

module.exports = { createReviewSyncManager, currentScheduleKey, exportReviewData, selectWindowsDirectory, taskSettings };

if (require.main === module) {
  const assistantRoot = process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手');
  const learningPath = path.join(assistantRoot, 'learning-data.json');
  const manager = createReviewSyncManager({ assistantRoot, getLearningSnapshot: () => readJson(learningPath, { revision: 0, days: {} }) });
  const command = process.argv[2] || 'status';
  Promise.resolve(command === 'push' ? manager.push() : command === 'pull' ? manager.pull() : manager.status())
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
