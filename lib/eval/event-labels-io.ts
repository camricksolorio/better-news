// Export and import of the labelled events (story-clustering-v2 TDD part 8), the way pair labels are handled in
// lib/labels.ts: articles are keyed by guid so the labels survive a rebuild of derived data. An event keeps its own id,
// since events are created in the database and have no other stable key.
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { evalEventArticles, evalEvents, feedItems } from "@/db/schema";
import type { EvalEvent } from "./events";

export type EventArticleRecord = {
  guid: string;
  label: "in" | "related" | "out";
  labeler: string;
  createdAt: string;
};

export type EventRecord = {
  type: "event";
  id: string;
  title: string;
  split: "dev" | "holdout";
  note: string | null;
  createdAt: string;
  articles: EventArticleRecord[];
};

export async function exportEvents(db: Db): Promise<EventRecord[]> {
  const events = await db.select().from(evalEvents);
  const rows = await db
    .select({
      eventId: evalEventArticles.eventId,
      guid: feedItems.guid,
      label: evalEventArticles.label,
      labeler: evalEventArticles.labeler,
      createdAt: evalEventArticles.createdAt,
    })
    .from(evalEventArticles)
    .innerJoin(feedItems, eq(feedItems.id, evalEventArticles.articleId));

  return events
    .map((e): EventRecord => ({
      type: "event",
      id: e.id,
      title: e.title,
      split: e.split as EventRecord["split"],
      note: e.note,
      createdAt: e.createdAt.toISOString(),
      articles: rows
        .filter((r) => r.eventId === e.id)
        .map((r) => ({ guid: r.guid, label: r.label as EventArticleRecord["label"], labeler: r.labeler, createdAt: r.createdAt.toISOString() }))
        .sort((x, y) => x.guid.localeCompare(y.guid)),
    }))
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
}

export const toEventsJsonl = (records: EventRecord[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

export function parseEventsJsonl(text: string): EventRecord[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EventRecord)
    .filter((r) => r.type === "event");
}

export type EventImportResult = { events: number; labels: number; skippedMissingArticle: number };

// Idempotent: re-importing the same file leaves the same events and labels.
export async function importEvents(db: Db, records: EventRecord[]): Promise<EventImportResult> {
  const guids = [...new Set(records.flatMap((r) => r.articles.map((a) => a.guid)))];
  const idByGuid = new Map<string, string>();
  for (let i = 0; i < guids.length; i += 500) {
    const rows = await db
      .select({ id: feedItems.id, guid: feedItems.guid })
      .from(feedItems)
      .where(inArray(feedItems.guid, guids.slice(i, i + 500)));
    for (const r of rows) idByGuid.set(r.guid, r.id);
  }

  let labels = 0;
  let skipped = 0;
  for (const r of records) {
    await db
      .insert(evalEvents)
      .values({ id: r.id, title: r.title, split: r.split, note: r.note, createdAt: new Date(r.createdAt) })
      .onConflictDoUpdate({
        target: evalEvents.id,
        set: { title: r.title, split: r.split, note: r.note, createdAt: new Date(r.createdAt) },
      });
    for (const a of r.articles) {
      const articleId = idByGuid.get(a.guid);
      if (!articleId) {
        skipped++;
        continue;
      }
      await db
        .insert(evalEventArticles)
        .values({ eventId: r.id, articleId, label: a.label, labeler: a.labeler, createdAt: new Date(a.createdAt) })
        .onConflictDoUpdate({
          target: [evalEventArticles.eventId, evalEventArticles.articleId],
          set: { label: a.label, labeler: a.labeler, createdAt: new Date(a.createdAt) },
        });
      labels++;
    }
  }
  return { events: records.length, labels, skippedMissingArticle: skipped };
}

// An event as the metrics see it. Only events the owner has labelled beyond the sampler's seed count; the others
// would score a trivial recall of 1.
export function toEvalEvent(r: EventRecord): EvalEvent {
  return {
    id: r.id,
    title: r.title,
    split: r.split,
    labels: new Map(r.articles.map((a) => [a.guid, a.label])),
    humanLabeled: r.articles.some((a) => a.labeler !== "sampler"),
  };
}
