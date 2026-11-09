import { describe, expect, it } from "vitest";
import { DEFAULT_CONSOLIDATE_CONFIG as DEFAULT } from "./consolidate-config";
import { createMemoryIndex, type RetrieveArticle } from "./retrieve";

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 0, 0);
const at = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
const art = (id: string, hours: number, deg: number): RetrieveArticle => ({ id, time: T0 + hours * H, embedding: at(deg) });
const cfg = { ...DEFAULT, tLow: 0.9, kMax: 3 };

function indexOf(articles: RetrieveArticle[]) {
  const index = createMemoryIndex();
  for (const a of articles) index.add(a);
  return index;
}

describe("memory index retrieval", () => {
  it("returns neighbours above the floor within the gap, most similar first, never the article itself", () => {
    const all = [art("a", 0, 0), art("b", 1, 5), art("c", 2, 12), art("far", 3, 60)];
    const found = indexOf(all).neighbours(all[0], cfg);
    expect(found.map((f) => f.id)).toEqual(["b", "c"]);
    expect(found[0].cosine).toBeGreaterThan(found[1].cosine);
  });

  it("leaves out articles more than maxGapHours apart, on either side", () => {
    const all = [art("a", 0, 0), art("late", 40, 0), art("early", -40, 0), art("ok", 36, 0), art("ok2", -36, 0)];
    expect(indexOf(all).neighbours(all[0], cfg).map((f) => f.id).sort()).toEqual(["ok", "ok2"]);
  });

  it("keeps only the kMax most similar, breaking ties by id", () => {
    const all = [art("a", 0, 0), art("e", 1, 3), art("d", 1, 3), art("c", 1, 3), art("b", 1, 1), art("f", 1, 8)];
    const found = indexOf(all).neighbours(all[0], { ...cfg, kMax: 3 });
    expect(found.map((f) => f.id)).toEqual(["b", "c", "d"]);
  });

  it("finds a neighbour added later, so batches can be indexed before they are searched", () => {
    const index = createMemoryIndex();
    const a = art("a", 0, 0);
    index.add(a);
    expect(index.neighbours(a, cfg)).toEqual([]);
    index.add(art("b", 5, 2));
    expect(index.neighbours(a, cfg).map((f) => f.id)).toEqual(["b"]);
  });

  it("gives symmetric results: if b is a neighbour of a within k, a sees b and b sees a", () => {
    const all = [art("a", 0, 0), art("b", 1, 5)];
    const index = indexOf(all);
    expect(index.neighbours(all[0], cfg).map((f) => f.id)).toEqual(["b"]);
    expect(index.neighbours(all[1], cfg).map((f) => f.id)).toEqual(["a"]);
  });
});
