#!/usr/bin/env node

const path = require('node:path');
const { createPrompter } = require('./configure-macmini.cjs');
const { resolveRuntimePaths } = require('./runtime-paths.cjs');
const {
  configureMobileAccess,
  publicMobileAuthStatus,
  removeMobileAccess,
} = require('./mobile-session-auth.cjs');

const DEFAULT_MAC_ROOT = '/Library/Application Support/KaoyanStudyCenter';

function parseArguments(argv = process.argv.slice(2)) {
  const result = { command: 'wizard', runtimeRoot: '', json: false, yes: false };
  let commandSeen = false;
  for (const argument of argv) {
    if (!argument.startsWith('-') && !commandSeen) {
      result.command = argument;
      commandSeen = true;
    } else if (argument === '--json') result.json = true;
    else if (argument === '--yes') result.yes = true;
    else if (argument.startsWith('--runtime-root=')) result.runtimeRoot = path.resolve(argument.slice(15).trim());
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function configPathFor(runtime) {
  return path.join(runtime.secretsRoot, 'mobile-access.json');
}

function printStatus(status, configPath, json = false) {
  const output = { ...status, configPath };
  if (json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else if (!status.configured) process.stdout.write(`移动访问尚未配置。配置位置：${configPath}\n`);
  else process.stdout.write(`移动访问已配置：${status.username}；会话 ${status.sessionTtlDays} 天；配置代次 ${status.generation}\n`);
}

async function runWizard(runtime, options = {}) {
  const configPath = configPathFor(runtime);
  const current = publicMobileAuthStatus(configPath);
  const prompter = options.prompter || createPrompter();
  try {
    process.stdout.write('Mac mini 手机/iPad 访问配置\n密码不会回显，也不会写入 Git、浏览器存储或命令行参数。\n');
    const username = await prompter.text('登录用户名', current.username || 'caobiji');
    const password = await prompter.secret('访问密码');
    const confirmation = await prompter.secret('再次输入访问密码');
    if (password !== confirmation) throw new Error('两次输入的密码不一致。');
    if (!options.yes && !await prompter.confirm('保存配置并让旧会话全部失效', true)) {
      process.stdout.write('已取消；旧配置没有改变。\n');
      return { saved: false, status: current };
    }
    const status = configureMobileAccess(configPath, { username, password });
    process.stdout.write('配置已写入 Mac 私有 secrets 目录；旧手机会话已失效。\n');
    return { saved: true, status };
  } finally {
    if (!options.prompter) prompter.close();
  }
}

async function main() {
  const args = parseArguments();
  const requestedRoot = args.runtimeRoot || (process.platform === 'darwin' ? DEFAULT_MAC_ROOT : '');
  const runtime = resolveRuntimePaths({ env: { ...process.env, ...(requestedRoot ? { KAOYAN_RUNTIME_ROOT: requestedRoot } : {}) } });
  const configPath = configPathFor(runtime);
  if (args.command === 'status') {
    printStatus(publicMobileAuthStatus(configPath), configPath, args.json);
    return;
  }
  if (args.command === 'remove') {
    const prompter = createPrompter();
    try {
      if (!args.yes && !await prompter.confirm('删除移动访问配置并使全部会话失效', false)) {
        process.stdout.write('已取消。\n');
        return;
      }
    } finally { prompter.close(); }
    removeMobileAccess(configPath);
    process.stdout.write('移动访问已停用；数据目录未删除。\n');
    return;
  }
  if (!['wizard', 'configure', 'rotate'].includes(args.command)) throw new Error(`Unknown command: ${args.command}`);
  await runWizard(runtime, args);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`移动访问配置失败：${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { configPathFor, parseArguments, printStatus, runWizard };
