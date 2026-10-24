import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm";
import {
  HEADLINE_MAX_CHARS,
  NotSummarizableError,
  SummaryValidationError,
  countOutlets,
  isSummarizable,
  summarizeStory,
  summaryMessages,
  validateSummary,
  type SummaryArticle,
} from "./summarize";

const articles: SummaryArticle[] = [
  { source: "cnbc", title: "Fed raises rates", snippet: "<p>The Federal Reserve raised rates by 25bp.</p>" },
  { source: "wsj", title: "Markets slide after Fed hike", snippet: "" },
  { source: "cnbc", title: "Fed hike: what it means", snippet: null },
];

const good = {
  headline: "Fed raises interest rates by a quarter point",
  summary: [
    { text: "The Fed raised rates by 25 basis points.", citations: [1, 3] },
    { text: "Stocks fell after the decision.", citations: [2] },
  ],
  coverage_notes: [{ text: "The WSJ stresses the market reaction.", citations: [2] }],
};

describe("summaryMessages", () => {
  it("numbers articles from 1, cleans snippets, and marks missing ones", () => {
    const [system, user] = summaryMessages(articles);
    expect(system.content).toContain("at least one article");
    expect(user.content).toContain("[1] cnbc — Fed raises rates — The Federal Reserve raised rates by 25bp.");
    expect(user.content).toContain("[2] wsj — Markets slide after Fed hike — (no description)");
    expect(user.content).toContain("[3] cnbc");
  });
});

describe("outlets", () => {
  it("counts distinct outlets, and needs at least two", () => {
    expect(countOutlets(articles)).toBe(2);
    expect(isSummarizable(articles)).toBe(true);
    expect(isSummarizable([articles[0], articles[2]])).toBe(false);
  });
});

describe("validateSummary", () => {
  it("accepts a valid summary and sorts and dedupes citations", () => {
    const out = validateSummary(
      { ...good, summary: [{ text: "  The Fed raised   rates. ", citations: [3, 1, 1] }] },
      3,
    );
    expect(out.summary.summary).toEqual([{ text: "The Fed raised rates.", citations: [1, 3] }]);
    expect(out.dropped).toBe(0);
  });

  it("drops uncited bullets and counts them", () => {
    const out = validateSummary(
      { ...good, summary: [...good.summary, { text: "An uncited claim.", citations: [] }] },
      3,
    );
    expect(out.summary.summary).toHaveLength(2);
    expect(out.dropped).toBe(1);
  });

  it("drops uncited coverage notes too", () => {
    const out = validateSummary({ ...good, coverage_notes: [{ text: "Framing differs.", citations: [] }] }, 3);
    expect(out.summary.coverageNotes).toEqual([]);
    expect(out.dropped).toBe(1);
  });

  it("fails the whole summary on a citation to a nonexistent article", () => {
    expect(() => validateSummary({ ...good, summary: [{ text: "x", citations: [4] }] }, 3)).toThrow(SummaryValidationError);
    expect(() => validateSummary({ ...good, summary: [{ text: "x", citations: [0] }] }, 3)).toThrow(/cites article 0/);
    expect(() => validateSummary({ ...good, coverage_notes: [{ text: "x", citations: [9] }] }, 3)).toThrow(/coverage_notes/);
  });

  it("fails when no cited bullet is left, or the shape is wrong", () => {
    expect(() => validateSummary({ ...good, summary: [{ text: "x", citations: [] }] }, 3)).toThrow(/no cited summary bullets/);
    expect(() => validateSummary({ ...good, summary: "text" }, 3)).toThrow(/not a list/);
    expect(() => validateSummary({ ...good, headline: " " }, 3)).toThrow(/headline/);
    expect(() => validateSummary(null, 3)).toThrow(SummaryValidationError);
  });

  it("trims a headline that is too long at a word boundary", () => {
    const long = "Federal Reserve raises interest rates by a quarter point as inflation stays stubbornly high this year";
    const out = validateSummary({ ...good, headline: long }, 3);
    expect(out.headlineTrimmed).toBe(true);
    expect(out.summary.headline.length).toBeLessThanOrEqual(HEADLINE_MAX_CHARS);
    expect(out.summary.headline.endsWith("…")).toBe(true);
  });
});

describe("summarizeStory", () => {
  const fakeLlm = (json: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const chat = vi.fn(async (_args: Record<string, unknown>) => ({
      text: JSON.stringify(json),
      json,
      provider: "openai" as const,
      model: "gpt-4o-mini",
      cached: false,
      usage: { inputTokens: 500, outputTokens: 80, costUsd: 0.0001 },
    }));
    return { llm: { chat } as unknown as LlmClient, chat };
  };

  it("calls OpenAI directly with the schema and the model's settings, and returns the validated summary", async () => {
    const { llm, chat } = fakeLlm(good);
    const out = await summarizeStory(llm, { articles, model: "gpt-6-luna" });
    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0][0]).toMatchObject({
      provider: "openai",
      model: "gpt-6-luna",
      reasoningEffort: "low",
      jsonSchema: { name: "story_summary" },
    });
    expect(chat.mock.calls[0][0].temperature).toBeUndefined();
    expect(out.summary.summary).toHaveLength(2);
    expect(out.usage?.costUsd).toBe(0.0001);
  });

  it("sends temperature 0 for gpt-4o-mini", async () => {
    const { llm, chat } = fakeLlm(good);
    await summarizeStory(llm, { articles, model: "gpt-4o-mini" });
    expect(chat.mock.calls[0][0]).toMatchObject({ temperature: 0 });
    expect(chat.mock.calls[0][0].reasoningEffort).toBeUndefined();
  });

  it("does not call the model for a story with fewer than two outlets", async () => {
    const { llm, chat } = fakeLlm(good);
    await expect(summarizeStory(llm, { articles: [articles[0], articles[2]] })).rejects.toThrow(NotSummarizableError);
    expect(chat).not.toHaveBeenCalled();
  });

  it("fails on a model output that cites a nonexistent article", async () => {
    const { llm } = fakeLlm({ ...good, summary: [{ text: "x", citations: [7] }] });
    await expect(summarizeStory(llm, { articles })).rejects.toThrow(SummaryValidationError);
  });

  it("rejects an unknown model", async () => {
    const { llm } = fakeLlm(good);
    await expect(summarizeStory(llm, { articles, model: "nope" })).rejects.toThrow(/unknown summary model/);
  });
});
