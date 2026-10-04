import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CLUSTER_CONFIG,
  assignArticle,
  fitsWindow,
  pipelineVersion,
  type ArticleInput,
} from "./assign";
import { createMemoryStore } from "./store-memory";

const cfg = { ...DEFAULT_CLUSTER_CONFIG, tLow: 0.75, tHigh: 0.88, windowHours: 36 };
const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 1, 12, 0);

// Unit vector at an angle (degrees): cosine similarity between two is cos(angle difference).
const at = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0, 0];

let n = 0;
const article = (hoursFromT0: number, deg: number, over: Partial<ArticleInput> = {}): ArticleInput => ({
  id: `a${n++}`,
  sourceId: "src",
  time: new Date(T0 + hoursFromT0 * H),
  embedding: at(deg),
  thin: false,
  ...over,
});

describe("window", () => {
  it("a later article within 36h of first_article_at joins; one beyond it does not", async () => {
    const store = createMemoryStore();
    const first = await assignArticle(store, article(0, 0), cfg);
    const within = await assignArticle(store, article(35, 0), cfg);
    const beyond = await assignArticle(store, article(37, 0), cfg);
    expect(within).toMatchObject({ storyId: first.storyId, method: "embedding" });
    expect(beyond.storyId).not.toBe(first.storyId);
  });

  it("the first-to-last span never exceeds 36h, even through a chain of joins", async () => {
    const store = createMemoryStore();
    for (const h of [0, 12, 24, 30, 35, 36, 40, 50, 60, 70, 80]) {
      await assignArticle(store, article(h, 0), cfg);
    }
    for (const story of store.stories.values()) {
      expect(story.lastAt.getTime() - story.firstAt.getTime()).toBeLessThanOrEqual(36 * H);
      expect(story.windowEndsAt.getTime()).toBeGreaterThanOrEqual(story.lastAt.getTime());
    }
  });

  it("an article earlier than first_article_at joins and moves the anchor back when every member still fits", async () => {
    const store = createMemoryStore();
    const a = await assignArticle(store, article(0, 0), cfg);
    await assignArticle(store, article(20, 0), cfg);
    const early = await assignArticle(store, article(-10, 0), cfg);
    expect(early.storyId).toBe(a.storyId);
    const story = store.stories.get(a.storyId)!;
    expect(story.firstAt.getTime()).toBe(T0 - 10 * H);
    expect(story.lastAt.getTime()).toBe(T0 + 20 * H);
    expect(story.windowEndsAt.getTime()).toBe(T0 - 10 * H + 36 * H);
  });

  it("an earlier article that would stretch the span past 36h starts its own story", async () => {
    const store = createMemoryStore();
    const a = await assignArticle(store, article(0, 0), cfg);
    await assignArticle(store, article(20, 0), cfg);
    const tooEarly = await assignArticle(store, article(-20, 0), cfg); // 20h -> -20h = 40h span
    expect(tooEarly.storyId).not.toBe(a.storyId);
    expect(store.stories.get(a.storyId)!.firstAt.getTime()).toBe(T0);
  });

  it("fitsWindow matches the TDD rule at the boundaries", () => {
    const story = { firstAt: new Date(T0), lastAt: new Date(T0 + 20 * H) };
    const fits = (h: number) => fitsWindow(story, new Date(T0 + h * H), 36);
    expect(fits(36)).toBe(true);
    expect(fits(36.01)).toBe(false);
    expect(fits(-16)).toBe(true);
    expect(fits(-16.01)).toBe(false);
  });
});

