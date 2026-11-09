import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin-auth";
import { loadLatestV2Run } from "@/lib/eval/v2-run-file";
import { StoryDetail } from "../../parts";

export const dynamic = "force-dynamic";

export default async function V2StoryPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const story = loadLatestV2Run()?.dump.multi.find((s) => s.id === id);
  if (!story) notFound();
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 text-zinc-800 dark:text-zinc-200">
      <a href="/admin/v2?view=stories" className="mb-4 inline-block text-sm underline">All v2 stories</a>
      <StoryDetail s={story} />
    </main>
  );
}
