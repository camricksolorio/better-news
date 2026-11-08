import { describe, expect, it } from "vitest";
import type { EvalEvent } from "./events";
import { reportRun } from "./event-report";

const ev = (labels: Record<string, "in" | "related" | "out">): EvalEvent => ({
  id: "e",
  title: "E",
  split: "dev",
  labels: new Map(Object.entries(labels)),
  humanLabeled: true,
});
const src = new Map([["a", "A"], ["b", "B"], ["c", "C"], ["r", "R"]]);

describe("reportRun", () => {
  it("scores events and the pairs they imply, and reports retrieval when the strategy has candidates", () => {
    const run = { clusterOf: new Map([["a", "S"], ["b", "S"], ["c", "T"], ["r", "S"]]), candidatePairs: new Set(["a|b"]), ticks: 2 };
    const r = reportRun(run, [ev({ a: "in", b: "in", c: "in", r: "related" })], src, []);
    expect(r.summary.all).toMatchObject({ events: 1, meanRecall: 2 / 3 });
    // Derived pairs: a-b same (together), a-c and b-c same (apart), a-r, b-r, c-r related (a-r and b-r merged).
    expect(r.pairs.counts).toMatchObject({ tp: 1, fn: 2, related: 3, relatedMerged: 2 });
    expect(r.retrieval).toEqual({ pairs: 3, found: 1, recall: 1 / 3 });
    expect(r.stories).toBe(2);
  });

  it("lets a directly labelled pair override the pair an event implies", () => {
    const run = { clusterOf: new Map([["a", "S"], ["b", "S"]]), candidatePairs: null, ticks: 1 };
    const r = reportRun(run, [ev({ a: "in", b: "in" })], src, [{ a: "b", b: "a", label: "related" }]);
    expect(r.pairs.counts).toMatchObject({ tp: 0, fp: 1, related: 1, relatedMerged: 1 });
    expect(r.retrieval).toBeNull();
  });
});
