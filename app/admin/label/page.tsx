import { db } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { loadQueue, type QueuePair } from "@/lib/labeling";
import { LabelUI } from "./LabelUI";

export const dynamic = "force-dynamic";

export default async function LabelPage() {
  await requireAdmin();
  let queue: QueuePair[];
  try {
    queue = await loadQueue(db);
  } catch (e) {
    return <p className="p-8 text-red-700">{(e as Error).message}</p>;
  }
  return <LabelUI initial={queue} />;
}
