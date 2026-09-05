#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { atomicWriteJson, withoutLegacyAiProviderEnvironment } = require('./runtime-paths.cjs');
const {
  PROVIDER_DEFINITIONS,
  assertProviderId,
  loadRuntimeAndConfig,
  providerStatus,
  removeProvider,
  upsertProvider,
  writeAiConfig,
} = require('./secure-ai-config.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SYSTEM_MAC_RUNTIME_ROOT = '/Library/Application Support/KaoyanStudyCenter';

function parseArguments(argv = process.argv.slice(2)) {
  const result = { command: 'wizard', runtimeRoot: '', provider: '', json: false, yes: false, live: false };
  let commandSeen = false;
  for (const argument of argv) {
    if (!argument.startsWith('-') && !commandSeen) {
      result.command = argument;
      commandSeen = true;
    } else if (argument === '--json') result.json = true;
    else if (argument === '--yes') result.yes = true;
    else if (argument === '--live') result.live = true;
    else if (argument.startsWith('--runtime-root=')) result.runtimeRoot = path.resolve(argument.slice(15).trim());
    else if (argument.startsWith('--provider=')) result.provider = assertProviderId(argument.slice(11));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function createPrompter(input = process.stdin, output = process.stdout) {
  let muted = false;
  const safeOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  const interface_ = readline.createInterface({ input, output: safeOutput, terminal: Boolean(input.isTTY && output.isTTY) });
  return {
    async text(label, defaultValue = '') {
      const suffix = defaultValue ? ` [${defaultValue}]` : '';
      const answer = String(await interface_.question(`${label}${suffix}: `)).trim();
      return answer || defaultValue;
    },
    async secret(label, keepExisting = false) {
      output.write(`${label}${keepExisting ? ' [回车保留现有密钥]' : ''}: `);
      muted = true;
      let answer;
      try {
        answer = String(await interface_.question('')).trim();
      } finally {
        muted = false;
        output.write('\n');
      }
      return answer;
    },
    async confirm(label, defaultYes = true) {
      const answer = String(await interface_.question(`${label} ${defaultYes ? '[Y/n]' : '[y/N]'}: `)).trim().toLowerCase();
      if (!answer) return defaultYes;
      return ['y', 'yes', '是'].includes(answer);
    },
    close() {
      interface_.close();
    },
  };
}

async function configureProvider(config, id, prompter) {
  const definition = PROVIDER_DEFINITIONS[id];
  const previous = config.providers?.[id] || {};
  const existingModels = Array.isArray(previous.models)
    ? previous.models.map((model) => typeof model === 'string' ? model : model?.id).filter(Boolean).join(',')
    : '';
  process.stdout.write(`\n配置 ${definition.label}\n`);
  const apiKey = await prompter.secret('API Key', Boolean(previous.apiKey));
  const baseUrl = await prompter.text('API Base URL', previous.baseUrl || definition.baseUrl);
  const models = await prompter.text('模型 ID；多个用英文逗号分隔', existingModels || definition.model);
  return upsertProvider(config, {
    id,
    apiKey: apiKey || previous.apiKey,
    baseUrl,
    models,
    enabled: true,
  });
}

function printStatus(runtimePaths, config, asJson = false) {
  const value = { configPath: runtimePaths.aiConfigPath, providers: providerStatus(config) };
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`配置文件：${runtimePaths.aiConfigPath}\n`);
  for (const provider of value.providers) {
    process.stdout.write(`${provider.configured ? 'OK  ' : '--  '} ${provider.label}: ${provider.apiKey}; ${provider.models.join(', ') || '无模型'}\n`);
  }
}

function runLiveTest(runtimePaths, providerId, options = {}) {
  const result = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'test-ai-provider.cjs')], {
    cwd: PROJECT_ROOT,
    env: {
      ...withoutLegacyAiProviderEnvironment(process.env),
      KAOYAN_RUNTIME_ROOT: runtimePaths.runtimeRoot,
      KAOYAN_ASSISTANT_ROOT: runtimePaths.assistantRoot,
      KAOYAN_AI_CONFIG_PATH: options.configPath || runtimePaths.aiConfigPath,
      KAOYAN_AI_PROVIDER: providerId,
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function runWizard(runtimePaths, initialConfig, options = {}) {
  const prompter = options.prompter || createPrompter();
  const liveTester = options.liveTester || runLiveTest;
  let config = initialConfig;
  const configured = [];
  try {
    process.stdout.write('Mac mini AI 配置向导\n密钥不会回显，也不会写入 Git、浏览器或命令行参数。\n');
    for (const id of Object.keys(PROVIDER_DEFINITIONS)) {
      const current = Boolean(config.providers?.[id]?.apiKey);
      const enable = options.provider === id
        || (!options.provider && await prompter.confirm(`${PROVIDER_DEFINITIONS[id].label}${current ? ' 已配置，是否检查/更新' : ' 是否启用'}`, current));
      if (!enable) continue;
      config = await configureProvider(config, id, prompter);
      configured.push(id);
      if (options.provider) break;
    }
    if (configured.length === 0) {
      process.stdout.write('没有修改任何提供商。\n');
      return { config: initialConfig, configured: [], saved: false };
    }
    if (!options.yes && !await prompter.confirm('保存以上配置', true)) {
      process.stdout.write('已取消；磁盘上的旧配置未改变。\n');
      return { config: initialConfig, configured: [], saved: false };
    }
    const shouldTest = options.live || (!options.yes && await prompter.confirm('是否执行最小真实 API 请求验证（可能产生少量费用）', false));
    if (shouldTest) {
      const validationPath = path.join(runtimePaths.secretsRoot, `.ai-provider-validation-${process.pid}-${crypto.randomUUID()}.json`);
      atomicWriteJson(validationPath, config);
      let validationFailed = false;
      try {
        for (const id of configured) {
          if (liveTester(runtimePaths, id, { configPath: validationPath }) !== 0) {
            validationFailed = true;
            break;
          }
        }
      } finally {
        fs.rmSync(validationPath, { force: true });
      }
      if (validationFailed) {
        process.stderr.write('连通性验证失败；磁盘上的旧配置保持不变。\n');
        return { config: initialConfig, configured, saved: false, validationFailed: true };
      }
    }
    writeAiConfig(runtimePaths, config);
    process.stdout.write(`配置已安全写入：${runtimePaths.aiConfigPath}\n`);
    return { config, configured, saved: true };
  } finally {
    if (!options.prompter) prompter.close();
  }
}

async function main() {
  const arguments_ = parseArguments();
  const defaultRuntimeRoot = process.platform === 'darwin' ? SYSTEM_MAC_RUNTIME_ROOT : undefined;
  const { runtimePaths, config } = loadRuntimeAndConfig({ runtimeRoot: arguments_.runtimeRoot || defaultRuntimeRoot });
  if (arguments_.command === 'status') {
    printStatus(runtimePaths, config, arguments_.json);
    return;
  }
  if (arguments_.command === 'test') {
    if (!arguments_.provider) throw new Error('test requires --provider=qwen|gemini|kimi|deepseek.');
    if (!arguments_.live) throw new Error('Live API validation requires the explicit --live flag because it may consume quota.');
    process.exitCode = runLiveTest(runtimePaths, arguments_.provider);
    return;
  }
  if (arguments_.command === 'remove') {
    if (!arguments_.provider) throw new Error('remove requires --provider=qwen|gemini|kimi|deepseek.');
    const prompter = createPrompter();
    try {
      if (!arguments_.yes && !await prompter.confirm(`删除 ${arguments_.provider} 的本地密钥配置`, false)) {
        process.stdout.write('已取消。\n');
        return;
      }
    } finally {
      prompter.close();
    }
    writeAiConfig(runtimePaths, removeProvider(config, arguments_.provider));
    process.stdout.write(`${arguments_.provider} 已从 Mac 配置中删除。\n`);
    return;
  }
  if (!['wizard', 'configure', 'rotate'].includes(arguments_.command)) throw new Error(`Unknown command: ${arguments_.command}`);
  if (arguments_.command === 'rotate' && !arguments_.provider) throw new Error('rotate requires --provider=.');
  const result = await runWizard(runtimePaths, config, arguments_);
  if (result.validationFailed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Mac mini configuration error: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  configureProvider,
  createPrompter,
  parseArguments,
  printStatus,
  runLiveTest,
  runWizard,
};
