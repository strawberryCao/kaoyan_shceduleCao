import { getLearningSnapshot } from './learning.js';
import { readJsonFile } from './github-store.js';

const SEARCH_INDEX_PATH = 'data/search/documents.json';

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokens(value) {
  const normalized = normalize(value);
  const result = new Set(normalized.match(/[\p{L}\p{N}]{2,}/gu) || []);
  const chinese = normalized.replace(/[^\p{Script=Han}]/gu, '');
  for (let index = 0; index < chinese.length - 1; index += 1) result.add(chinese.slice(index, index + 2));
  return [...result].slice(0, 80);
}

function fallbackDocuments(snapshot) {
  const documents = [];
  for (const [date, day] of Object.entries(snapshot?.days || {})) {
    for (const note of Array.isArray(day?.autoNotes) ? day.autoNotes : []) {
      documents.push({
        noteUid: note.noteUid,
        capturedDate: note.capturedDate || date,
        updatedAt: note.updatedAt || '',
        title: note.title || '',
        subject: note.subject || '',
        facets: note.facets || [],
        tags: note.tags || [],
        attachmentNames: (note.attachments || []).map((attachment) => attachment?.name || ''),
        content: [
          note.title,
          note.remark,
          note.subject,
          ...(note.tags || []),
          ...(note.facets || []),
          ...(note.knowledgePath || []),
          ...(note.questions || []),
          ...(note.items || []).flatMap((item) => [item?.title, item?.question, item?.answer, item?.remark]),
        ].filter(Boolean).join('\n'),
      });
    }
  }
  return documents;
}

function searchableText(document) {
  return [
    document.title,
    document.subject,
    ...(document.tags || []),
    ...(document.facets || []),
    ...(document.attachmentNames || []),
    document.content,
  ].join(' ');
}

function lexicalCandidates(documents, query, includeUnmatched) {
  const normalizedQuery = normalize(query);
  const queryTokens = tokens(query);
  return documents.map((document, originalIndex) => {
    const title = normalize(document.title);
    const haystack = normalize(searchableText(document));
    let score = haystack.includes(normalizedQuery) ? 80 : 0;
    const matchedTerms = [];
    for (const term of queryTokens) {
      if (!haystack.includes(term)) continue;
      score += title.includes(term) ? 18 : 7;
      matchedTerms.push(term);
    }
    return { document, originalIndex, score, matchedTerms };
  }).filter((candidate) => includeUnmatched || candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex);
}

async function rerank(env, query, candidates) {
  if (!env.AI || typeof env.AI.run !== 'function') return null;
  const contexts = candidates.map((candidate, id) => ({
    id,
    text: searchableText(candidate.document).slice(0, 5_000),
  }));
  const output = await env.AI.run('@cf/baai/bge-reranker-base', {
    query,
    contexts,
    top_k: Math.min(100, contexts.length),
  });
  const rows = Array.isArray(output?.response) ? output.response
    : Array.isArray(output?.data) ? output.data
      : Array.isArray(output) ? output : [];
  if (rows.length === 0) return null;
  return rows.map((row, order) => {
    const index = Number(row?.id ?? row?.index ?? order);
    const candidate = candidates[index];
    if (!candidate) return null;
    return {
      ...candidate,
      semanticScore: Number(row?.score) || 0,
    };
  }).filter(Boolean)
    .sort((left, right) => right.semanticScore - left.semanticScore || right.score - left.score);
}

export async function searchLearningRecords(env, payload) {
  const query = String(payload?.query || '').normalize('NFKC').trim().slice(0, 500);
  const mode = payload?.mode === 'ai' ? 'ai' : 'normal';
  const limit = Math.max(1, Math.min(200, Number(payload?.limit) || 80));
  if (!query) return { ok: true, mode, query, results: [] };
  const [stored, snapshot] = await Promise.all([
    readJsonFile(env, SEARCH_INDEX_PATH, { allowMissing: true, maxBytes: 24 * 1024 * 1024 }),
    getLearningSnapshot(env),
  ]);
  const documents = Array.isArray(stored?.value?.documents)
    ? stored.value.documents
    : fallbackDocuments(snapshot);
  const candidates = lexicalCandidates(documents, query, mode === 'ai').slice(0, mode === 'ai' ? 100 : limit);
  let ranked = candidates;
  let degraded = false;
  if (mode === 'ai') {
    try {
      ranked = await rerank(env, query, candidates) || candidates;
      degraded = ranked === candidates;
    } catch {
      degraded = true;
    }
  }
  return {
    ok: true,
    mode,
    query,
    results: ranked.slice(0, limit).map((candidate) => ({
      noteUid: candidate.document.noteUid,
      title: candidate.document.title || '',
      subject: candidate.document.subject || '',
      capturedDate: candidate.document.capturedDate || '',
      score: candidate.semanticScore ?? candidate.score,
      matchedTerms: candidate.matchedTerms.slice(0, 8),
      reason: mode === 'ai'
        ? candidate.matchedTerms.length ? `语义相关；同时匹配：${candidate.matchedTerms.join('、')}` : '与查询语义相关'
        : `匹配：${candidate.matchedTerms.join('、')}`,
    })),
    degraded,
    sourceRevision: Number(stored?.value?.sourceRevision) || Number(snapshot.revision) || 0,
  };
}
