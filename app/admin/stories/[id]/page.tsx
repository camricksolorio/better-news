import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { loadStory } from "@/lib/admin-stories";
import { doesntBelongAction } from "../actions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fmt = (d: Date) => d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
const score = (x: number | null) => (x === null ? "–" : x.toFixed(3));

export default async function StoryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ moved?: string; error?: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const { moved, error } = await searchParams;
  const story = UUID.test(id) ? await loadStory(db, id) : null;
  if (!story) notFound();
  const canRemove = story.members.length > 1;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 text-zinc-800 dark:text-zinc-200">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Story</h1>
        <Link href="/admin/stories" className="text-sm underline">All stories</Link>
      </div>
      <p className="mb-4 text-sm text-zinc-500">
        {story.articleCount} articles from {story.sourceCount} sources · {story.status} · {fmt(story.firstArticleAt)} to {fmt(story.lastArticleAt)} · window ends {fmt(story.windowEndsAt)}
      </p>
      {moved && (
        <p className="mb-4 rounded border border-emerald-600 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          Moved to <a href={`/admin/stories/${moved}`} className="underline">a story of its own</a>, and the label was recorded.
        </p>
      )}
      {error && <p className="mb-4 rounded border border-rose-600 px-3 py-2 text-sm text-rose-700 dark:text-rose-400">Not changed: {error}</p>}

      <ol className="space-y-4">
        {story.members.map((m) => (
          <li key={m.id} className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
            <a href={m.link} target="_blank" rel="noreferrer" className="font-medium hover:underline">{m.title}</a>
            <div className="mt-0.5 text-xs text-zinc-500">{m.source} · {fmt(m.time)}</div>
            <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
              <span className="font-medium">{m.method ?? "no decision logged"}</span>
              {m.method !== "manual" && <> · best member {score(m.topScore)} · centroid {score(m.centroidScore)}</>}
              {m.assignedAt && <> · {fmt(m.assignedAt)}</>}
            </div>
            {m.judgedAgainst.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                {m.judgedAgainst.map((j) => (
                  <li key={j.memberId}>
                    judged against “{j.title || j.memberId}”: <span className="font-medium">{j.relation ?? (j.same ? "same" : "not same")}</span>
                    {typeof j.pSame === "number" && <> (p_same {j.pSame.toFixed(3)})</>}
                    {j.model && <> · {j.model}</>}
                  </li>
                ))}
              </ul>
            )}
            {canRemove && (
              <div className="mt-3 flex gap-2 text-xs">
                <span className="self-center text-zinc-500">Doesn’t belong:</span>
                {(["related", "different"] as const).map((label) => (
                  <form key={label} action={doesntBelongAction.bind(null, story.id, m.id, label)}>
                    <button className="rounded border border-zinc-400 px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                      it’s {label}
                    </button>
                  </form>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-6 text-xs text-zinc-500">
        “Doesn’t belong” records a human label against the members it was judged against, moves the article into a story of its own, and logs a manual assignment. It cannot be undone here.
      </p>
    </main>
  );
}
