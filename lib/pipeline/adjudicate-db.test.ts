import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { feedItems } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import type { Candidate, ArticleInput } from "./assign";
import { createDbAdjudicator } from "./adjudicate-db";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

let n = 0;
const insert = async (title: string, sourceId: string) =>
  (await db.insert(feedItems).values({ sourceId, guid: `g${n++}`, title, link: `https://x.test/${n}`, summary: "<p>Some &amp; summary</p>", publishedAt: new Date("2026-10-05T10:00:00Z") }).returning())[0];

const classifyReturning = (choice: string, pSame: number) =>
  vi.fn().mockResolvedValue({ answers: { relation: { type: "choice", choice, probabilities: { same: pSame } } }, cached: false, model: "jev-1.13.0" });

const input = (id: string) => ({ id }) as ArticleInput;
const candidate = { story: { id: "story-1" } } as Candidate;

describe("createDbAdjudicator", () => {
  it("loads both articles from feed_items, sends cleaned text, and joins at or above τ", async () => {
    const a = await insert("Quake hits coast", "bbc");
    const m = await insert("Earthquake strikes coast", "npr");
    const classify = classifyReturning("same", 0.95);
    const judge = createDbAdjudicator(db, { chat: vi.fn(), classify }, { model: "jev-latest", promptVersion: "v2", tau: 0.93 });

    const out = await judge(input(a.id), m.id, candidate);

    expect(out.same).toBe(true);
    expect(out.verdict).toEqual({ relation: "same", pSame: 0.95, model: "jev-1.13.0" });
    const call = classify.mock.calls[0][0];
    expect(call.state).toContain("Quake hits coast");
    expect(call.state).toContain("Earthquake strikes coast");
    expect(call.state).toContain("Some & summary");
    expect(call.context).toEqual({ articleId: a.id, storyId: "story-1" });
  });

  it("does not join below τ, or on a `related` verdict", async () => {
    const a = await insert("A", "bbc");
    const m = await insert("B", "npr");
    const cfg = { model: "jev-latest", promptVersion: "v2", tau: 0.93 };
    expect((await createDbAdjudicator(db, { chat: vi.fn(), classify: classifyReturning("same", 0.9) }, cfg)(input(a.id), m.id, candidate)).same).toBe(false);
    expect((await createDbAdjudicator(db, { chat: vi.fn(), classify: classifyReturning("related", 0.99) }, cfg)(input(a.id), m.id, candidate)).same).toBe(false);
  });

  it("throws for a missing article and propagates a failed call (the article stays unclustered)", async () => {
    const a = await insert("A", "bbc");
    const m = await insert("B", "npr");
    const cfg = { model: "jev-latest", promptVersion: "v2", tau: 0.93 };
    const missing = "00000000-0000-0000-0000-000000000000";
    await expect(createDbAdjudicator(db, { chat: vi.fn(), classify: vi.fn() }, cfg)(input(a.id), missing, candidate)).rejects.toThrow(/not found/);
    const failing = vi.fn().mockRejectedValue(new Error("503"));
    await expect(createDbAdjudicator(db, { chat: vi.fn(), classify: failing }, cfg)(input(a.id), m.id, candidate)).rejects.toThrow("503");
  });
});
