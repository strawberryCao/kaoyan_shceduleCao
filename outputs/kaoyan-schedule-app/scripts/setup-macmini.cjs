#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_RUNTIME_ROOT = '/Library/Application Support/KaoyanStudyCenter';

function parseArguments(argv = process.argv.slice(2)) {
  const result = {
    command: 'plan',
    runtimeRoot: DEFAULT_RUNTIME_ROOT,
    notePort: 5174,
    webPort: 5173,
    skipVerify: false,
    json: false,
  };
  let commandSeen = false;
  for (const argument of argv) {
    if (!argument.startsWith('-') && !commandSeen) {
      result.command = argument;
      commandSeen = true;
    } else if (argument === '--skip-verify') result.skipVerify = true;
    else if (argument === '--json') result.json = true;
    else if (argument.startsWith('--runtime-root=')) result.runtimeRoot = argument.slice(15).trim();
    else if (argument.startsWith('--note-port=')) result.notePort = Number(argument.slice(12));
    else if (argument.startsWith('--web-port=')) result.webPort = Number(argument.slice(11));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function serviceUser(environment = process.env) {
  return String(environment.SUDO_USER || environment.USER || environment.USERNAME || os.userInfo().username || '').trim();
}

function stableNodePath(environment = process.env, fsModule = fs) {
  const candidates = [
    String(environment.KAOYAN_NODE_PATH || '').trim(),
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin/node', '/usr/local/bin/node'] : []),
    process.execPath,
  ].filter(Boolean);
  return candidates.find((candidate) => fsModule.existsSync(candidate)) || process.execPath;
}

function buildSetupPlan(options, environment = process.env) {
  const user = serviceUser(environment);
  const nodePath = stableNodePath(environment);
  const common = [
    `--runtime-root=${options.runtimeRoot}`,
    `--note-port=${options.notePort}`,
    `--web-port=${options.webPort}`,
  ];
  const steps = [];
  if (!options.skipVerify) {
    steps.push({ id: 'offline-tests', command: 'npm', args: ['test'], mutatesProduction: false });
    steps.push({ id: 'type-check', command: 'npm', args: ['exec', '--', 'tsc', '--noEmit'], mutatesProduction: false });
    steps.push({ id: 'production-build', command: 'npm', args: ['run', 'build'], mutatesProduction: false });
    steps.push({ id: 'runtime-smoke', command: 'npm', args: ['run', 'macmini:smoke'], mutatesProduction: false });
  }
  steps.push({
    id: 'install-launchdaemon',
    command: 'sudo',
    args: [
      nodePath,
      path.join(PROJECT_ROOT, 'scripts', 'install-macmini-service.cjs'),
      'install',
      `--user=${user}`,
      `--node=${process.execPath}`,
      ...common,
    ],
    mutatesProduction: true,
  });
  steps.push({
    id: 'configure-ai',
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'scripts', 'configure-macmini.cjs'), 'configure', `--runtime-root=${options.runtimeRoot}`],
    mutatesProduction: true,
    secretInput: 'interactive-hidden-only',
  });
  steps.push({
    id: 'doctor',
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'scripts', 'macmini-runtime.cjs'), 'doctor', ...common],
    mutatesProduction: false,
  });
  return {
    platformRequired: 'darwin/arm64',
    projectRoot: PROJECT_ROOT,
    runtimeRoot: options.runtimeRoot,
    serviceUser: user,
    networkBinding: '127.0.0.1',
    productionDataMigration: false,
    cloudflareDeployment: false,
    steps,
  };
}

function assertInstallHost() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(`Mac mini setup requires darwin/arm64; detected ${process.platform}/${process.arch}.`);
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('Run setup as your normal Mac user, not with sudo. The script asks sudo only for LaunchDaemon installation.');
  }
}

function runStep(step) {
  process.stdout.write(`\n[${step.id}] ${step.command} ${step.args.map((value) => JSON.stringify(value)).join(' ')}\n`);
  const result = spawnSync(step.command, step.args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${step.id} failed with exit code ${result.status}.`);
}

function probeReady(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get({ host: '127.0.0.1', port, path: '/readyz', timeout: 1_500 }, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve(true);
        else if (Date.now() >= deadline) reject(new Error(`Readiness returned ${response.statusCode}.`));
        else setTimeout(attempt, 250);
      });
      request.once('timeout', () => request.destroy(new Error('probe timeout')));
      request.once('error', (error) => {
        if (Date.now() >= deadline) reject(error);
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

async function main() {
  const options = parseArguments();
  const plan = buildSetupPlan(options);
  if (options.command === 'plan') {
    if (options.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    else {
      process.stdout.write('Mac mini setup plan (read-only)\n');
      process.stdout.write(`Project: ${plan.projectRoot}\nRuntime: ${plan.runtimeRoot}\nService user: ${plan.serviceUser}\n`);
      for (const step of plan.steps) process.stdout.write(`- ${step.id}${step.mutatesProduction ? ' [writes local Mac state]' : ''}\n`);
      process.stdout.write('\nRun `npm run macmini:setup -- install` on the Mac only after reviewing this plan.\n');
    }
    return;
  }
  if (options.command !== 'install') throw new Error(`Unknown command: ${options.command}`);
  assertInstallHost();
  for (const step of plan.steps) runStep(step);
  await probeReady(options.webPort);
  process.stdout.write(`\nMac mini core service is ready on loopback port ${options.webPort}.\n`);
  process.stdout.write('Tailscale Serve and Cloudflare Tunnel remain separate, explicit later-stage actions.\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Mac mini setup error: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertInstallHost,
  buildSetupPlan,
  parseArguments,
  probeReady,
  runStep,
  serviceUser,
  stableNodePath,
};
