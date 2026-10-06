"use server";

import { db } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { clearAuditLabel, saveAuditLabel } from "@/lib/audit";
import type { Label } from "@/lib/labeling";

export async function saveAuditLabelAction(auditId: string, articleId: string, memberId: string, label: Label) {
  await requireAdmin();
  await saveAuditLabel(db, auditId, articleId, memberId, label);
}

export async function clearAuditLabelAction(auditId: string, articleId: string, memberId: string) {
  await requireAdmin();
  await clearAuditLabel(db, auditId, articleId, memberId);
}
