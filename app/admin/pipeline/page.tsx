import Link from "next/link";
import { db } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { loadPipelineStatus } from "@/lib/admin-pipeline";

export const dynamic = "force-dynamic";

const ago = (d: Date) => {
  const h = (Date.now() - d.getTime()) / 3_600_000;
  return h < 1 ? `${Math.round(h * 60)}m ago` : `${h.toFixed(1)}h ago`;
};

export default async function PipelinePage() {
  await requireAdmin();
  const s = await loadPipelineStatus(db);
  const stat = (label: string, value: string | number, warn = false) => (
    <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`text-lg font-semibold ${warn ? "text-rose-600" : ""}`}>{value}</div>
    </div>
  );
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 text-zinc-800 dark:text-zinc-200">
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Pipeline health</h1>
        <a href="/admin" className="text-sm underline">Admin</a>
      </div>

      <h2 className="mb-2 text-sm font-semibold">Checks (same as /api/health)</h2>
      <ul className="mb-6 space-y-1 text-sm">
        {s.health.checks.map((c) => (
          <li key={c.name}>
            <span className={c.ok ? "text-emerald-600" : "font-semibold text-rose-600"}>{c.ok ? "ok" : "FAIL"}</span> {c.name.replace(/_/g, " ")}: <span className="text-zinc-500">{c.detail}</span>
          </li>
        ))}
      </ul>

      <h2 className="mb-2 text-sm font-semibold">Last run per stage</h2>
      {s.stages.length === 0 ? (
        <p className="mb-6 text-sm text-zinc-500">No runs recorded yet.</p>
      ) : (
        <ul className="mb-6 space-y-1 text-sm">
          {s.stages.map((r) => (
            <li key={r.stage}>
              <span className="font-medium">{r.stage}</span> · {r.status} · started {ago(r.startedAt)} · processed {r.processed ?? "–"}, remaining {r.remaining ?? "–"}, failed {r.failed ?? "–"}
              {r.error && <span className="text-rose-600"> · {r.error}</span>}
            </li>
          ))}
        </ul>
      )}

      <h2 className="mb-2 text-sm font-semibold">Articles by state</h2>
      <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {stat("Ingested, not embedded", s.counts.needsEmbedding)}
        {stat("Embedded, not clustered", s.counts.awaitingCluster)}
        {stat("Clustered", s.counts.clustered)}
        {stat("Oldest unprocessed", s.oldestUnprocessedHours === null ? "none" : `${s.oldestUnprocessedHours.toFixed(1)}h`)}
        {stat("Stuck (embed)", s.stuck.embed, s.stuck.embed > 0)}
        {stat("Stuck (cluster)", s.stuck.cluster, s.stuck.cluster > 0)}
        {stat("Open stories", s.openStories)}
      </div>

      <h2 className="mb-2 text-sm font-semibold">Model calls, last 24 hours</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stat("Calls", s.last24h.calls)}
        {stat("Failed", s.last24h.failed, s.last24h.failed > 0)}
        {stat("Rate limited (429)", s.last24h.rateLimited, s.last24h.rateLimited > 0)}
        {stat("Fallback (OpenRouter)", s.last24h.fallback)}
      </div>
      <p className="mt-6 text-xs text-zinc-500">
        <a href="/admin/costs" className="underline">Costs</a> · <Link href="/admin/stories" className="underline">Stories</Link>
      </p>
    </main>
  );
}
