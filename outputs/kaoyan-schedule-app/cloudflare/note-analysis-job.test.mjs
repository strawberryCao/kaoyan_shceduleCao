import assert from 'node:assert/strict';
import test from 'node:test';
import { noteAnalysisInternals } from './note-analysis-job.js';

test('cloud note analysis resolves a stable attachment when the legacy note path is local', async () => {
  const assetId = 'a'.repeat(64);
  const path = await noteAnalysisInternals.resolveImageRepoPath({}, {
    filePath: 'C:\\Users\\ASUS\\Desktop\\note.png',
    attachments: [{
      assetId,
      cloudPath: `github://data/assets/${assetId}.png`,
      filePath: 'C:\\Users\\ASUS\\Desktop\\note.png',
    }],
  });
  assert.equal(path, `data/assets/${assetId}.png`);
});

test('cloud note analysis gives an explicit mistake-only remark priority over inferred memory', () => {
  const note = {
    remark: '错题',
    noteType: 'mistake',
    facets: ['quick'],
    tags: ['背诵'],
    goodQuestion: false,
  };
  const hints = noteAnalysisInternals.strongHints(note);
  assert.equal(hints.explicitMistake, true);
  assert.equal(hints.explicitMemory, false);

  const analysis = noteAnalysisInternals.normalizeAnalysis({
    title: '极限公式',
    subject: '高等数学',
    knowledgePoint: '函数极限',
    summary: '测试',
    tags: ['错题', '公式记忆', '背诵'],
    questionType: '计算题',
    intent: { isQuestion: true, isMistake: true, shouldMemorize: true },
    items: [{
      title: '分项',
      knowledgePoint: '函数极限',
      summary: '分项测试',
      tags: ['背诵'],
      wrongReason: null,
      intent: { isQuestion: true, isMistake: true, shouldMemorize: true },
    }],
    cards: [],
    confidence: 0.9,
    reason: '测试',
  }, note, hints, {
    options: {
      mistakePolicy: 'semantic',
      goodQuestionPolicy: 'explicit_only',
      memorizePolicy: 'semantic',
      cardPolicy: 'intent_only',
      maxItems: 12,
      maxCards: 2,
    },
  });

  assert.equal(analysis.intent.isMistake, true);
  assert.equal(analysis.intent.shouldMemorize, false);
  assert.equal(analysis.items[0].intent.shouldMemorize, false);
  assert.equal(analysis.tags.some((tag) => /背诵|记忆/.test(tag)), false);
  assert.equal(analysis.items[0].tags.some((tag) => /背诵|记忆/.test(tag)), false);
});

test('cloud enrichment cannot move a stably named high-math note into probability', () => {
  const note = {
    title: '高等数学_分段函数积分求解_20260806_161432',
    subject: '概率论',
    remark: '',
    facets: [],
    tags: [],
    userEditedFields: [],
  };
  const hints = noteAnalysisInternals.strongHints(note);
  const analysis = noteAnalysisInternals.normalizeAnalysis({
    title: '正态分布期望计算',
    subject: '概率论',
    knowledgePoint: '数学期望',
    summary: '把积分误判为概率题。',
    tags: [],
    intent: { isQuestion: true, isMistake: false, shouldMemorize: false },
    items: [],
    cards: [],
    confidence: 0.7,
  }, note, hints, { options: {} });

  assert.equal(analysis.subject, '高等数学');
});
