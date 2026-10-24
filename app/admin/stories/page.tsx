import { db } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { listStories } from "@/lib/admin-stories";

export const dynamic = "force-dynamic";

const PAGE = 50;
const fmt = (d: Date) => d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";

export default async function StoriesPage({ searchParams }: { searchParams: Promise<{ status?: string; min?: string; page?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const status = sp.status === "open" || sp.status === "closed" ? sp.status : undefined;
  const min = Math.max(1, Number(sp.min) || 2);
  const page = Math.max(0, (Number(sp.page) || 1) - 1);
  const { rows, total } = await listStories(db, { status, minArticles: min, limit: PAGE, offset: page * PAGE });
  const link = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const merged = { status, min: String(min), page: String(page + 1), ...over };
    for (const [k, v] of Object.entries(merged)) if (v && !(k === "page" && v === "1")) q.set(k, v);
    return `/admin/stories?${q}`;
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 text-zinc-800 dark:text-zinc-200">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Stories</h1>
        <a href="/admin" className="text-sm underline">Admin</a>
      </div>
      <p className="mb-4 text-sm text-zinc-500">
        {total} {min > 1 ? `stories with ${min}+ articles` : "stories"}
        {status ? `, ${status}` : ""}. Newest first.
      </p>
      <nav className="mb-4 flex flex-wrap gap-3 text-sm">
        {[undefined, "open", "closed"].map((s) => (
          <a key={s ?? "all"} href={link({ status: s, page: "1" })} className={s === status ? "font-semibold underline" : "underline text-zinc-500"}>
            {s ?? "all"}
          </a>
        ))}
        <span className="text-zinc-400">|</span>
        <a href={link({ min: min > 1 ? "1" : "2", page: "1" })} className="underline text-zinc-500">
          {min > 1 ? "include single-article stories" : "multi-article only"}
        </a>
      </nav>
      {rows.length === 0 ? (
        <p className="text-zinc-500">No stories match.</p>
      ) : (
        <ul className="grid grid-cols-1 items-stretch gap-4 sm:grid-cols-[repeat(auto-fill,minmax(320px,1fr))] sm:gap-6">
          {rows.map((s) => (
            <li key={s.id}>
              <a
                href={`/admin/stories/${s.id}`}
                className="flex h-full flex-col rounded-2xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-400 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
              >
                <span className="mb-4 line-clamp-3 text-lg font-semibold leading-snug text-zinc-950 dark:text-zinc-50">
                  {s.headline || "(untitled)"}
                </span>
                <span className="mt-auto flex flex-col gap-0.5 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    {s.articleCount} articles · {s.sourceCount} sources
                  </span>
                  <span>{fmt(s.firstArticleAt)} to {fmt(s.lastArticleAt)}</span>
                  <span>{s.status}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex gap-4 text-sm">
        {page > 0 && <a href={link({ page: String(page) })} className="underline">Newer</a>}
        {(page + 1) * PAGE < total && <a href={link({ page: String(page + 2) })} className="underline">Older</a>}
      </div>
    </main>
  );
}
