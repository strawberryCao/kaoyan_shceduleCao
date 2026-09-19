const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseArguments: parseConfigurationArguments, runWizard } = require('../configure-macmini.cjs');
const { emptyAiConfig, readAiConfig, upsertProvider, writeAiConfig } = require('../secure-ai-config.cjs');
const { resolveRuntimePaths } = require('../runtime-paths.cjs');
const { buildSetupPlan, parseArguments, stableNodePath } = require('../setup-macmini.cjs');

test('setup is read-only by default and keeps secret input out of argv', () => {
  const options = parseArguments([]);
  assert.equal(options.command, 'plan');
  const plan = buildSetupPlan(options, { USER: 'study' });
  assert.equal(plan.productionDataMigration, false);
  assert.equal(plan.cloudflareDeployment, false);
  assert.equal(plan.networkBinding, '127.0.0.1');
  assert.equal(plan.steps.find((step) => step.id === 'configure-ai').secretInput, 'interactive-hidden-only');
  assert.equal(plan.steps.find((step) => step.id === 'configure-mobile-access').secretInput, 'interactive-hidden-only');
  assert.equal(plan.steps.find((step) => step.id === 'configure-tailscale-serve').mutatesProduction, true);
  assert.equal(plan.steps.find((step) => step.id === 'configure-cloudflare-fallback').secretInput, 'interactive-hidden-only');
  assert.equal(plan.steps.find((step) => step.id === 'configure-cloudflare-fallback').cloudflareAccountMutation, false);
  assert.equal(plan.steps.find((step) => step.id === 'install-menu-bar-manager').coreServiceDependency, false);
  assert.equal(plan.steps.find((step) => step.id === 'reload-launchdaemon-after-configuration').command, 'sudo');
  assert.doesNotMatch(JSON.stringify(plan), /api[-_]?key=/i);
  assert.deepEqual(plan.steps.slice(0, 4).map((step) => step.id), ['cloudflared-cli', 'offline-tests', 'type-check', 'production-build']);
  assert.equal(plan.steps[4].id, 'runtime-smoke');
  assert.equal(plan.steps.findIndex((step) => step.id === 'cloudflared-cli') < plan.steps.findIndex((step) => step.id === 'install-launchdaemon'), true);
  assert.match(plan.steps.find((step) => step.id === 'doctor').args.join(' '), /--note-port=5174/);
});

test('setup verification can only be skipped explicitly and unknown flags fail closed', () => {
  const plan = buildSetupPlan(parseArguments(['install', '--skip-verify']), { USER: 'study' });
  assert.equal(plan.steps.some((step) => step.id === 'offline-tests'), false);
  assert.throws(() => parseArguments(['install', '--api-key=leak']), /Unknown argument/);
});

test('Tailscale-only setup explicitly omits every Cloudflare prerequisite and mutation', () => {
  const options = parseArguments(['install', '--skip-cloudflare']);
  const plan = buildSetupPlan(options, { USER: 'study' });
  assert.equal(options.skipCloudflare, true);
  assert.equal(plan.tailscaleOnly, true);
  assert.equal(plan.cloudflareFallbackLocalConfiguration, false);
  assert.equal(plan.steps.some((step) => step.id === 'cloudflared-cli'), false);
  assert.equal(plan.steps.some((step) => step.id === 'configure-cloudflare-fallback'), false);
  assert.equal(plan.steps.some((step) => step.id === 'configure-tailscale-serve'), true);
  assert.equal(plan.steps.some((step) => step.id === 'install-launchdaemon'), true);
  assert.equal(plan.steps.some((step) => step.id === 'reload-launchdaemon-after-configuration'), true);
  assert.doesNotMatch(JSON.stringify(plan), /tunnel token/i);
});

test('setup can pin an explicitly selected stable Node launcher without putting secrets in arguments', () => {
  assert.equal(stableNodePath({ KAOYAN_NODE_PATH: '/opt/homebrew/bin/node' }, {
    existsSync(candidate) { return candidate === '/opt/homebrew/bin/node'; },
  }), '/opt/homebrew/bin/node');
});

