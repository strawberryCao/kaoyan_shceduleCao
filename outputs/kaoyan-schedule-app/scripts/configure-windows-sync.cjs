#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPrompter } = require('./configure-macmini.cjs');
const { provisionRuntimeLayout, resolveRuntimePaths } = require('./runtime-paths.cjs');
const { createSyncClient } = require('./sync-client.cjs');
const { createWindowsReplicaStore } = require('./windows-replica-store.cjs');
const { publicWindowsSyncStatus, writeWindowsSyncConfig } = require('./windows-sync-config.cjs');

function parseArguments(argv = process.argv.slice(2)) {
  const result = { command: argv[0] || 'wizard', runtimeRoot: '', yes: false, live: false };
  for (const argument of argv.slice(1)) {
    if (argument === '--yes') result.yes = true;
    else if (argument === '--live') result.live = true;
    else if (argument.startsWith('--runtime-root=')) result.runtimeRoot = path.resolve(argument.slice('--runtime-root='.length).trim());
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

async function verifyCandidate(runtimePaths, candidate) {
  const validationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-windows-sync-validation-'));
  const replica = createWindowsReplicaStore({
    databasePath: path.join(validationRoot, 'windows-replica-validation.sqlite'),
    assetsRoot: path.join(validationRoot, 'assets'),
    deviceId: candidate.deviceId,
  });
  try {
    const client = createSyncClient({ replica, baseUrl: candidate.baseUrl, token: candidate.token });
    return await client.syncOnce();
  } finally {
    replica.close();
    fs.rmSync(validationRoot, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  const arguments_ = parseArguments(argv);
  const env = { ...process.env, KAOYAN_RUNTIME_LAYOUT: 'managed' };
  if (arguments_.runtimeRoot) env.KAOYAN_RUNTIME_ROOT = arguments_.runtimeRoot;
  const runtime = resolveRuntimePaths({ env, platform: 'win32' });
  if (arguments_.command === 'status') {
    process.stdout.write(`${JSON.stringify(publicWindowsSyncStatus(runtime), null, 2)}\n`);
    return;
  }
  if (arguments_.command !== 'wizard') throw new Error(`Unknown command: ${arguments_.command}`);
  provisionRuntimeLayout(runtime);
  const previous = publicWindowsSyncStatus(runtime);
  const prompter = createPrompter();
  try {
    process.stdout.write('Windows 到 Mac mini 同步配置\n令牌不会回显，也不会写入 Git、浏览器或命令行参数。\n');
    const deviceId = await prompter.text('设备 ID', previous.deviceId || 'windows-main');
    const baseUrl = await prompter.text('Mac 的 Tailscale HTTPS 地址', previous.baseUrl || 'https://macmini.example.ts.net');
    const token = await prompter.secret('Mac 生成的一次性设备令牌');
    if (!token) throw new Error('未填写设备令牌；原配置保持不变。');
    const candidate = { deviceId, baseUrl, token };
    const live = arguments_.live || (!arguments_.yes && await prompter.confirm('现在只做连通性验证', true));
    if (live) await verifyCandidate(runtime, candidate);
    if (!arguments_.yes && !await prompter.confirm('验证通过，保存 Windows 同步配置', true)) return;
    const saved = writeWindowsSyncConfig(runtime, candidate);
    process.stdout.write(`同步配置已保存：${saved.paths.configPath}\n`);
  } finally {
    prompter.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Windows sync configuration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArguments, verifyCandidate };
