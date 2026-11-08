// The event-labelling queue (story-clustering-v2 TDD part 8): for one event, proposes the articles the owner should
// judge next and stores the labels. Candidates are articles within 48h and cosine 0.70 of any article already marked
// `in`, so they widen as more `in` articles are found.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { evalEventArticles, evalEvents, feedItems } from "@/db/schema";
import { cleanText } from "@/lib/text";

export const EVENT_LABELS = ["in", "related", "out"] as const;
export type EventLabel = (typeof EVENT_LABELS)[number];

export const CANDIDATE_WINDOW_HOURS = 48;
export const CANDIDATE_MIN_COSINE = 0.7;
export const CANDIDATE_LIMIT = 40;

export type EventArticle = {
  id: string;
  title: string;
  source: string;
  time: string;
  snippet: string;
  link: string;
};
export type LabeledArticle = EventArticle & { label: EventLabel; labeler: string };
export type Candidate = EventArticle & { similarity: number };
export type LoadedEvent = {
  event: { id: string; title: string; note: string | null; split: string };
  labeled: LabeledArticle[];
  candidates: Candidate[];
};

type ArticleRow = {
  id: string;
  title: string;
  source_id: string;
  summary: string | null;
  link: string;
  first_published_at: Date | string;
};

const toArticle = (r: ArticleRow): EventArticle => ({
  id: r.id,
  title: cleanText(r.title),
  source: r.source_id,
  time: new Date(r.first_published_at).toISOString(),
  snippet: cleanText(r.summary).slice(0, 1000),
  link: r.link,
});

export async function proposeCandidates(db: Db, eventId: string, limit = CANDIDATE_LIMIT): Promise<Candidate[]> {
  const rows = (await db.execute(sql`
    WITH ins AS (
      SELECT a.embedding, a.first_published_at AS t
      FROM eval_event_articles ea JOIN feed_items a ON a.id = ea.article_id
      WHERE ea.event_id = ${eventId} AND ea.label = 'in' AND a.embedding IS NOT NULL
    )
    SELECT f.id, f.title, f.source_id, f.summary, f.link, f.first_published_at,
           max(1 - (f.embedding <=> ins.embedding)) AS similarity
    FROM feed_items f
    JOIN ins ON f.first_published_at BETWEEN ins.t - (${CANDIDATE_WINDOW_HOURS} * interval '1 hour')
                                         AND ins.t + (${CANDIDATE_WINDOW_HOURS} * interval '1 hour')
    WHERE f.excluded_reason IS NULL AND f.embedding IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM eval_event_articles x WHERE x.event_id = ${eventId} AND x.article_id = f.id)
    GROUP BY f.id
    HAVING max(1 - (f.embedding <=> ins.embedding)) >= ${CANDIDATE_MIN_COSINE}
    ORDER BY similarity DESC, f.id
    LIMIT ${limit}
  `)) as unknown as (ArticleRow & { similarity: number })[];
  return rows.map((r) => ({ ...toArticle(r), similarity: Number(r.similarity) }));
}

export async function loadEvent(db: Db, eventId: string): Promise<LoadedEvent | null> {
  const [event] = await db
    .select({ id: evalEvents.id, title: evalEvents.title, note: evalEvents.note, split: evalEvents.split })
    .from(evalEvents)
    .where(eq(evalEvents.id, eventId));
  if (!event) return null;

  const labeledRows = (await db.execute(sql`
    SELECT f.id, f.title, f.source_id, f.summary, f.link, f.first_published_at, ea.label, ea.labeler
    FROM eval_event_articles ea JOIN feed_items f ON f.id = ea.article_id
    WHERE ea.event_id = ${eventId}
    ORDER BY f.first_published_at, f.id
  `)) as unknown as (ArticleRow & { label: EventLabel; labeler: string })[];
  const labeled = labeledRows.map((r) => ({ ...toArticle(r), label: r.label, labeler: r.labeler }));

  return { event, labeled, candidates: await proposeCandidates(db, eventId) };
}

export async function saveEventLabel(db: Db, eventId: string, articleId: string, label: EventLabel) {
  if (!EVENT_LABELS.includes(label)) throw new Error(`invalid label: ${label}`);
  const [event] = await db.select({ id: evalEvents.id }).from(evalEvents).where(eq(evalEvents.id, eventId));
  if (!event) throw new Error("unknown event");
  const [article] = await db.select({ id: feedItems.id }).from(feedItems).where(eq(feedItems.id, articleId));
  if (!article) throw new Error("unknown article");
  await db
    .insert(evalEventArticles)
    .values({ eventId, articleId, label, labeler: "human" })
    .onConflictDoUpdate({
      target: [evalEventArticles.eventId, evalEventArticles.articleId],
      set: { label, labeler: "human", createdAt: new Date() },
    });
}

// Takes a human label back so the article returns to the queue. The sampler's seed stays: an event needs an `in`
// article to propose anything.
export async function clearEventLabel(db: Db, eventId: string, articleId: string) {
  await db
    .delete(evalEventArticles)
    .where(and(eq(evalEventArticles.eventId, eventId), eq(evalEventArticles.articleId, articleId), eq(evalEventArticles.labeler, "human")));
}

export type EventSummary = {
  id: string;
  title: string;
  note: string | null;
  split: string;
  in: number;
  related: number;
  out: number;
  human: number;
};

export async function listEvents(db: Db): Promise<EventSummary[]> {
  const rows = (await db.execute(sql`
    SELECT e.id, e.title, e.note, e.split,
           count(*) FILTER (WHERE ea.label = 'in')::int AS "in",
           count(*) FILTER (WHERE ea.label = 'related')::int AS related,
           count(*) FILTER (WHERE ea.label = 'out')::int AS "out",
           count(*) FILTER (WHERE ea.labeler = 'human')::int AS human
    FROM eval_events e LEFT JOIN eval_event_articles ea ON ea.event_id = e.id
    GROUP BY e.id
    ORDER BY e.split, e.created_at, e.id
  `)) as unknown as EventSummary[];
  return rows;
}
