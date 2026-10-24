import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  articleVersions,
  candidatePairs,
  consolidationRuns,
  evalEventArticles,
  evalEvents,
  feedItems,
  pairVerdicts,
  stories,
  storyAssignments,
} from "@/db/schema";
import { connectTestDb, dbError, resetTestDb } from "@/tests/test-db";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

const vec = () => Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
const t = (iso: string) => new Date(iso);

async function makeStory(over: Partial<typeof stories.$inferInsert> = {}) {
  const [s] = await db
    .insert(stories)
    .values({
      firstArticleAt: t("2026-10-01T00:00:00Z"),
      lastArticleAt: t("2026-10-01T01:00:00Z"),
      windowEndsAt: t("2026-10-02T12:00:00Z"),
      centroid: vec(),
      ...over,
    })
    .returning();
  return s;
}

let n = 0;
async function makeItem(over: Partial<typeof feedItems.$inferInsert> = {}) {
  const [i] = await db
    .insert(feedItems)
    .values({ sourceId: "x", guid: `g${n++}`, title: "t", link: "https://x/1", ...over })
    .returning();
  return i;
}

async function makeVersion(articleId: string, hash = `h${n++}`) {
  const [v] = await db.insert(articleVersions).values({ articleId, title: "t", contentHash: hash }).returning();
  return v;
}

// Two rows ordered by id, as the canonical pair order requires.
const ordered = <T extends { id: string }>(a: T, b: T): [T, T] => (a.id < b.id ? [a, b] : [b, a]);

describe("feed_items.first_published_at", () => {
  it("is set from published_at, else created_at, when the insert leaves it out", async () => {
    const withDate = await makeItem({ publishedAt: t("2026-10-05T10:00:00Z") });
    expect(withDate.firstPublishedAt.toISOString()).toBe("2026-10-05T10:00:00.000Z");
    const without = await makeItem();
    expect(without.firstPublishedAt.getTime()).toBe(without.createdAt.getTime());
  });

  it("keeps a value the insert gives", async () => {
    const item = await makeItem({ publishedAt: t("2026-10-05T10:00:00Z"), firstPublishedAt: t("2026-10-04T00:00:00Z") });
    expect(item.firstPublishedAt.toISOString()).toBe("2026-10-04T00:00:00.000Z");
  });
});

describe("article_versions", () => {
  it("rejects a second version with the same hash for one article", async () => {
    const item = await makeItem();
    await makeVersion(item.id, "same");
    expect(await dbError(makeVersion(item.id, "same"))).toMatch(/article_versions_article_hash_idx/);
  });

  it("allows the same hash on different articles", async () => {
    const a = await makeItem();
    const b = await makeItem();
    await makeVersion(a.id, "same");
    await expect(makeVersion(b.id, "same")).resolves.toBeTruthy();
  });
});

describe("candidate_pairs and pair_verdicts", () => {
  it("rejects a candidate pair that is not in canonical order", async () => {
    const [lo, hi] = ordered(await makeItem(), await makeItem());
    await expect(db.insert(candidatePairs).values({ aId: lo.id, bId: hi.id, cosine: 0.9 })).resolves.toBeTruthy();
    expect(await dbError(db.insert(candidatePairs).values({ aId: hi.id, bId: lo.id, cosine: 0.9 }))).toMatch(
      /candidate_pairs_order_check/,
    );
    expect(await dbError(db.insert(candidatePairs).values({ aId: lo.id, bId: lo.id, cosine: 1 }))).toMatch(
      /candidate_pairs_order_check/,
    );
  });

  it("rejects a verdict with versions out of order, a duplicate key, or an unknown relation", async () => {
    const [a, b] = ordered(await makeItem(), await makeItem());
    const [va, vb] = ordered(await makeVersion(a.id), await makeVersion(b.id));
    const row = (over: Partial<typeof pairVerdicts.$inferInsert> = {}) => ({
      versionA: va.id,
      versionB: vb.id,
      articleA: a.id,
      articleB: b.id,
      model: "jev-1.14.0",
      promptVersion: "v2",
      relation: "same",
      pSame: 0.9,
      ...over,
    });
    await expect(db.insert(pairVerdicts).values(row())).resolves.toBeTruthy();
    expect(await dbError(db.insert(pairVerdicts).values(row({ versionA: vb.id, versionB: va.id })))).toMatch(
      /pair_verdicts_order_check/,
    );
    expect(await dbError(db.insert(pairVerdicts).values(row()))).toMatch(/pair_verdicts_key_idx/);
    expect(await dbError(db.insert(pairVerdicts).values(row({ model: "other", relation: "maybe" })))).toMatch(
      /pair_verdicts_relation_check/,
    );
    await expect(db.insert(pairVerdicts).values(row({ model: "jev-1.15.0" }))).resolves.toBeTruthy();
  });
});

