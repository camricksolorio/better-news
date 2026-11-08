import { db } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { listEvents } from "@/lib/eval/event-labeling";

export const dynamic = "force-dynamic";

export default async function EventsPage() {
  await requireAdmin();
  const events = await listEvents(db);
  const started = events.filter((e) => e.human > 0).length;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 text-zinc-800 dark:text-zinc-200">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Event labels</h1>
        <a href="/admin" className="text-sm underline">Admin</a>
      </div>
      <p className="mb-4 text-sm text-zinc-500">
        {events.length} events, {started} started. Open an event, then mark each proposed article in, related or out.
      </p>
      {events.length === 0 ? (
        <p className="text-zinc-500">No events yet. Run <code>pnpm eval:event-sample --confirm</code> to draw them.</p>
      ) : (
        <ul className="grid grid-cols-1 items-stretch gap-4 sm:grid-cols-[repeat(auto-fill,minmax(320px,1fr))] sm:gap-6">
          {events.map((e) => (
            <li key={e.id}>
              <a
                href={`/admin/events/${e.id}`}
                className="flex h-full flex-col rounded-2xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-400 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
              >
                <span className="mb-4 line-clamp-3 text-lg font-semibold leading-snug text-zinc-950 dark:text-zinc-50">{e.title}</span>
                <span className="mt-auto flex flex-col gap-0.5 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    {e.in} in · {e.related} related · {e.out} out
                  </span>
                  <span>
                    {e.split}
                    {e.note === "PRD example" ? " · PRD example" : ""} · {e.human > 0 ? `${e.human} labelled by you` : "not started"}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
