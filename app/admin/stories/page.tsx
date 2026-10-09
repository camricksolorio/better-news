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
    <main className="mx-auto max-w-3xl px-4 py-8 text-zinc-800 dark:text-zinc-200">
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
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {rows.map((s) => (
            <li key={s.id} className="py-3">
              <a href={`/admin/stories/${s.id}`} className="font-medium hover:underline">{s.headline || "(untitled)"}</a>
              <div className="mt-0.5 text-xs text-zinc-500">
                {s.articleCount} articles from {s.sourceCount} sources · {fmt(s.firstArticleAt)} to {fmt(s.lastArticleAt)} · {s.status}
              </div>
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
