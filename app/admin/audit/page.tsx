import { db } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { latestAuditId, loadAudit } from "@/lib/audit";
import { AuditUI } from "./AuditUI";

export const dynamic = "force-dynamic";

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  await requireAdmin();
  const { id } = await searchParams;
  const auditId = id ?? (await latestAuditId(db));
  if (!auditId) {
    return (
      <main className="mx-auto max-w-xl px-4 py-10 text-zinc-700 dark:text-zinc-300">
        <h1 className="mb-2 text-xl font-semibold">Join audit</h1>
        <p>No audit has been sampled yet. Run <code>pnpm eval:audit</code> to draw one.</p>
        <a href="/admin" className="mt-4 inline-block text-sm underline">Admin</a>
      </main>
    );
  }
  const items = await loadAudit(db, auditId);
  return <AuditUI auditId={auditId} initial={items} />;
}
