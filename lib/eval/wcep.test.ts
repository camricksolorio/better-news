import { describe, expect, it } from "vitest";
import { buildPairs, isJunk, normalizeCategory, type WcepArticle, type WcepEvent } from "./wcep";

const art = (url: string, time = "2019-01-06T10:00:00Z", origin = "WCEP"): WcepArticle => ({
  url,
  title: `title ${url}`,
  text: "the president said that the plan was not in the best interest of the people and he will not sign it after the vote on the bill in the senate ".repeat(3),
  time,
  origin,
});
const event = (id: number, category: string, urls: string[], date = "2019-01-06"): WcepEvent => ({
  id,
  date,
  category,
  articles: urls.map((u) => art(u)),
});

describe("wcep", () => {
  it("merges category typos", () => {
    expect(normalizeCategory("Armed conflict and attacks ")).toBe(normalizeCategory("Armed conflicts and attack"));
    expect(normalizeCategory("Art and culture")).toBe(normalizeCategory("Arts and culture"));
  });

  it("pairs cited articles of one event as same, ordered a < b", () => {
    const pairs = buildPairs([event(1, "Sports", ["https://x.com/b", "https://x.com/a"])]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: "https://x.com/a", b: "https://x.com/b", label: "same", eventA: 1, eventB: 1 });
  });

  it("builds negatives only from different events on the same day and category", () => {
    const events = [
      event(1, "Sports", ["https://x.com/1", "https://x.com/2"]),
      event(2, "Sports ", ["https://y.com/1"]),
      event(3, "Sports", ["https://z.com/1"], "2019-01-07"),
    ];
    const neg = buildPairs(events).filter((p) => p.label === "different");
    expect(neg.length).toBeGreaterThan(0);
    for (const p of neg) expect(new Set([p.eventA, p.eventB])).toEqual(new Set([1, 2]));
  });

  it("ignores Common Crawl articles and short ones", () => {
    const e: WcepEvent = { id: 1, date: "2019-01-06", category: "Sports", articles: [art("https://x.com/a"), art("https://x.com/b", "2019-01-06T10:00:00Z", "CommonCrawl"), { ...art("https://x.com/c"), text: "short" }] };
    expect(buildPairs([e])).toHaveLength(0);
  });

  it("flags non-article pages", () => {
    const text = "the president said that the plan was not in the best interest of the people and he will not sign it after the vote on the bill in the senate ".repeat(3);
    const ok = { url: "https://cnn.com/a", title: "President rejects plan", text };
    expect(isJunk(ok)).toBe(false);
    expect(isJunk({ ...ok, url: "https://twitter.com/x/status/1" })).toBe(true);
    expect(isJunk({ ...ok, url: "https://nhc.noaa.gov/a" })).toBe(true);
    expect(isJunk({ ...ok, title: "Are you a robot?" })).toBe(true);
    expect(isJunk({ ...ok, title: "Federaal parket sleept beruchte Belgische wapenhandelaar opn..." })).toBe(true);
    expect(isJunk({ ...ok, text: "Het federaal parket sleept de beruchte Belgische wapenhandelaar opnieuw voor de strafrechter. ".repeat(10) })).toBe(true);
  });

  it("is deterministic for a seed", () => {
    const events = [1, 2, 3].map((i) => event(i, "Sports", [`https://x.com/${i}a`, `https://x.com/${i}b`, `https://x.com/${i}c`]));
    expect(buildPairs(events, { seed: 5 })).toEqual(buildPairs(events, { seed: 5 }));
  });
});
