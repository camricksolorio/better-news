import type { DumpEvent, DumpMember, DumpStory, PairStatus } from "@/lib/eval/v2-dump";

export const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
export const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);

export const STATUS: Record<PairStatus, { label: string; bar: string; help: string }> = {
  merged: { label: "Merged", bar: "bg-emerald-500", help: "in the same story" },
  judged_high: { label: "Judged same, not merged", bar: "bg-sky-500", help: "p_same at or above the link threshold, but a guard or the average kept the stories apart" },
  judged_low: { label: "Judged low", bar: "bg-amber-500", help: "the classifier gave p_same below the link threshold" },
  unjudged: { label: "Retrieved, not judged", bar: "bg-zinc-400", help: "a candidate pair with no verdict" },
  not_retrieved: { label: "Never retrieved", bar: "bg-rose-500", help: "not a candidate pair: below the similarity floor, over the time gap, or outside the top k" },
};
export const ORDER: PairStatus[] = ["merged", "judged_high", "judged_low", "unjudged", "not_retrieved"];


export function Bar({ counts, small }: { counts: Record<PairStatus, number>; small?: boolean }) {
  const sum = ORDER.reduce((n, s) => n + counts[s], 0);
  if (sum === 0) return <div className="text-xs text-zinc-500">no pairs (fewer than two “in” articles in the replay)</div>;
  return (
    <div className={`flex w-full overflow-hidden rounded ${small ? "h-2" : "h-4"}`}>
      {ORDER.map((s) => counts[s] > 0 && <div key={s} title={`${STATUS[s].label}: ${counts[s]}`} className={STATUS[s].bar} style={{ width: `${(counts[s] / sum) * 100}%` }} />)}
    </div>
  );
}

export function Legend({ counts }: { counts: Record<PairStatus, number> }) {
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


export const LABEL_STYLE = { in: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200", related: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200", out: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" } as const;

export function EventDetail({ e }: { e: DumpEvent }) {
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

export function StoryDetail({ s }: { s: DumpStory }) {
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
