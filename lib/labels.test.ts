import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { evalPairLabels, feedItems } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { exportPairLabels, importPairLabels, parseJsonl, toJsonl } from "./labels";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

async function articles(guids: string[]) {
  return db
    .insert(feedItems)
    .values(guids.map((guid) => ({ sourceId: "s", guid, title: guid, link: `https://x.test/${guid}` })))
    .returning();
}

const ordered = (x: { id: string }, y: { id: string }) => (x.id < y.id ? [x, y] : [y, x]);

describe("label export/import", () => {
  it("export then import into an empty database restores the same labels", async () => {
    const [a, b, c] = await articles(["guid-a", "guid-b", "guid-c"]);
    const [p1, p2] = ordered(a, b);
    const [q1, q2] = ordered(b, c);
    await db.insert(evalPairLabels).values([
      { articleA: p1.id, articleB: p2.id, label: "same", labeler: "human", note: "obvious" },
      { articleA: p1.id, articleB: p2.id, label: "related", labeler: "model:x" },
      { articleA: q1.id, articleB: q2.id, label: "different", labeler: "human" },
    ]);
    const exported = await exportPairLabels(db);
    const text = toJsonl(exported);
    expect(text.split("\n").filter(Boolean)).toHaveLength(3);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // keyed by guid, no internal UUIDs

    // A fresh database: same articles (new ids), no labels.
    await resetTestDb(client);
    await articles(["guid-c", "guid-b", "guid-a"]);
    const result = await importPairLabels(db, parseJsonl(text));
    expect(result).toEqual({ imported: 3, skippedMissingArticle: 0 });
    expect(await exportPairLabels(db)).toEqual(exported);
  });

  it("is idempotent and updates a changed label", async () => {
    const [a, b] = await articles(["g1", "g2"]);
    const records = [
      { type: "pair" as const, a: "g1", b: "g2", label: "same" as const, labeler: "human", note: null, createdAt: "2026-10-04T00:00:00.000Z" },
    ];
    await importPairLabels(db, records);
    await importPairLabels(db, records);
    expect(await db.select().from(evalPairLabels)).toHaveLength(1);
    await importPairLabels(db, [{ ...records[0], label: "related" }]);
    const rows = await db.select().from(evalPairLabels);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("related");
    expect([a.id, b.id]).toContain(rows[0].articleA);
  });

  it("skips labels whose articles are missing and reports them", async () => {
    await articles(["only-one"]);
    const result = await importPairLabels(db, [
      { type: "pair", a: "only-one", b: "gone", label: "same", labeler: "human", note: null, createdAt: "2026-10-04T00:00:00.000Z" },
    ]);
    expect(result).toEqual({ imported: 0, skippedMissingArticle: 1 });
  });
});
