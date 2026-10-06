import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CLUSTER_CONFIG,
  assignArticle,
  fitsWindow,
  pipelineVersion,
  type Adjudicator,
  type ArticleInput,
  type StoryStore,
} from "./assign";
import { createMemoryStore } from "./store-memory";

const cfg = { ...DEFAULT_CLUSTER_CONFIG, tLow: 0.75, windowHours: 36 };
const H = 3_600_000;
const yes: Adjudicator = async () => ({ same: true });
// Most tests are about scoring and windows, so the classifier agrees; the classifier tests below vary it.
const assign = (store: StoryStore, a: ArticleInput, adj: Adjudicator = yes, c = cfg) => assignArticle(store, a, c, adj);
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
    const first = await assign(store, article(0, 0));
    const within = await assign(store, article(35, 0));
    const beyond = await assign(store, article(37, 0));
    expect(within).toMatchObject({ storyId: first.storyId, method: "llm" });
    expect(beyond.storyId).not.toBe(first.storyId);
  });

  it("the first-to-last span never exceeds 36h, even through a chain of joins", async () => {
    const store = createMemoryStore();
    for (const h of [0, 12, 24, 30, 35, 36, 40, 50, 60, 70, 80]) {
      await assign(store, article(h, 0));
    }
    for (const story of store.stories.values()) {
      expect(story.lastAt.getTime() - story.firstAt.getTime()).toBeLessThanOrEqual(36 * H);
      expect(story.windowEndsAt.getTime()).toBeGreaterThanOrEqual(story.lastAt.getTime());
    }
  });

  it("an article earlier than first_article_at joins and moves the anchor back when every member still fits", async () => {
    const store = createMemoryStore();
    const a = await assign(store, article(0, 0));
    await assign(store, article(20, 0));
    const early = await assign(store, article(-10, 0));
    expect(early.storyId).toBe(a.storyId);
    const story = store.stories.get(a.storyId)!;
    expect(story.firstAt.getTime()).toBe(T0 - 10 * H);
    expect(story.lastAt.getTime()).toBe(T0 + 20 * H);
    expect(story.windowEndsAt.getTime()).toBe(T0 - 10 * H + 36 * H);
  });

  it("an earlier article that would stretch the span past 36h starts its own story", async () => {
    const store = createMemoryStore();
    const a = await assign(store, article(0, 0));
    await assign(store, article(20, 0));
    const tooEarly = await assign(store, article(-20, 0)); // 20h -> -20h = 40h span
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
    const strict = { ...cfg, tLow: 0.9 };
    const a = await assign(store, article(0, 0), yes, strict);
    const b = await assign(store, article(1, 20), yes, strict); // cos 20deg = 0.94 to A
    const c = await assign(store, article(2, 40), yes, strict); // 0.94 to B, but 0.866 to the {A,B} centroid
    expect(b.storyId).toBe(a.storyId);
    expect(c.storyId).not.toBe(a.storyId);
  });

  it("an article below T_low starts a new story", async () => {
    const store = createMemoryStore();
    const a = await assign(store, article(0, 0));
    const b = await assign(store, article(1, 60)); // cos 60deg = 0.5
    expect(b).toMatchObject({ created: true, method: "new_story" });
    expect(b.storyId).not.toBe(a.storyId);
  });

  it("keeps a running-mean centroid and counts distinct sources", async () => {
    const store = createMemoryStore();
    const a = await assign(store, article(0, 0, { sourceId: "x" }));
    await assign(store, article(1, 10, { sourceId: "y" }));
    await assign(store, article(2, 0, { sourceId: "y" }));
    const story = store.stories.get(a.storyId)!;
    expect(story.articleCount).toBe(3);
    expect(story.sourceCount).toBe(2);
    const expectedX = (at(0)[0] + at(10)[0] + at(0)[0]) / 3;
    expect(story.centroid[0]).toBeCloseTo(expectedX, 10);
  });

  it("an older article that is clustered after newer ones still joins the right story", async () => {
    const store = createMemoryStore();
    const a = await assign(store, article(10, 0));
    await assign(store, article(12, 5));
    const late = await assign(store, article(8, 3)); // arrives last, published earliest
    expect(late.storyId).toBe(a.storyId);
    expect(store.stories.get(a.storyId)!.firstAt.getTime()).toBe(T0 + 8 * H);
  });

  it("records the scores and method of every decision", async () => {
    const store = createMemoryStore();
    await assign(store, article(0, 0));
    await assign(store, article(1, 0));
    expect(store.assignments.map((x) => x.info.method)).toEqual(["new_story", "llm"]);
    expect(store.assignments[1].info.topScore).toBeCloseTo(1);
  });
});

describe("ties", () => {
  it("an exact tie goes to the bigger story, regardless of candidate order", async () => {
    const store = createMemoryStore();
    const big = await assign(store, article(0, 0));
    await assign(store, article(20, 0));
    const small = await assign(store, article(-20, 0)); // too early to join: its own story
    expect(small.storyId).not.toBe(big.storyId);
    const out = await assign(store, article(-10, 0)); // fits both, identical score
    expect(out.storyId).toBe(big.storyId);
  });
});

