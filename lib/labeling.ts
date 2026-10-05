// Server side of the labeling UI: the pair file, stored labels, and the review queue (D11, D12).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/types";
import { evalPairLabels, feedItems } from "@/db/schema";
import { mulberry32, type PairRecord } from "@/lib/eval/pairs";

export type Label = "same" | "related" | "different" | "unsure";
export const LABELS: Label[] = ["same", "related", "different", "unsure"];

export type QueuePair = PairRecord & {
  key: string;
  linkA: string | null;
  linkB: string | null;
  human: Label | null;
  silver: { label: Label; labeler: string; note: string | null } | null;
  // Why this pair is in the review queue: the model and the baseline disagree, or a random check.
  reviewReason: "disagreement" | "random" | null;
};

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function loadPairFile(dir = path.join(process.cwd(), "eval")): PairRecord[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^pairs-.*\.jsonl$/.test(f)).sort();
  } catch {
    // no eval folder
  }
  if (files.length === 0) throw new Error("No pair file found. Run `pnpm eval:pairs` first.");
  return readFileSync(path.join(dir, files[files.length - 1]), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PairRecord);
}

// Every pair where the silver label and the baseline disagree (the model says `same` but the
// baseline kept them apart, or the reverse), plus a random sample of the rest to measure how
// reliable the silver labeler is.
export function chooseReviewSet(
  pairs: Pick<PairRecord, "a" | "b" | "merged">[],
  silver: Map<string, Label>,
  randomExtra = 50,
  seed = 7,
): Map<string, "disagreement" | "random"> {
  const out = new Map<string, "disagreement" | "random">();
  const rest: string[] = [];
  for (const p of pairs) {
    const key = pairKey(p.a, p.b);
    const label = silver.get(key);
    if (!label) continue;
    if ((label === "same") !== p.merged) out.set(key, "disagreement");
    else rest.push(key);
  }
  const rand = mulberry32(seed);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  for (const key of rest.slice(0, randomExtra)) out.set(key, "random");
  return out;
}

export async function loadQueue(db: Db, pairs = loadPairFile()): Promise<QueuePair[]> {
  const guids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const rows: { id: string; guid: string; link: string }[] = [];
  for (let i = 0; i < guids.length; i += 500) {
    rows.push(
      ...(await db
        .select({ id: feedItems.id, guid: feedItems.guid, link: feedItems.link })
        .from(feedItems)
        .where(inArray(feedItems.guid, guids.slice(i, i + 500)))),
    );
  }
  const byGuid = new Map(rows.map((r) => [r.guid, r]));
  const guidById = new Map(rows.map((r) => [r.id, r.guid]));

  const labelRows = await db.select().from(evalPairLabels);
  const human = new Map<string, Label>();
  const silver = new Map<string, { label: Label; labeler: string; note: string | null }>();
  for (const r of labelRows) {
    const ga = guidById.get(r.articleA);
    const gb = guidById.get(r.articleB);
    if (!ga || !gb) continue;
    const key = pairKey(ga, gb);
    if (r.labeler === "human") human.set(key, r.label as Label);
    else if (r.labeler.startsWith("model:")) silver.set(key, { label: r.label as Label, labeler: r.labeler, note: r.note });
  }

  const review = chooseReviewSet(
    pairs,
    new Map([...silver].map(([k, v]) => [k, v.label])),
  );
  return pairs.map((p) => {
    const key = pairKey(p.a, p.b);
    return {
      ...p,
      key,
      linkA: byGuid.get(p.a)?.link ?? null,
      linkB: byGuid.get(p.b)?.link ?? null,
      human: human.get(key) ?? null,
      silver: silver.get(key) ?? null,
      reviewReason: review.get(key) ?? null,
    };
  });
}

export async function saveHumanLabel(db: Db, a: string, b: string, label: Label, note?: string | null) {
  if (!LABELS.includes(label)) throw new Error(`invalid label: ${label}`);
  const rows = await db.select({ id: feedItems.id, guid: feedItems.guid }).from(feedItems).where(inArray(feedItems.guid, [a, b]));
  const ida = rows.find((r) => r.guid === a)?.id;
  const idb = rows.find((r) => r.guid === b)?.id;
  if (!ida || !idb || ida === idb) throw new Error("unknown article in pair");
  const [articleA, articleB] = ida < idb ? [ida, idb] : [idb, ida];
  await db
    .insert(evalPairLabels)
    .values({ articleA, articleB, label, labeler: "human", note: note ?? null })
    .onConflictDoUpdate({
      target: [evalPairLabels.articleA, evalPairLabels.articleB, evalPairLabels.labeler],
      set: { label, note: note ?? null, createdAt: new Date() },
    });
}

export async function deleteHumanLabel(db: Db, a: string, b: string) {
  const rows = await db.select({ id: feedItems.id }).from(feedItems).where(inArray(feedItems.guid, [a, b]));
  if (rows.length !== 2) return;
  const [articleA, articleB] = rows[0].id < rows[1].id ? [rows[0].id, rows[1].id] : [rows[1].id, rows[0].id];
  await db
    .delete(evalPairLabels)
    .where(and(eq(evalPairLabels.articleA, articleA), eq(evalPairLabels.articleB, articleB), eq(evalPairLabels.labeler, "human")));
}
