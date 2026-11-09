import { describe, expect, it } from "vitest";
import type { Merge } from "./consolidate";
import { reconcile, type ReconcileCluster } from "./reconcile";

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 0, 0);
const stories = (spec: Record<string, number>) => new Map(Object.entries(spec).map(([id, h]) => [id, { createdAt: T0 + h * H }]));
const current = (spec: Record<string, string | null>) =>
  new Map(Object.entries(spec).map(([id, storyId]) => [id, { storyId, placed: storyId !== null }]));
const cluster = (members: string[], identity: string | null = null, merges: Merge[] = []): ReconcileCluster => ({ members, identity, merges });

describe("reconcile", () => {
  it("rule 1 (new): a cluster of never-placed articles becomes a new story", () => {
    const r = reconcile([cluster(["a", "b"])], current({ a: null, b: null }), stories({}));
    expect(r.newStories).toEqual([{ key: "new:a", members: ["a", "b"] }]);
    expect(r.moves.map((m) => [m.articleId, m.from, m.to, m.newStory])).toEqual([
      ["a", null, "new:a", true],
      ["b", null, "new:a", true],
    ]);
    expect(r.retired).toEqual([]);
  });

  it("rule 1: an old story plus a never-placed article stays the old story, and only the new article moves", () => {
    const r = reconcile([cluster(["old1", "old2", "fresh"])], current({ old1: "X", old2: "X", fresh: null }), stories({ X: 0 }));
    expect(r.newStories).toEqual([]);
    expect(r.moves.map((m) => [m.articleId, m.from, m.to])).toEqual([["fresh", null, "X"]]);
    expect(r.retired).toEqual([]);
  });

  it("rule 2: when two visible stories merge, the newer one survives and the older is retired into it", () => {
    const r = reconcile([cluster(["x1", "x2", "y1"])], current({ x1: "X", x2: "X", y1: "Y" }), stories({ X: 0, Y: 10 }));
    expect(r.moves.map((m) => [m.articleId, m.from, m.to]).sort()).toEqual([["x1", "X", "Y"], ["x2", "X", "Y"]]);
    expect(r.retired).toEqual([{ storyId: "X", mergedInto: "Y" }]);
  });

  it("rule 3: an article can always move out into its own story", () => {
    const r = reconcile([cluster(["a", "b"]), cluster(["c"])], current({ a: "X", b: "X", c: "X" }), stories({ X: 0 }));
    expect(r.moves.map((m) => [m.articleId, m.from, m.to, m.newStory])).toEqual([["c", "X", "new:c", true]]);
    expect(r.newStories).toEqual([{ key: "new:c", members: ["c"] }]);
    expect(r.retired).toEqual([]);
  });

  it("gives a story to the biggest cluster first, so a split keeps the card most people have seen", () => {
    const r = reconcile(
      [cluster(["a"]), cluster(["b", "c", "d"])],
      current({ a: "X", b: "X", c: "X", d: "X" }),
      stories({ X: 0 }),
    );
    expect(r.moves.map((m) => [m.articleId, m.to])).toEqual([["a", "new:a"]]);
  });

  it("never uses a story id for two clusters", () => {
    const r = reconcile(
      [cluster(["a", "b"]), cluster(["c", "d"])],
      current({ a: "X", b: "X", c: "X", d: "X" }),
      stories({ X: 0 }),
    );
    const targets = new Set<string>();
    for (const c of [["a", "b"], ["c", "d"]]) {
      const to = r.moves.find((m) => c.includes(m.articleId))?.to ?? "X";
      expect(targets.has(to)).toBe(false);
      targets.add(to);
    }
    expect(targets.size).toBe(2);
  });

  it("writes nothing for articles that stay where they are", () => {
    const r = reconcile([cluster(["a", "b"]), cluster(["c"])], current({ a: "X", b: "X", c: "Y" }), stories({ X: 0, Y: 5 }));
    expect(r.moves).toEqual([]);
    expect(r.newStories).toEqual([]);
    expect(r.retired).toEqual([]);
  });

  it("keeps a frozen or pinned cluster's own story, and lets never-placed articles join it", () => {
    const r = reconcile(
      [cluster(["f1", "f2", "fresh"], "S"), cluster(["o"])],
      current({ f1: "S", f2: "S", fresh: null, o: "T" }),
      stories({ S: 0, T: 50 }),
    );
    expect(r.moves.map((m) => [m.articleId, m.to])).toEqual([["fresh", "S"]]);
  });

  it("an identity cluster keeps its story even when a newer story's article joins it", () => {
    const r = reconcile([cluster(["f1", "n1"], "S")], current({ f1: "S", n1: "N" }), stories({ S: 0, N: 40 }));
    expect(r.moves.map((m) => [m.articleId, m.from, m.to])).toEqual([["n1", "N", "S"]]);
    expect(r.retired).toEqual([{ storyId: "N", mergedInto: "S" }]);
  });

  it("retires an emptied story into the survivor that took most of its members, newest on a tie", () => {
    const most = reconcile(
      [cluster(["a1", "a2", "b"]), cluster(["a3", "c"])],
      current({ a1: "X", a2: "X", a3: "X", b: "Y", c: "Z" }),
      stories({ X: 0, Y: 10, Z: 20 }),
    );
    // X's members split: a1 and a2 go to Y (the newer of X and Y), a3 goes to Z. Y took the most, so X retires into Y.
    expect(most.retired).toEqual([{ storyId: "X", mergedInto: "Y" }]);
    const tie = reconcile(
      [cluster(["a1", "y1"]), cluster(["a2", "z1"])],
      current({ a1: "X", a2: "X", y1: "Y", z1: "Z" }),
      stories({ X: 0, Y: 10, Z: 20 }),
    );
    expect(tie.retired).toEqual([{ storyId: "X", mergedInto: "Z" }]);
  });

  it("carries the merge evidence onto each move", () => {
    const merge: Merge = { a: ["a"], b: ["b"], L: 0.9, n: 1, dissent: 0, pairs: [["a", "b"]] };
    const r = reconcile([cluster(["a", "b"], null, [merge])], current({ a: null, b: null }), stories({}));
    expect(r.moves.every((m) => m.evidence.length === 1 && m.evidence[0].L === 0.9)).toBe(true);
  });

  it("gives the same changes whatever order the clusters come in", () => {
    const clusters = [cluster(["a", "b"]), cluster(["c", "d", "e"]), cluster(["f"])];
    const cur = current({ a: "X", b: "Y", c: "X", d: "X", e: null, f: "Y" });
    const st = stories({ X: 0, Y: 10 });
    expect(reconcile([...clusters].reverse(), cur, st)).toEqual(reconcile(clusters, cur, st));
  });
});
