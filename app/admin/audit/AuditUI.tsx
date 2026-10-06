"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { summarize } from "@/lib/audit-summary";
import type { AuditArticle, AuditItem } from "@/lib/audit";
import type { Label } from "@/lib/labeling";
import { clearAuditLabelAction, saveAuditLabelAction } from "./actions";

const KEYS: Record<string, Label> = { s: "same", r: "related", d: "different", u: "unsure" };
const BUTTONS: { label: Label; hint: string; style: string }[] = [
  { label: "same", hint: "s", style: "border-emerald-600 text-emerald-700 dark:text-emerald-400" },
  { label: "related", hint: "r", style: "border-amber-600 text-amber-700 dark:text-amber-400" },
  { label: "different", hint: "d", style: "border-rose-600 text-rose-700 dark:text-rose-400" },
  { label: "unsure", hint: "u", style: "border-zinc-400 text-zinc-600 dark:text-zinc-400" },
];
const fmt = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(1)}%`);

export function AuditUI({ auditId, initial }: { auditId: string; initial: AuditItem[] }) {
  const [labels, setLabels] = useState(() => new Map(initial.map((i) => [i.key, i.label])));
  const firstOpen = initial.findIndex((i) => !i.label);
  const [pos, setPos] = useState(firstOpen === -1 ? 0 : firstOpen);
  const [showResults, setShowResults] = useState(false);
  const [showDefinition, setShowDefinition] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = initial[Math.min(pos, initial.length - 1)];
  const summary = useMemo(() => summarize(initial.map((i) => labels.get(i.key) ?? null)), [initial, labels]);
  const mine = current ? labels.get(current.key) ?? null : null;

  const label = useCallback(
    async (l: Label) => {
      if (!current) return;
      const previous = labels.get(current.key) ?? null;
      setLabels((m) => new Map(m).set(current.key, l));
      // Move to the next pair still waiting for a label, else the next one.
      const after = initial.findIndex((i, idx) => idx > pos && !labels.get(i.key));
      setPos(after === -1 ? Math.min(pos + 1, initial.length - 1) : after);
      try {
        await saveAuditLabelAction(auditId, current.articleId, current.memberId, l);
        setError(null);
      } catch (e) {
        setLabels((m) => new Map(m).set(current.key, previous)); // it was not saved
        setPos(pos);
        setError(`Not saved: ${(e as Error).message}`);
      }
    },
    [auditId, current, initial, labels, pos],
  );

  const clear = useCallback(async () => {
    if (!current || !mine) return;
    setLabels((m) => new Map(m).set(current.key, null));
    try {
      await clearAuditLabelAction(auditId, current.articleId, current.memberId);
    } catch (e) {
      setLabels((m) => new Map(m).set(current.key, mine));
      setError(`Not cleared: ${(e as Error).message}`);
    }
  }, [auditId, current, mine]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k in KEYS) void label(KEYS[k]);
      else if (k === "arrowleft" || k === "k") setPos((p) => Math.max(0, p - 1));
      else if (k === "arrowright" || k === "j") setPos((p) => Math.min(initial.length - 1, p + 1));
      else if (k === "backspace") void clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [label, clear, initial.length]);

  if (initial.length === 0) {
    return <p className="p-6 text-zinc-600">Audit “{auditId}” has no items.</p>;
  }

  return (
    <main className="mx-auto max-w-4xl px-4 pb-40 pt-4 text-zinc-900 dark:text-zinc-100">
      <header className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Join audit</h1>
          <p className="text-xs text-zinc-500">{auditId}</p>
        </div>
        <a href="/admin" className="text-sm text-zinc-500 underline">Admin</a>
      </header>

      <div className="mb-3 flex items-center gap-2 text-sm">
        <div className="h-2 flex-1 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800" role="progressbar" aria-valuenow={summary.labeled} aria-valuemax={summary.total}>
          <div className="h-full bg-emerald-600" style={{ width: `${(summary.labeled / summary.total) * 100}%` }} />
        </div>
        <span className="tabular-nums text-zinc-500">{summary.labeled}/{summary.total}</span>
        <button onClick={() => setShowResults((v) => !v)} className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700">Results</button>
        <button onClick={() => setShowDefinition((v) => !v)} className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700">Definition</button>
      </div>

      {showDefinition && (
        <aside className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-zinc-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <p className="mb-1 font-medium">Same story only if both report the same specific event (the same announcement, incident, ruling, vote, or statement) as their main subject.</p>
          <ul className="list-disc pl-5">
            <li><b>same</b>: different outlets&apos; news reports on that one event</li>
            <li><b>related</b>: follow-ups, reactions, consequences, new developments, background, and analysis or opinion about the event</li>
            <li><b>different</b>: same topic, different event, or unrelated</li>
          </ul>
          <p className="mt-1">When in doubt, choose related.</p>
        </aside>
      )}

      {showResults && <Results s={summary} />}

      {error && <p className="mb-3 rounded bg-red-100 p-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{error}</p>}

      <p className="mb-2 text-xs text-zinc-500">
        Pair {Math.min(pos, initial.length - 1) + 1} of {initial.length}
        {mine && <span className="ml-2 rounded bg-emerald-600 px-2 py-0.5 text-white">you: {mine}</span>}
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <Card name="A" side={current.a} />
        <Card name="B" side={current.b} />
      </div>

      <nav className="fixed inset-x-0 bottom-0 border-t border-zinc-200 bg-white/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
        <div className="mx-auto max-w-4xl">
          <div className="grid grid-cols-4 gap-2">
            {BUTTONS.map((b) => (
              <button key={b.label} onClick={() => void label(b.label)} className={`min-h-12 rounded-lg border-2 px-1 text-sm font-medium ${b.style} ${mine === b.label ? "bg-current/10 ring-2 ring-current" : ""}`}>
                {b.label}
                <kbd className="ml-1 hidden font-mono text-[10px] opacity-60 sm:inline">{b.hint}</kbd>
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
            <button onClick={() => setPos((p) => Math.max(0, p - 1))} disabled={pos === 0} className="rounded px-3 py-2 disabled:opacity-30">← Previous</button>
            {mine && <button onClick={() => void clear()} className="rounded px-3 py-2 underline">Clear</button>}
            <button onClick={() => setPos((p) => Math.min(initial.length - 1, p + 1))} disabled={pos >= initial.length - 1} className="rounded px-3 py-2 disabled:opacity-30">Next →</button>
          </div>
        </div>
      </nav>
    </main>
  );
}

function Results({ s }: { s: ReturnType<typeof summarize> }) {
  const verdict = s.clears
    ? { text: "Clears the 95% bar", style: "bg-emerald-600 text-white" }
    : s.canStillClear
      ? { text: "Can still clear the 95% bar", style: "bg-zinc-200 dark:bg-zinc-800" }
      : { text: "Cannot clear the 95% bar", style: "bg-rose-600 text-white" };
  return (
    <section className="mb-3 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <p className={`mb-2 inline-block rounded px-2 py-0.5 text-xs font-medium ${verdict.style}`}>{verdict.text}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
        <div><dt className="text-zinc-500">Precision so far</dt><dd className="font-medium">{pct(s.precision)}</dd></div>
        <div><dt className="text-zinc-500">95% lower bound</dt><dd className="font-medium">{pct(s.lowerBound)}</dd></div>
        <div><dt className="text-zinc-500">Labeled</dt><dd className="font-medium">{s.labeled} of {s.total}</dd></div>
        <div><dt className="text-zinc-500">Errors (related + different + unsure)</dt><dd className="font-medium">{s.errors}</dd></div>
        <div><dt className="text-zinc-500">same</dt><dd>{s.same}</dd></div>
        <div><dt className="text-zinc-500">related</dt><dd>{s.related}</dd></div>
        <div><dt className="text-zinc-500">different</dt><dd>{s.different}</dd></div>
        <div><dt className="text-zinc-500">unsure</dt><dd>{s.unsure}</dd></div>
      </dl>
      <p className="mt-2 text-xs text-zinc-500">At 150 joins the bound clears 95% with at most 2 errors. Unsure counts as an error.</p>
    </section>
  );
}

function Card({ name, side }: { name: string; side: AuditArticle }) {
  return (
    <article className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Article {name} · {side.source} · {fmt(side.time)}</p>
      <h2 className="mb-2 text-lg font-semibold leading-snug">{side.title}</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{side.snippet || <i>No description</i>}</p>
      <a href={side.link} target="_blank" rel="noreferrer noopener" className="mt-2 inline-block text-xs text-zinc-500 underline">Open article</a>
    </article>
  );
}
