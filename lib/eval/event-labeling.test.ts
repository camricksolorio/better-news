import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { evalEventArticles, evalEvents, feedItems } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { clearEventLabel, listEvents, loadEvent, saveEventLabel } from "./event-labeling";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 12, 0);
const at = (deg: number) => {
  const v = new Array(768).fill(0);
  v[0] = Math.cos((deg * Math.PI) / 180);
  v[1] = Math.sin((deg * Math.PI) / 180);
  return v;
};

let n = 0;
async function article(hours: number, deg: number, over: Partial<typeof feedItems.$inferInsert> = {}) {
  const [row] = await db
    .insert(feedItems)
    .values({
      sourceId: `s${n}`,
      guid: `g${n++}`,
      title: `Headline ${n}`,
      link: `https://x.test/${n}`,
      summary: "A reasonably long description of the article for the labeller to read.",
      publishedAt: new Date(T0 + hours * H),
      embedding: at(deg),
      embeddingModel: "gemini-embedding-2",
      embeddingInputVersion: "v1",
      ...over,
    })
    .returning();
  return row;
}

async function event(seed: { id: string }, over: Partial<typeof evalEvents.$inferInsert> = {}) {
  const [e] = await db.insert(evalEvents).values({ title: "An event", split: "dev", ...over }).returning();
  await db.insert(evalEventArticles).values({ eventId: e.id, articleId: seed.id, label: "in", labeler: "sampler" });
  return e;
}

const candidateIds = async (eventId: string, wide = false) => (await loadEvent(db, eventId, { wide }))!.candidates.map((c) => c.id);

describe("loadEvent candidates", () => {
  it("proposes articles within 48h and cosine 0.85 of an in article, most similar first", async () => {
    const seed = await article(0, 0);
    const close = await article(2, 10); // cos 0.985
    const mid = await article(20, 25); // cos 0.906
    const edge = await article(-47, 30); // cos 0.866, 47h before
    await article(5, 35); // cos 0.819: below the default floor
    const e = await event(seed);
    expect(await candidateIds(e.id)).toEqual([close.id, mid.id, edge.id]);
  });

  it("includes articles down to cosine 0.70 in wide mode, still most similar first", async () => {
    const seed = await article(0, 0);
    const close = await article(2, 10); // 0.985
    const low = await article(5, 35); // 0.819
    const lower = await article(-47, 45); // 0.707, 47h before
    await article(3, 50); // 0.643: below even the wide floor
    const e = await event(seed);
    expect(await candidateIds(e.id)).toEqual([close.id]);
    expect(await candidateIds(e.id, true)).toEqual([close.id, low.id, lower.id]);
  });

  it("leaves out articles too far in time or too dissimilar", async () => {
    const seed = await article(0, 0);
    await article(49, 0); // right on topic, 49h later
    await article(-49, 0);
    await article(2, 60); // cos 0.5
    const e = await event(seed);
    expect(await candidateIds(e.id)).toEqual([]);
  });

  it("leaves out excluded articles, articles without a vector, and already labelled ones", async () => {
    const seed = await article(0, 0);
    await article(1, 5, { excludedReason: "live_blog" });
    await article(1, 5, { embedding: null, embeddingModel: null, embeddingInputVersion: null });
    const labelled = await article(1, 5);
    const open = await article(1, 8);
    const e = await event(seed);
    await saveEventLabel(db, e.id, labelled.id, "out");
    expect(await candidateIds(e.id)).toEqual([open.id]);
  });

  it("never proposes the in articles themselves", async () => {
    const seed = await article(0, 0);
    const e = await event(seed);
    expect(await candidateIds(e.id)).not.toContain(seed.id);
  });

  it("widens when an article is marked in, and not when it is marked related or out", async () => {
    const seed = await article(0, 0);
    const x = await article(40, 30); // within 48h and 0.866 of the seed
    const y = await article(80, 55); // 80h from the seed and cos 0.57 to it, but 40h and cos 0.91 from x
    const e = await event(seed);
    expect(await candidateIds(e.id)).toEqual([x.id]);

    await saveEventLabel(db, e.id, x.id, "related");
    expect(await candidateIds(e.id)).toEqual([]);

    await saveEventLabel(db, e.id, x.id, "in");
    expect(await candidateIds(e.id)).toEqual([y.id]);
  });

  it("returns the labelled articles with their labels, and null for an unknown event", async () => {
    const seed = await article(0, 0);
    const other = await article(1, 5);
    const e = await event(seed);
    await saveEventLabel(db, e.id, other.id, "related");
    const loaded = (await loadEvent(db, e.id))!;
    expect(loaded.labeled.map((a) => [a.id, a.label, a.labeler]).sort()).toEqual(
      [[seed.id, "in", "sampler"], [other.id, "related", "human"]].sort(),
    );
    expect(await loadEvent(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("saveEventLabel and clearEventLabel", () => {
  it("writes a human label, and a second label for the same article replaces the first", async () => {
    const seed = await article(0, 0);
    const a = await article(1, 5);
    const e = await event(seed);
    await saveEventLabel(db, e.id, a.id, "out");
    await saveEventLabel(db, e.id, a.id, "in");
    const rows = await db.select().from(evalEventArticles).where(and(eq(evalEventArticles.eventId, e.id), eq(evalEventArticles.articleId, a.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "in", labeler: "human" });
  });

  it("lets the owner relabel the seed", async () => {
    const seed = await article(0, 0);
    const e = await event(seed);
    await saveEventLabel(db, e.id, seed.id, "related");
    const [row] = await db.select().from(evalEventArticles).where(eq(evalEventArticles.articleId, seed.id));
    expect(row).toMatchObject({ label: "related", labeler: "human" });
  });

  it("rejects an invalid label, an unknown event and an unknown article", async () => {
    const seed = await article(0, 0);
    const e = await event(seed);
    await expect(saveEventLabel(db, e.id, seed.id, "same" as never)).rejects.toThrow(/invalid label/);
    await expect(saveEventLabel(db, "00000000-0000-0000-0000-000000000000", seed.id, "in")).rejects.toThrow();
    await expect(saveEventLabel(db, e.id, "00000000-0000-0000-0000-000000000000", "in")).rejects.toThrow();
  });

  it("clears a human label, but not a sampler seed", async () => {
    const seed = await article(0, 0);
    const a = await article(1, 5);
    const e = await event(seed);
    await saveEventLabel(db, e.id, a.id, "in");
    await clearEventLabel(db, e.id, a.id);
    expect(await candidateIds(e.id)).toContain(a.id);
    await clearEventLabel(db, e.id, seed.id);
    const rows = await db.select().from(evalEventArticles).where(eq(evalEventArticles.eventId, e.id));
    expect(rows.map((r) => r.articleId)).toEqual([seed.id]);
  });
});

describe("listEvents", () => {
  it("counts labels per event and how many were labelled by a person", async () => {
    const seed1 = await article(0, 0);
    const seed2 = await article(500, 0);
    const a = await article(1, 5);
    const b = await article(2, 6);
    const e1 = await event(seed1, { title: "First", split: "dev" });
    await event(seed2, { title: "Second", split: "holdout" });
    await saveEventLabel(db, e1.id, a.id, "in");
    await saveEventLabel(db, e1.id, b.id, "related");
    const events = await listEvents(db);
    const first = events.find((e) => e.title === "First")!;
    const second = events.find((e) => e.title === "Second")!;
    expect(first).toMatchObject({ split: "dev", in: 2, related: 1, out: 0, human: 2 });
    expect(second).toMatchObject({ split: "holdout", in: 1, related: 0, out: 0, human: 0 });
  });
});
