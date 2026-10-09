// The production Adjudicator for /api/cluster: resolves both articles from feed_items, asks the configured
// classifier, and applies τ. The eval harness has its own snapshot-backed version (lib/eval/adjudicator.ts).
import { inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { feedItems } from "@/db/schema";
import type { LlmClient } from "@/lib/llm";
import { cleanText } from "@/lib/text";
import type { Adjudicator } from "./assign";
import { DEFAULT_ADJUDICATOR, createAdjudicator, passes, type AdjudicationArticle, type AdjudicatorConfig } from "./adjudicate";

async function loadArticles(db: Db, ids: string[]): Promise<Map<string, AdjudicationArticle>> {
  const rows = await db
    .select({ id: feedItems.id, title: feedItems.title, sourceId: feedItems.sourceId, summary: feedItems.summary, publishedAt: feedItems.publishedAt, createdAt: feedItems.createdAt })
    .from(feedItems)
    .where(inArray(feedItems.id, ids));
  return new Map(
    rows.map((r) => [r.id, { id: r.id, title: cleanText(r.title), source: r.sourceId, time: r.publishedAt ?? r.createdAt, snippet: cleanText(r.summary) }]),
  );
}

export function createDbAdjudicator(db: Db, llm: Pick<LlmClient, "chat" | "classify">, cfg: AdjudicatorConfig = DEFAULT_ADJUDICATOR): Adjudicator {
  const { adjudicate } = createAdjudicator(llm, cfg);
  return async (article, memberId, candidate) => {
    const found = await loadArticles(db, [article.id, memberId]);
    const a = found.get(article.id);
    const m = found.get(memberId);
    if (!a || !m) throw new Error(`article not found: ${a ? memberId : article.id}`);
    const verdict = await adjudicate(a, m, { articleId: article.id, storyId: candidate.story.id });
    return { same: passes(verdict, cfg.tau), verdict: { relation: verdict.relation, pSame: verdict.pSame, model: verdict.model } };
  };
}
