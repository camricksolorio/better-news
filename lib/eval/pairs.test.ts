import { describe, expect, it } from "vitest";
import { buildSimCache } from "./sim-cache";
import { DEFAULT_QUOTA, mulberry32, selectPairs } from "./pairs";
import type { SnapshotArticle } from "./replay";

// 300 articles over ~100h across 6 sources, 8-dim vectors in a few loose topic groups.
function fixture(): SnapshotArticle[] {
  const r = mulberry32(42);
  const topics = Array.from({ length: 6 }, () => Array.from({ length: 8 }, () => r() - 0.5));
  return Array.from({ length: 300 }, (_, i) => {
    const t = topics[i % 6];
    return {
      guid: `g${i}`,
      sourceId: `src${i % 5}`,
      title: `title ${i}`,
      summary: `<p>summary ${i}</p>`,
      time: new Date(Date.UTC(2026, 9, 1, 0, i * 20)).toISOString(),
      thin: false,
      embedding: t.map((x) => x + (r() - 0.5) * 0.4),
    };
  });
}

describe("selectPairs", () => {
  const snap = fixture();
  const cache = buildSimCache(snap);
  // Pretend the baseline merged each topic's first 40 articles.
  const clusterOf = new Map(cache.sorted.map((a) => [a.guid, Number(a.guid.slice(1)) < 40 ? `c${Number(a.guid.slice(1)) % 6}` : a.guid]));

  it("is deterministic for a seed and varies across seeds", () => {
    const a = selectPairs(cache, clusterOf, { seed: 3 }).map((p) => `${p.a}|${p.b}`);
    const b = selectPairs(cache, clusterOf, { seed: 3 }).map((p) => `${p.a}|${p.b}`);
    const c = selectPairs(cache, clusterOf, { seed: 4 }).map((p) => `${p.a}|${p.b}`);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("returns no duplicate pairs, no same-source pairs, and respects the quotas", () => {
    const pairs = selectPairs(cache, clusterOf, { seed: 1 });
    const keys = pairs.map((p) => [p.a, p.b].sort().join("|"));
    expect(new Set(keys).size).toBe(keys.length);
    const source = new Map(snap.map((a) => [a.guid, a.sourceId]));
    for (const p of pairs) expect(source.get(p.a)).not.toBe(source.get(p.b));
    for (const category of Object.keys(DEFAULT_QUOTA) as (keyof typeof DEFAULT_QUOTA)[]) {
      expect(pairs.filter((p) => p.category === category).length).toBeLessThanOrEqual(DEFAULT_QUOTA[category]);
    }
  });

  it("puts the earlier article first and categorizes by the stated rules", () => {
    const pairs = selectPairs(cache, clusterOf, { seed: 1 });
    expect(pairs.length).toBeGreaterThan(50);
    for (const p of pairs) {
      expect(new Date(p.article.a.time).getTime()).toBeLessThanOrEqual(new Date(p.article.b.time).getTime());
      if (p.category === "related") {
        expect(p.hoursApart).toBeGreaterThanOrEqual(12);
        expect(p.hoursApart).toBeLessThanOrEqual(48);
        expect(p.sim).toBeGreaterThanOrEqual(0.7);
        expect(p.sim).toBeLessThan(0.92);
      }
      if (p.category === "merged") expect(p.merged).toBe(true);
      if (p.category === "sim90") expect(p.sim).toBeGreaterThanOrEqual(0.9);
      if (p.category === "sim60") expect(p.sim).toBeLessThan(0.7);
    }
  });

  it("strips HTML from the snippets", () => {
    const pairs = selectPairs(cache, clusterOf, { seed: 1 });
    expect(pairs.every((p) => !p.article.a.snippet.includes("<p>"))).toBe(true);
  });
});
