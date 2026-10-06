// Precomputed similarities between each article and the articles published just before it, so
// replaying a snapshot at different thresholds costs lookups instead of 768-dim dot products.
import type { ArticleInput } from "@/lib/pipeline/assign";
import type { SnapshotArticle } from "./replay";

export const MAX_CACHED_WINDOW_HOURS = 48;

export type SimCache = {
  // Calls fn(i, j, sim) for every cached pair with j < i (indexes into `sorted`).
  eachPair: (fn: (i: number, j: number, sim: number) => void) => void;
  // Articles sorted by time (then guid), the order a replay processes them in.
  sorted: SnapshotArticle[];
  memberSim: (article: ArticleInput, member: ArticleInput) => number;
};

function normalize(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  const inv = n === 0 ? 0 : 1 / Math.sqrt(n);
  return Float32Array.from(v, (x) => x * inv);
}

export function buildSimCache(snapshot: SnapshotArticle[], maxHours = MAX_CACHED_WINDOW_HOURS): SimCache {
  const sorted = [...snapshot].sort(
    (x, y) => new Date(x.time).getTime() - new Date(y.time).getTime() || x.guid.localeCompare(y.guid),
  );
  const times = sorted.map((a) => new Date(a.time).getTime());
  const vecs = sorted.map((a) => normalize(a.embedding));
  const index = new Map(sorted.map((a, i) => [a.guid, i]));
  const dim = vecs[0]?.length ?? 0;

  // sims[i] holds the similarity of article i to articles lo[i]..i-1.
  const lo: number[] = new Array(sorted.length);
  const sims: Float32Array[] = new Array(sorted.length);
  let start = 0;
  for (let i = 0; i < sorted.length; i++) {
    while (times[i] - times[start] > maxHours * 3_600_000) start++;
    lo[i] = start;
    const row = new Float32Array(i - start);
    const vi = vecs[i];
    for (let j = start; j < i; j++) {
      const vj = vecs[j];
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += vi[d] * vj[d];
      row[j - start] = dot;
    }
    sims[i] = row;
  }

  const memberSim = (a: ArticleInput, m: ArticleInput): number => {
    const i = index.get(a.id);
    const j = index.get(m.id);
    if (i !== undefined && j !== undefined && j < i && j >= lo[i]) return sims[i][j - lo[i]];
    // Outside the cached range: fall back to computing it.
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let d = 0; d < a.embedding.length; d++) {
      dot += a.embedding[d] * m.embedding[d];
      na += a.embedding[d] ** 2;
      nb += m.embedding[d] ** 2;
    }
    return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
  };

  const eachPair = (fn: (i: number, j: number, sim: number) => void) => {
    for (let i = 0; i < sorted.length; i++) {
      const row = sims[i];
      for (let k = 0; k < row.length; k++) fn(i, lo[i] + k, row[k]);
    }
  };

  return { sorted, memberSim, eachPair };
}
