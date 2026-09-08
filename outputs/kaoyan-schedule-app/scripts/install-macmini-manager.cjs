#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  MANAGER_LAUNCHD_LABEL,
  renderManagerLaunchAgent,
  validateManagerDefinition,
} = require('./macos-manager-launchagent.cjs');
const { ensurePrivateDirectory, resolveRuntimePaths } = require('./runtime-paths.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MAC_ROOT = '/Library/Application Support/KaoyanStudyCenter';

function parseArguments(argv = process.argv.slice(2)) {
  const result = { command: 'plan', runtimeRoot: '', json: false };
  let commandSeen = false;
  for (const argument of argv) {
    if (!argument.startsWith('-') && !commandSeen) {
      result.command = argument;
      commandSeen = true;
    } else if (argument === '--json') result.json = true;
    else if (argument.startsWith('--runtime-root=')) result.runtimeRoot = path.resolve(argument.slice(15).trim());
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function resolveElectronPath(options = {}) {
  if (options.electronPath) return path.resolve(options.electronPath);
  const electronExport = require('electron');
  if (typeof electronExport !== 'string') throw new Error('无法定位 Electron 可执行文件；请使用 Node 运行此安装器。');
  return path.resolve(electronExport);
}

function buildDefinition(options = {}) {
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const runtimeRoot = path.resolve(options.runtimeRoot || DEFAULT_MAC_ROOT);
  return validateManagerDefinition({
    homeDir,
    runtimeRoot,
    projectRoot: options.projectRoot || PROJECT_ROOT,
    electronPath: resolveElectronPath(options),
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) throw new Error(String(result.stderr || result.stdout || `${command} exited ${result.status}`).trim());
  return result;
}

function assertInstallEnvironment() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error(`菜单栏管理中心安装需要 Apple 芯片 macOS；当前为 ${process.platform}/${process.arch}。`);
  if (typeof process.getuid !== 'function' || process.getuid() === 0) throw new Error('请以当前 Mac 用户运行，不要使用 sudo。');
}

function writeAgent(definition) {
  fs.mkdirSync(path.dirname(definition.plistPath), { recursive: true });
  ensurePrivateDirectory(path.dirname(definition.stdoutPath));
  const temporaryPath = `${definition.plistPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, renderManagerLaunchAgent(definition), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    run('/usr/bin/plutil', ['-lint', temporaryPath]);
    fs.renameSync(temporaryPath, definition.plistPath);
  } finally { fs.rmSync(temporaryPath, { force: true }); }
}

function install(definition) {
  assertInstallEnvironment();
  fs.accessSync(definition.electronPath, fs.constants.X_OK);
  fs.accessSync(path.join(definition.projectRoot, 'electron', 'main.cjs'), fs.constants.R_OK);
  const domain = `gui/${process.getuid()}`;
  writeAgent(definition);
  run('/bin/launchctl', ['bootout', domain, definition.plistPath], { allowFailure: true });
  run('/bin/launchctl', ['bootstrap', domain, definition.plistPath]);
  run('/bin/launchctl', ['enable', `${domain}/${definition.label}`]);
  run('/bin/launchctl', ['kickstart', '-k', `${domain}/${definition.label}`]);
}

function uninstall(definition) {
  assertInstallEnvironment();
  const domain = `gui/${process.getuid()}`;
  run('/bin/launchctl', ['bootout', domain, definition.plistPath], { allowFailure: true });
  fs.rmSync(definition.plistPath, { force: true });
}

function status(definition) {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') return { installed: false, loaded: false, detail: 'not on macOS' };
  const domain = `gui/${process.getuid()}`;
  const result = run('/bin/launchctl', ['print', `${domain}/${definition.label}`], { allowFailure: true });
  return { installed: fs.existsSync(definition.plistPath), loaded: result.status === 0, detail: result.status === 0 ? 'running' : String(result.stderr || '').trim() };
}

function publicPlan(definition) {
  return {
    label: definition.label,
    plistPath: definition.plistPath,
    programArguments: definition.programArguments,
    runtimeRoot: definition.runtimeRoot,
    coreServiceDependency: false,
    startsAfterUserLogin: true,
    exposesSecrets: false,
    removesDataOnUninstall: false,
  };
}

function main() {
  const options = parseArguments();
  const runtimeRoot = options.runtimeRoot || (process.platform === 'darwin' ? DEFAULT_MAC_ROOT : path.join(os.tmpdir(), 'kaoyan-macmini-preview'));
  const definition = buildDefinition({ runtimeRoot });
  if (options.command === 'plan') {
    process.stdout.write(`${JSON.stringify(publicPlan(definition), null, 2)}\n`);
    return;
  }
  if (options.command === 'status') {
    process.stdout.write(`${JSON.stringify(status(definition), null, 2)}\n`);
    return;
  }
  if (options.command === 'install') {
    install(definition);
    process.stdout.write('Mac 菜单栏管理中心已安装，将在登录后自动运行。\n');
    return;
  }
  if (options.command === 'uninstall') {
    uninstall(definition);
    process.stdout.write('菜单栏管理中心已移除；Mac 核心服务和学习数据保持不变。\n');
    return;
  }
  throw new Error(`Unknown command: ${options.command}`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`菜单栏管理中心安装失败：${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  MANAGER_LAUNCHD_LABEL,
  assertInstallEnvironment,
  buildDefinition,
  install,
  parseArguments,
  publicPlan,
  resolveElectronPath,
  status,
  uninstall,
  writeAgent,
};
