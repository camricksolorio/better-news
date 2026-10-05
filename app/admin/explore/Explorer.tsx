"use client";

import { useEffect, useRef, useState } from "react";
import type { ArticleView, ExploreSummary, StoryView, ViewPayload } from "@/lib/eval/explore";

type Response = { params: { tLow: number; tHigh: number; windowHours: number }; summary: ExploreSummary; payload: ViewPayload; ms: number };

const PAGE_SIZE = 20;
const fmtTime = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function Explorer() {
  const [tLow, setTLow] = useState(0.75);
  const [tHigh, setTHigh] = useState(0.88);
  const [windowHours, setWindowHours] = useState(36);
  const [gray, setGray] = useState<"new" | "join">("new");
  const [view, setView] = useState<"stories" | "gray" | "search">("stories");
  const [sort, setSort] = useState<"size" | "suspicious" | "sources" | "recent">("suspicious");
  const [minSize, setMinSize] = useState(2);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  // Any control change goes back to page 1 (except paging itself).
  const resetPage = () => setPage(1);

  useEffect(() => {
    const id = ++seq.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      const params = new URLSearchParams({
        tLow: String(tLow), tHigh: String(tHigh), windowHours: String(windowHours), gray,
        view, sort, minSize: String(minSize), q, page: String(page),
      });
      try {
        const res = await fetch(`/admin/explore/data?${params}`);
        const json = await res.json();
        if (id !== seq.current) return; // a newer request superseded this one
        if (!res.ok) throw new Error(json.error ?? res.statusText);
        setData(json);
        setError(null);
      } catch (e) {
        if (id === seq.current) setError((e as Error).message);
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [tLow, tHigh, windowHours, gray, view, sort, minSize, q, page]);

  const setHigh = (v: number) => { setTHigh(v); if (tLow > v) setTLow(v); resetPage(); };
  const setLow = (v: number) => { setTLow(v); if (tHigh < v) setTHigh(v); resetPage(); };
  const total = data?.payload.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="mx-auto max-w-5xl px-6 py-8 text-zinc-900 dark:text-zinc-100">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Clustering explorer</h1>
        <a href="/admin" className="text-sm text-zinc-500 underline">Admin</a>
      </div>

      <section className="mb-6 grid gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800 sm:grid-cols-2">
        <Slider label="T_high (auto-join at or above)" value={tHigh} min={0.5} max={1} step={0.005} onChange={setHigh} />
        <Slider label="T_low (new story below)" value={tLow} min={0.5} max={1} step={0.005} onChange={setLow} />
        <Slider label="Window (hours)" value={windowHours} min={6} max={48} step={1} onChange={(v) => { setWindowHours(v); resetPage(); }} digits={0} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-500">Gray zone (between T_low and T_high)</span>
          <select value={gray} onChange={(e) => { setGray(e.target.value as "new" | "join"); resetPage(); }} className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700">
            <option value="new">Start a new story (conservative: LLM says no)</option>
            <option value="join">Join best candidate (optimistic: LLM says yes)</option>
          </select>
        </label>
      </section>

      {error && <p className="mb-4 rounded bg-red-100 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{error}</p>}

      {data && <Summary s={data.summary} tLow={data.params.tLow} tHigh={data.params.tHigh} ms={data.ms} loading={loading} />}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {(["stories", "gray", "search"] as const).map((v) => (
          <button key={v} onClick={() => { setView(v); resetPage(); }} className={`rounded px-3 py-1 text-sm ${view === v ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "border border-zinc-300 dark:border-zinc-700"}`}>
            {v === "stories" ? "Stories" : v === "gray" ? "Gray-zone articles" : "Search"}
          </button>
        ))}
        {view === "stories" && (
          <>
            <select value={sort} onChange={(e) => { setSort(e.target.value as typeof sort); resetPage(); }} className="rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700">
              <option value="suspicious">Most suspicious first (lowest centroid similarity)</option>
              <option value="size">Largest first</option>
              <option value="sources">Most sources first</option>
              <option value="recent">Most recent first</option>
            </select>
            <label className="flex items-center gap-2 text-sm text-zinc-500">min size
              <input type="number" min={2} value={minSize} onChange={(e) => { setMinSize(Math.max(2, Number(e.target.value) || 2)); resetPage(); }} className="w-16 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700" />
            </label>
          </>
        )}
        {view === "search" && (
          <input value={q} onChange={(e) => { setQ(e.target.value); resetPage(); }} placeholder="Search article titles…" className="min-w-64 flex-1 rounded border border-zinc-300 bg-transparent px-3 py-1 text-sm dark:border-zinc-700" autoFocus />
        )}
        <span className="ml-auto text-sm text-zinc-500">{total.toLocaleString()} result{total === 1 ? "" : "s"}</span>
      </div>

      <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
        {data?.payload.view === "stories" && data.payload.items.map((s) => <Story key={s.id} s={s} />)}
        {data?.payload.view === "gray" && data.payload.items.map((g) => (
          <div key={g.article.guid} className="mb-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Article</p>
            <ArticleRow a={g.article} />
            <p className="mb-1 mt-3 text-xs uppercase tracking-wide text-zinc-500">Best candidate story ({g.candidate?.size ?? 0} articles)</p>
            {g.candidate?.members.slice(0, 5).map((m) => <ArticleRow key={m.guid} a={m} compact />)}
          </div>
        ))}
        {data?.payload.view === "search" && data.payload.items.map((x) => (
          <div key={x.article.guid} className="mb-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <ArticleRow a={x.article} />
            {x.story && x.story.size > 1 && (
              <div className="mt-2 border-l-2 border-zinc-300 pl-3 dark:border-zinc-700">
                <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Same story ({x.story.size} articles)</p>
                {x.story.members.filter((m) => m.guid !== x.article.guid).map((m) => <ArticleRow key={m.guid} a={m} compact />)}
              </div>
            )}
          </div>
        ))}
        {data && total === 0 && !loading && <p className="text-zinc-500">{view === "search" && !q ? "Type to search titles." : "Nothing to show at these settings."}</p>}
      </div>

      {pages > 1 && (
        <div className="my-6 flex items-center justify-center gap-4 text-sm">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-zinc-300 px-3 py-1 disabled:opacity-40 dark:border-zinc-700">Prev</button>
          <span>Page {page} of {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded border border-zinc-300 px-3 py-1 disabled:opacity-40 dark:border-zinc-700">Next</button>
        </div>
      )}
    </main>
  );
}

function Slider({ label, value, min, max, step, onChange, digits = 3 }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; digits?: number }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="flex justify-between text-zinc-500"><span>{label}</span><span className="font-mono text-zinc-900 dark:text-zinc-100">{value.toFixed(digits)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Summary({ s, tLow, tHigh, ms, loading }: { s: ExploreSummary; tLow: number; tHigh: number; ms: number; loading: boolean }) {
  const max = Math.max(1, ...s.histogram.map((b) => b.count));
  const stats: [string, string][] = [
    ["Articles", s.articles.toLocaleString()],
    ["Stories", s.stories.toLocaleString()],
    ["Multi-article", `${s.multi.toLocaleString()} (avg ${s.avgMultiSize}, max ${s.largest})`],
    ["Singletons", s.singletons.toLocaleString()],
    ["Gray zone (LLM band)", `${s.grayCount.toLocaleString()} (${(s.grayShare * 100).toFixed(1)}%)`],
    ["…of which thin", s.thinGray.toLocaleString()],
  ];
  return (
    <section className="mb-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <dl className="mb-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        {stats.map(([k, v]) => (<div key={k}><dt className="text-zinc-500">{k}</dt><dd className="font-medium">{v}</dd></div>))}
      </dl>
      <p className="mb-1 text-xs text-zinc-500">Best-candidate score per article (min of max-member and centroid similarity). {s.noCandidate.toLocaleString()} had no candidate.</p>
      <div className="relative flex h-24 items-end gap-px">
        {s.histogram.map((b) => {
          const mid = b.from + 0.01;
          const zone = mid >= tHigh ? "bg-emerald-500" : mid >= tLow ? "bg-amber-500" : "bg-zinc-400";
          return <div key={b.from} title={`${b.from.toFixed(2)}–${(b.from + 0.02).toFixed(2)}: ${b.count}`} className={`flex-1 ${zone}`} style={{ height: `${(b.count / max) * 100}%`, minHeight: b.count ? 2 : 0 }} />;
        })}
      </div>
      <div className="flex justify-between text-xs text-zinc-500"><span>0.50</span><span>0.75</span><span>1.00</span></div>
      <p className="mt-2 text-xs text-zinc-500"><span className="text-emerald-600">green</span> joins · <span className="text-amber-600">amber</span> LLM band · <span className="text-zinc-500">grey</span> new story · {loading ? "updating…" : `${ms} ms`} · {s.snapshot}</p>
    </section>
  );
}

function Story({ s }: { s: StoryView }) {
  const risky = s.minCentroidSim < 0.8;
  return (
    <article className="mb-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <header className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{s.size} articles · {s.sourceCount} sources</span>
        <span>{fmtTime(s.firstAt)} → {fmtTime(s.lastAt)}</span>
        <span className={risky ? "font-medium text-amber-600" : ""}>lowest centroid sim {s.minCentroidSim.toFixed(3)}</span>
      </header>
      {s.members.map((m) => <ArticleRow key={m.guid} a={m} />)}
    </article>
  );
}

function ArticleRow({ a, compact }: { a: ArticleView; compact?: boolean }) {
  const badge = a.method === "new_story" ? (a.gray ? "gray → new" : "new") : a.method === "llm" ? "gray → joined" : "embedding";
  return (
    <div className={`flex gap-3 ${compact ? "py-0.5 text-sm" : "py-1"}`}>
      <div className="w-28 shrink-0 text-xs text-zinc-500"><div>{a.source}</div><div>{fmtTime(a.time)}</div></div>
      <div className="min-w-0 flex-1">
        <div className={compact ? "truncate" : "font-medium"}>{a.title}{a.thin && <span className="ml-2 rounded bg-zinc-200 px-1 text-xs dark:bg-zinc-800">thin</span>}</div>
        {!compact && a.snippet && <div className="line-clamp-2 text-sm text-zinc-500">{a.snippet}</div>}
      </div>
      <div className="w-32 shrink-0 text-right font-mono text-xs text-zinc-500">
        <div>{badge}</div>
        {a.topScore !== null && <div>max {a.topScore.toFixed(3)} · ctr {a.centroidScore?.toFixed(3)}</div>}
      </div>
    </div>
  );
}
