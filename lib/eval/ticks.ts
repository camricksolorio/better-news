// Simulates the six-hour cron over a snapshot (story-clustering-v2 TDD part 8): an article becomes visible at the
// first tick at or after it was stored, and a strategy is shown each tick's articles in turn. Seeded shuffles and
// tick jitter let the same data be replayed in different arrival orders to measure order dependence (R7).
import type { SnapshotArticle } from "./replay";

export const TICK_MS = 6 * 3_600_000;

export const tickOf = (iso: string): number => Math.ceil(new Date(iso).getTime() / TICK_MS);

export type TickPlan = { tick: number; batch: SnapshotArticle[] }[];

export type PlanOptions = {
  // Shuffle the order within each tick (and, with `jitter`, move each article by up to one tick either way).
  shuffleSeed?: number;
  jitter?: boolean;
};

// mulberry32: a small seeded generator, so the same seed always gives the same order.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const byTime = (x: SnapshotArticle, y: SnapshotArticle) =>
  new Date(x.time).getTime() - new Date(y.time).getTime() || x.guid.localeCompare(y.guid);

export function planTicks(articles: SnapshotArticle[], opts: PlanOptions): TickPlan {
  const random = opts.shuffleSeed === undefined ? null : rng(opts.shuffleSeed);
  const byTick = new Map<number, SnapshotArticle[]>();
  // Sorted first, so a seed gives the same plan whatever order the snapshot file is in.
  for (const a of [...articles].sort(byTime)) {
    let tick = tickOf(a.createdAt ?? a.time);
    if (random && opts.jitter) tick += Math.floor(random() * 3) - 1;
    byTick.set(tick, [...(byTick.get(tick) ?? []), a]);
  }
  return [...byTick]
    .sort((x, y) => x[0] - y[0])
    .map(([tick, batch]) => {
      const ordered = [...batch].sort(byTime);
      if (random) {
        for (let i = ordered.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
        }
      }
      return { tick, batch: ordered };
    });
}

// What the harness needs from a clustering method. v1's incremental assignment and v2's consolidation both fit.
export interface StrategyRun {
  // Called once per tick with the articles that became visible, in the order they should be processed.
  processTick(batch: SnapshotArticle[], tick: number): Promise<void>;
  clusterOf(): Map<string, string>;
  // Pairs ("a|b", ordered by guid) the method proposed for judging, when it has such a step (v2 retrieval).
  candidatePairs?(): Set<string> | null;
}

export interface Strategy {
  name: string;
  start(): StrategyRun;
}

export type RunResult = { clusterOf: Map<string, string>; candidatePairs: Set<string> | null; ticks: number };

export async function runStrategy(plan: TickPlan, strategy: Strategy): Promise<RunResult> {
  const run = strategy.start();
  for (const { tick, batch } of plan) await run.processTick(batch, tick);
  return { clusterOf: run.clusterOf(), candidatePairs: run.candidatePairs?.() ?? null, ticks: plan.length };
}
