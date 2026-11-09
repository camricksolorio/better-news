import { requireAdmin } from "@/lib/admin-auth";
import { loadLatestV2Run } from "@/lib/eval/v2-run-file";
import type { DumpEvent, DumpStory, PairStatus, V2Dump } from "@/lib/eval/v2-dump";
import { Bar, Legend, ORDER, fmt, pct } from "./parts";

export const dynamic = "force-dynamic";

const PAGE = 30;
type SP = { view?: string; sort?: string; page?: string; min?: string };

const CARD =
  "flex h-full flex-col rounded-2xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-400 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600";
const HEADLINE = "mb-4 line-clamp-3 text-lg font-semibold leading-snug text-zinc-950 dark:text-zinc-50";
const FOOTER = "mt-auto flex flex-col gap-0.5 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800";
const GRID = "grid grid-cols-1 items-stretch gap-4 sm:grid-cols-[repeat(auto-fill,minmax(320px,1fr))] sm:gap-6";

export default async function V2Page({ searchParams }: { searchParams: Promise<SP> }) {
  await requireAdmin();
  const sp = await searchParams;
  const loaded = loadLatestV2Run();
  const view = sp.view === "stories" ? "stories" : "events";
  const link = (over: Partial<SP>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ view, sort: sp.sort, page: sp.page, min: sp.min, ...over })) if (v) q.set(k, v);
    return `/admin/v2?${q}`;
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 text-zinc-800 dark:text-zinc-200">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">v2 clusters</h1>
        <a href="/admin" className="text-sm underline">Admin</a>
      </div>
      {!loaded ? (
        <p className="text-zinc-500">
          No v2 run found. Run <code>pnpm eval:v2-dump</code> locally (it spends nothing: it replays the snapshot over cached verdicts) and reload. This page reads
          <code> eval/v2-run-*.json</code>, which exists only on a machine that has run it.
        </p>
      ) : (
        <>
          <Header file={loaded.file} d={loaded.dump} />
          <nav className="mb-4 flex flex-wrap gap-3 text-sm">
            {(["events", "stories"] as const).map((v) => (
              <a key={v} href={link({ view: v, page: undefined, sort: undefined })} className={v === view ? "font-semibold underline" : "text-zinc-500 underline"}>
                {v === "events" ? "Labelled events" : "All stories"}
              </a>
            ))}
          </nav>
          {view === "events" ? <Events events={loaded.dump.events.filter((e) => e.humanLabeled)} tau={loaded.dump.tauLink} /> : <Stories d={loaded.dump} sp={sp} link={link} />}
        </>
      )}
    </main>
  );
}

function Header({ file, d }: { file: string; d: V2Dump }) {
  return (
    <section className="mb-4 text-sm text-zinc-500">
      <p>
        {d.articles.toLocaleString()} articles replayed through v2 in six-hour ticks; {d.stories.toLocaleString()} stories ({d.multi.length.toLocaleString()} with 2+ articles,{" "}
        {d.singletons.toLocaleString()} alone). Built from cached verdicts only, so this shows what v2 does without spending anything.
      </p>
      <p className="mt-1">
        {Object.entries(d.config).map(([k, v]) => `${k} ${v}`).join(" · ")} · {file} · {fmt(d.generatedAt)} UTC
      </p>
    </section>
  );
}

