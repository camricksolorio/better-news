// The join audit (D37): sampling joins from a replay, loading the review queue, saving labels, and the
// precision read-out. Everything is database-backed so the review page works in production with no repo files.
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { evalPairLabels, feedItems, joinAuditItems } from "@/db/schema";
import { cleanText } from "@/lib/text";
import { exactLowerBound } from "@/lib/eval/stats";
import { mulberry32 } from "@/lib/eval/pairs";
import { LABELS, type Label } from "@/lib/labeling";

export type Join = { articleId: string; memberIds: string[]; verdict?: unknown };
export type AuditPick = { articleId: string; memberId: string; verdict?: unknown };

// A join was judged against up to two members (the story's first article and its most similar member). The audit
// checks one of them, chosen at random, so both kinds of judgment get reviewed.
export function sampleJoins(joins: Join[], n: number, seed = 1): AuditPick[] {
  const rand = mulberry32(seed);
  const shuffled = [...joins].filter((j) => j.memberIds.length > 0);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n).map((j) => ({
    articleId: j.articleId,
    memberId: j.memberIds[Math.floor(rand() * j.memberIds.length)],
    verdict: j.verdict,
  }));
}

export async function insertAudit(db: Db, auditId: string, picks: AuditPick[]): Promise<number> {
  const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM join_audit_items WHERE audit_id = ${auditId}`)) as unknown as { n: number }[];
  if (n > 0) throw new Error(`audit "${auditId}" already has ${n} items; pick a new id`);
  await db.insert(joinAuditItems).values(picks.map((p, position) => ({ auditId, articleId: p.articleId, memberId: p.memberId, position, verdict: p.verdict ?? null })));
  return picks.length;
}

export async function latestAuditId(db: Db): Promise<string | null> {
  const [row] = await db
    .select({ auditId: joinAuditItems.auditId })
    .from(joinAuditItems)
    .groupBy(joinAuditItems.auditId)
    .orderBy(desc(sql`max(${joinAuditItems.sampledAt})`))
    .limit(1);
  return row?.auditId ?? null;
}

export type AuditArticle = { id: string; title: string; source: string; time: string; snippet: string; link: string };
export type AuditItem = { key: string; articleId: string; memberId: string; a: AuditArticle; b: AuditArticle; label: Label | null };

const pairIds = (x: string, y: string) => (x < y ? [x, y] : [y, x]);
export const itemKey = (articleId: string, memberId: string) => `${articleId}|${memberId}`;

// In random order, each with the reviewer's existing human label for that pair (if any). The classifier's
// verdict is deliberately not loaded: reviewing blind avoids anchoring on it.
export async function loadAudit(db: Db, auditId: string): Promise<AuditItem[]> {
  const items = await db.select().from(joinAuditItems).where(eq(joinAuditItems.auditId, auditId)).orderBy(asc(joinAuditItems.position));
  if (items.length === 0) return [];
  const ids = [...new Set(items.flatMap((i) => [i.articleId, i.memberId]))];
  const articles: Awaited<ReturnType<typeof fetchArticles>> = [];
  for (let i = 0; i < ids.length; i += 500) articles.push(...(await fetchArticles(db, ids.slice(i, i + 500))));
  const byId = new Map(articles.map((a) => [a.id, a]));

  const labelRows = await db
    .select()
    .from(evalPairLabels)
    .where(and(eq(evalPairLabels.labeler, "human"), or(inArray(evalPairLabels.articleA, ids), inArray(evalPairLabels.articleB, ids))));
  const human = new Map(labelRows.map((r) => [itemKey(r.articleA, r.articleB), r.label as Label]));

  return items.flatMap((i) => {
    const a = byId.get(i.articleId);
    const b = byId.get(i.memberId);
    if (!a || !b) return [];
    const [x, y] = pairIds(i.articleId, i.memberId);
    return [{ key: itemKey(i.articleId, i.memberId), articleId: i.articleId, memberId: i.memberId, a, b, label: human.get(itemKey(x, y)) ?? null }];
  });
}

async function fetchArticles(db: Db, ids: string[]): Promise<AuditArticle[]> {
  const rows = await db
    .select({ id: feedItems.id, title: feedItems.title, source: feedItems.sourceId, summary: feedItems.summary, link: feedItems.link, publishedAt: feedItems.publishedAt, createdAt: feedItems.createdAt })
    .from(feedItems)
    .where(inArray(feedItems.id, ids));
  return rows.map((r) => ({
    id: r.id,
    title: cleanText(r.title),
    source: r.source,
    time: (r.publishedAt ?? r.createdAt).toISOString(),
    snippet: cleanText(r.summary).slice(0, 1000),
    link: r.link,
  }));
}

async function assertInAudit(db: Db, auditId: string, articleId: string, memberId: string) {
  const [hit] = await db
    .select({ n: sql<number>`1` })
    .from(joinAuditItems)
    .where(and(eq(joinAuditItems.auditId, auditId), eq(joinAuditItems.articleId, articleId), eq(joinAuditItems.memberId, memberId)))
    .limit(1);
  if (!hit) throw new Error("that pair is not in this audit");
}

// Only pairs that belong to the audit can be labeled through it.
export async function saveAuditLabel(db: Db, auditId: string, articleId: string, memberId: string, label: Label) {
  if (!LABELS.includes(label)) throw new Error(`invalid label: ${label}`);
  await assertInAudit(db, auditId, articleId, memberId);
  const [a, b] = pairIds(articleId, memberId);
  await db
    .insert(evalPairLabels)
    .values({ articleA: a, articleB: b, label, labeler: "human", note: `join-audit:${auditId}` })
    .onConflictDoUpdate({
      target: [evalPairLabels.articleA, evalPairLabels.articleB, evalPairLabels.labeler],
      set: { label, note: `join-audit:${auditId}`, createdAt: new Date() },
    });
}

export async function clearAuditLabel(db: Db, auditId: string, articleId: string, memberId: string) {
  await assertInAudit(db, auditId, articleId, memberId);
  const [a, b] = pairIds(articleId, memberId);
  await db.delete(evalPairLabels).where(and(eq(evalPairLabels.articleA, a), eq(evalPairLabels.articleB, b), eq(evalPairLabels.labeler, "human")));
}

export type AuditSummary = {
  total: number;
  labeled: number;
  same: number;
  related: number;
  different: number;
  unsure: number;
  // `unsure` counts as wrong: a join the reviewer cannot defend should not pass a precision bar.
  errors: number;
  precision: number | null;
  lowerBound: number | null;
  // D37: at n = 150 the bound clears 0.95 with at most 2 errors; this says whether the audit can still clear it.
  canStillClear: boolean;
  clears: boolean;
};

export const SHIP_PRECISION = 0.95;

export function summarize(labels: (Label | null)[]): AuditSummary {
  const count = (l: Label) => labels.filter((x) => x === l).length;
  const total = labels.length;
  const same = count("same");
  const related = count("related");
  const different = count("different");
  const unsure = count("unsure");
  const labeled = same + related + different + unsure;
  const errors = related + different + unsure;
  const remaining = total - labeled;
  return {
    total,
    labeled,
    same,
    related,
    different,
    unsure,
    errors,
    precision: labeled === 0 ? null : same / labeled,
    lowerBound: labeled === 0 ? null : exactLowerBound(same, labeled),
    // Best case: every remaining item is `same`.
    canStillClear: exactLowerBound(same + remaining, total) > SHIP_PRECISION,
    clears: remaining === 0 && exactLowerBound(same, total) > SHIP_PRECISION,
  };
}
