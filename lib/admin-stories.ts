// Data and actions behind the stories inspector (/admin/stories): list stories, show a story's members with
// why each joined, and the "doesn't belong" action, which turns a production mistake into eval data.
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { evalPairLabels, feedItems, stories, storyAssignments } from "@/db/schema";
import { cleanText } from "@/lib/text";
import { DEFAULT_CLUSTER_CONFIG, type ClusterConfig } from "@/lib/pipeline/assign";

export const DOESNT_BELONG_LABELS = ["related", "different"] as const;
export type DoesntBelongLabel = (typeof DOESNT_BELONG_LABELS)[number];

export type StoryFilter = { status?: "open" | "closed"; minArticles?: number; limit?: number; offset?: number };
export type StorySummary = {
  id: string;
  status: string;
  firstArticleAt: Date;
  lastArticleAt: Date;
  articleCount: number;
  sourceCount: number;
  headline: string;
};

// Newest first. Most stories are a single article, so the inspector defaults to stories with at least two.
export async function listStories(db: Db, filter: StoryFilter = {}): Promise<{ rows: StorySummary[]; total: number }> {
  const min = filter.minArticles ?? 2;
  const where = and(sql`${stories.articleCount} >= ${min}`, filter.status ? eq(stories.status, filter.status) : undefined);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(stories).where(where);
  const rows = (await db.execute(sql`
    SELECT stories.id, stories.status, stories.first_article_at, stories.last_article_at, stories.article_count, stories.source_count,
           (SELECT f.title FROM feed_items f WHERE f.story_id = stories.id ORDER BY coalesce(f.published_at, f.created_at), f.id LIMIT 1) AS headline
    FROM stories
    WHERE ${where}
    ORDER BY stories.last_article_at DESC, stories.id
    LIMIT ${filter.limit ?? 50} OFFSET ${filter.offset ?? 0}
  `)) as unknown as {
    id: string;
    status: string;
    first_article_at: Date;
    last_article_at: Date;
    article_count: number;
    source_count: number;
    headline: string | null;
  }[];
  return {
    total: n,
    rows: rows.map((r) => ({
      id: r.id,
      status: r.status,
      firstArticleAt: new Date(r.first_article_at),
      lastArticleAt: new Date(r.last_article_at),
      articleCount: r.article_count,
      sourceCount: r.source_count,
      headline: cleanText(r.headline ?? ""),
    })),
  };
}

export type JudgedMember = { memberId: string; title: string; same: boolean; relation?: string; pSame?: number; model?: string };
export type StoryMember = {
  id: string;
  title: string;
  source: string;
  link: string;
  time: Date;
  method: string | null;
  topScore: number | null;
  centroidScore: number | null;
  assignedAt: Date | null;
  judgedAgainst: JudgedMember[];
};
export type StoryDetail = {
  id: string;
  status: string;
  firstArticleAt: Date;
  lastArticleAt: Date;
  windowEndsAt: Date;
  articleCount: number;
  sourceCount: number;
  members: StoryMember[];
};

type Verdict = { memberId?: string; same?: boolean; verdict?: { relation?: string; pSame?: number; model?: string } };

export async function loadStory(db: Db, storyId: string): Promise<StoryDetail | null> {
  const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
  if (!story) return null;
  const members = await db
    .select({ id: feedItems.id, title: feedItems.title, source: feedItems.sourceId, link: feedItems.link, publishedAt: feedItems.publishedAt, createdAt: feedItems.createdAt })
    .from(feedItems)
    .where(eq(feedItems.storyId, storyId));

  // The decision that placed each member: its latest assignment.
  const ids = members.map((m) => m.id);
  const log = ids.length
    ? await db
        .selectDistinctOn([storyAssignments.articleId])
        .from(storyAssignments)
        .where(inArray(storyAssignments.articleId, ids))
        .orderBy(storyAssignments.articleId, sql`${storyAssignments.createdAt} DESC`)
    : [];
  const byArticle = new Map(log.map((a) => [a.articleId, a]));

  // Titles for the members each join was judged against (they may have since left the story).
  const judgedIds = [...new Set(log.flatMap((a) => (Array.isArray(a.llmVerdict) ? (a.llmVerdict as Verdict[]).map((v) => v.memberId).filter((x): x is string => !!x) : [])))];
  const known = new Map(members.map((m) => [m.id, m.title]));
  const missing = judgedIds.filter((id) => !known.has(id));
  if (missing.length) {
    for (const r of await db.select({ id: feedItems.id, title: feedItems.title }).from(feedItems).where(inArray(feedItems.id, missing))) known.set(r.id, r.title);
  }

  const detail = members
    .map<StoryMember>((m) => {
      const a = byArticle.get(m.id);
      const verdicts = a && Array.isArray(a.llmVerdict) ? (a.llmVerdict as Verdict[]) : [];
      return {
        id: m.id,
        title: cleanText(m.title),
        source: m.source,
        link: m.link,
        time: m.publishedAt ?? m.createdAt,
        method: a?.method ?? null,
        topScore: a?.topScore ?? null,
        centroidScore: a?.centroidScore ?? null,
        assignedAt: a?.createdAt ?? null,
        judgedAgainst: verdicts
          .filter((v): v is Verdict & { memberId: string } => !!v.memberId)
          .map((v) => ({ memberId: v.memberId, title: cleanText(known.get(v.memberId) ?? ""), same: !!v.same, relation: v.verdict?.relation, pSame: v.verdict?.pSame, model: v.verdict?.model })),
      };
    })
    .sort((x, y) => x.time.getTime() - y.time.getTime() || x.id.localeCompare(y.id));

  return { id: story.id, status: story.status, firstArticleAt: story.firstArticleAt, lastArticleAt: story.lastArticleAt, windowEndsAt: story.windowEndsAt, articleCount: story.articleCount, sourceCount: story.sourceCount, members: detail };
}

