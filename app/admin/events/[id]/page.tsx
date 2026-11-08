import { notFound } from "next/navigation";
import { db } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { loadEvent } from "@/lib/eval/event-labeling";
import { EventUI } from "./EventUI";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  // A malformed id would make Postgres reject the uuid; treat it as not found.
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const loaded = await loadEvent(db, id);
  if (!loaded) notFound();
  return <EventUI initial={loaded} />;
}
