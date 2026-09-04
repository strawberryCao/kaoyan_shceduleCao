import assert from 'node:assert/strict';
import test from 'node:test';
import { questionDetectionInternals } from './ai.js';

test('Workers AI vision fallback requests non-streaming JSON question regions', async () => {
  let invocation = null;
  const result = await questionDetectionInternals.runWorkersAiQuestionDetection({
    AI: {
      async run(model, input) {
        invocation = { model, input };
        return {
          answer: '```json\n{"regions":[{"x":0.1,"y":0.2,"width":0.8,"height":0.4,"confidence":0.9}]}\n```',
          metrics: { tokens: 12 },
        };
      },
    },
  }, {
    image: 'data:image/png;base64,AQID',
    prompt: '只返回题目区域 JSON',
    maxTokens: 900,
    settings: {
      configurationHash: 'configuration-hash',
      workflowHash: 'workflow-hash',
    },
  });

  assert.equal(invocation.model, '@cf/moondream/moondream3.1-9B-A2B');
  assert.equal(invocation.input.task, 'query');
  assert.equal(invocation.input.stream, false);
  assert.equal(invocation.input.image, 'data:image/png;base64,AQID');
  assert.equal(result.provider, 'cloudflare-workers-ai');
  assert.equal(result.configurationHash, 'configuration-hash');
  assert.equal(result.json.regions.length, 1);
});

test('Workers AI fallback rejects an unparseable visual response', async () => {
  await assert.rejects(
    questionDetectionInternals.runWorkersAiQuestionDetection({
      AI: { run: async () => ({ answer: '没有结构化区域' }) },
    }, {
      image: 'data:image/png;base64,AQID',
      prompt: '只返回 JSON',
      maxTokens: 900,
      settings: { configurationHash: 'a', workflowHash: 'b' },
    }),
    (error) => error?.code === 'WORKERS_AI_JSON_INVALID',
  );
});
