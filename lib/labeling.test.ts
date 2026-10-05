import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { evalPairLabels, feedItems } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { chooseReviewSet, deleteHumanLabel, loadQueue, pairKey, saveHumanLabel } from "./labeling";
import type { PairRecord } from "@/lib/eval/pairs";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

const pair = (a: string, b: string, merged = false): PairRecord => ({
  a, b, merged, category: "sim80", sim: 0.8, hoursApart: 3,
  article: { a: { title: a, source: "x", time: "2026-10-01T00:00:00Z", snippet: "" }, b: { title: b, source: "y", time: "2026-10-01T01:00:00Z", snippet: "" } },
});

async function seed(guids: string[]) {
  return db.insert(feedItems).values(guids.map((guid) => ({ sourceId: "s", guid, title: guid, link: `https://x.test/${guid}` }))).returning();
}

describe("chooseReviewSet", () => {
  it("includes every silver-vs-baseline disagreement and a bounded random sample of the rest", () => {
    const pairs = Array.from({ length: 100 }, (_, i) => pair(`a${i}`, `b${i}`, i < 50));
    const silver = new Map<string, "same" | "different">();
    pairs.forEach((p, i) => {
      // 10 pairs disagree: merged but silver says different, or the reverse.
      const disagree = i % 10 === 0;
      silver.set(pairKey(p.a, p.b), (p.merged ? "same" : "different") === "same" === !disagree ? "same" : "different");
    });
    const set = chooseReviewSet(pairs, silver, 20);
    const disagreements = [...set.values()].filter((v) => v === "disagreement");
    expect(disagreements).toHaveLength(10);
    expect([...set.values()].filter((v) => v === "random")).toHaveLength(20);
    // Pairs with no silver label are never queued.
    expect(chooseReviewSet(pairs, new Map(), 20).size).toBe(0);
  });

  it("is deterministic for a seed", () => {
    const pairs = Array.from({ length: 80 }, (_, i) => pair(`a${i}`, `b${i}`, false));
    const silver = new Map(pairs.map((p) => [pairKey(p.a, p.b), "different" as const]));
    expect([...chooseReviewSet(pairs, silver, 10, 3).keys()]).toEqual([...chooseReviewSet(pairs, silver, 10, 3).keys()]);
  });
});

describe("saving and loading labels", () => {
  it("saves a human label with ordered ids, overwrites it, and deletes it", async () => {
    await seed(["g1", "g2"]);
    await saveHumanLabel(db, "g2", "g1", "same", "obvious");
    await saveHumanLabel(db, "g1", "g2", "related");
    const rows = await db.select().from(evalPairLabels);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "related", labeler: "human", note: null });
    expect(rows[0].articleA < rows[0].articleB).toBe(true);
    await deleteHumanLabel(db, "g1", "g2");
    expect(await db.select().from(evalPairLabels)).toHaveLength(0);
  });

  it("rejects invalid labels and unknown articles", async () => {
    await seed(["g1"]);
    await expect(saveHumanLabel(db, "g1", "nope", "same")).rejects.toThrow(/unknown article/);
    await expect(saveHumanLabel(db, "g1", "g1", "same")).rejects.toThrow();
    // @ts-expect-error invalid label on purpose
    await expect(saveHumanLabel(db, "g1", "g2", "maybe")).rejects.toThrow(/invalid label/);
  });

  it("loadQueue attaches links, human labels, and silver labels", async () => {
    const [a, b, c] = await seed(["g1", "g2", "g3"]);
    const [x, y] = a.id < b.id ? [a, b] : [b, a];
    await db.insert(evalPairLabels).values({ articleA: x.id, articleB: y.id, label: "same", labeler: "model:test/m", note: "same event" });
    await saveHumanLabel(db, "g1", "g3", "different");
    void c;
    const queue = await loadQueue(db, [pair("g1", "g2", false), pair("g1", "g3", false)]);
    const q12 = queue.find((q) => q.key === pairKey("g1", "g2"))!;
    expect(q12).toMatchObject({ human: null, linkA: "https://x.test/g1", silver: { label: "same", labeler: "model:test/m" } });
    expect(q12.reviewReason).toBe("disagreement"); // silver says same, baseline kept them apart
    expect(queue.find((q) => q.key === pairKey("g1", "g3"))!.human).toBe("different");
  });
});
