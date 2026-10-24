// Stores one source's parsed items (story-clustering-v2 TDD part 1): live blogs are dropped, every other item is
// upserted by guid, and a change to the title or summary becomes a new article version.
import { inArray, and, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { feedItems } from "@/db/schema";
import { contentHash } from "@/lib/content-hash";
import { isLiveBlog } from "@/lib/live-blog";
import type { ParsedFeedItem } from "@/lib/rss";

export type StoreResult = { stored: number; excluded: number };

export async function storeFeedItems(db: Db, sourceId: string, parsed: ParsedFeedItem[]): Promise<StoreResult> {
  // A feed that repeats a guid would make one INSERT touch the same row twice.
  const items = [...new Map(parsed.map((item) => [item.guid, item])).values()];
  const live = items.filter((item) => isLiveBlog({ sourceId, link: item.link, title: item.title }));
  const keep = items.filter((item) => !live.includes(item));

  // An existing row whose link or title now matches a live-blog rule leaves clustering. It is not updated further.
  if (live.length > 0) {
    await db
      .update(feedItems)
      .set({ excludedReason: "live_blog" })
      .where(and(inArray(feedItems.guid, live.map((item) => item.guid)), isNull(feedItems.excludedReason)));
  }
  if (keep.length === 0) return { stored: 0, excluded: live.length };

  // first_published_at is left out on purpose: a trigger sets it on insert and nothing updates it.
  await db
    .insert(feedItems)
    .values(
      keep.map((item) => ({
        sourceId,
        guid: item.guid,
        title: item.title,
        link: item.link,
        summary: item.summary,
        imageUrl: item.imageUrl,
        publishedAt: item.publishedAt,
        contentHash: contentHash(item.title, item.summary),
      })),
    )
    .onConflictDoUpdate({
      target: feedItems.guid,
      set: {
        title: sql`excluded.title`,
        link: sql`excluded.link`,
        summary: sql`excluded.summary`,
        imageUrl: sql`excluded.image_url`,
        publishedAt: sql`excluded.published_at`,
        contentHash: sql`excluded.content_hash`,
      },
      // Rows already excluded stay as they were.
      setWhere: isNull(feedItems.excludedReason),
    });

  const guids = sql.join(keep.map((item) => sql`${item.guid}`), sql`, `);
  await db.execute(sql`
    INSERT INTO article_versions (article_id, title, summary, published_at, content_hash)
    SELECT id, title, summary, published_at, content_hash FROM feed_items
    WHERE guid IN (${guids}) AND excluded_reason IS NULL
    ON CONFLICT (article_id, content_hash) DO NOTHING
  `);
  await db.execute(sql`
    UPDATE feed_items f SET current_version_id = v.id
    FROM article_versions v
    WHERE v.article_id = f.id AND v.content_hash = f.content_hash
      AND f.guid IN (${guids}) AND f.excluded_reason IS NULL
      AND f.current_version_id IS DISTINCT FROM v.id
  `);

  return { stored: keep.length, excluded: live.length };
}
