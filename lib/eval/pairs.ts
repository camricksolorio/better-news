// Picks the pairs to label (D11): stratified by similarity so every score range is covered, plus
// the pairs the baseline merged and the likely `related` ones (same topic, published 12-48h apart).
// Random pairs would be ~99% `different` and teach us nothing.
import { cleanText } from "@/lib/text";
import type { SnapshotArticle } from "./replay";
import type { SimCache } from "./sim-cache";

export type PairCategory = "sim60" | "sim70" | "sim80" | "sim90" | "merged" | "related";

export type PairRecord = {
  a: string; // guid
  b: string; // guid
  category: PairCategory;
  sim: number;
  hoursApart: number;
  // Whether the baseline pipeline put both articles in one story.
  merged: boolean;
  article: {
    a: { title: string; source: string; time: string; snippet: string };
    b: { title: string; source: string; time: string; snippet: string };
  };
};

export type PairQuota = Record<PairCategory, number>;

export const DEFAULT_QUOTA: PairQuota = { sim60: 40, sim70: 50, sim80: 50, sim90: 40, merged: 60, related: 60 };

// Priority when one pair qualifies for several categories: the rarer, more informative one wins.
const PRIORITY: PairCategory[] = ["merged", "related", "sim90", "sim80", "sim70", "sim60"];

export function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Raw = { i: number; j: number; sim: number };

export function selectPairs(
  cache: SimCache,
  clusterOf: Map<string, string>,
  opts: { seed?: number; quota?: PairQuota } = {},
): PairRecord[] {
  const rand = mulberry32(opts.seed ?? 1);
  const quota = opts.quota ?? DEFAULT_QUOTA;
  const { sorted } = cache;
  const time = (i: number) => new Date(sorted[i].time).getTime();

  // Reservoir sampling per category, oversampled so duplicates across categories can be skipped.
  const reservoirs = new Map<PairCategory, { seen: number; items: Raw[] }>(
    PRIORITY.map((c) => [c, { seen: 0, items: [] }]),
  );
  const offer = (category: PairCategory, raw: Raw) => {
    const r = reservoirs.get(category)!;
    const cap = quota[category] * 3;
    r.seen++;
    if (r.items.length < cap) r.items.push(raw);
    else {
      const k = Math.floor(rand() * r.seen);
      if (k < cap) r.items[k] = raw;
    }
  };

  cache.eachPair((i, j, sim) => {
    const a = sorted[i];
    const b = sorted[j];
    if (a.sourceId === b.sourceId) return; // cross-outlet pairs are the product's whole point
    const hours = Math.abs(time(i) - time(j)) / 3_600_000;
    const raw = { i, j, sim };
    if (clusterOf.get(a.guid) === clusterOf.get(b.guid)) offer("merged", raw);
    if (hours >= 12 && hours <= 48 && sim >= 0.7 && sim < 0.92) offer("related", raw);
    if (hours <= 36) {
      if (sim >= 0.9) offer("sim90", raw);
      else if (sim >= 0.8) offer("sim80", raw);
      else if (sim >= 0.7) offer("sim70", raw);
      else if (sim >= 0.6) offer("sim60", raw);
    }
  });

  const chosen = new Map<string, { raw: Raw; category: PairCategory }>();
  const counts = new Map<PairCategory, number>();
  for (const category of PRIORITY) {
    const items = reservoirs.get(category)!.items;
    // Shuffle so the kept subset is random, not whatever the reservoir happened to retain first.
    for (let k = items.length - 1; k > 0; k--) {
      const m = Math.floor(rand() * (k + 1));
      [items[k], items[m]] = [items[m], items[k]];
    }
    for (const raw of items) {
      if ((counts.get(category) ?? 0) >= quota[category]) break;
      const key = `${raw.i}|${raw.j}`;
      if (chosen.has(key)) continue;
      chosen.set(key, { raw, category });
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }

  const describe = (x: SnapshotArticle) => ({
    title: cleanText(x.title),
    source: x.sourceId,
    time: x.time,
    snippet: cleanText(x.summary).slice(0, 400),
  });
  const records = [...chosen.values()].map(({ raw, category }): PairRecord => {
    const a = sorted[raw.j]; // the earlier-published article first
    const b = sorted[raw.i];
    return {
      a: a.guid,
      b: b.guid,
      category,
      sim: Math.round(raw.sim * 1000) / 1000,
      hoursApart: Math.round((Math.abs(time(raw.i) - time(raw.j)) / 3_600_000) * 10) / 10,
      merged: clusterOf.get(a.guid) === clusterOf.get(b.guid),
      article: { a: describe(a), b: describe(b) },
    };
  });

  // Random order so a labeler never sees one category in a block.
  for (let k = records.length - 1; k > 0; k--) {
    const m = Math.floor(rand() * (k + 1));
    [records[k], records[m]] = [records[m], records[k]];
  }
  return records;
}
