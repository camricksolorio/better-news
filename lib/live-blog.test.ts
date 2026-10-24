import { describe, expect, it } from "vitest";
import { isLiveBlog } from "./live-blog";

const live = (sourceId: string, link: string, title = "A headline") => isLiveBlog({ sourceId, link, title });

describe("isLiveBlog: production examples (2026-10-24)", () => {
  it.each([
    ["aljazeera-all", "https://www.aljazeera.com/news/liveblog/2026/10/24/france-protests-live-135-arrested?traffic_source=rss"],
    ["bloomberg-markets", "https://www.bloomberg.com/news/live-blog/2026-10-13/ftse-100-live-updates-what-s-moving-mv69nrdn"],
    ["cbs-main", "https://www.cbsnews.com/live-updates/iran-war-trump-us-oil-gas-prices-strait-of-hormuz-midterms/"],
    ["cnn-top", "https://www.cnn.com/europe/live-news/russia-ukraine-war-news-04-18-23/index.html"],
    ["dw-all", "https://www.dw.com/en/france-clashes-break-out-as-protests-go-nationwide/live-79748223?maca=en-rss-en-all-1573-rdf"],
    ["guardian-us", "https://www.theguardian.com/us-news/live/2026/oct/23/trump-florida-midterms-ramaswamy-latest-updates"],
    ["guardian-world", "https://www.theguardian.com/world/live/2026/oct/24/france-demonstrations-police-macron-latest-news"],
    ["nyt-business", "https://www.nytimes.com/live/2026/09/24/business/trump-cnn-politico-msnow-white-house/the-court-ordered"],
    ["nyt-economy", "https://www.nytimes.com/live/2026/10/14/business/inflation-cpi-report-september/heres-the-latest"],
    ["nyt-us", "https://www.nytimes.com/live/2026/10/21/us/kansas-senate-debate-election/a-megachurch-pastor"],
    ["the-hill", "https://thehill.com/homenews/administration/6169684-live-updates-obama-harris-to-campaign-for-democrats/"],
  ])("%s", (sourceId, link) => {
    expect(live(sourceId, link)).toBe(true);
  });
});

describe("isLiveBlog: known false positives", () => {
  it("does not match PBS live-map articles", () => {
    expect(live("pbs-newshour", "https://www.pbs.org/newshour/nation/live-map-track-the-path-of-hurricane-vance", "LIVE MAP: Track the path of Hurricane Vance")).toBe(false);
  });

  it("does not match Washington Examiner live-grenade articles", () => {
    expect(live("washington-examiner", "https://www.washingtonexaminer.com/news/world/4776807/live-grenade-training-canada-military-base-fire/", "Live grenade training sparked deadly fire")).toBe(false);
  });

  it("does not match a normal article from a source that has live-blog rules", () => {
    expect(live("guardian-us", "https://www.theguardian.com/us-news/2026/oct/23/trump-florida-midterms")).toBe(false);
    expect(live("dw-all", "https://www.dw.com/en/france-protests/a-79748223")).toBe(false);
    expect(live("the-hill", "https://thehill.com/homenews/6169684-obama-harris-campaign/")).toBe(false);
  });

  it("does not apply one source's URL rule to another source", () => {
    expect(live("npr-top", "https://www.npr.org/live/2026/10/24/story")).toBe(false);
  });

  it("does not throw on a link that is not a URL", () => {
    expect(live("nyt-us", "not a url")).toBe(false);
  });
});

describe("isLiveBlog: title rule (all sources)", () => {
  it.each(["Live: Protests across France", "LIVE: Markets open lower", "Live updates – Storm hits Florida", "Live updates: Debate night", "Live | Election results", "Live - Senate vote"])(
    "matches %s",
    (title) => {
      expect(live("npr-top", "https://www.npr.org/2026/10/24/story", title)).toBe(true);
    },
  );

  it.each(["Live grenade training", "Live music returns to Austin", "Delivered: new report", "Alive and well", "Fans live stream the final"])(
    "does not match %s",
    (title) => {
      expect(live("npr-top", "https://www.npr.org/2026/10/24/story", title)).toBe(false);
    },
  );
});
