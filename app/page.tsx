import { desc } from "drizzle-orm";
import { db } from "@/db";
import { feedItems } from "@/db/schema";
import { FeedCard } from "@/app/components/FeedCard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const items = await db
    .select()
    .from(feedItems)
    .orderBy(desc(feedItems.publishedAt))
    .limit(60);

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <h1 className="mb-8 text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
          Better News
        </h1>
        {items.length === 0 ? (
          <p className="text-zinc-500 dark:text-zinc-400">
            No items yet — trigger <code>/api/ingest</code> to pull in the feeds.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <FeedCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
