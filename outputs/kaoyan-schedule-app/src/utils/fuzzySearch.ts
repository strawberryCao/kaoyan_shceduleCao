export interface WeightedSearchField {
  text: string | null | undefined;
  weight?: number;
}

const MAX_FUZZY_TEXT = 6000;

export const normalizeSearchText = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase('zh-CN')
  .replace(/[\p{P}\p{S}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const editDistanceWithin = (left: string, right: string, limit: number): number => {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column <= right.length; column += 1) {
      const value = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
};

const approximateSubstringScore = (needle: string, haystack: string): number => {
  if (needle.length < 2 || haystack.length < 2) return 0;
  const allowedEdits = needle.length <= 5 ? 1 : Math.min(2, Math.floor(needle.length / 4));
  const starts = new Set<number>();
  const sample = haystack.slice(0, MAX_FUZZY_TEXT);
  for (let needleIndex = 0; needleIndex < needle.length; needleIndex += 1) {
    let position = sample.indexOf(needle[needleIndex]);
    while (position >= 0 && starts.size < 160) {
      starts.add(Math.max(0, position - needleIndex));
      position = sample.indexOf(needle[needleIndex], position + 1);
    }
  }
  let best = 0;
  for (const start of starts) {
    for (let delta = -allowedEdits; delta <= allowedEdits; delta += 1) {
      const length = needle.length + delta;
      if (length < 1 || start + length > sample.length) continue;
      const candidate = sample.slice(start, start + length);
      const distance = editDistanceWithin(needle, candidate, allowedEdits);
      if (distance <= allowedEdits) best = Math.max(best, 1 - distance / Math.max(needle.length, candidate.length));
    }
  }
  return best;
};

const subsequenceScore = (needle: string, haystack: string): number => {
  if (needle.length < 3) return 0;
  let needleIndex = 0;
  let first = -1;
  let last = -1;
  for (let index = 0; index < haystack.length && needleIndex < needle.length; index += 1) {
    if (haystack[index] !== needle[needleIndex]) continue;
    if (first < 0) first = index;
    last = index;
    needleIndex += 1;
  }
  if (needleIndex !== needle.length) return 0;
  const spread = Math.max(needle.length, last - first + 1);
  return 0.58 + (needle.length / spread) * 0.2;
};

const termScore = (rawTerm: string, rawText: string): number => {
  const term = normalizeSearchText(rawTerm);
  const text = normalizeSearchText(rawText).slice(0, MAX_FUZZY_TEXT);
  if (!term || !text) return 0;
  if (text === term) return 1.2;
  const directIndex = text.indexOf(term);
  if (directIndex >= 0) return 1.05 - Math.min(0.12, directIndex / 10000);
  const compactTerm = term.replace(/\s/g, '');
  const compactText = text.replace(/\s/g, '');
  if (!compactTerm) return 0;
  if (compactText.includes(compactTerm)) return 1;
  if (compactTerm.length === 1) return 0;
  const approximate = approximateSubstringScore(compactTerm, compactText);
  const minimumSimilarity = compactTerm.length <= 2 ? 0.5 : 0.66;
  if (approximate >= minimumSimilarity) return 0.58 + approximate * 0.28;
  return subsequenceScore(compactTerm, compactText);
};

export const fuzzySearchScore = (query: string, fields: WeightedSearchField[]): number => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 1;
  const terms = normalizedQuery.split(' ').filter(Boolean);
  let total = 0;
  for (const term of terms) {
    let best = 0;
    for (const field of fields) {
      if (!field.text) continue;
      best = Math.max(best, termScore(term, String(field.text)) * (field.weight ?? 1));
    }
    if (best <= 0) return 0;
    total += best;
  }
  return total / terms.length;
};

export const fuzzyMatches = (query: string, fields: WeightedSearchField[]): boolean => fuzzySearchScore(query, fields) > 0;
