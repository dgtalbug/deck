// Deterministic path/keyword retrieval over an explicitly selected corpus.
// This is the evaluation baseline: the ranking uses only path and content
// term matches with frozen tie-breaking (descending score, then reference
// code-point order) so runs are reproducible without any index.

export interface CorpusFile {
  path: string;
  bytes: string | null;
}

const SYMBOL_PATTERN = /^\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

export function extractSymbols(bytes: string): string[] {
  const names: string[] = [];
  for (const match of bytes.matchAll(SYMBOL_PATTERN)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return [...new Set(names)];
}

function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9_$]+/).filter((term) => term.length >= 3))];
}

function scoreFile(path: string, bytes: string | null, query: string): number {
  const queryTerms = terms(query);
  if (queryTerms.length === 0) return 0;
  let score = 0;
  const lowerPath = path.toLowerCase();
  const lowerBytes = bytes?.toLowerCase() ?? '';
  for (const term of queryTerms) {
    if (lowerPath.includes(term)) score += 2;
    if (lowerBytes.includes(term)) score += 1;
  }
  return score;
}

export interface ScoredReference {
  reference: string;
  score: number;
}

// Returns `file:symbol` references ranked by descending score; equal scores
// break by Unicode code-point order of the reference so ordering is stable.
export function retrieveReferences(query: string, corpus: CorpusFile[], limit = 10): ScoredReference[] {
  const scored: ScoredReference[] = [];
  for (const file of corpus) {
    if (file.bytes === null) continue;
    const fileScore = scoreFile(file.path, file.bytes, query);
    if (fileScore === 0) continue;
    for (const symbol of extractSymbols(file.bytes)) {
      const symbolBonus = terms(query).some((term) => symbol.toLowerCase().includes(term)) ? 2 : 0;
      scored.push({ reference: `${file.path}:${symbol}`, score: fileScore + symbolBonus });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || (a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0))
    .slice(0, limit);
}