// "This article doesn't belong in this story." In one transaction it
//  1. records a human label (`related` or `different`) for the article against the members the classifier judged it
//     against (or, if it was not joined by the classifier, the story's earliest other member),
//  2. moves the article into a story of its own and logs a `manual` assignment, and
//  3. recomputes the old story from the members that remain.
// Production mistakes then show up in the eval labels. It does not re-run the classifier.
export async function markDoesntBelong(
  db: Db,
  storyId: string,
  articleId: string,
  label: DoesntBelongLabel,
  cfg: ClusterConfig = DEFAULT_CLUSTER_CONFIG,
): Promise<{ newStoryId: string; labeledAgainst: string[] }> {
  if (!DOESNT_BELONG_LABELS.includes(label)) throw new Error(`invalid label: ${label}`);

  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ id: stories.id }).from(stories).where(eq(stories.id, storyId)).for("update");
    if (!locked) throw new Error("story not found");

    const [article] = await tx.select().from(feedItems).where(eq(feedItems.id, articleId));
    if (!article || article.storyId !== storyId) throw new Error("that article is not in this story");
    if (!article.embedding) throw new Error("that article has no embedding");

    const others = await tx
      .select({ id: feedItems.id })
      .from(feedItems)
      .where(and(eq(feedItems.storyId, storyId), ne(feedItems.id, articleId)))
      .orderBy(sql`coalesce(${feedItems.publishedAt}, ${feedItems.createdAt})`, feedItems.id);
    if (others.length === 0) throw new Error("it is the only article in this story");

    // Who it was judged against, if it joined through the classifier.
    const [placed] = await tx
      .select({ llmVerdict: storyAssignments.llmVerdict })
      .from(storyAssignments)
      .where(and(eq(storyAssignments.articleId, articleId), eq(storyAssignments.storyId, storyId), eq(storyAssignments.method, "llm")))
      .orderBy(sql`${storyAssignments.createdAt} DESC`)
      .limit(1);
    const stillThere = new Set(others.map((o) => o.id));
    const judged = Array.isArray(placed?.llmVerdict) ? (placed.llmVerdict as Verdict[]).map((v) => v.memberId).filter((id): id is string => !!id && stillThere.has(id)) : [];
    const labeledAgainst = judged.length ? [...new Set(judged)] : [others[0].id];

    for (const memberId of labeledAgainst) {
      const [a, b] = articleId < memberId ? [articleId, memberId] : [memberId, articleId];
      await tx
        .insert(evalPairLabels)
        .values({ articleA: a, articleB: b, label, labeler: "human", note: `inspector:${storyId}` })
        .onConflictDoUpdate({
          target: [evalPairLabels.articleA, evalPairLabels.articleB, evalPairLabels.labeler],
          set: { label, note: `inspector:${storyId}`, createdAt: new Date() },
        });
    }

    // A story of its own, built the way the pipeline builds one.
    const time = article.publishedAt ?? article.createdAt;
    const windowEndsAt = new Date(time.getTime() + cfg.windowHours * 3_600_000);
    const [fresh] = await tx
      .insert(stories)
      .values({ firstArticleAt: time, lastArticleAt: time, windowEndsAt, centroid: article.embedding, status: windowEndsAt.getTime() < Date.now() ? "closed" : "open" })
      .returning({ id: stories.id });
    await tx.update(feedItems).set({ storyId: fresh.id }).where(eq(feedItems.id, articleId));
    await tx.insert(storyAssignments).values({
      articleId,
      storyId: fresh.id,
      method: "manual",
      pipelineVersion: "admin",
      llmVerdict: { action: "doesnt_belong", label, fromStoryId: storyId, labeledAgainst },
    });

    // The old story, recomputed from the members that remain (the centroid is the plain mean, as the pipeline keeps it).
    await tx.execute(sql`
      UPDATE stories s SET
        article_count = m.n,
        source_count = m.sources,
        first_article_at = m.first_at,
        last_article_at = m.last_at,
        window_ends_at = m.first_at + (${cfg.windowHours}::double precision * interval '1 hour'),
        centroid = m.centroid
      FROM (
        SELECT count(*)::int AS n,
               count(DISTINCT source_id)::int AS sources,
               min(coalesce(published_at, created_at)) AS first_at,
               max(coalesce(published_at, created_at)) AS last_at,
               avg(embedding) AS centroid
        FROM feed_items WHERE story_id = ${storyId}
      ) m
      WHERE s.id = ${storyId}
    `);

    return { newStoryId: fresh.id, labeledAgainst };
  });
}
