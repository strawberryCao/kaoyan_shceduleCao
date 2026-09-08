#!/usr/bin/env node

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createPrompter } = require('./configure-macmini.cjs');
const {
  configureTunnel,
  disableTunnel,
  publicTunnelStatus,
  removeTunnel,
} = require('./cloudflare-tunnel-config.cjs');
const { resolveRuntimePaths } = require('./runtime-paths.cjs');

const DEFAULT_MAC_ROOT = '/Library/Application Support/KaoyanStudyCenter';

function parseArguments(argv = process.argv.slice(2)) {
  const result = { command: 'plan', runtimeRoot: '', hostname: '', webPort: 5173, json: false, yes: false };
  let commandSeen = false;
  for (const argument of argv) {
    if (!argument.startsWith('-') && !commandSeen) {
      result.command = argument;
      commandSeen = true;
    } else if (argument === '--json') result.json = true;
    else if (argument === '--yes') result.yes = true;
    else if (argument.startsWith('--runtime-root=')) result.runtimeRoot = path.resolve(argument.slice(15).trim());
    else if (argument.startsWith('--hostname=')) result.hostname = argument.slice(11).trim();
    else if (argument.startsWith('--web-port=')) result.webPort = Number(argument.slice(11));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function printStatus(status, json = false) {
  if (json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  if (!status.configured) {
    process.stdout.write('Cloudflare 备用入口尚未配置。\n');
    return;
  }
  process.stdout.write(`Cloudflare 备用入口：${status.enabled ? '已启用' : '已停用'}\n`);
  process.stdout.write(`域名：${status.hostname}\nOrigin：${status.serviceUrl}\nToken：${status.token}\n`);
}

function buildPlan(runtime, options = {}) {
  const current = publicTunnelStatus(runtime);
  return {
    mode: 'cloudflare-public-fallback',
    authoritativeServer: 'Mac mini',
    defaultClientPath: 'Tailscale',
    hostname: options.hostname || current.hostname || '由配置向导填写',
    origin: `http://127.0.0.1:${options.webPort || 5173}`,
    credentialStorage: current.tokenPath,
    tokenOnCommandLine: false,
    mutatesCloudflareAccount: false,
    requiresDashboardRoute: true,
    ordinaryReadWriteOnly: true,
    adminAndSecretPages: false,
  };
}

function cloudflaredVersion(command = 'cloudflared', spawn = spawnSync) {
  const result = spawn(command, ['version'], { encoding: 'utf8', windowsHide: true });
  return {
    available: !result.error && result.status === 0,
    detail: String(result.stdout || result.stderr || result.error?.message || '').trim(),
  };
}

async function runWizard(runtime, options = {}) {
  const current = publicTunnelStatus(runtime);
  const prompter = options.prompter || createPrompter();
  try {
    process.stdout.write('Cloudflare 备用入口配置\n它只转发到 Mac；Tailscale 仍是手机/iPad 默认入口。Token 不回显，也不会进入命令行或 Git。\n');
    const hostname = options.hostname || await prompter.text('备用访问域名', current.hostname || '');
    const token = await prompter.secret('Cloudflare Tunnel token', current.configured);
    if (!options.yes && !await prompter.confirm('保存并在 Mac 核心服务下次启动时启用备用入口', true)) {
      process.stdout.write('已取消；旧配置没有改变。\n');
      return { saved: false, status: current };
    }
    const status = configureTunnel(runtime, { hostname, token, webPort: options.webPort });
    process.stdout.write('备用入口配置已保存。请在 Cloudflare 控制台把 Published application 的 Service URL 设为同一回环地址。\n');
    return { saved: true, status };
  } finally {
    if (!options.prompter) prompter.close();
  }
}

async function main() {
  const options = parseArguments();
  const requestedRoot = options.runtimeRoot || (process.platform === 'darwin' ? DEFAULT_MAC_ROOT : '');
  const runtime = resolveRuntimePaths({ env: { ...process.env, ...(requestedRoot ? { KAOYAN_RUNTIME_ROOT: requestedRoot } : {}) } });
  if (options.command === 'plan') {
    const plan = buildPlan(runtime, options);
    process.stdout.write(options.json ? `${JSON.stringify(plan, null, 2)}\n` : [
      'Cloudflare 备用入口计划（只读）',
      `备用域名：${plan.hostname}`,
      `Mac Origin：${plan.origin}`,
      '默认访问仍为 Tailscale；不会在 Cloudflare 保存业务数据或 AI 密钥。',
      '本命令不会登录、创建 Tunnel、修改 DNS 或写入任何配置。',
      '',
    ].join('\n'));
    return;
  }
  if (options.command === 'status') {
    printStatus(publicTunnelStatus(runtime), options.json);
    return;
  }
  if (options.command === 'version') {
    const status = cloudflaredVersion();
    process.stdout.write(options.json ? `${JSON.stringify(status, null, 2)}\n` : `${status.available ? 'cloudflared 可用' : '找不到 cloudflared'}${status.detail ? `：${status.detail}` : ''}\n`);
    if (!status.available) process.exitCode = 1;
    return;
  }
  if (options.command === 'disable') {
    disableTunnel(runtime);
    process.stdout.write('Cloudflare 备用入口已停用；Token 与数据均保留。重启 Mac 核心服务后生效。\n');
    return;
  }
  if (options.command === 'remove') {
    const prompter = createPrompter();
    try {
      if (!options.yes && !await prompter.confirm('删除本机 Cloudflare Tunnel token 和入口配置', false)) {
        process.stdout.write('已取消。\n');
        return;
      }
    } finally { prompter.close(); }
    removeTunnel(runtime);
    process.stdout.write('本机 Cloudflare 入口配置已删除；Cloudflare 账户和 DNS 未被修改。\n');
    return;
  }
  if (!['configure', 'rotate'].includes(options.command)) throw new Error(`Unknown command: ${options.command}`);
  await runWizard(runtime, options);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Cloudflare 备用入口配置失败：${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildPlan, cloudflaredVersion, parseArguments, printStatus, runWizard };
