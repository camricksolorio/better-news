// One-off cleanup for story-clustering-v2: marks existing rows that match a live-blog rule as excluded. It never
// touches stories; the repair (plan Phase 5) moves excluded rows out of them.
import { and, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db/types";
import { feedItems } from "@/db/schema";
import { isLiveBlog } from "@/lib/live-blog";

export type ExcludeResult = {
  total: number;
  bySource: Record<string, number>;
  // A few matches per source, for the owner's spot-check before a real run.
  samples: { sourceId: string; title: string; link: string }[];
};

const SAMPLES_PER_SOURCE = 4;

export async function excludeLiveBlogs(db: Db, opts: { dryRun: boolean }): Promise<ExcludeResult> {
  const rows = await db
    .select({ id: feedItems.id, sourceId: feedItems.sourceId, title: feedItems.title, link: feedItems.link })
    .from(feedItems)
    .where(isNull(feedItems.excludedReason));
  const matches = rows.filter((row) => isLiveBlog(row));

  const bySource: Record<string, number> = {};
  const samples: ExcludeResult["samples"] = [];
  for (const m of matches) {
    bySource[m.sourceId] = (bySource[m.sourceId] ?? 0) + 1;
    if (bySource[m.sourceId] <= SAMPLES_PER_SOURCE) samples.push({ sourceId: m.sourceId, title: m.title, link: m.link });
  }

  if (!opts.dryRun) {
    for (let i = 0; i < matches.length; i += 500) {
      await db
        .update(feedItems)
        .set({ excludedReason: "live_blog" })
        .where(and(inArray(feedItems.id, matches.slice(i, i + 500).map((m) => m.id)), isNull(feedItems.excludedReason)));
    }
  }
  return { total: matches.length, bySource, samples };
}
