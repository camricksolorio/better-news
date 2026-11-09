import { requireAdmin } from "@/lib/admin-auth";
import { loadLatestV2Run } from "@/lib/eval/v2-run-file";
import type { DumpEvent, DumpMember, DumpStory, PairStatus } from "@/lib/eval/v2-dump";

export const dynamic = "force-dynamic";

const PAGE = 25;
const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);

const STATUS: Record<PairStatus, { label: string; bar: string; help: string }> = {
  merged: { label: "Merged", bar: "bg-emerald-500", help: "in the same story" },
  judged_high: { label: "Judged same, not merged", bar: "bg-sky-500", help: "p_same at or above the link threshold, but a guard or the average kept the stories apart" },
  judged_low: { label: "Judged low", bar: "bg-amber-500", help: "the classifier gave p_same below the link threshold" },
  unjudged: { label: "Retrieved, not judged", bar: "bg-zinc-400", help: "a candidate pair with no verdict" },
  not_retrieved: { label: "Never retrieved", bar: "bg-rose-500", help: "not a candidate pair: below the similarity floor, over the time gap, or outside the top k" },
};
const ORDER: PairStatus[] = ["merged", "judged_high", "judged_low", "unjudged", "not_retrieved"];

type SP = { view?: string; sort?: string; page?: string; min?: string; split?: string };

export default async function V2Page({ searchParams }: { searchParams: Promise<SP> }) {
  await requireAdmin();
  const sp = await searchParams;
  const loaded = loadLatestV2Run();
  const view = sp.view === "stories" ? "stories" : "events";
  const link = (over: Partial<SP>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ view, sort: sp.sort, page: sp.page, min: sp.min, split: sp.split, ...over })) if (v) q.set(k, v);
    return `/admin/v2?${q}`;
  };

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 text-zinc-800 dark:text-zinc-200">
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
              <a key={v} href={link({ view: v, page: undefined })} className={v === view ? "font-semibold underline" : "text-zinc-500 underline"}>
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

function Header({ file, d }: { file: string; d: import("@/lib/eval/v2-dump").V2Dump }) {
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
  const sum = ORDER.reduce((n, s) => n + total[s], 0) || 1;
  return (
    <>
      <section className="mb-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-1 text-sm font-medium">Where same-event pairs end up ({sum} pairs, {scored.length} events)</h2>
        <p className="mb-2 text-xs text-zinc-500">Every pair of articles you labelled “in” for the same event, and why the pair is or is not in one story. Link threshold {tau}.</p>
        <Bar counts={total} />
        <Legend counts={total} />
      </section>
      <ul className="space-y-3">
        {events.map((e) => (
          <li key={e.id}>
            <details className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <summary className="cursor-pointer list-none">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <span className="font-medium">{e.title}</span>
                  <span className="text-xs text-zinc-500">
                    {e.split} · {e.inArticles} in · recall {pct(e.recall)} · {e.stories.length} {e.stories.length === 1 ? "story" : "stories"}
                  </span>
                </div>
                <div className="mt-2"><Bar counts={e.counts} small /></div>
              </summary>
              <EventDetail e={e} />
            </details>
          </li>
        ))}
      </ul>
    </>
  );
}

function Bar({ counts, small }: { counts: Record<PairStatus, number>; small?: boolean }) {
  const sum = ORDER.reduce((n, s) => n + counts[s], 0);
  if (sum === 0) return <div className="text-xs text-zinc-500">no pairs (fewer than two “in” articles in the replay)</div>;
  return (
    <div className={`flex w-full overflow-hidden rounded ${small ? "h-2" : "h-4"}`}>
      {ORDER.map((s) => counts[s] > 0 && <div key={s} title={`${STATUS[s].label}: ${counts[s]}`} className={STATUS[s].bar} style={{ width: `${(counts[s] / sum) * 100}%` }} />)}
    </div>
  );
}

