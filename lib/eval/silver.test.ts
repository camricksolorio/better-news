import { describe, expect, it } from "vitest";
import { SAME_STORY_DEFINITION, estimateSilverCost, parseSilverVerdict, silverMessages } from "./silver";
import type { PairRecord } from "./pairs";

const pair: PairRecord = {
  a: "ga", b: "gb", category: "sim80", sim: 0.8, hoursApart: 2, merged: false,
  article: {
    a: { title: "Fed raises rates", source: "cnbc", time: "2026-10-01T10:00:00Z", snippet: "The Federal Reserve raised rates by 25bp." },
    b: { title: "Markets slide after Fed hike", source: "wsj", time: "2026-10-01T14:00:00Z", snippet: "Stocks fell." },
  },
};

describe("silver labeling", () => {
  it("builds a prompt with the verbatim definition and both articles, without similarity or the baseline's call", () => {
    const [system, user] = silverMessages(pair);
    expect(system.content).toContain(SAME_STORY_DEFINITION);
    expect(user.content).toContain("Fed raises rates");
    expect(user.content).toContain("Markets slide after Fed hike");
    expect(user.content).not.toContain("0.8");
    expect(user.content).not.toMatch(/baseline|merged/i);
  });

  it("parses a valid verdict and rejects an invalid one", () => {
    expect(parseSilverVerdict({ relation: "related", confidence: 1.4, reason: "reaction" })).toEqual({ relation: "related", confidence: 1, reason: "reaction" });
    expect(parseSilverVerdict({ relation: "maybe", confidence: 0.5, reason: "x" })).toBeNull();
    expect(parseSilverVerdict(null)).toBeNull();
  });

  it("estimates cost from the price table", () => {
    const est = estimateSilverCost([pair, pair], { input: 2, output: 10 });
    expect(est.outputTokens).toBe(240);
    expect(est.inputTokens).toBeGreaterThan(200);
    expect(est.costUsd).toBeCloseTo((est.inputTokens * 2 + 240 * 10) / 1_000_000);
  });
});
