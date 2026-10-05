import { describe, expect, it } from "vitest";
import { computeMetrics, type PairLabel } from "./metrics";
import { replay, type SnapshotArticle } from "./replay";
import { DEFAULT_CLUSTER_CONFIG } from "@/lib/pipeline/assign";

const clusters = (obj: Record<string, string>) => new Map(Object.entries(obj));

describe("computeMetrics", () => {
  // a,b,c in one story; d,e in another; f alone.
  const clusterOf = clusters({ a: "1", b: "1", c: "1", d: "2", e: "2", f: "3" });

  it("computes pairwise precision, recall, and F1 on a hand-built fixture", () => {
    const labels: PairLabel[] = [
      { a: "a", b: "b", label: "same" }, // TP
      { a: "a", b: "c", label: "same" }, // TP
      { a: "d", b: "e", label: "same" }, // TP
      { a: "a", b: "f", label: "same" }, // FN (split)
      { a: "b", b: "c", label: "different" }, // FP (merged)
      { a: "a", b: "d", label: "different" }, // TN
    ];
    const m = computeMetrics(clusterOf, labels);
    expect(m.counts).toMatchObject({ tp: 3, fp: 1, fn: 1, tn: 1 });
    expect(m.precision).toBeCloseTo(3 / 4);
    expect(m.recall).toBeCloseTo(3 / 4);
    expect(m.f1).toBeCloseTo(3 / 4);
    expect(m.falseMerges).toEqual([{ a: "b", b: "c", label: "different" }]);
    expect(m.falseSplits).toEqual([{ a: "a", b: "f", label: "same" }]);
  });

  it("counts `related` as a negative and reports the leak rate", () => {
    const labels: PairLabel[] = [
      { a: "a", b: "b", label: "same" }, // TP
      { a: "a", b: "c", label: "related" }, // merged: FP + leak
      { a: "d", b: "f", label: "related" }, // apart: TN
    ];
    const m = computeMetrics(clusterOf, labels);
    expect(m.counts).toMatchObject({ tp: 1, fp: 1, tn: 1, related: 2, relatedMerged: 1 });
    expect(m.precision).toBeCloseTo(1 / 2);
    expect(m.relatedLeak).toBeCloseTo(1 / 2);
  });

  it("ignores unsure pairs and counts pairs with unknown articles as missing", () => {
    const m = computeMetrics(clusterOf, [
      { a: "a", b: "b", label: "unsure" },
      { a: "a", b: "zzz", label: "same" },
    ]);
    expect(m.counts).toMatchObject({ tp: 0, fp: 0, fn: 0, tn: 0 });
    expect(m.unlabeledMissing).toBe(1);
  });

  it("returns zeros instead of NaN when there is nothing to score", () => {
    const m = computeMetrics(clusterOf, []);
    expect(m).toMatchObject({ precision: 0, recall: 0, f1: 0, relatedLeak: 0 });
  });
});

describe("replay", () => {
  const at = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0, 0];
  const snap = (guid: string, hour: number, deg: number): SnapshotArticle => ({
    guid,
    sourceId: "s",
    title: guid,
    summary: "x".repeat(60),
    time: new Date(Date.UTC(2026, 9, 1, hour)).toISOString(),
    thin: false,
    embedding: at(deg),
  });

  it("clusters a snapshot, scores it against labels, and reports the gray share", async () => {
    const snapshot = [snap("a", 0, 0), snap("b", 1, 2), snap("c", 2, 90), snap("d", 3, 30)];
    const labels: PairLabel[] = [
      { a: "a", b: "b", label: "same" },
      { a: "a", b: "c", label: "different" },
      { a: "a", b: "d", label: "related" },
    ];
    const r = await replay(snapshot, labels, DEFAULT_CLUSTER_CONFIG);
    expect(r.articles).toBe(4);
    expect(r.clusterOf.get("a")).toBe(r.clusterOf.get("b"));
    expect(r.clusterOf.get("c")).not.toBe(r.clusterOf.get("a"));
    // d is 30 degrees off a/b: cos = 0.866, inside the gray band, treated as a new story at baseline.
    expect(r.grayCount).toBe(1);
    expect(r.grayShare).toBeCloseTo(0.25);
    expect(r.metrics.precision).toBe(1);
    expect(r.metrics.recall).toBe(1);
    expect(r.metrics.relatedLeak).toBe(0);
  });

  it("is deterministic regardless of input order", async () => {
    const snapshot = [snap("a", 0, 0), snap("b", 1, 2), snap("c", 2, 90)];
    const one = await replay(snapshot, [], DEFAULT_CLUSTER_CONFIG);
    const two = await replay([...snapshot].reverse(), [], DEFAULT_CLUSTER_CONFIG);
    expect(two.stories).toBe(one.stories);
  });
});

