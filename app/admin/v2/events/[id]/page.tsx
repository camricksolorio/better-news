import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin-auth";
import { loadLatestV2Run } from "@/lib/eval/v2-run-file";
import { Bar, EventDetail, pct } from "../../parts";

export const dynamic = "force-dynamic";

export default async function V2EventPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const event = loadLatestV2Run()?.dump.events.find((e) => e.id === id);
  if (!event) notFound();
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 text-zinc-800 dark:text-zinc-200">
      <a href="/admin/v2" className="mb-4 inline-block text-sm underline">All labelled events</a>
      <h1 className="mb-1 text-xl font-semibold">{event.title}</h1>
      <p className="mb-3 text-sm text-zinc-500">
        {event.split} · {event.inArticles} “in” articles · recall {pct(event.recall)} · {event.stories.length} {event.stories.length === 1 ? "story" : "stories"}
      </p>
      <Bar counts={event.counts} />
      <EventDetail e={event} />
    </main>
  );
}
