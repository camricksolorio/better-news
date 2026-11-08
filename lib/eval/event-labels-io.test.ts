import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { evalEventArticles, evalEvents, feedItems } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { exportEvents, importEvents, parseEventsJsonl, toEvalEvent, toEventsJsonl, type EventRecord } from "./event-labels-io";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

async function articles(guids: string[]) {
  return db
    .insert(feedItems)
    .values(guids.map((guid) => ({ sourceId: "s", guid, title: guid, link: `https://x.test/${guid}` })))
    .returning();
}

async function seedEvents() {
  const [a, b, c, d] = await articles(["guid-a", "guid-b", "guid-c", "guid-d"]);
  const [e1] = await db.insert(evalEvents).values({ title: "Tariff ruling", split: "dev", note: "PRD example" }).returning();
  const [e2] = await db.insert(evalEvents).values({ title: "Bakery award", split: "holdout" }).returning();
  await db.insert(evalEventArticles).values([
    { eventId: e1.id, articleId: a.id, label: "in", labeler: "sampler" },
    { eventId: e1.id, articleId: b.id, label: "in", labeler: "human" },
    { eventId: e1.id, articleId: c.id, label: "related", labeler: "human" },
    { eventId: e2.id, articleId: d.id, label: "in", labeler: "sampler" },
  ]);
  return { e1, e2 };
}

describe("event label export/import", () => {
  it("exports one record per event with its articles keyed by guid, not internal ids", async () => {
    const { e1 } = await seedEvents();
    const records = await exportEvents(db);
    expect(records).toHaveLength(2);
    const tariff = records.find((r) => r.id === e1.id)!;
    expect(tariff).toMatchObject({ type: "event", title: "Tariff ruling", split: "dev", note: "PRD example" });
    expect(tariff.articles.map((x) => [x.guid, x.label, x.labeler])).toEqual([
      ["guid-a", "in", "sampler"],
      ["guid-b", "in", "human"],
      ["guid-c", "related", "human"],
    ]);
    const text = toEventsJsonl(records);
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
    // Only the event's own id appears; article ids do not.
    const uuids = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
    expect(new Set(uuids)).toEqual(new Set(records.map((r) => r.id)));
  });

  it("export then import into a rebuilt database restores the same events", async () => {
    await seedEvents();
    const exported = await exportEvents(db);
    const text = toEventsJsonl(exported);

    await resetTestDb(client);
    await articles(["guid-d", "guid-c", "guid-b", "guid-a"]); // same guids, new ids
    expect(await importEvents(db, parseEventsJsonl(text))).toEqual({ events: 2, labels: 4, skippedMissingArticle: 0 });
    expect(await exportEvents(db)).toEqual(exported);
  });

  it("is idempotent, and a changed label replaces the old one", async () => {
    await seedEvents();
    const exported = await exportEvents(db);
    await importEvents(db, exported);
    await importEvents(db, exported);
    expect(await db.select().from(evalEvents)).toHaveLength(2);
    expect(await db.select().from(evalEventArticles)).toHaveLength(4);

    const changed: EventRecord[] = exported.map((r) => ({
      ...r,
      articles: r.articles.map((x) => (x.guid === "guid-c" ? { ...x, label: "out" as const } : x)),
    }));
    await importEvents(db, changed);
    const rows = await db.select().from(evalEventArticles);
    expect(rows).toHaveLength(4);
    const c = (await db.select().from(feedItems).where(eq(feedItems.guid, "guid-c")))[0];
    expect(rows.find((r) => r.articleId === c.id)?.label).toBe("out");
  });

  it("skips labels for articles that are missing and reports them", async () => {
    await articles(["only-one"]);
    const record: EventRecord = {
      type: "event",
      id: "11111111-1111-1111-1111-111111111111",
      title: "E",
      split: "dev",
      note: null,
      createdAt: "2026-11-08T00:00:00.000Z",
      articles: [
        { guid: "only-one", label: "in", labeler: "human", createdAt: "2026-11-08T00:00:00.000Z" },
        { guid: "gone", label: "in", labeler: "human", createdAt: "2026-11-08T00:00:00.000Z" },
      ],
    };
    expect(await importEvents(db, [record])).toEqual({ events: 1, labels: 1, skippedMissingArticle: 1 });
  });

  it("ignores lines that are not event records", () => {
    const text = '{"type":"pair","a":"x","b":"y"}\n{"type":"event","id":"i","title":"t","split":"dev","note":null,"createdAt":"2026-11-08T00:00:00.000Z","articles":[]}\n';
    expect(parseEventsJsonl(text).map((r) => r.id)).toEqual(["i"]);
  });
});

describe("toEvalEvent", () => {
  const record = (labelers: string[]): EventRecord => ({
    type: "event",
    id: "e",
    title: "E",
    split: "holdout",
    note: null,
    createdAt: "2026-11-08T00:00:00.000Z",
    articles: labelers.map((labeler, i) => ({ guid: `g${i}`, label: "in" as const, labeler, createdAt: "2026-11-08T00:00:00.000Z" })),
  });

  it("maps labels by guid and counts an event as human-labelled only beyond the sampler's seed", () => {
    const labelled = toEvalEvent(record(["sampler", "human"]));
    expect(labelled).toMatchObject({ id: "e", split: "holdout", humanLabeled: true });
    expect(labelled.labels.get("g1")).toBe("in");
    expect(toEvalEvent(record(["sampler"])).humanLabeled).toBe(false);
  });
});
