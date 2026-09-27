import type { FeedItem } from "@/db/schema";
import { FEED_SOURCES } from "@/feeds.config";

function sourceLabel(sourceId: string): string {
  return FEED_SOURCES.find((s) => s.id === sourceId)?.label ?? sourceId;
}

function formatTime(date: Date | null): string | null {
  if (!date) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function FeedCard({ item }: { item: FeedItem }) {
  return (
    <a
      href={item.link}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col gap-3 rounded-lg border border-black/10 bg-white p-4 transition-colors hover:border-black/20 dark:border-white/10 dark:bg-zinc-900 dark:hover:border-white/20"
    >
      <div className="flex items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="font-medium uppercase tracking-wide">{sourceLabel(item.sourceId)}</span>
        {formatTime(item.publishedAt) && <span>{formatTime(item.publishedAt)}</span>}
      </div>
      <h2 className="text-lg font-semibold leading-snug text-zinc-950 dark:text-zinc-50">
        {item.title}
      </h2>
      {item.summary && (
        <p className="line-clamp-3 text-sm text-zinc-600 dark:text-zinc-400">
          {item.summary.replace(/<[^>]*>/g, "")}
        </p>
      )}
    </a>
  );
}