describe("scoring", () => {
  it("does not chain: A~B and B~C do not merge A with C", async () => {
    const store = createMemoryStore();
    const a = await assignArticle(store, article(0, 0), cfg);
    const b = await assignArticle(store, article(1, 20), cfg); // cos 20deg = 0.94 to A
    const c = await assignArticle(store, article(2, 40), cfg); // 0.94 to B, but 0.866 to the {A,B} centroid
    expect(b.storyId).toBe(a.storyId);
    expect(c.storyId).not.toBe(a.storyId);
  });

  it("an article below T_low starts a new story", async () => {
    const store = createMemoryStore();
    const a = await assignArticle(store, article(0, 0), cfg);
    const b = await assignArticle(store, article(1, 60), cfg); // cos 60deg = 0.5
    expect(b).toMatchObject({ created: true, method: "new_story" });
    expect(b.storyId).not.toBe(a.storyId);
  });

  it("keeps a running-mean centroid and counts distinct sources", async () => {
    const store = createMemoryStore();
    const a = await assignArticle(store, article(0, 0, { sourceId: "x" }), cfg);
    await assignArticle(store, article(1, 10, { sourceId: "y" }), cfg);
    await assignArticle(store, article(2, 0, { sourceId: "y" }), cfg);
    const story = store.stories.get(a.storyId)!;
    expect(story.articleCount).toBe(3);
    expect(story.sourceCount).toBe(2);
    const expectedX = (at(0)[0] + at(10)[0] + at(0)[0]) / 3;
    expect(story.centroid[0]).toBeCloseTo(expectedX, 10);
  });

  it("an older article that is clustered after newer ones still joins the right story", async () => {
    const store = createMemoryStore();
    const a = await assignArticle(store, article(10, 0), cfg);
    await assignArticle(store, article(12, 5), cfg);
    const late = await assignArticle(store, article(8, 3), cfg); // arrives last, published earliest
    expect(late.storyId).toBe(a.storyId);
    expect(store.stories.get(a.storyId)!.firstAt.getTime()).toBe(T0 + 8 * H);
  });

  it("records the scores and method of every decision", async () => {
    const store = createMemoryStore();
    await assignArticle(store, article(0, 0), cfg);
    await assignArticle(store, article(1, 0), cfg);
    expect(store.assignments.map((x) => x.info.method)).toEqual(["new_story", "embedding"]);
    expect(store.assignments[1].info.topScore).toBeCloseTo(1);
  });
});

describe("ties", () => {
  it("an exact tie goes to the bigger story, regardless of candidate order", async () => {
    const store = createMemoryStore();
    const big = await assignArticle(store, article(0, 0), cfg);
    await assignArticle(store, article(20, 0), cfg);
    const small = await assignArticle(store, article(-20, 0), cfg); // too early to join: its own story
    expect(small.storyId).not.toBe(big.storyId);
    const out = await assignArticle(store, article(-10, 0), cfg); // fits both, identical score
    expect(out.storyId).toBe(big.storyId);
  });
});

describe("gray zone and thin articles", () => {
  const gray = 30; // cos 30deg = 0.866: between T_low and T_high

  it("without an adjudicator a gray-zone article starts a new story", async () => {
    const store = createMemoryStore();
    await assignArticle(store, article(0, 0), cfg);
    const out = await assignArticle(store, article(1, gray), cfg);
    expect(out.created).toBe(true);
  });

  it("sends the gray zone to the adjudicator; same joins with method llm, otherwise a new story", async () => {
    const store = createMemoryStore();
    const a = await assignArticle(store, article(0, 0), cfg);
    const yes = vi.fn(async () => ({ same: true, verdict: { reason: "y" } }));
    const joined = await assignArticle(store, article(1, gray), cfg, yes);
    expect(joined).toMatchObject({ storyId: a.storyId, method: "llm" });
    expect(yes).toHaveBeenCalledTimes(1);
    expect(store.assignments.at(-1)!.info.llmVerdict).toEqual({ reason: "y" });

    const store2 = createMemoryStore();
    const b = await assignArticle(store2, article(0, 0), cfg);
    const no = vi.fn(async () => ({ same: false }));
    const split = await assignArticle(store2, article(1, gray), cfg, no);
    expect(split.storyId).not.toBe(b.storyId);
  });

  it("does not call the adjudicator for clear joins or clear misses", async () => {
    const store = createMemoryStore();
    await assignArticle(store, article(0, 0), cfg);
    const adj = vi.fn(async () => ({ same: true }));
    await assignArticle(store, article(1, 0), cfg, adj);
    await assignArticle(store, article(2, 80), cfg, adj);
    expect(adj).not.toHaveBeenCalled();
  });

  it("a thin article above T_low never auto-joins, even when identical", async () => {
    const store = createMemoryStore();
    const a = await assignArticle(store, article(0, 0), cfg);
    const adj = vi.fn(async () => ({ same: true }));
    const out = await assignArticle(store, article(1, 0, { thin: true }), cfg, adj);
    expect(adj).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ storyId: a.storyId, method: "llm" });

    const store2 = createMemoryStore();
    await assignArticle(store2, article(0, 0), cfg);
    const noAdj = await assignArticle(store2, article(1, 0, { thin: true }), cfg);
    expect(noAdj.created).toBe(true);
  });
});

describe("pipelineVersion", () => {
  it("changes when a threshold changes and is stable otherwise", () => {
    expect(pipelineVersion(cfg)).toBe(pipelineVersion({ ...cfg }));
    expect(pipelineVersion(cfg)).not.toBe(pipelineVersion({ ...cfg, tHigh: 0.9 }));
  });
});
