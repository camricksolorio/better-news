// Adjudicator for the replay harness: looks each article up in the snapshot, asks the configured classifier,
// and applies τ. Counts calls, and refuses to go past a call budget so a replay cannot spend unexpectedly.
import { cleanText } from "@/lib/text";
import type { Adjudicator } from "@/lib/pipeline/assign";
import { chatMessages, passes, type AdjudicationArticle, type Verdict } from "@/lib/pipeline/adjudicate";
import type { SnapshotArticle } from "./replay";

export class BudgetExceededError extends Error {
  constructor(readonly maxCalls: number) {
    super(`call budget of ${maxCalls} classifier calls reached`);
    this.name = "BudgetExceededError";
  }
}

export type AdjudicatorStats = {
  // Calls that reached the model (cache misses) and calls answered from the verdict cache.
  calls: number;
  cached: number;
  invalid: number;
  failed: number;
};

export function toAdjudicationArticle(a: SnapshotArticle): AdjudicationArticle {
  return { id: a.guid, title: cleanText(a.title), source: a.sourceId, time: a.time, snippet: cleanText(a.summary) };
}

export function snapshotAdjudicator(args: {
  snapshot: SnapshotArticle[];
  judge: (article: AdjudicationArticle, member: AdjudicationArticle) => Promise<Verdict>;
  tau: number;
  maxCalls?: number;
}): { adjudicate: Adjudicator; stats: AdjudicatorStats } {
  const byGuid = new Map(args.snapshot.map((a) => [a.guid, toAdjudicationArticle(a)]));
  const stats: AdjudicatorStats = { calls: 0, cached: 0, invalid: 0, failed: 0 };

  const adjudicate: Adjudicator = async (article, memberId) => {
    const a = byGuid.get(article.id);
    const m = byGuid.get(memberId);
    if (!a || !m) throw new Error(`article missing from the snapshot: ${a ? memberId : article.id}`);
    if (args.maxCalls !== undefined && stats.calls >= args.maxCalls) throw new BudgetExceededError(args.maxCalls);
    let verdict: Verdict;
    try {
      verdict = await args.judge(a, m);
    } catch (e) {
      stats.failed++;
      throw e;
    }
    if (verdict.cached) stats.cached++;
    else stats.calls++;
    if (verdict.relation === "invalid") stats.invalid++;
    return { same: passes(verdict, args.tau), verdict: { relation: verdict.relation, pSame: verdict.pSame, model: verdict.model } };
  };
  return { adjudicate, stats };
}

// Dry-run stand-in: spends nothing, says "no" (so exactly one call per article that reaches the classifier),
// and measures the prompt size of every pair it is asked about.
export function measuringAdjudicator(snapshot: SnapshotArticle[]): { adjudicate: Adjudicator; measured: { calls: number; inputChars: number } } {
  const byGuid = new Map(snapshot.map((a) => [a.guid, toAdjudicationArticle(a)]));
  const measured = { calls: 0, inputChars: 0 };
  const adjudicate: Adjudicator = async (article, memberId) => {
    measured.calls++;
    measured.inputChars += chatMessages(byGuid.get(article.id)!, byGuid.get(memberId)!).reduce((n, m) => n + m.content.length, 0);
    return { same: false };
  };
  return { adjudicate, measured };
}
