#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  LAUNCHD_LABEL,
  LAUNCHD_PLIST_PATH,
  createLaunchDaemonDefinition,
  publicLaunchDaemonPlan,
  renderLaunchDaemonPlist,
} = require('./macos-launchd.cjs');
const {
  provisionRuntimeLayout,
  resolveRuntimePaths,
} = require('./runtime-paths.cjs');
const { runDoctor } = require('./macmini-runtime.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function defaultNodePath(environment = process.env) {
  const candidates = [
    String(environment.KAOYAN_NODE_PATH || '').trim(),
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin/node', '/usr/local/bin/node'] : []),
    process.execPath,
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || process.execPath;
}

function parseArguments(argv = process.argv.slice(2), environment = process.env) {
  const result = {
    command: 'plan',
    dryRun: false,
    json: false,
    runtimeRoot: '/Library/Application Support/KaoyanStudyCenter',
    serviceUser: String(
      environment.SUDO_USER
      || environment.USER
      || environment.USERNAME
      || os.userInfo().username
      || '',
    ).trim(),
    nodePath: defaultNodePath(environment),
    notePort: 5174,
    webPort: 5173,
  };
  let commandSeen = false;
  for (const argument of argv) {
    if (!argument.startsWith('-') && !commandSeen) {
      result.command = argument;
      commandSeen = true;
    } else if (argument === '--dry-run') result.dryRun = true;
    else if (argument === '--json') result.json = true;
    else if (argument.startsWith('--runtime-root=')) result.runtimeRoot = argument.slice(15).trim();
    else if (argument.startsWith('--user=')) result.serviceUser = argument.slice(7).trim();
    else if (argument.startsWith('--node=')) result.nodePath = argument.slice(7).trim();
    else if (argument.startsWith('--note-port=')) result.notePort = Number(argument.slice(12));
    else if (argument.startsWith('--web-port=')) result.webPort = Number(argument.slice(11));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function assertMacInstallEnvironment() {
  if (process.platform !== 'darwin') throw new Error('Actual service installation is only supported on macOS. Use plan --dry-run elsewhere.');
  if (process.arch !== 'arm64') throw new Error(`Apple silicon is required; detected ${process.arch}.`);
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    throw new Error('Installation requires sudo because it writes /Library/LaunchDaemons.');
  }
}

function lookupIdentity(user) {
  const uid = Number(run('/usr/bin/id', ['-u', user]).stdout.trim());
  const gid = Number(run('/usr/bin/id', ['-g', user]).stdout.trim());
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid <= 0 || gid <= 0) {
    throw new Error(`Unable to resolve a non-root uid/gid for ${user}.`);
  }
  return { uid, gid };
}

function assignRuntimeOwnership(runtimePaths, uid, gid) {
  const targets = [
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
    runtimePaths.runtimeConfigPath,
  ];
  for (const target of new Set(targets)) {
    const stats = fs.lstatSync(target);
    if (stats.isSymbolicLink()) throw new Error(`Refusing a symlink in the managed runtime layout: ${target}`);
    fs.chownSync(target, uid, gid);
  }
}

function writeLaunchDaemonPlistBody(body) {
  const temporaryPath = `${LAUNCHD_PLIST_PATH}.${process.pid}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o644);
    fs.writeFileSync(descriptor, body, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    run('/usr/bin/plutil', ['-lint', temporaryPath]);
    fs.chmodSync(temporaryPath, 0o644);
    fs.chownSync(temporaryPath, 0, 0);
    fs.renameSync(temporaryPath, LAUNCHD_PLIST_PATH);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function writeLaunchDaemonPlist(definition) {
  writeLaunchDaemonPlistBody(renderLaunchDaemonPlist(definition));
}

function install(definition, runtimePaths) {
  assertMacInstallEnvironment();
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) throw new Error(`Node.js 22 or newer is required; detected ${process.versions.node}.`);
  if (!fs.existsSync(path.join(PROJECT_ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html is missing. Run npm ci, npm test, and npm run build before installing.');
  }
  fs.accessSync(definition.nodePath, fs.constants.X_OK);
  fs.accessSync(path.join(PROJECT_ROOT, 'scripts', 'macmini-runtime.cjs'), fs.constants.R_OK);
  const identity = lookupIdentity(definition.serviceUser);
  provisionRuntimeLayout(runtimePaths);
  assignRuntimeOwnership(runtimePaths, identity.uid, identity.gid);
  const previousPlist = fs.existsSync(LAUNCHD_PLIST_PATH)
    ? fs.readFileSync(LAUNCHD_PLIST_PATH, 'utf8')
    : null;
  writeLaunchDaemonPlist(definition);
  run('/bin/launchctl', ['bootout', 'system', LAUNCHD_PLIST_PATH], { allowFailure: true });
  try {
    run('/bin/launchctl', ['bootstrap', 'system', LAUNCHD_PLIST_PATH]);
    run('/bin/launchctl', ['enable', `system/${LAUNCHD_LABEL}`]);
    run('/bin/launchctl', ['kickstart', '-k', `system/${LAUNCHD_LABEL}`]);
  } catch (error) {
    run('/bin/launchctl', ['bootout', 'system', LAUNCHD_PLIST_PATH], { allowFailure: true });
    let rollbackError = '';
    try {
      if (previousPlist === null) fs.rmSync(LAUNCHD_PLIST_PATH, { force: true });
      else {
        writeLaunchDaemonPlistBody(previousPlist);
        run('/bin/launchctl', ['bootstrap', 'system', LAUNCHD_PLIST_PATH]);
      }
    } catch (rollbackFailure) {
      rollbackError = ` Rollback also failed: ${rollbackFailure.message}`;
    }
    throw new Error(`LaunchDaemon activation failed and the previous definition was restored when possible: ${error.message}${rollbackError}`);
  }
}

function uninstall() {
  assertMacInstallEnvironment();
  run('/bin/launchctl', ['bootout', 'system', LAUNCHD_PLIST_PATH], { allowFailure: true });
  fs.rmSync(LAUNCHD_PLIST_PATH, { force: true });
}

function serviceStatus() {
  if (process.platform !== 'darwin') return { installed: false, loaded: false, detail: 'not running on macOS' };
  const result = run('/bin/launchctl', ['print', `system/${LAUNCHD_LABEL}`], { allowFailure: true });
  return {
    installed: fs.existsSync(LAUNCHD_PLIST_PATH),
    loaded: result.status === 0,
    detail: result.status === 0 ? String(result.stdout || '').slice(0, 4_000) : String(result.stderr || '').trim(),
  };
}

function buildContext(arguments_) {
  const runtimeEnvironment = {
    ...process.env,
    KAOYAN_SERVICE_MODE: 'system',
    KAOYAN_RUNTIME_LAYOUT: 'managed',
    KAOYAN_RUNTIME_ROOT: path.resolve(arguments_.runtimeRoot),
  };
  const runtimePaths = resolveRuntimePaths({ env: runtimeEnvironment });
  const definition = createLaunchDaemonDefinition({
    runtimePaths,
    serviceUser: arguments_.serviceUser,
    projectRoot: PROJECT_ROOT,
    nodePath: arguments_.nodePath,
    notePort: arguments_.notePort,
    webPort: arguments_.webPort,
  });
  return { runtimePaths, definition };
}

function print(value, json) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else {
    for (const [key, detail] of Object.entries(value)) process.stdout.write(`${key}: ${typeof detail === 'object' ? JSON.stringify(detail) : detail}\n`);
  }
}

function main() {
  const arguments_ = parseArguments();
  if (arguments_.command === 'status') {
    print(serviceStatus(), arguments_.json);
    return;
  }
  if (arguments_.command === 'uninstall') {
    if (arguments_.dryRun) print({ action: 'uninstall', plistPath: LAUNCHD_PLIST_PATH, dataPreserved: true }, arguments_.json);
    else uninstall();
    return;
  }
  const { runtimePaths, definition } = buildContext(arguments_);
  const plan = {
    action: arguments_.command === 'install' ? 'install' : 'plan',
    ...publicLaunchDaemonPlan(definition),
    doctor: runDoctor(runtimePaths),
  };
  if (arguments_.command === 'plan' || arguments_.dryRun) {
    print(plan, arguments_.json);
    return;
  }
  if (arguments_.command !== 'install') throw new Error(`Unknown command: ${arguments_.command}`);
  install(definition, runtimePaths);
  print({ installed: true, ...publicLaunchDaemonPlan(definition), dataPreservedOnUninstall: true }, arguments_.json);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Mac mini service installer error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  assertMacInstallEnvironment,
  assignRuntimeOwnership,
  buildContext,
  defaultNodePath,
  install,
  lookupIdentity,
  parseArguments,
  serviceStatus,
  uninstall,
  writeLaunchDaemonPlist,
  writeLaunchDaemonPlistBody,
};
