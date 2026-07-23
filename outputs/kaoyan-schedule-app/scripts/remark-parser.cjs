const PARSER_VERSION = 1;

const unique = (items) => [...new Set(items.filter((item) => item !== '' && item !== null && item !== undefined))];

function normalizeQuestionNumber(value) {
  return String(value || '')
    .trim()
    .replace(/[．。]/g, '.')
    .replace(/[—–－]/g, '-')
    .replace(/\s+/g, '');
}

function expandPageRange(start, end) {
  const first = Number(start);
  const last = Number(end ?? start);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) {
    return [];
  }
  if (last - first > 50) {
    return [first, last];
  }
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function collectMatches(text, regex, mapper) {
  const results = [];
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    results.push(mapper(match));
    if (match[0] === '') regex.lastIndex += 1;
  }
  return results;
}

function extractPageRefs(text) {
  const matches = [
    ...collectMatches(text, /\b[pP]\s*[.．:：]?\s*(\d{1,5})(?:\s*[-~～—–－至到]\s*(\d{1,5}))?/g, (match) => ({
      raw: match[0],
      start: Number(match[1]),
      end: Number(match[2] || match[1]),
    })),
    ...collectMatches(text, /第?\s*(\d{1,5})(?:\s*[-~～—–－至到]\s*(\d{1,5}))?\s*页/g, (match) => ({
      raw: match[0],
      start: Number(match[1]),
      end: Number(match[2] || match[1]),
    })),
  ];

  const seen = new Set();
  return matches.filter((item) => {
    const key = `${item.start}:${item.end}`;
    if (seen.has(key) || item.start < 1 || item.end < item.start) return false;
    seen.add(key);
    return true;
  });
}

function extractQuestionRefs(text) {
  const patterns = [
    /(?:第\s*)?(\d+(?:[.．。-]\d+){0,3})\s*(?:题|小题|问)/g,
    /(?:题|[qQ](?:uestion)?)\s*[:：#]?\s*(\d+(?:[.．。-]\d+){0,3})/g,
    /(?:例|例题)\s*(\d+(?:[.．。-]\d+){0,3})/g,
  ];
  const matches = patterns.flatMap((regex) => collectMatches(text, regex, (match) => ({
    raw: match[0],
    number: normalizeQuestionNumber(match[1]),
  })));
  const seen = new Set();
  return matches.filter((item) => {
    if (!item.number || seen.has(item.number)) return false;
    seen.add(item.number);
    return true;
  });
}

function extractExplicitTags(text) {
  const hashTags = collectMatches(text, /#([\p{L}\p{N}_-]{1,24})/gu, (match) => match[1]);
  const bracketTags = collectMatches(text, /(?:【|\[)([^\]】\r\n]{1,24})(?:】|\])/g, (match) => match[1].trim());
  return unique([...hashTags, ...bracketTags]);
}

function extractLabeledValues(text, labels, maxLength = 120) {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const regex = new RegExp(`(?:${escaped})\\s*[:：]\\s*([^\\r\\n；;。]{1,${maxLength}})`, 'g');
  return unique(collectMatches(text, regex, (match) => match[1].trim()));
}

function hasAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function hasStandalonePrompt(text, prompt) {
  const boundary = '[\\s,，。.!！?？;；:：#、/\\[\\]【】()（）]';
  return new RegExp(`(?:^|${boundary})${prompt}(?=$|${boundary})`).test(text);
}

function parseRemark(input) {
  const raw = typeof input === 'string' ? input : '';
  const text = raw.normalize('NFKC');
  const pageRefs = extractPageRefs(text);
  const questionRefs = extractQuestionRefs(text);
  const explicitTags = extractExplicitTags(text);
  const wrongReasons = extractLabeledValues(text, ['错因', '错误原因', '做错原因', '易错原因']);
  const cautions = extractLabeledValues(text, ['注意', '易错点', '提醒']);
  const sources = extractLabeledValues(text, ['教材', '书名', '来源'], 80);

  const lowerTags = new Set(explicitTags.map((tag) => tag.toLocaleLowerCase('zh-CN')));
  const tagged = (values) => values.some((value) => lowerTags.has(value.toLocaleLowerCase('zh-CN')));

  const isMistake = tagged(['错题', '易错', '做错'])
    || hasAny(text, ['错题', '做错了', '答错', '算错', '易错题', '错误题'])
    || wrongReasons.length > 0;
  const isClassic = tagged(['经典', '典型', '好题']) || hasAny(text, ['经典题', '典型题', '好题']);
  const shouldMemorize = tagged(['背诵', '要背', '记忆', '默写', '记', '背'])
    || hasAny(text, ['需要背', '需背', '要背', '背诵', '背下来', '记住', '要记住', '要记', '需记', '记一下', '默写', '记忆点'])
    || hasStandalonePrompt(text, '记')
    || hasStandalonePrompt(text, '背');
  const needsReview = tagged(['复习', '回看', '重做', '待复习'])
    || hasAny(text, ['需要复习', '待复习', '回看', '重做', '再做一遍', '再看']);

  const inferredTags = [];
  if (isMistake) inferredTags.push('错题');
  if (isClassic) inferredTags.push('经典');
  if (shouldMemorize) inferredTags.push('背诵');
  if (needsReview) inferredTags.push('待复习');

  return {
    parserVersion: PARSER_VERSION,
    pages: unique(pageRefs.flatMap((item) => expandPageRange(item.start, item.end))),
    pageRefs,
    questions: unique(questionRefs.map((item) => item.number)),
    questionRefs,
    explicitTags,
    inferredTags: unique(inferredTags),
    flags: {
      isMistake,
      isClassic,
      shouldMemorize,
      needsReview,
    },
    wrongReasons,
    cautions,
    sources,
  };
}

module.exports = {
  PARSER_VERSION,
  normalizeQuestionNumber,
  parseRemark,
};
