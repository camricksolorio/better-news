import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONSOLIDATE_CONFIG as DEFAULT } from "./consolidate-config";
import { createMemoryVerdictStore, judgePairs, pairKey, weightOf, type StoredVerdict } from "./judge";

const cfg = { ...DEFAULT, judgeConcurrency: 3 };
const verdict = (relation: StoredVerdict["relation"], pSame: number, model = "jev-1.14.0"): StoredVerdict => ({ relation, pSame, model });
const pairs = (...p: [string, string][]) => p;

describe("judgePairs", () => {
  it("judges unjudged pairs once and stores the verdicts in canonical order", async () => {
    const store = createMemoryVerdictStore();
    const judge = vi.fn(async () => verdict("same", 0.9));
    const result = await judgePairs({ pairs: pairs(["b", "a"], ["c", "d"]), store, judge, cfg });
    expect(result).toMatchObject({ judged: 2, cached: 0, failed: [], mismatched: [] });
    expect(store.get("a", "b")).toEqual(verdict("same", 0.9));
    expect(store.get("b", "a")).toEqual(verdict("same", 0.9));
    expect(judge).toHaveBeenCalledTimes(2);
    expect(judge.mock.calls.map((c) => (c as unknown[]).slice(0, 2)).sort()).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("makes no call for a pair that is already judged, in either order", async () => {
    const store = createMemoryVerdictStore();
    store.put("a", "b", verdict("related", 0.2));
    const judge = vi.fn(async () => verdict("same", 0.9));
    const result = await judgePairs({ pairs: pairs(["b", "a"]), store, judge, cfg });
    expect(judge).not.toHaveBeenCalled();
    expect(result).toMatchObject({ judged: 0, cached: 1 });
  });

  it("leaves a pair unjudged when the call fails, and reports it", async () => {
    const store = createMemoryVerdictStore();
    const judge = vi.fn(async (a: string) => {
      if (a === "x") throw new Error("llm down");
      return verdict("same", 0.9);
    });
    const result = await judgePairs({ pairs: pairs(["x", "y"], ["a", "b"]), store, judge, cfg });
    expect(result.failed).toEqual([["x", "y"]]);
    expect(store.get("x", "y")).toBeUndefined();
    expect(store.get("a", "b")).toBeDefined();
    expect(result.judged).toBe(1);
  });

  it("stops the whole run on an error the caller names as fatal", async () => {
    const fatal = new Error("budget");
    const judge = vi.fn(async () => {
      throw fatal;
    });
    await expect(judgePairs({ pairs: pairs(["a", "b"]), store: createMemoryVerdictStore(), judge, cfg, abortOn: (e) => e === fatal })).rejects.toBe(fatal);
  });

  it("reports a verdict whose model differs from the pinned one, but still stores it under its real version", async () => {
    const store = createMemoryVerdictStore();
    const judge = async () => verdict("same", 0.9, "jev-1.15.0");
    const result = await judgePairs({ pairs: pairs(["a", "b"]), store, judge, cfg, expectedModel: "jev-1.14.0" });
    expect(result.mismatched).toEqual([{ a: "a", b: "b", model: "jev-1.15.0" }]);
    expect(store.get("a", "b")?.model).toBe("jev-1.15.0");
  });

  it("does not call the model for a pair a human labelled", async () => {
    const store = createMemoryVerdictStore();
    const judge = vi.fn(async () => verdict("same", 0.9));
    const overrides = new Map([[pairKey("a", "b"), "related" as const]]);
    const result = await judgePairs({ pairs: pairs(["a", "b"], ["c", "d"]), store, judge, cfg, overrides });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ judged: 1, overridden: 1 });
  });

  it("runs at most judgeConcurrency calls at a time", async () => {
    let running = 0;
    let peak = 0;
    const judge = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return verdict("same", 0.9);
    };
    const many = Array.from({ length: 12 }, (_, i): [string, string] => [`a${i}`, `b${i}`]);
    await judgePairs({ pairs: many, store: createMemoryVerdictStore(), judge, cfg: { ...cfg, judgeConcurrency: 3 } });
    expect(peak).toBe(3);
  });

  it("starts no new call after the deadline, and reports what is left", async () => {
    const judge = vi.fn(async () => verdict("same", 0.9));
    const result = await judgePairs({ pairs: pairs(["a", "b"], ["c", "d"]), store: createMemoryVerdictStore(), judge, cfg, deadline: Date.now() - 1 });
    expect(judge).not.toHaveBeenCalled();
    expect(result.remaining).toBe(2);
  });
});

describe("weightOf", () => {
  it("uses p_same, and counts an unreadable verdict as zero", () => {
    expect(weightOf(verdict("same", 0.83))).toEqual({ w: 0.83, cannot: false });
    expect(weightOf(verdict("related", 0.3))).toEqual({ w: 0.3, cannot: false });
    expect(weightOf(verdict("invalid", 0.9))).toEqual({ w: 0, cannot: false });
  });

  it("lets a human label win: same is weight 1, related and different are cannot-links", () => {
    expect(weightOf(verdict("different", 0.1), "same")).toEqual({ w: 1, cannot: false });
    expect(weightOf(verdict("same", 0.99), "related")).toEqual({ w: 0, cannot: true });
    expect(weightOf(undefined, "different")).toEqual({ w: 0, cannot: true });
  });
});