describe("classifier decides every join (D32, D34)", () => {
  const near = 5; // cos 5deg = 0.996: far above T_low
  const joinIds = (calls: { memberId: string }[]) => calls.map((c) => c.memberId);

  it("without an adjudicator nothing joins, however similar", async () => {
    const store = createMemoryStore();
    await assignArticle(store, article(0, 0), cfg);
    const out = await assignArticle(store, article(1, 0), cfg);
    expect(out).toMatchObject({ created: true, method: "new_story" });
  });

  it("an article below T_low never reaches the classifier", async () => {
    const store = createMemoryStore();
    await assign(store, article(0, 0));
    const adj = vi.fn(yes);
    await assign(store, article(1, 60), adj);
    expect(adj).not.toHaveBeenCalled();
  });

  it("a thin article takes the same path as any other", async () => {
    const store = createMemoryStore();
    const a = await assign(store, article(0, 0));
    const adj = vi.fn(yes);
    const out = await assign(store, article(1, 0, { thin: true }), adj);
    expect(adj).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ storyId: a.storyId, method: "llm" });
  });

  it("uses one call when the first article is also the most similar member", async () => {
    const store = createMemoryStore();
    const a = await assign(store, article(0, 0));
    const calls: string[] = [];
    const adj: Adjudicator = async (_art, memberId) => (calls.push(memberId), { same: true });
    await assign(store, article(1, near), adj);
    expect(calls).toEqual([store.members.get(a.storyId)![0].id]);
  });

  it("checks the first article and the most similar member when they differ, and needs both", async () => {
    const store = createMemoryStore();
    const first = await assign(store, article(0, 0));
    const second = article(1, 20); // joins the story: the member nearest to later articles
    await assign(store, second);
    const members = store.members.get(first.storyId)!;
    const newcomer = article(2, 22); // nearest member is `second`, not the first article
    const seen: string[] = [];
    const allYes: Adjudicator = async (_a, memberId) => (seen.push(memberId), { same: true });
    const out = await assign(store, newcomer, allYes);
    expect(seen).toEqual([members[0].id, second.id]);
    expect(out).toMatchObject({ storyId: first.storyId, method: "llm" });
  });

  it("a single 'related' verdict blocks the join, and a rejection on the first article skips the second call", async () => {
    const store = createMemoryStore();
    const first = await assign(store, article(0, 0));
    await assign(store, article(1, 20));
    const firstId = store.members.get(first.storyId)![0].id;

    const rejectFirst = vi.fn<Adjudicator>(async () => ({ same: false }));
    const out1 = await assign(store, article(2, 22), rejectFirst);
    expect(out1.created).toBe(true);
    expect(rejectFirst).toHaveBeenCalledTimes(1);

    const rejectSecond: Adjudicator = async (_a, memberId) => ({ same: memberId === firstId });
    const out2 = await assign(store, article(3, 21), rejectSecond);
    expect(out2.created).toBe(true);
  });

  it("logs both verdicts on the assignment", async () => {
    const store = createMemoryStore();
    const first = await assign(store, article(0, 0));
    await assign(store, article(1, 20));
    const adj: Adjudicator = async (_a, memberId) => ({ same: true, verdict: { v: memberId }, llmCallId: "call-1" });
    await assign(store, article(2, 22), adj);
    const info = store.assignments.at(-1)!.info;
    expect(info.method).toBe("llm");
    expect(info.llmCallId).toBe("call-1");
    expect(joinIds(info.llmVerdict as { memberId: string }[])).toHaveLength(2);
    expect(store.members.get(first.storyId)).toHaveLength(3);
  });

  it("a failed call leaves the article unclustered: nothing is written", async () => {
    const store = createMemoryStore();
    await assign(store, article(0, 0));
    const before = { stories: store.stories.size, assignments: store.assignments.length };
    const boom: Adjudicator = async () => {
      throw new Error("jev 500");
    };
    await expect(assign(store, article(1, 0), boom)).rejects.toThrow("jev 500");
    expect({ stories: store.stories.size, assignments: store.assignments.length }).toEqual(before);
  });

  it("the default 12h window blocks a join at 13h", async () => {
    const store = createMemoryStore();
    const dflt = { ...DEFAULT_CLUSTER_CONFIG };
    const a = await assign(store, article(0, 0), yes, dflt);
    const at11 = await assign(store, article(11, 0), yes, dflt);
    const at13 = await assign(store, article(13, 0), yes, dflt);
    expect(at11.storyId).toBe(a.storyId);
    expect(at13.storyId).not.toBe(a.storyId);
  });

  it("defaults: T_low 0.84, 12h window, no T_high", () => {
    expect(DEFAULT_CLUSTER_CONFIG).toMatchObject({ tLow: 0.84, windowHours: 12 });
    expect("tHigh" in DEFAULT_CLUSTER_CONFIG).toBe(false);
  });
});

describe("pipelineVersion", () => {
  it("changes when a threshold changes and is stable otherwise", () => {
    expect(pipelineVersion(cfg)).toBe(pipelineVersion({ ...cfg }));
    expect(pipelineVersion(cfg)).not.toBe(pipelineVersion({ ...cfg, tLow: 0.9 }));
  });
});
