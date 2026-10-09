import Link from "next/link";
import { requireAdmin } from "@/lib/admin-auth";
import { logout } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  await requireAdmin();
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">Admin</h1>
        <form action={logout}>
          <button className="text-sm text-zinc-500 underline">Sign out</button>
        </form>
      </div>
      <ul className="list-disc pl-5 text-zinc-700 dark:text-zinc-300">
        <li>
          <a href="/admin/explore" className="underline">Clustering explorer</a>: replay the snapshot at any thresholds (no API calls)
        </li>
        <li>
          <a href="/admin/label" className="underline">Label pairs</a>: judge same / related / different (the eval ground truth)
        </li>
        <li>
          <a href="/admin/audit" className="underline">Join audit</a>: review a random sample of joins (works on a phone)
        </li>
        <li>
          <Link href="/admin/stories" className="underline">Stories</Link>: inspect what was grouped and why, and flag articles that don&apos;t belong
        </li>
        <li>
          <a href="/admin/pipeline" className="underline">Pipeline health</a>: stage runs, backlog, stuck articles, rate limits
        </li>
        <li>
          <a href="/admin/costs" className="underline">Costs</a>: model spend by day, purpose, and model
        </li>
      </ul>
    </main>
  );
}