test('configuration CLI accepts provider selection but never accepts a key argument', () => {
  assert.deepEqual(parseConfigurationArguments(['rotate', '--provider=qwen', '--live']), {
    command: 'rotate',
    runtimeRoot: '',
    provider: 'qwen',
    json: false,
    yes: false,
    live: true,
  });
  assert.throws(() => parseConfigurationArguments(['configure', '--api-key=leak']), /Unknown argument/);
});

test('configuration wizard writes a selected provider only after validation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-wizard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = resolveRuntimePaths({ env: { KAOYAN_RUNTIME_ROOT: root } });
  const result = await runWizard(runtime, emptyAiConfig(), {
    provider: 'qwen',
    yes: true,
    live: false,
    prompter: {
      async secret() { return 'sk-1234567890abcdef'; },
      async text() { throw new Error('Qwen should use built-in endpoint and models'); },
      async confirm() { throw new Error('non-interactive wizard must not prompt for confirmation'); },
    },
  });
  assert.equal(result.saved, true);
  assert.deepEqual(result.configured, ['qwen']);
  const stored = readAiConfig(runtime.aiConfigPath);
  assert.equal(stored.providers.qwen.apiKey, 'sk-1234567890abcdef');
  assert.equal(stored.providers.qwen.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.deepEqual(stored.providers.qwen.models.map((model) => model.id), ['qwen3-vl-plus']);
});

test('Gemini only asks for the provider endpoint and otherwise uses built-in models', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-wizard-gemini-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = resolveRuntimePaths({ env: { KAOYAN_RUNTIME_ROOT: root } });
  const textPrompts = [];
  const result = await runWizard(runtime, emptyAiConfig(), {
    provider: 'gemini',
    yes: true,
    live: false,
    prompter: {
      async secret() { return 'sk-gemini-1234567890'; },
      async text(label) {
        textPrompts.push(label);
        return 'https://gemini-relay.example/v1';
      },
      async confirm() { throw new Error('non-interactive wizard must not prompt for confirmation'); },
    },
  });
  assert.equal(result.saved, true);
  assert.deepEqual(textPrompts, ['Gemini 服务提供地址']);
  const stored = readAiConfig(runtime.aiConfigPath);
  assert.equal(stored.providers.gemini.baseUrl, 'https://gemini-relay.example/v1');
  assert.deepEqual(stored.providers.gemini.models.map((model) => model.id), ['gemini-3.5-flash']);
});

test('failed live validation leaves the previous secret configuration untouched', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-wizard-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = resolveRuntimePaths({ env: { KAOYAN_RUNTIME_ROOT: root } });
  const original = upsertProvider(emptyAiConfig(), {
    id: 'qwen',
    apiKey: 'sk-original-1234567890',
    models: 'qwen3-vl-plus',
  });
  writeAiConfig(runtime, original);
  let candidatePath = '';
  const result = await runWizard(runtime, original, {
    provider: 'qwen',
    yes: true,
    live: true,
    prompter: {
      async secret() { return 'sk-replacement-0987654321'; },
      async text() { throw new Error('Qwen should use built-in endpoint and models'); },
      async confirm() { throw new Error('non-interactive wizard must not prompt for confirmation'); },
    },
    liveTester(_runtime, _provider, options) {
      candidatePath = options.configPath;
      assert.notEqual(candidatePath, runtime.aiConfigPath);
      assert.equal(readAiConfig(candidatePath).providers.qwen.apiKey, 'sk-replacement-0987654321');
      return 1;
    },
  });
  assert.equal(result.validationFailed, true);
  assert.equal(result.saved, false);
  assert.equal(readAiConfig(runtime.aiConfigPath).providers.qwen.apiKey, 'sk-original-1234567890');
  assert.equal(fs.existsSync(candidatePath), false);
});
