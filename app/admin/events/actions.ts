"use server";

import { db } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { clearEventLabel, loadEvent, saveEventLabel, type EventLabel, type LoadedEvent } from "@/lib/eval/event-labeling";

// Each action returns the event as it now stands, so the page picks up candidates that the new label brought in.
export async function labelEventArticleAction(eventId: string, articleId: string, label: EventLabel): Promise<LoadedEvent> {
  await requireAdmin();
  await saveEventLabel(db, eventId, articleId, label);
  return reload(eventId);
}

export async function clearEventLabelAction(eventId: string, articleId: string): Promise<LoadedEvent> {
  await requireAdmin();
  await clearEventLabel(db, eventId, articleId);
  return reload(eventId);
}

async function reload(eventId: string): Promise<LoadedEvent> {
  const loaded = await loadEvent(db, eventId);
  if (!loaded) throw new Error("unknown event");
  return loaded;
}
