import { describe, expect, it } from "vitest";
import { DEFAULT_CONSOLIDATE_CONFIG } from "@/lib/pipeline/consolidate-config";
import { createMemoryVerdictStore, pairKey, type StoredVerdict } from "@/lib/pipeline/judge";
import type { SnapshotArticle } from "./replay";
import { planTicks, runStrategy, TICK_MS, tickOf } from "./ticks";
import { createV2Strategy } from "./v2-strategy";

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 0, 0);
const at = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
// `hours` is when the article was stored (and, unless given, published).
const art = (guid: string, hours: number, deg: number, over: Partial<SnapshotArticle> = {}): SnapshotArticle => ({
  guid,
  sourceId: guid,
  title: guid,
  summary: "a reasonably long description, well over forty characters in all",
  time: new Date(T0 + hours * H).toISOString(),
  createdAt: new Date(T0 + hours * H).toISOString(),
  thin: false,
  embedding: at(deg),
  ...over,
});

const cfg = { ...DEFAULT_CONSOLIDATE_CONFIG, tLow: 0.84, adjudicator: { ...DEFAULT_CONSOLIDATE_CONFIG.adjudicator, model: "jev-latest" } };

// A judge that says "same" for the listed pairs and "different" for everything else, and counts its calls.
function judgeFor(same: string[], p = 0.9) {
  const asked: string[] = [];
  const set = new Set(same.map((s) => pairKey(...(s.split("|") as [string, string]))));
  const judge = async (a: SnapshotArticle, b: SnapshotArticle): Promise<StoredVerdict> => {
    asked.push(pairKey(a.guid, b.guid));
    return set.has(pairKey(a.guid, b.guid))
      ? { relation: "same", pSame: p, model: "jev-latest" }
      : { relation: "different", pSame: 0.05, model: "jev-latest" };
  };
  return { judge, asked };
}

const partition = (clusterOf: Map<string, string>) => {
  const byStory = new Map<string, string[]>();
  for (const [g, s] of clusterOf) byStory.set(s, [...(byStory.get(s) ?? []), g]);
  return [...byStory.values()].map((m) => m.sort()).sort((a, b) => a[0].localeCompare(b[0]));
};

// A clique of "same" pairs.
const sameAll = (ids: string[]) => ids.flatMap((a, i) => ids.slice(i + 1).map((b) => `${a}|${b}`));

