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
        <li>Labeling, stories, costs, and pipeline health will be linked here.</li>
      </ul>
    </main>
  );
}
