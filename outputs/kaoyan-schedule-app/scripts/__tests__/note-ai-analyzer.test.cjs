const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ANALYZER_VERSION,
  analyzeNote,
  compactTaxonomy,
  createNoteAiAnalyzer,
  detectStrongIntentHints,
} = require('../note-ai-analyzer.cjs');
const { parseRemark } = require('../remark-parser.cjs');

function makeImageFixture(t, extension = '.png') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-ai-analyzer-'));
  const imagePath = path.join(root, `note${extension}`);
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return imagePath;
}

function baseAiResult(overrides = {}) {
  return {
    subject: '高等数学',
    knowledgePoint: '函数极限',
    aliases: {
      subject: ['高数'],
      knowledgePoint: ['极限'],
    },
    title: '函数极限定义错题',
    summary: '判断函数极限时应先明确趋近过程和定义域。',
    tags: ['函数极限'],
    wrongReason: null,
    intent: {
      isQuestion: true,
      isMistake: false,
      shouldMemorize: false,
    },
    items: [],
    cards: [],
    confidence: 0.94,
    reason: '图片包含函数极限题目，备注提供页码和题号。',
    ...overrides,
  };
}

function makeContext(imagePath, overrides = {}) {
  return {
    imagePath,
    metadata: {
      kind: 'single',
      title: '待整理',
      remark: '',
      ...overrides.metadata,
    },
    currentCategory: {
      subject: '默认文件夹',
      knowledgePoint: null,
      ...overrides.currentCategory,
    },
    taxonomy: overrides.taxonomy || {
      revision: 3,
      subjects: [
        {
          name: '高等数学',
          aliases: ['高数'],
          knowledgePoints: [{ name: '函数极限', aliases: ['极限'] }],
        },
        { name: '线性代数', aliases: ['线代'], knowledgePoints: [] },
      ],
    },
  };
}

test('exports the organizer-compatible analyzeNote entry point and analyzer version', () => {
  assert.equal(typeof analyzeNote, 'function');
  assert.equal(analyzeNote.analyzerVersion, ANALYZER_VERSION);
});

test('factory reuses createAiRouter with a mocked fetch and no real network', async (t) => {
  const imagePath = makeImageFixture(t);
  let fetchCalls = 0;
  const analyzer = createNoteAiAnalyzer({
    routerOptions: {
      config: {
        providers: [{
          id: 'qwen',
          apiKey: 'mock-secret',
          baseUrl: 'https://mock-provider.invalid/v1',
          models: [{
            id: 'mock-vision',
            capabilities: ['text', 'vision', 'json'],
            costTier: 1,
            qualityTier: 2,
          }],
        }],
        routing: { networkRetries: 0, jsonRepairRetries: 0 },
      },
      fetchImpl: async (_url, init) => {
        fetchCalls += 1;
        assert.match(init.headers.Authorization, /^Bearer /);
        return {
          ok: true,
          status: 200,
          async json() {
            return { choices: [{ message: { content: JSON.stringify(baseAiResult()) } }] };
          },
        };
      },
    },
  });

  const result = await analyzer(makeContext(imagePath));
  assert.equal(fetchCalls, 1);
  assert.equal(result.provider, 'qwen');
  assert.equal(result.model, 'mock-vision');
});

test('sends image, local parsing, current category and compact taxonomy through the router', async (t) => {
  const imagePath = makeImageFixture(t);
  let capturedRequest;
  const router = {
    async complete(request) {
      capturedRequest = request;
      return {
        json: baseAiResult({
          wrongReason: '没有检查定义域',
          cards: [{ front: '极限存在前先检查什么？', back: '检查函数定义域。', kind: 'qa', itemIndex: null }],
        }),
        provider: 'gemini',
        model: 'gemini-test-model',
      };
    },
  };
  const analyzer = createNoteAiAnalyzer({ router });
  const result = await analyzer(makeContext(imagePath, {
    metadata: {
      remark: 'p108 3.1题 #错题 要背 错因：没有检查定义域',
    },
  }));

  assert.equal(capturedRequest.task, 'note_enrichment');
  assert.equal(capturedRequest.difficulty, 'medium');
  assert.ok(capturedRequest.responseSchema);
  const content = capturedRequest.messages[0].content;
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
  assert.match(content[0].text, /p108 3\.1题/);
  assert.match(content[0].text, /"pages":\[108\]/);
  assert.match(content[0].text, /"questions":\["3\.1"\]/);
  assert.match(content[0].text, /"currentCategory":\{"subject":"默认文件夹"/);
  assert.match(content[0].text, /"name":"函数极限"/);

  assert.equal(result.provider, 'gemini');
  assert.equal(result.model, 'gemini-test-model');
  assert.deepEqual(result.subjectAliases, ['高数']);
  assert.deepEqual(result.knowledgePointAliases, ['极限']);
  assert.equal(result.intent.isMistake, true);
  assert.equal(result.intent.shouldMemorize, true);
  assert.ok(result.tags.includes('错题'));
  assert.ok(result.tags.includes('背诵'));
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].status, 'draft');
  assert.equal(result.cards[0].sourceKey, 'ai:root:0');
});

test('does not create cards for an ordinary note without mistake or memory intent', async (t) => {
  const imagePath = makeImageFixture(t);
  const analyzer = createNoteAiAnalyzer({
    router: {
      async complete() {
        return {
          json: baseAiResult({
            title: '普通参考例题',
            tags: ['例题'],
            cards: [{ front: '不应保留', back: '不应保留', kind: 'qa', itemIndex: null }],
          }),
          provider: 'qwen',
          model: 'qwen-test',
        };
      },
    },
  });

  const result = await analyzer(makeContext(imagePath, {
    metadata: { remark: '普通例题，暂时留作参考。' },
  }));
  assert.deepEqual(result.cards, []);
  assert.equal(result.intent.isMistake, false);
  assert.equal(result.intent.shouldMemorize, false);
});