function Legend({ counts }: { counts: Record<PairStatus, number> }) {
  const sum = ORDER.reduce((n, s) => n + counts[s], 0) || 1;
  return (
    <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {ORDER.map((s) => (
        <div key={s} className="flex items-baseline gap-2">
          <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${STATUS[s].bar}`} />
          <dt className="font-medium">{STATUS[s].label}</dt>
          <dd className="text-zinc-500">{counts[s]} ({((counts[s] / sum) * 100).toFixed(0)}%) <span className="hidden sm:inline">· {STATUS[s].help}</span></dd>
        </div>
      ))}
    </dl>
  );
}

const LABEL_STYLE = { in: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200", related: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200", out: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" } as const;

function EventDetail({ e }: { e: DumpEvent }) {
  const title = new Map(e.members.map((m) => [m.guid, m]));
  const storyOrder = new Map(e.stories.map((s, i) => [s.id, i]));
  const byStory = new Map<string, typeof e.members>();
  for (const m of e.members) byStory.set(m.storyId ?? "none", [...(byStory.get(m.storyId ?? "none") ?? []), m]);
  const groups = [...byStory].sort((a, b) => (storyOrder.get(a[0]) ?? 99) - (storyOrder.get(b[0]) ?? 99));
  return (
    <div className="mt-3 space-y-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <Legend counts={e.counts} />
      {groups.map(([storyId, members]) => (
        <section key={storyId}>
          <h3 className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
            Story {storyId} · {members[0].storySize} article{members[0].storySize === 1 ? "" : "s"} · {members.filter((m) => m.label === "in").length} “in” from this event
          </h3>
          {members.map((m) => (
            <div key={m.guid} className="flex gap-3 py-0.5 text-sm">
              <span className={`mt-0.5 h-fit w-14 shrink-0 rounded px-1 text-center text-xs ${LABEL_STYLE[m.label]}`}>{m.label}</span>
              <span className="w-24 shrink-0 text-xs text-zinc-500">{m.source}<br />{fmt(m.time)}</span>
              <span className="min-w-0 flex-1">{m.title}</span>
            </div>
          ))}
        </section>
      ))}
      {e.unmerged.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Same-event pairs not merged ({e.unmerged.length}), most similar first</h3>
          <div className="space-y-2">
            {e.unmerged.slice(0, 40).map((p) => (
              <div key={p.a + p.b} className="rounded border border-zinc-200 p-2 text-sm dark:border-zinc-800">
                <div className="mb-1 flex flex-wrap gap-x-3 text-xs text-zinc-500">
                  <span className="font-medium text-zinc-800 dark:text-zinc-200">{STATUS[p.status].label}</span>
                  <span>cosine {p.cosine.toFixed(3)}</span>
                  <span>p_same {p.pSame === null ? "none" : p.pSame.toFixed(2)}</span>
                </div>
                <div>{title.get(p.a)?.source}: {title.get(p.a)?.title}</div>
                <div>{title.get(p.b)?.source}: {title.get(p.b)?.title}</div>
              </div>
            ))}
            {e.unmerged.length > 40 && <p className="text-xs text-zinc-500">…and {e.unmerged.length - 40} more.</p>}
          </div>
        </section>
      )}
    </div>
  );
}

function Stories({ d, sp, link }: { d: import("@/lib/eval/v2-dump").V2Dump; sp: SP; link: (o: Partial<SP>) => string }) {
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
      <nav className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        {(Object.keys(labels) as (keyof typeof labels)[]).map((s) => (
          <a key={s} href={link({ sort: s, page: undefined })} className={s === sort ? "font-semibold underline" : "text-zinc-500 underline"}>{labels[s]}</a>
        ))}
        <span className="text-zinc-400">|</span>
        <a href={link({ min: min > 2 ? undefined : "5", page: undefined })} className="text-zinc-500 underline">{min > 2 ? "show all multi-article" : "5+ articles only"}</a>
        <span className="ml-auto text-zinc-500">{rows.length} stories</span>
      </nav>
      <div className="space-y-3">
        {rows.slice((page - 1) * PAGE, page * PAGE).map((s) => <StoryCard key={s.id} s={s} />)}
      </div>
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

function StoryCard({ s }: { s: DumpStory }) {
  const weak = s.minLink !== null && s.minLink < 0.5;
  return (
    <article className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <header className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{s.size} articles · {s.sourceCount} sources</span>
        <span>{fmt(s.firstAt)} → {fmt(s.lastAt)}</span>
        <span className={weak ? "font-medium text-amber-600" : ""}>weakest link {s.minLink === null ? "none judged" : s.minLink.toFixed(2)}</span>
        <span>mean {s.meanLink === null ? "n/a" : s.meanLink.toFixed(2)} · {s.judgedPairs} of {s.possiblePairs} pairs judged</span>
      </header>
      {s.members.map((m) => <Member key={m.guid} m={m} />)}
    </article>
  );
}

function Member({ m }: { m: DumpMember }) {
  return (
    <div className="flex gap-3 py-1 text-sm">
      <span className="w-24 shrink-0 text-xs text-zinc-500">{m.source}<br />{fmt(m.time)}</span>
      <span className="min-w-0 flex-1">
        <span className="font-medium">{m.title}</span>
        {m.event && <span className={`ml-2 rounded px-1 text-xs ${LABEL_STYLE[m.event.label]}`} title={m.event.title}>{m.event.label}: {m.event.title.slice(0, 28)}</span>}
        {m.snippet && <span className="line-clamp-2 block text-zinc-500">{m.snippet}</span>}
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-xs text-zinc-500">{m.avgLink === null ? "—" : m.avgLink.toFixed(2)}</span>
    </div>
  );
}
