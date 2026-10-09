"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { markDoesntBelong, type DoesntBelongLabel } from "@/lib/admin-stories";

// Bound in the page: doesntBelongAction.bind(null, storyId, articleId, label); the form data it is also given is unused.
export async function doesntBelongAction(storyId: string, articleId: string, label: DoesntBelongLabel) {
  await requireAdmin();
  let target: string;
  try {
    const { newStoryId } = await markDoesntBelong(db, storyId, articleId, label);
    target = `/admin/stories/${storyId}?moved=${newStoryId}`;
  } catch (e) {
    target = `/admin/stories/${storyId}?error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`;
  }
  revalidatePath(`/admin/stories/${storyId}`);
  redirect(target);
}
