/** Preserve Legacy's lexical fallback and weighted dense fusion; design/skills-thetis §5. */
export interface Document { id: string; text: string; vector?: readonly number[] }
export interface Score { id: string; score: number }
export const defaults = { k1: 1.2, b: 0.75, fusionWeight: 0.7, candidates: 50, corpus: 10000, textBytes: 16384, dimensions: 4096 };
export function tokenize(text: string): string[] { return text.split(/[^\p{L}\p{N}]+/u).filter(word => Buffer.byteLength(word) > 1).map(word => word.toLowerCase()); }
export function ordered(scores: Score[]): Score[] { return scores.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); }

export function lexical(corpus: readonly Document[], query: string): Score[] {
  const docs = corpus.map(doc => ({ id: doc.id, terms: tokenize(doc.text) }));
  const average = docs.reduce((sum, doc) => sum + doc.terms.length, 0) / Math.max(1, docs.length);
  const frequency = new Map<string, number>();
  for (const doc of docs) for (const term of new Set(doc.terms)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const terms = tokenize(query);
  return ordered(docs.map(doc => {
    const counts = new Map<string, number>();
    for (const term of doc.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    const score = terms.reduce((sum, term) => {
      const count = counts.get(term) ?? 0;
      const present = frequency.get(term) ?? 0;
      const idf = Math.max(0, Math.log(1 + (docs.length - present + 0.5) / (present + 0.5)));
      const denominator = count + defaults.k1 * (1 - defaults.b + defaults.b * doc.terms.length / Math.max(1, average));
      return sum + idf * count * (defaults.k1 + 1) / Math.max(Number.EPSILON, denominator);
    }, 0);
    return { id: doc.id, score };
  }).filter(item => item.score > 0));
}

export function dense(corpus: readonly Document[], query: readonly number[]): Score[] {
  return ordered(corpus.flatMap(doc => {
    if (!doc.vector || doc.vector.length !== query.length) return [];
    let dot = 0; let left = 0; let right = 0;
    for (let i = 0; i < query.length; i++) {
      const a = doc.vector[i] ?? 0; const b = query[i] ?? 0;
      dot += a * b; left += a * a; right += b * b;
    }
    return [{ id: doc.id, score: left && right ? dot / Math.sqrt(left * right) : 0 }];
  }));
}

export function fusion(denseScores: readonly Score[], lexicalScores: readonly Score[], weight: number): Score[] {
  const bounded = Math.max(0, Math.min(1, weight));
  const scores = new Map<string, number>();
  for (const [i, item] of denseScores.entries()) scores.set(item.id, (scores.get(item.id) ?? 0) + bounded / (61 + i));
  for (const [i, item] of lexicalScores.entries()) scores.set(item.id, (scores.get(item.id) ?? 0) + (1 - bounded) / (61 + i));
  return ordered([...scores].map(([id, score]) => ({ id, score })));
}

export function rank(corpus: readonly Document[], query: string, limit: number, vector?: readonly number[], weight = defaults.fusionWeight, absorb = true): Score[] {
  if (corpus.length > defaults.corpus || corpus.some(doc => Buffer.byteLength(doc.text) > defaults.textBytes || (doc.vector?.length ?? 0) > defaults.dimensions)) throw new Error('The retrieval index exceeds its declared limits.');
  if (limit <= 0) return [];
  if (corpus.length <= limit) return ordered(corpus.map(doc => ({ id: doc.id, score: 1 })));
  const lexicalScores = lexical(corpus, query);
  const denseScores = vector ? dense(corpus, vector) : [];
  const scores = denseScores.length ? weight > 0 ? fusion(denseScores, lexicalScores, weight) : denseScores : lexicalScores;
  const pool = scores.slice(0, defaults.candidates);
  if (!absorb) return pool.slice(0, limit);
  const present = new Set(pool.map(item => item.id));
  const lifted = new Map<string, number>();
  for (const item of pool) {
    let target = item.id;
    for (let parent = item.id.split('/').slice(0, -1); parent.length; parent.pop()) if (present.has(parent.join('/'))) target = parent.join('/');
    lifted.set(target, Math.max(lifted.get(target) ?? 0, item.score));
  }
  const result = ordered([...lifted].map(([id, score]) => ({ id, score }))).slice(0, limit);
  for (const item of [...result]) {
    const parent = item.id.split('/').slice(0, -1).join('/');
    if (result.length < limit && corpus.some(doc => doc.id === parent) && !result.some(doc => doc.id === parent)) result.push({ id: parent, score: item.score * 0.99 });
  }
  return result;
}
