import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError, measuringAdjudicator, snapshotAdjudicator } from "./adjudicator";
import { replay, type SnapshotArticle } from "./replay";
import { DEFAULT_CLUSTER_CONFIG } from "@/lib/pipeline/assign";
import type { Verdict } from "@/lib/pipeline/adjudicate";

const at = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0, 0];
const snap = (guid: string, hour: number, deg: number, thin = false): SnapshotArticle => ({
  guid,
  sourceId: "s",
  title: `Title ${guid}`,
  summary: "summary text ".repeat(10),
  time: new Date(Date.UTC(2026, 9, 1, hour)).toISOString(),
  thin,
  embedding: at(deg),
});
const same = (pSame: number, cached = false): Verdict => ({ relation: "same", pSame, cached, model: "m" });

const cfg = { ...DEFAULT_CLUSTER_CONFIG, tLow: 0.9 };

describe("snapshotAdjudicator", () => {
  it("applies τ to p_same and tallies calls and cache hits", async () => {
    const snapshot = [snap("a", 0, 0), snap("b", 1, 1), snap("c", 2, 2)];
    const judge = vi.fn()
      .mockResolvedValueOnce(same(0.95)) // b vs a: joins
      .mockResolvedValueOnce(same(0.85, true)); // c vs a: below τ, cached
    const { adjudicate, stats } = snapshotAdjudicator({ snapshot, judge, tau: 0.9 });
    const r = await replay(snapshot, [], cfg, { adjudicate });
    expect(r.clusterOf.get("a")).toBe(r.clusterOf.get("b"));
    expect(r.clusterOf.get("c")).not.toBe(r.clusterOf.get("a"));
    expect(stats).toMatchObject({ calls: 1, cached: 1, failed: 0 });
  });

  it("stops the whole replay once the call budget is spent, before another call is made", async () => {
    const snapshot = [snap("a", 0, 0), snap("b", 1, 1), snap("c", 2, 2)];
    const judge = vi.fn().mockResolvedValue(same(0.99));
    const { adjudicate } = snapshotAdjudicator({ snapshot, judge, tau: 0.9, maxCalls: 1 });
    await expect(replay(snapshot, [], cfg, { adjudicate, abortOn: (e) => e instanceof BudgetExceededError })).rejects.toThrow(/budget/);
    expect(judge).toHaveBeenCalledTimes(1); // b's call used the budget; c was refused before any call
  });

  it("a failed call leaves that article unclustered and the replay carries on", async () => {
    const snapshot = [snap("a", 0, 0), snap("b", 1, 1), snap("c", 2, 90)];
    const judge = vi.fn().mockRejectedValue(new Error("jev 500"));
    const { adjudicate, stats } = snapshotAdjudicator({ snapshot, judge, tau: 0.9 });
    const r = await replay(snapshot, [], cfg, { adjudicate, abortOn: () => false });
    expect(r.failed).toEqual(["b"]);
    expect(r.clusterOf.has("b")).toBe(false);
    expect(r.clusterOf.has("c")).toBe(true);
    expect(stats.failed).toBe(1);
  });

  it("counts unreadable verdicts and treats them as rejections", async () => {
    const snapshot = [snap("a", 0, 0), snap("b", 1, 1)];
    const judge = vi.fn().mockResolvedValue({ relation: "invalid", pSame: 0, cached: false, model: "m" } satisfies Verdict);
    const { adjudicate, stats } = snapshotAdjudicator({ snapshot, judge, tau: 0 });
    const r = await replay(snapshot, [], cfg, { adjudicate });
    expect(r.stories).toBe(2);
    expect(stats.invalid).toBe(1);
  });
});

describe("measuringAdjudicator", () => {
  it("makes one call per article that reaches the classifier and sizes the prompts", async () => {
    const snapshot = [snap("a", 0, 0), snap("b", 1, 1), snap("c", 2, 90)];
    const { adjudicate, measured } = measuringAdjudicator(snapshot);
    await replay(snapshot, [], cfg, { adjudicate });
    expect(measured.calls).toBe(1);
    expect(measured.inputChars).toBeGreaterThan(300);
  });
});
