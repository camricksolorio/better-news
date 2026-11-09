// Judges candidate pairs (story-clustering-v2 TDD part 4): asks the classifier about each pair that has no verdict yet
// and keeps the answer, so a pair is paid for once. `createMemoryVerdictStore` is the harness's cache; production keeps
// the same verdicts in `pair_verdicts`, keyed by the exact text versions judged.
import type { ConsolidateConfig } from "./consolidate-config";

export type Relation = "same" | "related" | "different" | "invalid";
export type StoredVerdict = { relation: Relation; pSame: number; model: string };
export type HumanLabel = "same" | "related" | "different";

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export interface VerdictStore {
  get(a: string, b: string): StoredVerdict | undefined;
  put(a: string, b: string, verdict: StoredVerdict): void;
}

export function createMemoryVerdictStore(): VerdictStore & { size(): number; entries(): [string, StoredVerdict][] } {
  const map = new Map<string, StoredVerdict>();
  return {
    get: (a, b) => map.get(pairKey(a, b)),
    put: (a, b, v) => void map.set(pairKey(a, b), v),
    size: () => map.size,
    entries: () => [...map],
  };
}

// The weight of a pair in the graph: a human label wins over the model ("same" is weight 1; "related" and "different"
// are cannot-links); otherwise p_same, with an unreadable verdict counting as zero.
export function weightOf(verdict: StoredVerdict | undefined, human?: HumanLabel): { w: number; cannot: boolean } {
  if (human === "same") return { w: 1, cannot: false };
  if (human) return { w: 0, cannot: true };
  if (!verdict || verdict.relation === "invalid") return { w: 0, cannot: false };
  return { w: verdict.pSame, cannot: false };
}

export type JudgeResult = {
  judged: number; // calls made this time
  cached: number; // pairs that already had a verdict
  overridden: number; // pairs a human labelled, so no call
  failed: [string, string][]; // calls that failed; the pair stays unjudged
  remaining: number; // pairs not started before the deadline
  // Verdicts whose resolved model differs from the pinned one. They are stored under their real version, and the run
  // must not commit on them (a changed model needs the evaluation re-run).
  mismatched: { a: string; b: string; model: string }[];
};

export type JudgeOptions = {
  pairs: [string, string][];
  store: VerdictStore;
  judge: (a: string, b: string) => Promise<StoredVerdict>;
  cfg: Pick<ConsolidateConfig, "judgeConcurrency">;
  overrides?: Map<string, HumanLabel>;
  expectedModel?: string;
  // A call that fails leaves that pair unjudged; an error named here stops the whole run (a spent call budget).
  abortOn?: (e: unknown) => boolean;
  // Epoch ms after which no new call starts.
  deadline?: number;
};

export async function judgePairs(opts: JudgeOptions): Promise<JudgeResult> {
  const result: JudgeResult = { judged: 0, cached: 0, overridden: 0, failed: [], remaining: 0, mismatched: [] };
  const todo: [string, string][] = [];
  const seen = new Set<string>();
  for (const [x, y] of opts.pairs) {
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = pairKey(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    if (opts.overrides?.has(key)) result.overridden++;
    else if (opts.store.get(a, b)) result.cached++;
    else todo.push([a, b]);
  }

  let next = 0;
  let fatal: unknown = null;
  const worker = async () => {
    while (fatal === null) {
      if (opts.deadline !== undefined && Date.now() > opts.deadline) return;
      const i = next++;
      if (i >= todo.length) return;
      const [a, b] = todo[i];
      try {
        const verdict = await opts.judge(a, b);
        opts.store.put(a, b, verdict);
        result.judged++;
        if (opts.expectedModel && verdict.model !== opts.expectedModel) result.mismatched.push({ a, b, model: verdict.model });
      } catch (e) {
        if (opts.abortOn?.(e)) {
          fatal = e;
          return;
        }
        result.failed.push([a, b]);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.cfg.judgeConcurrency) }, worker));
  if (fatal !== null) throw fatal;
  result.remaining = Math.max(0, todo.length - next);
  return result;
}