import { buildSimCache } from "./sim-cache";
import { cosine } from "@/lib/pipeline/assign";

describe("sim cache", () => {
  // Deterministic pseudo-random unit-ish vectors.
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296) - 0.5;
  const make = (n: number): SnapshotArticle[] => {
    const r = rng(7);
    return Array.from({ length: n }, (_, i) => ({
      guid: `g${i}`,
      sourceId: "s",
      title: `t${i}`,
      summary: null,
      time: new Date(Date.UTC(2026, 9, 1, 0, i * 20)).toISOString(), // 3 per hour: ~120 articles span 40h
      thin: false,
      embedding: Array.from({ length: 16 }, () => r()),
    }));
  };

  it("matches direct cosine within the cached window", () => {
    const snap = make(120);
    const cache = buildSimCache(snap, 48);
    const a = cache.sorted[100];
    const m = cache.sorted[40];
    const toInput = (x: SnapshotArticle) => ({ id: x.guid, sourceId: x.sourceId, time: new Date(x.time), embedding: x.embedding, thin: x.thin });
    expect(cache.memberSim(toInput(a), toInput(m))).toBeCloseTo(cosine(a.embedding, m.embedding), 5);
  });

  it("falls back to direct cosine outside the cached window", () => {
    const snap = make(300); // 100h span, window 48h
    const cache = buildSimCache(snap, 48);
    const a = cache.sorted[299];
    const m = cache.sorted[0];
    const toInput = (x: SnapshotArticle) => ({ id: x.guid, sourceId: x.sourceId, time: new Date(x.time), embedding: x.embedding, thin: x.thin });
    expect(cache.memberSim(toInput(a), toInput(m))).toBeCloseTo(cosine(a.embedding, m.embedding), 5);
  });

  it("replay with the cache gives the same clusters as without", async () => {
    const snap = make(200);
    const plain = await replay(snap, [], { ...DEFAULT_CLUSTER_CONFIG, tHigh: 0.2, tLow: 0.1 });
    const cached = await replay(snap, [], { ...DEFAULT_CLUSTER_CONFIG, tHigh: 0.2, tLow: 0.1 }, { memberSim: buildSimCache(snap).memberSim });
    const groups = (m: Map<string, string>) => {
      const g = new Map<string, string[]>();
      for (const [k, v] of m) g.set(v, [...(g.get(v) ?? []), k]);
      return [...g.values()].map((x) => x.sort().join(",")).sort();
    };
    expect(groups(cached.clusterOf)).toEqual(groups(plain.clusterOf));
    expect(plain.stories).toBeLessThan(200);
  });

  it("gray 'join' mode joins gray-zone articles, 'new' does not", async () => {
    const a = (guid: string, hour: number, deg: number): SnapshotArticle => ({
      guid, sourceId: "s", title: guid, summary: null, thin: false,
      time: new Date(Date.UTC(2026, 9, 1, hour)).toISOString(),
      embedding: [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0, 0],
    });
    const snap = [a("x", 0, 0), a("y", 1, 30)]; // cos 30deg = 0.866: gray
    const conservative = await replay(snap, [], DEFAULT_CLUSTER_CONFIG, { gray: "new" });
    const optimistic = await replay(snap, [], DEFAULT_CLUSTER_CONFIG, { gray: "join" });
    expect(conservative.stories).toBe(2);
    expect(optimistic.stories).toBe(1);
    expect(optimistic.decisions.get("y")).toMatchObject({ gray: true, method: "llm" });
  });
});
