"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Label, QueuePair } from "@/lib/labeling";
import { clearLabelAction, saveLabelAction } from "./actions";

const KEYS: Record<string, Label> = { s: "same", r: "related", d: "different", u: "unsure" };
const fmt = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

type Mode = "review" | "unlabeled" | "all";

export function LabelUI({ initial }: { initial: QueuePair[] }) {
  const hasSilver = initial.some((p) => p.silver);
  const [mode, setMode] = useState<Mode>(hasSilver ? "review" : "unlabeled");
  const [labels, setLabels] = useState(() => new Map(initial.map((p) => [p.key, p.human])));
  const [pos, setPos] = useState(0);
  const [showHint, setShowHint] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The queue is fixed per mode when chosen, so a pair does not vanish the moment it is labeled.
  const queue = useMemo(() => {
    const base = mode === "review" ? initial.filter((p) => p.reviewReason) : initial;
    return mode === "unlabeled" ? base.filter((p) => !p.human) : base;
  }, [initial, mode]);

  const current = queue[Math.min(pos, queue.length - 1)];
  const done = queue.filter((p) => labels.get(p.key)).length;

  const label = useCallback(
    async (l: Label) => {
      if (!current) return;
      const previous = labels.get(current.key) ?? null;
      setLabels((m) => new Map(m).set(current.key, l));
      setPos((p) => Math.min(p + 1, queue.length - 1));
      setShowHint(false);
      try {
        await saveLabelAction(current.a, current.b, l);
        setError(null);
      } catch (e) {
        setLabels((m) => new Map(m).set(current.key, previous)); // roll back: it was not saved
        setError(`Not saved: ${(e as Error).message}`);
      }
    },
    [current, labels, queue.length],
  );

  const clear = useCallback(async () => {
    if (!current) return;
    setLabels((m) => new Map(m).set(current.key, null));
    try {
      await clearLabelAction(current.a, current.b);
    } catch (e) {
      setError(`Not cleared: ${(e as Error).message}`);
    }
  }, [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k in KEYS) void label(KEYS[k]);
      else if (k === "h") setShowHint((v) => !v);
      else if (k === "arrowleft" || k === "k" || k === "z") setPos((p) => Math.max(0, p - 1));
      else if (k === "arrowright" || k === "j") setPos((p) => Math.min(queue.length - 1, p + 1));
      else if (k === "backspace") void clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [label, clear, queue.length]);

  const mine = current ? labels.get(current.key) : null;

  return (
    <main className="mx-auto max-w-5xl px-6 py-6 text-zinc-900 dark:text-zinc-100">
      <div className="mb-3 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Label pairs</h1>
        <a href="/admin" className="text-sm text-zinc-500 underline">Admin</a>
      </div>

      <aside className="sticky top-0 z-10 mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-zinc-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
        <p className="mb-1 font-medium">Same story = the same specific development (announcement, incident, ruling, vote, release, statement), reported around the same time.</p>
        <ul className="grid gap-x-6 sm:grid-cols-3">
          <li><b>s</b> same: different outlets&apos; reports, or analysis/opinion whose main subject is that development</li>
          <li><b>r</b> related: a reaction, consequence, or new development that follows from it</li>
          <li><b>d</b> different: same topic, different development, or unrelated</li>
        </ul>
        <p className="mt-1 text-xs">u unsure · h show model&apos;s call · ←/→ or k/j navigate · Backspace clears this label</p>
      </aside>

      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        {(["review", "unlabeled", "all"] as const).map((m) => (
          <button key={m} disabled={m === "review" && !hasSilver} onClick={() => { setMode(m); setPos(0); }} className={`rounded px-3 py-1 disabled:opacity-40 ${mode === m ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "border border-zinc-300 dark:border-zinc-700"}`}>
            {m === "review" ? "Review (disagreements + random)" : m === "unlabeled" ? "Unlabeled" : "All"}
          </button>
        ))}
        <span className="ml-auto text-zinc-500">{done} / {queue.length} labeled · pair {queue.length ? Math.min(pos, queue.length - 1) + 1 : 0}</span>
      </div>

      {error && <p className="mb-3 rounded bg-red-100 p-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{error}</p>}

      {!current ? (
        <p className="text-zinc-500">{mode === "unlabeled" ? "Nothing left to label." : "No pairs in this queue."}</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3 text-sm text-zinc-500">
            <span>published {current.hoursApart} h apart</span>
            {current.reviewReason && <span className="rounded bg-zinc-200 px-2 dark:bg-zinc-800">{current.reviewReason === "disagreement" ? "model and baseline disagree" : "random check"}</span>}
            {mine && <span className="rounded bg-emerald-600 px-2 text-white">you: {mine}</span>}
            {showHint && current.silver && <span className="rounded bg-sky-600 px-2 text-white" title={current.silver.note ?? ""}>model: {current.silver.label}{current.silver.note ? ` — ${current.silver.note}` : ""}</span>}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Card side={current.article.a} link={current.linkA} />
            <Card side={current.article.b} link={current.linkB} />
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            {(["same", "related", "different", "unsure"] as const).map((l) => (
              <button key={l} onClick={() => void label(l)} className={`rounded border px-4 py-2 ${mine === l ? "border-emerald-600 bg-emerald-600 text-white" : "border-zinc-300 dark:border-zinc-700"}`}>
                <kbd className="mr-2 font-mono text-xs opacity-70">{l[0]}</kbd>{l}
              </button>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function Card({ side, link }: { side: QueuePair["article"]["a"]; link: string | null }) {
  return (
    <article className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">{side.source} · {fmt(side.time)}</p>
      <h2 className="mb-2 text-lg font-semibold leading-snug">{side.title}</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{side.snippet || <i>No description</i>}</p>
      {link && <a href={link} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-zinc-500 underline">Open article</a>}
    </article>
  );
}
