// Export and import of human/silver pair labels (D26). Labels are keyed by article guid, not
// internal UUIDs, so they survive a rebuild of derived data. Manual story assignments are
// exported alongside them once the "doesn't belong" action exists (Phase 4).
import { eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db/types";
import { evalPairLabels, feedItems } from "@/db/schema";

export type PairLabelRecord = {
  type: "pair";
  a: string; // guid
  b: string; // guid
  label: "same" | "related" | "different" | "unsure";
  labeler: string;
  note: string | null;
  createdAt: string;
};

export async function exportPairLabels(db: Db): Promise<PairLabelRecord[]> {
  const fa = alias(feedItems, "fa");
  const fb = alias(feedItems, "fb");
  const rows = await db
    .select({
      a: fa.guid,
      b: fb.guid,
      label: evalPairLabels.label,
      labeler: evalPairLabels.labeler,
      note: evalPairLabels.note,
      createdAt: evalPairLabels.createdAt,
    })
    .from(evalPairLabels)
    .innerJoin(fa, eq(fa.id, evalPairLabels.articleA))
    .innerJoin(fb, eq(fb.id, evalPairLabels.articleB));
  return rows
    .map((r) => {
      // Order by guid so the file does not depend on random UUID ordering.
      const [a, b] = r.a < r.b ? [r.a, r.b] : [r.b, r.a];
      return {
        type: "pair" as const,
        a,
        b,
        label: r.label as PairLabelRecord["label"],
        labeler: r.labeler,
        note: r.note,
        createdAt: r.createdAt.toISOString(),
      };
    })
    .sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b) || x.labeler.localeCompare(y.labeler));
}

export const toJsonl = (records: object[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

export function parseJsonl(text: string): PairLabelRecord[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PairLabelRecord)
    .filter((r) => r.type === "pair");
}

export type ImportResult = { imported: number; skippedMissingArticle: number };

// Idempotent: re-importing the same file leaves the same labels.
export async function importPairLabels(db: Db, records: PairLabelRecord[]): Promise<ImportResult> {
  const guids = [...new Set(records.flatMap((r) => [r.a, r.b]))];
  const idByGuid = new Map<string, string>();
  for (let i = 0; i < guids.length; i += 500) {
    const rows = await db
      .select({ id: feedItems.id, guid: feedItems.guid })
      .from(feedItems)
      .where(inArray(feedItems.guid, guids.slice(i, i + 500)));
    for (const r of rows) idByGuid.set(r.guid, r.id);
  }

  let imported = 0;
  let skipped = 0;
  for (const r of records) {
    const ida = idByGuid.get(r.a);
    const idb = idByGuid.get(r.b);
    if (!ida || !idb) {
      skipped++;
      continue;
    }
    const [articleA, articleB] = ida < idb ? [ida, idb] : [idb, ida];
    await db
      .insert(evalPairLabels)
      .values({
        articleA,
        articleB,
        label: r.label,
        labeler: r.labeler,
        note: r.note,
        createdAt: new Date(r.createdAt),
      })
      .onConflictDoUpdate({
        target: [evalPairLabels.articleA, evalPairLabels.articleB, evalPairLabels.labeler],
        set: { label: r.label, note: r.note, createdAt: new Date(r.createdAt) },
      });
    imported++;
  }
  return { imported, skippedMissingArticle: skipped };
}

