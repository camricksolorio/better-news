"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Candidate, EventArticle, EventLabel, LabeledArticle, LoadedEvent } from "@/lib/eval/event-labeling";
import { clearEventLabelAction, labelEventArticleAction } from "../actions";

const KEYS: Record<string, EventLabel> = { i: "in", r: "related", o: "out" };
const BUTTONS: { label: EventLabel; hint: string; style: string }[] = [
  { label: "in", hint: "i", style: "border-emerald-600 text-emerald-700 dark:text-emerald-400" },
  { label: "related", hint: "r", style: "border-amber-600 text-amber-700 dark:text-amber-400" },
  { label: "out", hint: "o", style: "border-rose-600 text-rose-700 dark:text-rose-400" },
];
const fmt = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function EventUI({ initial }: { initial: LoadedEvent }) {
  const [state, setState] = useState(initial);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [showDefinition, setShowDefinition] = useState(false);
  const [showLabeled, setShowLabeled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Skipped articles go to the back of the queue until the owner has been through the rest.
  const queue = [...state.candidates.filter((c) => !skipped.includes(c.id)), ...state.candidates.filter((c) => skipped.includes(c.id))];
  const current: Candidate | undefined = queue[0];
  const counts = { in: 0, related: 0, out: 0 };
  for (const a of state.labeled) counts[a.label]++;

  const label = useCallback(
    async (articleId: string, l: EventLabel) => {
      if (busy) return;
      setBusy(true);
      try {
        setState(await labelEventArticleAction(state.event.id, articleId, l));
        setSkipped((s) => s.filter((id) => id !== articleId));
        setError(null);
      } catch (e) {
        setError(`Not saved: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, state.event.id],
  );

  const clear = useCallback(
    async (articleId: string) => {
      if (busy) return;
      setBusy(true);
      try {
        setState(await clearEventLabelAction(state.event.id, articleId));
        setError(null);
      } catch (e) {
        setError(`Not cleared: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, state.event.id],
  );

  // Undo takes back the most recent human label.
  const lastHuman = [...state.labeled].filter((a) => a.labeler === "human").pop();
  const skip = useCallback(() => current && setSkipped((s) => [...s.filter((id) => id !== current.id), current.id]), [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !current) return;
      const k = e.key.toLowerCase();
      if (k in KEYS) void label(current.id, KEYS[k]);
      else if (k === "s" || k === "arrowright") skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, label, skip]);

  return (
    <main className="mx-auto max-w-4xl px-4 pb-40 pt-4 text-zinc-900 dark:text-zinc-100">
      <header className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold leading-snug">{state.event.title}</h1>
          <p className="text-xs text-zinc-500">
            {state.event.split}
            {state.event.note ? ` · ${state.event.note}` : ""}
          </p>
        </div>
        <Link href="/admin/events" className="shrink-0 text-sm text-zinc-500 underline">All events</Link>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
          {counts.in} in · {counts.related} related · {counts.out} out
        </span>
        <span className="text-zinc-400">·</span>
        <span className="tabular-nums text-zinc-500">{queue.length} to review</span>
        <button onClick={() => setShowLabeled((v) => !v)} className="ml-auto rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700">Labelled</button>
        <button onClick={() => setShowDefinition((v) => !v)} className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700">Definition</button>
      </div>

      {showDefinition && (
        <aside className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-zinc-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <p className="mb-1 font-medium">An event is one specific announcement, incident, ruling, vote or statement. Mark each article against the in articles.</p>
          <ul className="list-disc pl-5">
            <li><b>in</b>: a news report whose main subject is that one event</li>
            <li><b>related</b>: follow-ups, reactions, consequences, new developments, background, and analysis or opinion about it</li>
            <li><b>out</b>: a different event, or unrelated</li>
          </ul>
          <p className="mt-1">When in doubt, choose related. Each article you mark <b>in</b> brings in more candidates.</p>
        </aside>
      )}

      {error && <p className="mb-3 rounded bg-red-100 p-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{error}</p>}

      {showLabeled && <LabeledList items={state.labeled} onChange={(id, l) => void label(id, l)} onClear={(id) => void clear(id)} />}

      <section className="mb-4">
        <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">In this event so far</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {state.labeled.filter((a) => a.label === "in").map((a) => (
            <li key={a.id}><Card article={a} compact /></li>
          ))}
        </ul>
      </section>

      {current ? (
        <section>
          <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
            Is this part of the event? <span className="normal-case">({Math.round(current.similarity * 100)}% similar to an in article)</span>
          </h2>
          <Card article={current} />
        </section>
      ) : (
        <p className="rounded-lg border border-zinc-200 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          No more candidates. Anything within 48 hours and 70% similar to an in article has been labelled. Finished with this event.
        </p>
      )}

      <nav className="fixed inset-x-0 bottom-0 border-t border-zinc-200 bg-white/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
        <div className="mx-auto max-w-4xl">
          <div className="grid grid-cols-3 gap-2">
            {BUTTONS.map((b) => (
              <button
                key={b.label}
                disabled={!current || busy}
                onClick={() => current && void label(current.id, b.label)}
                className={`min-h-12 rounded-lg border-2 px-1 text-sm font-medium disabled:opacity-40 ${b.style}`}
              >
                {b.label}
                <kbd className="ml-1 hidden font-mono text-[10px] opacity-60 sm:inline">{b.hint}</kbd>
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
            <button onClick={() => lastHuman && void clear(lastHuman.id)} disabled={!lastHuman || busy} className="rounded px-3 py-2 disabled:opacity-30">
              Undo last
            </button>
            <button onClick={skip} disabled={!current || queue.length < 2} className="rounded px-3 py-2 disabled:opacity-30">
              Skip for now <kbd className="ml-1 hidden font-mono text-[10px] opacity-60 sm:inline">s</kbd>
            </button>
          </div>
        </div>
      </nav>
    </main>
  );
}

function Card({ article, compact = false }: { article: EventArticle; compact?: boolean }) {
  return (
    <article className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800 sm:p-4">
      <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
        {article.source} · {fmt(article.time)}
      </p>
      <h3 className={`font-semibold leading-snug ${compact ? "line-clamp-3 text-sm" : "mb-2 text-lg"}`}>{article.title}</h3>
      {!compact && <p className="text-sm text-zinc-600 dark:text-zinc-400">{article.snippet || <i>No description</i>}</p>}
      <a href={article.link} target="_blank" rel="noreferrer noopener" className="mt-2 inline-block text-xs text-zinc-500 underline">
        Open article
      </a>
    </article>
  );
}

function LabeledList({ items, onChange, onClear }: { items: LabeledArticle[]; onChange: (id: string, l: EventLabel) => void; onClear: (id: string) => void }) {
  return (
    <section className="mb-4 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {items.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="min-w-0 flex-1 basis-60">
              <span className="block truncate font-medium">{a.title}</span>
              <span className="text-xs text-zinc-500">{a.source} · {fmt(a.time)}{a.labeler !== "human" ? " · seed" : ""}</span>
            </span>
            <span className="flex gap-1">
              {BUTTONS.map((b) => (
                <button
                  key={b.label}
                  onClick={() => onChange(a.id, b.label)}
                  className={`rounded border px-2 py-1 text-xs ${b.style} ${a.label === b.label ? "bg-current/10 ring-1 ring-current" : "opacity-60"}`}
                >
                  {b.label}
                </button>
              ))}
              {a.labeler === "human" && (
                <button onClick={() => onClear(a.id)} className="rounded px-2 py-1 text-xs text-zinc-500 underline">
                  clear
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