describe("v2 strategy", () => {
  const event = ["a", "b", "c", "d"];

  it("puts an event reported across several ticks into one story", async () => {
    const articles = [art("a", 1, 0), art("b", 2, 3), art("c", 8, 5), art("d", 14, 2)];
    const { judge } = judgeFor(sameAll(event));
    const r = await runStrategy(planTicks(articles, {}), createV2Strategy({ cfg, judge }));
    expect(partition(r.clusterOf)).toEqual([event]);
  });

  it("does not let a wrong article block a correct one (R4)", async () => {
    const articles = [art("a", 1, 0), art("b", 2, 3), art("c", 3, 5), art("wrong", 4, 4), art("right", 9, 2)];
    // `wrong` looks close to everything but is judged different; `right` is the same event as a, b and c.
    const { judge } = judgeFor(sameAll(["a", "b", "c", "right"]));
    const r = await runStrategy(planTicks(articles, {}), createV2Strategy({ cfg, judge }));
    expect(partition(r.clusterOf)).toEqual([["a", "b", "c", "right"], ["wrong"]]);
  });

  it("gives the same groups whatever order articles arrive in", async () => {
    const articles = [art("a", 1, 0), art("b", 2, 3), art("c", 3, 5), art("d", 9, 2), art("e", 10, 80), art("f", 11, 82)];
    const same = [...sameAll(["a", "b", "c", "d"]), "e|f"];
    const expected = [["a", "b", "c", "d"], ["e", "f"]];
    for (const seed of [undefined, 1, 2, 3]) {
      const plan = planTicks(articles, seed === undefined ? {} : { shuffleSeed: seed, jitter: true });
      const { judge } = judgeFor(same);
      expect(partition((await runStrategy(plan, createV2Strategy({ cfg, judge }))).clusterOf)).toEqual(expected);
    }
  });

  it("lets a never-placed article join an old story without moving anything else (reader-safety rule 1)", async () => {
    const articles = [art("a", 1, 0), art("b", 2, 3), art("c", 20, 2)];
    const { judge } = judgeFor(sameAll(["a", "b", "c"]));
    const strategy = createV2Strategy({ cfg, judge });
    const run = strategy.start();
    const plan = planTicks(articles, {});
    await run.processTick(plan[0].batch, plan[0].tick);
    const before = new Map(run.clusterOf());
    await run.processTick(plan[1].batch, plan[1].tick);
    const after = run.clusterOf();
    expect(after.get("a")).toBe(before.get("a"));
    expect(after.get("b")).toBe(before.get("b"));
    expect(after.get("c")).toBe(before.get("a"));
  });

  it("merges two stories through a bridging article: the newer story survives and the older is retired (rule 2)", async () => {
    // a (0 deg) and b (60 deg) are 0.5 similar, so never a candidate pair; c (30 deg) is similar to both.
    const articles = [art("a", 1, 0), art("b", 8, 60), art("c", 14, 30)];
    const { judge, asked } = judgeFor(sameAll(["a", "b", "c"]));
    const run = createV2Strategy({ cfg, judge }).start();
    const plan = planTicks(articles, {});
    await run.processTick(plan[0].batch, plan[0].tick);
    await run.processTick(plan[1].batch, plan[1].tick);
    const [x, y] = [run.clusterOf().get("a"), run.clusterOf().get("b")];
    expect(x).not.toBe(y);
    await run.processTick(plan[2].batch, plan[2].tick);
    const final = run.clusterOf();
    expect(new Set([final.get("a"), final.get("b"), final.get("c")]).size).toBe(1);
    expect(final.get("a")).toBe(y); // b's story is newer, so it survives
    expect(asked).toContain(pairKey("a", "b")); // densified: the algorithm asked for the pair retrieval never proposed
  });

  it("keeps a frozen story's id when a late article joins it", async () => {
    const articles = [art("a", 1, 0), art("late", 1, 2, { createdAt: new Date(T0 + 100 * H).toISOString(), time: new Date(T0 + 20 * H).toISOString() })];
    const { judge } = judgeFor(["a|late"]);
    const run = createV2Strategy({ cfg, judge }).start();
    const plan = planTicks(articles, {});
    expect(plan).toHaveLength(2);
    await run.processTick(plan[0].batch, plan[0].tick);
    const storyOfA = run.clusterOf().get("a");
    await run.processTick(plan[1].batch, plan[1].tick);
    expect(run.clusterOf().get("late")).toBe(storyOfA);
    expect(run.clusterOf().get("a")).toBe(storyOfA);
  });

  it("reports the candidate pairs it retrieved", async () => {
    const articles = [art("a", 1, 0), art("b", 2, 3), art("far", 3, 90)];
    const { judge } = judgeFor([]);
    const r = await runStrategy(planTicks(articles, {}), createV2Strategy({ cfg, judge }));
    expect(r.candidatePairs).toEqual(new Set(["a|b"]));
  });

  it("reuses a shared verdict store, so a second run makes no calls", async () => {
    const articles = [art("a", 1, 0), art("b", 2, 3), art("c", 8, 5)];
    const store = createMemoryVerdictStore();
    const first = judgeFor(sameAll(["a", "b", "c"]));
    await runStrategy(planTicks(articles, {}), createV2Strategy({ cfg, judge: first.judge, store }));
    const second = judgeFor(sameAll(["a", "b", "c"]));
    await runStrategy(planTicks(articles, { shuffleSeed: 5 }), createV2Strategy({ cfg, judge: second.judge, store }));
    expect(second.asked).toEqual([]);
    expect(first.asked.length).toBeGreaterThan(0);
  });

  it("stops when the classifier returns a different model than the one pinned", async () => {
    const pinned = { ...cfg, adjudicator: { ...cfg.adjudicator, model: "jev-1.14.0" } };
    const judge = async (): Promise<StoredVerdict> => ({ relation: "same", pSame: 0.9, model: "jev-1.15.0" });
    const articles = [art("a", 1, 0), art("b", 2, 3)];
    await expect(runStrategy(planTicks(articles, {}), createV2Strategy({ cfg: pinned, judge }))).rejects.toThrow(/jev-1\.15\.0/);
  });

  it("uses the tick time as the story creation time", () => {
    expect(TICK_MS).toBe(6 * H);
    expect(tickOf(new Date(T0 + 1 * H).toISOString())).toBe(tickOf(new Date(T0 + 6 * H).toISOString()));
  });
});
