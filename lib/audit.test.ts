import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { evalPairLabels, feedItems } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { clearAuditLabel, insertAudit, latestAuditId, loadAudit, sampleJoins, saveAuditLabel, summarize } from "./audit";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

async function article(n: number, over: Partial<typeof feedItems.$inferInsert> = {}) {
  const [row] = await db
    .insert(feedItems)
    .values({ sourceId: "src", guid: `g${n}`, title: `Title ${n} &amp; more`, link: `https://x/${n}`, summary: `<p>Summary ${n}</p>`, publishedAt: new Date(Date.UTC(2026, 9, 1, n)), ...over })
    .returning();
  return row;
}

describe("sampleJoins", () => {
  const joins = Array.from({ length: 50 }, (_, i) => ({ articleId: `a${i}`, memberIds: i % 2 ? ["first", "top"] : ["only"] }));

  it("draws n distinct joins, is repeatable for a seed, and picks one judged member per join", () => {
    const s = sampleJoins(joins, 20, 3);
    expect(s).toHaveLength(20);
    expect(new Set(s.map((p) => p.articleId)).size).toBe(20);
    expect(sampleJoins(joins, 20, 3)).toEqual(s);
    expect(sampleJoins(joins, 20, 4)).not.toEqual(s);
    for (const p of s) expect(joins.find((j) => j.articleId === p.articleId)!.memberIds).toContain(p.memberId);
  });

  it("returns everything when n exceeds the joins, and skips joins with no judged member", () => {
    expect(sampleJoins([...joins, { articleId: "none", memberIds: [] }], 999)).toHaveLength(50);
  });

  it("picks both kinds of member across many joins", () => {
    const s = sampleJoins(joins.filter((j) => j.memberIds.length === 2), 25, 1);
    expect(new Set(s.map((p) => p.memberId))).toEqual(new Set(["first", "top"]));
  });
});

describe("audit queue", () => {
  it("loads items in random order with cleaned text and no classifier verdict", async () => {
    const [a, b, c] = [await article(1), await article(2), await article(3)];
    await insertAudit(db, "audit-1", [
      { articleId: b.id, memberId: a.id, verdict: { secret: "p_same 0.97" } },
      { articleId: c.id, memberId: a.id },
    ]);
    const items = await loadAudit(db, "audit-1");
    expect(items.map((i) => i.articleId)).toEqual([b.id, c.id]);
    expect(items[0].a.title).toBe("Title 2 & more");
    expect(items[0].b.snippet).toBe("Summary 1");
    expect(JSON.stringify(items)).not.toContain("p_same");
    expect(items[0].label).toBeNull();
  });

  it("refuses to reuse an audit id, and finds the latest audit", async () => {
    const [a, b] = [await article(1), await article(2)];
    await insertAudit(db, "old", [{ articleId: a.id, memberId: b.id }]);
    await expect(insertAudit(db, "old", [{ articleId: a.id, memberId: b.id }])).rejects.toThrow(/already has/);
    await new Promise((r) => setTimeout(r, 10));
    await insertAudit(db, "new", [{ articleId: b.id, memberId: a.id }]);
    expect(await latestAuditId(db)).toBe("new");
  });

  it("saves a human label for the unordered pair, tagged with the audit, and shows it on reload", async () => {
    const [a, b] = [await article(1), await article(2)];
    await insertAudit(db, "au", [{ articleId: b.id, memberId: a.id }]);
    await saveAuditLabel(db, "au", b.id, a.id, "related");
    const [row] = await db.select().from(evalPairLabels);
    expect([row.articleA, row.articleB]).toEqual(a.id < b.id ? [a.id, b.id] : [b.id, a.id]);
    expect(row).toMatchObject({ label: "related", labeler: "human", note: "join-audit:au" });
    expect((await loadAudit(db, "au"))[0].label).toBe("related");
    await saveAuditLabel(db, "au", b.id, a.id, "same"); // relabeling replaces
    expect(await db.select().from(evalPairLabels)).toHaveLength(1);
    await clearAuditLabel(db, "au", b.id, a.id);
    expect(await db.select().from(evalPairLabels).where(eq(evalPairLabels.labeler, "human"))).toHaveLength(0);
  });

  it("only labels pairs that are in the audit, and only valid labels", async () => {
    const [a, b, c] = [await article(1), await article(2), await article(3)];
    await insertAudit(db, "au", [{ articleId: b.id, memberId: a.id }]);
    await expect(saveAuditLabel(db, "au", c.id, a.id, "same")).rejects.toThrow(/not in this audit/);
    await expect(saveAuditLabel(db, "au", b.id, a.id, "bogus" as never)).rejects.toThrow(/invalid label/);
    await expect(clearAuditLabel(db, "au", c.id, a.id)).rejects.toThrow(/not in this audit/);
  });
});

describe("summarize", () => {
  const ls = (same: number, wrong: number, open = 0) => [...Array(same).fill("same"), ...Array(wrong).fill("related"), ...Array(open).fill(null)];

  it("D37: 2 errors in 150 clears the 95% lower bound, 3 do not", () => {
    expect(summarize(ls(148, 2))).toMatchObject({ labeled: 150, errors: 2, clears: true });
    expect(summarize(ls(147, 3))).toMatchObject({ errors: 3, clears: false, canStillClear: false });
  });

  it("counts unsure as wrong and reports whether the audit can still clear", () => {
    const s = summarize(["same", "unsure", ...Array(148).fill(null)]);
    expect(s).toMatchObject({ labeled: 2, errors: 1, same: 1, unsure: 1, clears: false });
    expect(s.canStillClear).toBe(true);
    expect(summarize(ls(100, 4, 46)).canStillClear).toBe(false);
  });

  it("has no precision before anything is labeled", () => {
    expect(summarize([null, null])).toMatchObject({ labeled: 0, precision: null, lowerBound: null });
  });
});
