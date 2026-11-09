// Candidate pairs (story-clustering-v2 TDD part 3): for an article, the other articles close to it in embedding space
// and in time. `createMemoryIndex` is the brute-force version the replay harness uses; the database version (pgvector)
// comes with the production wiring and answers the same question.
import type { ConsolidateConfig } from "./consolidate-config";

const HOUR = 3_600_000;

export type RetrieveArticle = { id: string; time: number; embedding: number[] };
export type Neighbour = { id: string; cosine: number };

export interface RetrieveIndex {
  add(article: RetrieveArticle): void;
  // Up to kMax articles within maxGapHours of `article` and at least tLow similar, most similar first.
  neighbours(article: RetrieveArticle, cfg: Pick<ConsolidateConfig, "tLow" | "kMax" | "maxGapHours">): Neighbour[];
}

export function createMemoryIndex(): RetrieveIndex {
  type Entry = { id: string; time: number; v: Float32Array; norm: number };
  const entries: Entry[] = []; // kept sorted by time so a window is a contiguous range
  const norm = (v: Float32Array) => Math.sqrt(v.reduce((t, x) => t + x * x, 0));

  const lowerBound = (time: number) => {
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  return {
    add(a) {
      const v = Float32Array.from(a.embedding);
      const entry = { id: a.id, time: a.time, v, norm: norm(v) };
      entries.splice(lowerBound(a.time), 0, entry);
    },
    neighbours(a, cfg) {
      const q = Float32Array.from(a.embedding);
      const qn = norm(q);
      const gap = cfg.maxGapHours * HOUR;
      const found: Neighbour[] = [];
      for (let i = lowerBound(a.time - gap); i < entries.length && entries[i].time <= a.time + gap; i++) {
        const e = entries[i];
        if (e.id === a.id || e.norm === 0 || qn === 0) continue;
        let dot = 0;
        for (let k = 0; k < q.length; k++) dot += q[k] * e.v[k];
        const cosine = dot / (qn * e.norm);
        if (cosine >= cfg.tLow) found.push({ id: e.id, cosine });
      }
      return found.sort((x, y) => y.cosine - x.cosine || x.id.localeCompare(y.id)).slice(0, cfg.kMax);
    },
  };
}
