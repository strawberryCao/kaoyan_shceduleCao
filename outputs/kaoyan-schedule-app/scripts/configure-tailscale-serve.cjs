#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { publicMobileAuthStatus } = require('./mobile-session-auth.cjs');
const { resolveRuntimePaths } = require('./runtime-paths.cjs');

const DEFAULT_MAC_ROOT = '/Library/Application Support/KaoyanStudyCenter';
const DEFAULT_WEB_PORT = 5173;

function parseArguments(argv = process.argv.slice(2)) {
  const result = { command: 'plan', runtimeRoot: '', webPort: DEFAULT_WEB_PORT, json: false };
  for (const argument of argv) {
    if (!argument.startsWith('-') && result.command === 'plan') result.command = argument;
    else if (argument === '--json') result.json = true;
    else if (argument.startsWith('--runtime-root=')) result.runtimeRoot = argument.slice(15).trim();
    else if (argument.startsWith('--web-port=')) result.webPort = Number(argument.slice(11));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(result.webPort) || result.webPort < 1024 || result.webPort > 65535) {
    throw new Error('Web port must be an unprivileged TCP port between 1024 and 65535.');
  }
  return result;
}

function tailscalePath(fsModule = fs) {
  const candidates = process.platform === 'darwin' ? [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ] : ['tailscale'];
  return candidates.find((candidate) => candidate === 'tailscale' || fsModule.existsSync(candidate)) || '';
}

function buildPlan(options = {}) {
  const webPort = Number(options.webPort || DEFAULT_WEB_PORT);
  const target = `http://127.0.0.1:${webPort}`;
  return {
    mode: 'tailnet-private-https',
    target,
    command: ['tailscale', 'serve', '--bg', '--https=443', target],
    publicFunnel: false,
    changesCloudflare: false,
    requiresMobileLogin: true,
  };
}

function probeReady(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get({ host: '127.0.0.1', port, path: '/readyz', timeout: 1_000 }, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve(true);
        else if (Date.now() >= deadline) reject(new Error(`Mac gateway readiness returned ${response.statusCode}.`));
        else setTimeout(attempt, 200);
      });
      request.once('timeout', () => request.destroy(new Error('readiness timeout')));
      request.once('error', (error) => {
        if (Date.now() >= deadline) reject(error);
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function readStatus(command = tailscalePath(), spawn = spawnSync) {
  if (!command) return { available: false, configured: false, raw: '' };
  const result = spawn(command, ['serve', 'status', '--json'], { encoding: 'utf8', windowsHide: true });
  return {
    available: !result.error,
    configured: result.status === 0 && Boolean(String(result.stdout || '').trim()),
    exitCode: result.status,
    raw: String(result.stdout || '').trim(),
    error: result.error?.message || String(result.stderr || '').trim(),
  };
}

async function applyTailscaleServe(options = {}, dependencies = {}) {
  if (process.platform !== 'darwin' && dependencies.allowNonMac !== true) {
    throw new Error(`Tailscale Serve configuration requires macOS; detected ${process.platform}.`);
  }
  const requestedRoot = options.runtimeRoot || DEFAULT_MAC_ROOT;
  const runtime = resolveRuntimePaths({ env: { ...process.env, KAOYAN_RUNTIME_ROOT: requestedRoot } });
  const auth = publicMobileAuthStatus(path.join(runtime.secretsRoot, 'mobile-access.json'));
  if (!auth.configured) throw new Error('请先配置手机/iPad 登录，再开启 Tailscale 入口。');
  const command = dependencies.command || tailscalePath();
  if (!command) throw new Error('找不到 Tailscale 命令行，请先安装或更新 Tailscale。');
  await (dependencies.probeReady || probeReady)(options.webPort || DEFAULT_WEB_PORT);
  const plan = buildPlan(options);
  const spawn = dependencies.spawn || spawnSync;
  const result = spawn(command, plan.command.slice(1), { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Tailscale Serve 配置失败（退出码 ${result.status}）。`);
  return { ok: true, plan, status: readStatus(command, spawn) };
}

async function main() {
  const options = parseArguments();
  const plan = buildPlan(options);
  if (options.command === 'plan') {
    process.stdout.write(options.json ? `${JSON.stringify(plan, null, 2)}\n` : [
      'Tailscale 私有 HTTPS 入口计划（只读）',
      `目标：${plan.target}`,
      `命令：${plan.command.join(' ')}`,
      '不会开启 Funnel，也不会改动 Cloudflare。',
      '',
    ].join('\n'));
    return;
  }
  if (options.command === 'status') {
    const status = readStatus();
    process.stdout.write(options.json ? `${JSON.stringify(status, null, 2)}\n` : `${status.configured ? 'Tailscale Serve 已配置' : 'Tailscale Serve 未配置'}\n`);
    return;
  }
  if (options.command !== 'apply') throw new Error(`Unknown argument: ${options.command}`);
  const result = await applyTailscaleServe(options);
  process.stdout.write(`Tailscale 私有 HTTPS 已指向 ${result.plan.target}。请使用 tailscale serve status 查看 *.ts.net 地址。\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Tailscale Serve 配置失败：${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { applyTailscaleServe, buildPlan, parseArguments, probeReady, readStatus, tailscalePath };
