import assert from 'node:assert/strict';
import test from 'node:test';
import { agentProviderInternals } from './agent-provider.js';
import { agentRuntimeInternals } from './agent-runtime.js';
import { questionDetectionInternals } from './ai.js';
import { renameWorkflowInternals } from './rename-job.js';

function runtimeFixture() {
  return {
    providers: {
      qwen: {
        id: 'qwen',
        enabled: true,
        baseUrl: 'https://dashscope.example/v1',
        secretRef: 'QWEN_API_KEY',
        cloudUsable: true,
        priority: 10,
        models: [{
          id: 'qwen3-vl-plus',
          capabilities: ['text', 'vision', 'json'],
          costTier: 1,
          qualityTier: 2,
        }],
      },
      kimi: {
        id: 'kimi',
        enabled: true,
        baseUrl: 'https://api.moonshot.cn/v1',
        secretRef: 'KIMI_API_KEY',
        cloudUsable: true,
        models: [{
          id: 'kimi-k3',
          capabilities: ['text', 'vision', 'json', 'reasoning'],
          costTier: 2,
          qualityTier: 3,
        }],
      },
    },
  };
}

function taskFixture(settings = {}) {
  return {
    id: 'note_naming',
    active: true,
    profile: { difficulty: 'low', capabilities: ['text', 'vision', 'json'] },
    settings,
  };
}

test('strict provider routing rejects a locally selected provider when its Cloudflare Secret is missing', () => {
  assert.throws(() => agentProviderInternals.routeCandidates(
    {},
    runtimeFixture(),
    taskFixture({ providerId: 'qwen', modelId: 'qwen3-vl-plus', fallback: false }),
    { imageDataUrl: 'data:image/png;base64,AQID', json: true },
  ), (error) => error?.code === 'PROVIDER_SECRET_MISSING' && /QWEN_API_KEY/.test(error.message));
});

test('strict provider routing prioritizes the exact local provider and model selection', () => {
  const route = agentProviderInternals.routeCandidates(
    { QWEN_API_KEY: 'qwen-secret', KIMI_API_KEY: 'kimi-secret' },
    runtimeFixture(),
    taskFixture({ providerId: 'qwen', modelId: 'qwen3-vl-plus', fallback: true }),
    { imageDataUrl: 'data:image/png;base64,AQID', json: true },
  );
  assert.equal(route.candidates[0].providerId, 'qwen');
  assert.equal(route.candidates[0].model.id, 'qwen3-vl-plus');
});

test('local catalog models are materialized only when a task explicitly selects them', () => {
  const normalized = agentRuntimeInternals.normalizeProvider('qwen', {
    models: [{ id: 'qwen-vl-plus' }],
    catalog: ['qwen3-vl-plus', 'qwen-max'],
  }, new Set(['qwen3-vl-plus']));
  assert.deepEqual(normalized.models.map((model) => model.id), ['qwen-vl-plus', 'qwen3-vl-plus']);
  assert.ok(normalized.models.every((model) => model.capabilities.includes('json')));
  assert.ok(normalized.models.find((model) => model.id === 'qwen3-vl-plus').capabilities.includes('vision'));
});

test('Cloudflare naming prompt retains the local Windows filename workflow and user constraints', () => {
  const prompt = renameWorkflowInternals.namingPrompt({
    workflow: {
      version: 'test-note-naming-v1',
      steps: ['读取局域网配置', '调用命名模型', '校验文件名'],
      prompt: {
        instructions: [
          '你是考研学习笔记整理助手。请生成适合 Windows 文件名的中文标题。',
          'title 目标长度为 {titleMinLength} 到 {titleMaxLength} 个字符。',
          '用户备注：{remark}',
          '字段命名规则：{namingRules}',
        ],
        outputFormat: '只输出 JSON 对象。',
      },
    },
    customInstructions: '标题必须突出考点，不要出现英文句子。',
    namingRules: [{ id: 'rule-1', name: '题号', enabled: true, when: '有题号', extract: '读取题号', titleTemplate: '{value}' }],
    options: { titleMinLength: 8, titleMaxLength: 20, useRemark: true, preferSpecificSubject: true, rejectGenericTitle: true },
  }, '第一次做错是因为忽略定义域');
  assert.match(prompt, /适合 Windows 文件名的中文标题/);
  assert.match(prompt, /第一次做错是因为忽略定义域/);
  assert.match(prompt, /标题必须突出考点/);
  assert.match(prompt, /rule-1/);
  assert.match(prompt, /8 到 20 个字符/);
});

test('multi-question prompt is constrained by local task options and emits normalized boxes', () => {
  const prompt = questionDetectionInternals.splittingPrompt({
    workflow: {
      version: 'test-question-splitting-v1',
      steps: ['读取局域网配置', '识别区域', '规范化坐标'],
      prompt: {
        instructions: [
          '最多返回 {maxQuestions} 个区域。',
          'x、y、width、height 使用 0 到 1 的归一化坐标。',
        ],
        outputFormat: '只返回 JSON 对象。',
      },
    },
    customInstructions: '不要裁掉题目前的例题编号。',
    options: { maxQuestions: 12, includeQuestionNumber: true, includeOptions: true, includeDiagram: true },
  }, 1200, 1600);
  assert.match(prompt, /最多返回 12 个区域/);
  assert.match(prompt, /不要裁掉题目前的例题编号/);
  assert.match(prompt, /0 到 1 的归一化坐标/);

  const regions = questionDetectionInternals.normalizeRegions({
    regions: [{ x: 0.1, y: 0.2, width: 0.6, height: 0.3 }],
  }, 1200, 1600, { options: { maxQuestions: 12, minimumRegionPercent: 3.5, edgePaddingPercent: 0 } });
  assert.equal(regions.length, 1);
  assert.equal(regions[0].x, 0.1);
});

test('workflow contract is required for public naming and splitting tasks', () => {
  const workflow = { version: 'v1', steps: ['route'], prompt: { instructions: ['instruction'], outputFormat: 'JSON' } };
  const normalized = agentRuntimeInternals.normalizeWorkflow('question_splitting', workflow);
  assert.equal(normalized.version, 'v1');
  assert.equal(normalized.prompt.outputFormat, 'JSON');
});
