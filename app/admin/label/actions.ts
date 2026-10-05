"use server";

import { db } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { LABELS, deleteHumanLabel, saveHumanLabel, type Label } from "@/lib/labeling";

export async function saveLabelAction(a: string, b: string, label: Label) {
  await requireAdmin();
  if (!LABELS.includes(label)) throw new Error("invalid label");
  await saveHumanLabel(db, a, b, label);
}

export async function clearLabelAction(a: string, b: string) {
  await requireAdmin();
  await deleteHumanLabel(db, a, b);
}