function Events({ events, tau }: { events: DumpEvent[]; tau: number }) {
  const scored = events.filter((e) => e.inArticles >= 2);
  const total = Object.fromEntries(ORDER.map((s) => [s, scored.reduce((n, e) => n + e.counts[s], 0)])) as Record<PairStatus, number>;
  const sum = ORDER.reduce((n, s) => n + total[s], 0);
  return (
    <>
      <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-1 text-sm font-medium">Where same-event pairs end up ({sum} pairs, {scored.length} events)</h2>
        <p className="mb-2 text-xs text-zinc-500">Every pair of articles you labelled “in” for the same event, and why the pair is or is not in one story. Link threshold {tau}.</p>
        <Bar counts={total} />
        <Legend counts={total} />
      </section>
      <ul className={GRID}>
        {events.map((e) => (
          <li key={e.id}>
            <a href={`/admin/v2/events/${e.id}`} className={CARD}>
              <span className={HEADLINE}>{e.title}</span>
              <span className="mb-4"><Bar counts={e.counts} small /></span>
              <span className={FOOTER}>
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  recall {pct(e.recall)} · {e.stories.length} {e.stories.length === 1 ? "story" : "stories"}
                </span>
                <span>{e.inArticles} “in” articles · {e.split}</span>
                <span>{e.counts.merged} of {ORDER.reduce((n, s) => n + e.counts[s], 0)} pairs merged</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

// The most central article (highest mean link to the others) names the story; the earliest when none were judged.
const headline = (s: DumpStory) => [...s.members].sort((a, b) => (b.avgLink ?? -1) - (a.avgLink ?? -1))[0].title;

function Stories({ d, sp, link }: { d: V2Dump; sp: SP; link: (o: Partial<SP>) => string }) {
  const sort = sp.sort === "weakest" || sp.sort === "recent" || sp.sort === "sources" ? sp.sort : "size";
  const min = Math.max(2, Number(sp.min) || 2);
  const rows = d.multi.filter((s) => s.size >= min);
  const key: Record<string, (s: DumpStory) => number> = {
    size: (s) => -s.size,
    weakest: (s) => s.minLink ?? 2,
    sources: (s) => -s.sourceCount,
    recent: (s) => -new Date(s.lastAt).getTime(),
  };
  rows.sort((a, b) => key[sort](a) - key[sort](b));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const page = Math.min(pages, Math.max(1, Number(sp.page) || 1));
  const labels = { size: "Largest", weakest: "Weakest link", sources: "Most sources", recent: "Most recent" };
  return (
    <>
      <nav className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        {(Object.keys(labels) as (keyof typeof labels)[]).map((s) => (
          <a key={s} href={link({ sort: s, page: undefined })} className={s === sort ? "font-semibold underline" : "text-zinc-500 underline"}>{labels[s]}</a>
        ))}
        <span className="text-zinc-400">|</span>
        <a href={link({ min: min > 2 ? undefined : "5", page: undefined })} className="text-zinc-500 underline">{min > 2 ? "show all multi-article" : "5+ articles only"}</a>
        <span className="ml-auto text-zinc-500">{rows.length} stories</span>
      </nav>
      <ul className={GRID}>
        {rows.slice((page - 1) * PAGE, page * PAGE).map((s) => {
          const weak = s.minLink !== null && s.minLink < 0.5;
          return (
            <li key={s.id}>
              <a href={`/admin/v2/stories/${s.id}`} className={CARD}>
                <span className={HEADLINE}>{headline(s)}</span>
                <span className={FOOTER}>
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">{s.size} articles · {s.sourceCount} sources</span>
                  <span>{fmt(s.firstAt)} to {fmt(s.lastAt)}</span>
                  <span className={weak ? "font-medium text-amber-600" : ""}>
                    weakest link {s.minLink === null ? "none judged" : s.minLink.toFixed(2)} · mean {s.meanLink === null ? "n/a" : s.meanLink.toFixed(2)}
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      {pages > 1 && (
        <div className="my-6 flex items-center justify-center gap-4 text-sm">
          {page > 1 ? <a className="rounded border border-zinc-300 px-3 py-1 dark:border-zinc-700" href={link({ page: String(page - 1) })}>Prev</a> : <span className="px-3 py-1 text-zinc-400">Prev</span>}
          <span>Page {page} of {pages}</span>
          {page < pages ? <a className="rounded border border-zinc-300 px-3 py-1 dark:border-zinc-700" href={link({ page: String(page + 1) })}>Next</a> : <span className="px-3 py-1 text-zinc-400">Next</span>}
        </div>
      )}
    </>
  );
}
