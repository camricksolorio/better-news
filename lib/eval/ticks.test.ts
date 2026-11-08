import { describe, expect, it } from "vitest";
import type { SnapshotArticle } from "./replay";
import { planTicks, runStrategy, tickOf, TICK_MS, type Strategy } from "./ticks";

const H = 3_600_000;
const T = Date.UTC(2026, 9, 20, 0, 0); // a tick boundary: 00:00 UTC

const art = (guid: string, createdHours: number, timeHours = createdHours): SnapshotArticle => ({
  guid,
  sourceId: "s",
  title: guid,
  summary: null,
  time: new Date(T + timeHours * H).toISOString(),
  createdAt: new Date(T + createdHours * H).toISOString(),
  thin: false,
  embedding: [1, 0],
});

describe("tickOf", () => {
  it("puts an article in the first 6h tick at or after it was stored", () => {
    expect(tickOf(new Date(T + 1 * H).toISOString())).toBe(tickOf(new Date(T + 6 * H).toISOString()));
    expect(tickOf(new Date(T + 6 * H + 1).toISOString())).toBe(tickOf(new Date(T + 6 * H).toISOString()) + 1);
    expect(TICK_MS).toBe(6 * H);
  });
});

describe("planTicks", () => {
  const items = [art("a", 1), art("b", 2), art("c", 5), art("d", 7), art("e", 13)];

  it("groups articles by tick in time order, each batch sorted by time", () => {
    const plan = planTicks(items, {});
    expect(plan.map((p) => p.batch.map((a) => a.guid))).toEqual([["a", "b", "c"], ["d"], ["e"]]);
    expect(plan[0].tick).toBeLessThan(plan[1].tick);
  });

  it("orders a batch by first_published_at, not by when it was stored", () => {
    const plan = planTicks([art("late-pub", 1, 3), art("early-pub", 2, 0.5)], {});
    expect(plan[0].batch.map((a) => a.guid)).toEqual(["early-pub", "late-pub"]);
  });

  it("is deterministic for a seed and shuffles within a tick without moving articles between ticks", () => {
    const many = Array.from({ length: 12 }, (_, i) => art(`x${i}`, 1 + i * 0.1));
    const a = planTicks(many, { shuffleSeed: 7 });
    const b = planTicks(many, { shuffleSeed: 7 });
    expect(a.map((p) => p.batch.map((x) => x.guid))).toEqual(b.map((p) => p.batch.map((x) => x.guid)));
    expect(a).toHaveLength(1);
    expect(a[0].batch.map((x) => x.guid)).not.toEqual(many.map((x) => x.guid));
    expect([...a[0].batch.map((x) => x.guid)].sort()).toEqual(many.map((x) => x.guid).sort());
  });

  it("jitters each article's tick by at most one", () => {
    const many = Array.from({ length: 60 }, (_, i) => art(`j${i}`, 7 + (i % 5) * 0.1));
    const base = tickOf(many[0].createdAt!);
    const plan = planTicks(many, { shuffleSeed: 3, jitter: true });
    const ticks = plan.map((p) => p.tick);
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(base - 1);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(base + 1);
    expect(new Set(ticks).size).toBeGreaterThan(1);
    expect(plan.flatMap((p) => p.batch)).toHaveLength(60);
  });

  it("falls back to the clustering time when an article has no stored time", () => {
    const { createdAt: _drop, ...bare } = art("z", 1);
    expect(planTicks([bare as SnapshotArticle], {})).toHaveLength(1);
  });
});

describe("runStrategy", () => {
  it("shows a strategy each tick's batch in order, with only the articles stored so far", async () => {
    const seen: string[][] = [];
    const strategy: Strategy = {
      name: "fake",
      start: () => ({
        async processTick(batch) {
          seen.push(batch.map((a) => a.guid));
        },
        clusterOf: () => new Map([["a", "S"]]),
        candidatePairs: () => new Set(["a|b"]),
      }),
    };
    const result = await runStrategy(planTicks([art("a", 1), art("d", 7), art("b", 2)], {}), strategy);
    expect(seen).toEqual([["a", "b"], ["d"]]);
    expect(result.clusterOf.get("a")).toBe("S");
    expect(result.candidatePairs).toEqual(new Set(["a|b"]));
  });
});