test('semantic AI memory intent can create a draft card without fixed memory words', async (t) => {
  const imagePath = makeImageFixture(t);
  const analyzer = createNoteAiAnalyzer({
    router: {
      async complete() {
        return {
          json: baseAiResult({
            intent: { isQuestion: false, isMistake: false, shouldMemorize: true },
            cards: [{ front: '极限定义中的量词顺序是什么？', back: '先任意给定 ε，再存在 δ。', kind: 'memory', itemIndex: null }],
          }),
          provider: 'kimi',
          model: 'kimi-test',
        };
      },
    },
  });

  const result = await analyzer(makeContext(imagePath, {
    metadata: { remark: '这个结论之后的证明会反复用到。' },
  }));
  assert.equal(result.intent.shouldMemorize, true);
  assert.ok(result.tags.includes('背诵'));
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].status, 'draft');
});

test('standalone 记/背 language is treated as a strong hint without matching 笔记', () => {
  const remember = detectStrongIntentHints('p20 这一条 记', parseRemark('p20 这一条 记'));
  const noteWord = detectStrongIntentHints('这是一条普通笔记', parseRemark('这是一条普通笔记'));
  const memorize = detectStrongIntentHints('这个结论要背', parseRemark('这个结论要背'));
  assert.equal(remember.shouldMemorize, true);
  assert.equal(memorize.shouldMemorize, true);
  assert.equal(noteWord.shouldMemorize, false);
});

test('canvas analysis preserves multiple items and only their intent-backed draft cards', async (t) => {
  const imagePath = makeImageFixture(t, '.webp');
  let capturedRequest;
  const analyzer = createNoteAiAnalyzer({
    router: {
      async complete(request) {
        capturedRequest = request;
        return {
          json: baseAiResult({
            knowledgePoint: '微分学综合',
            intent: { isQuestion: true, isMistake: false, shouldMemorize: false },
            tags: [],
            items: [
              {
                title: '洛必达法则错题',
                knowledgePoint: '洛必达法则',
                summary: '忽略了适用条件。',
                tags: ['错题'],
                wrongReason: '没有检查未定式类型',
                intent: { isQuestion: true, isMistake: true, shouldMemorize: false },
              },
              {
                title: '泰勒公式条件',
                knowledgePoint: '泰勒公式',
                summary: '需要主动回忆展开条件。',
                tags: ['背诵'],
                wrongReason: null,
                intent: { isQuestion: false, isMistake: false, shouldMemorize: true },
              },
            ],
            cards: [
              { front: '洛必达前检查什么？', back: '检查未定式及可导条件。', kind: 'mistake', itemIndex: 0 },
              { front: '泰勒展开需要哪些条件？', back: '在展开点具有相应阶导数。', kind: 'memory', itemIndex: 1 },
              { front: '无对应分项', back: '应被过滤', kind: 'qa', itemIndex: 9 },
            ],
          }),
          provider: 'gemini',
          model: 'gemini-strong',
        };
      },
    },
  });

  const result = await analyzer(makeContext(imagePath, {
    metadata: { kind: 'canvas', remark: '两张内容拼在一起整理。' },
  }));
  assert.equal(capturedRequest.difficulty, 'high');
  assert.match(capturedRequest.messages[0].content[1].image_url.url, /^data:image\/webp;base64,/);
  assert.equal(result.items.length, 2);
  assert.equal(result.cards.length, 2);
  assert.deepEqual(result.cards.map((card) => card.itemIndex), [0, 1]);
  assert.ok(result.cards.every((card) => card.status === 'draft'));
});

test('taxonomy compaction is valid, bounded and marks truncation', () => {
  const taxonomy = {
    revision: 8,
    subjects: Array.from({ length: 20 }, (_, subjectIndex) => ({
      name: `科目${subjectIndex}`,
      aliases: [`别名${subjectIndex}`],
      knowledgePoints: Array.from({ length: 30 }, (_, pointIndex) => ({
        name: `知识点${subjectIndex}-${pointIndex}-${'很长'.repeat(20)}`,
        aliases: [],
      })),
    })),
  };
  const compact = compactTaxonomy(taxonomy, 900);
  const serialized = JSON.stringify(compact);
  assert.ok(serialized.length <= 900);
  assert.equal(compact.truncated, true);
  assert.doesNotThrow(() => JSON.parse(serialized));
});

test('router failures propagate so the organizer can record and retry them', async (t) => {
  const imagePath = makeImageFixture(t);
  const expected = Object.assign(new Error('all providers failed'), { code: 'AI_ALL_PROVIDERS_FAILED' });
  const analyzer = createNoteAiAnalyzer({
    router: {
      async complete() {
        throw expected;
      },
    },
  });
  await assert.rejects(analyzer(makeContext(imagePath)), (error) => error === expected);
});

test('missing image fails before invoking the router', async () => {
  let calls = 0;
  const analyzer = createNoteAiAnalyzer({
    router: {
      async complete() {
        calls += 1;
        return { json: baseAiResult(), provider: 'test', model: 'test' };
      },
    },
  });
  await assert.rejects(analyzer(makeContext(path.join(os.tmpdir(), 'definitely-missing-note.png'))), {
    code: 'NOTE_IMAGE_UNAVAILABLE',
  });
  assert.equal(calls, 0);
});