describe("stories: merged status", () => {
  it("rejects merged without a target, and a target without merged", async () => {
    const target = await makeStory();
    expect(await dbError(makeStory({ status: "merged" }))).toMatch(/stories_merged_check/);
    expect(await dbError(makeStory({ status: "open", mergedInto: target.id }))).toMatch(/stories_merged_check/);
    await expect(makeStory({ status: "merged", mergedInto: target.id })).resolves.toBeTruthy();
  });

  const setStatus = (id: string, status: string, mergedInto: string | null = null) =>
    db.update(stories).set({ status, mergedInto }).where(eq(stories.id, id));

  it("allows open→closed, open→merged and closed→merged", async () => {
    const target = await makeStory();
    const a = await makeStory();
    const b = await makeStory();
    const c = await makeStory({ status: "closed" });
    await expect(setStatus(a.id, "closed")).resolves.toBeTruthy();
    await expect(setStatus(b.id, "merged", target.id)).resolves.toBeTruthy();
    await expect(setStatus(c.id, "merged", target.id)).resolves.toBeTruthy();
  });

  it("still rejects closed→open", async () => {
    const s = await makeStory({ status: "closed" });
    expect(await dbError(setStatus(s.id, "open"))).toMatch(/cannot be reopened/);
  });

  it("rejects leaving merged unless the revert flag is set in the transaction", async () => {
    const target = await makeStory();
    const s = await makeStory({ status: "merged", mergedInto: target.id });
    expect(await dbError(setStatus(s.id, "open"))).toMatch(/revert run/);
    expect(await dbError(setStatus(s.id, "closed"))).toMatch(/revert run/);

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('better_news.revert', 'on', true)`);
      await tx.update(stories).set({ status: "open", mergedInto: null }).where(eq(stories.id, s.id));
    });
    expect((await db.select().from(stories).where(eq(stories.id, s.id)))[0].status).toBe("open");
  });

  it("does not let the revert flag reopen a closed story", async () => {
    const s = await makeStory({ status: "closed" });
    const error = await dbError(
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('better_news.revert', 'on', true)`);
        await tx.update(stories).set({ status: "open" }).where(eq(stories.id, s.id));
      }),
    );
    expect(error).toMatch(/cannot be reopened/);
  });
});

describe("story_assignments v2 columns", () => {
  it("accepts the new methods with run, version and evidence, and stays append-only", async () => {
    const item = await makeItem();
    const from = await makeStory();
    const to = await makeStory();
    const version = await makeVersion(item.id);
    const [run] = await db
      .insert(consolidationRuns)
      .values({ mode: "scheduled", pipelineVersion: "p1" })
      .returning();
    for (const method of ["consolidate", "repair", "revert", "exclude"]) {
      await db.insert(storyAssignments).values({
        articleId: item.id,
        storyId: to.id,
        fromStoryId: from.id,
        runId: run.id,
        articleVersionId: version.id,
        method,
        evidence: { L: 0.9, n: 3 },
      });
    }
    expect(await dbError(db.insert(storyAssignments).values({ articleId: item.id, storyId: to.id, method: "bogus" }))).toMatch(
      /story_assignments_method_check/,
    );
    expect(await dbError(client.unsafe("UPDATE story_assignments SET method = 'manual'"))).toMatch(/append-only/);
  });
});

describe("consolidation_runs and eval tables", () => {
  it("rejects unknown mode and phase, and defaults the phase to retrieve", async () => {
    expect(await dbError(db.insert(consolidationRuns).values({ mode: "weekly", pipelineVersion: "p" }))).toMatch(
      /consolidation_runs_mode_check/,
    );
    expect(
      await dbError(db.insert(consolidationRuns).values({ mode: "repair", pipelineVersion: "p", phase: "paused" })),
    ).toMatch(/consolidation_runs_phase_check/);
    const [run] = await db.insert(consolidationRuns).values({ mode: "repair", pipelineVersion: "p" }).returning();
    expect(run.phase).toBe("retrieve");
  });

  it("rejects an unknown event split and article label", async () => {
    expect(await dbError(db.insert(evalEvents).values({ title: "e", split: "test" }))).toMatch(/eval_events_split_check/);
    const [event] = await db.insert(evalEvents).values({ title: "e", split: "dev" }).returning();
    const item = await makeItem();
    expect(
      await dbError(db.insert(evalEventArticles).values({ eventId: event.id, articleId: item.id, label: "maybe", labeler: "human" })),
    ).toMatch(/eval_event_articles_label_check/);
    await expect(
      db.insert(evalEventArticles).values({ eventId: event.id, articleId: item.id, label: "in", labeler: "human" }),
    ).resolves.toBeTruthy();
  });
});
