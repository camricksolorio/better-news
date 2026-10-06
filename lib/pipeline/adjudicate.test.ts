import { describe, expect, it, vi } from "vitest";
import {
  SAME_STORY_DEFINITION,
  cacheKey,
  chatMessages,
  createAdjudicator,
  jevQuestion,
  parseChatVerdict,
  passes,
  type AdjudicationArticle,
  type AdjudicatorConfig,
} from "./adjudicate";

const art = (id: string, title = `title ${id}`): AdjudicationArticle => ({
  id,
  title,
  source: "src",
  time: new Date("2026-10-05T10:00:00Z"),
  snippet: "x".repeat(1500),
});
const cfg = (model: string): AdjudicatorConfig => ({ model, promptVersion: "v2", tau: 0.9 });

const chatResult = (json: unknown, cached = false) => ({ text: "", json, provider: "openai" as const, model: "gpt-4o-mini", cached });

function fakeLlm() {
  return { chat: vi.fn(), classify: vi.fn() };
}

describe("prompt", () => {
  it("uses the approved definition verbatim, no examples, and caps snippets at 1,000 chars", () => {
    const [system, user] = chatMessages(art("a"), art("b"));
    expect(system.content).toContain(SAME_STORY_DEFINITION);
    expect(user.content).toContain("x".repeat(1000));
    expect(user.content).not.toContain("x".repeat(1001));
    expect(JSON.stringify(jevQuestion())).toContain(SAME_STORY_DEFINITION.replace(/"/g, '\\"'));
  });

  it("shows the pair in id order whichever way it is asked", () => {
    expect(chatMessages(art("b"), art("a"))[1].content).toBe(chatMessages(art("a"), art("b"))[1].content);
  });
});

describe("cache key", () => {
  it("is order-independent and tied to model and prompt version", () => {
    expect(cacheKey(art("a"), art("b"), cfg("m"))).toBe(cacheKey(art("b"), art("a"), cfg("m")));
    expect(cacheKey(art("a"), art("b"), cfg("m"))).not.toBe(cacheKey(art("a"), art("b"), cfg("n")));
    expect(cacheKey(art("a"), art("b"), cfg("m"))).not.toBe(cacheKey(art("a"), art("b"), { ...cfg("m"), promptVersion: "v3" }));
  });
});

describe("adjudicate with a chat model", () => {
  it("returns relation and p_same, sends the cache key, and routes gpt-4o-mini to OpenAI only", async () => {
    const llm = fakeLlm();
    llm.chat.mockResolvedValue(chatResult({ relation: "same", p_same: 0.97, reason: "r" }));
    const v = await createAdjudicator(llm as never, cfg("gpt-4o-mini")).adjudicate(art("b"), art("a"));
    expect(v).toMatchObject({ relation: "same", pSame: 0.97, reason: "r", cached: false });
    expect(llm.chat.mock.calls[0][0]).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      cacheKey: cacheKey(art("a"), art("b"), cfg("gpt-4o-mini")),
      purpose: "adjudicate",
    });
    expect(llm.classify).not.toHaveBeenCalled();
  });

  it("lets Gemini models take the default route", async () => {
    const llm = fakeLlm();
    llm.chat.mockResolvedValue(chatResult({ relation: "related", p_same: 0.2, reason: "" }));
    await createAdjudicator(llm as never, cfg("gemini-3.5-flash-lite")).adjudicate(art("a"), art("b"));
    expect(llm.chat.mock.calls[0][0].provider).toBeUndefined();
  });

  it("treats unreadable output as an invalid verdict, which never passes", async () => {
    const llm = fakeLlm();
    for (const bad of [null, {}, { relation: "maybe", p_same: 1 }, { relation: "same" }, { relation: "same", p_same: "high" }]) {
      llm.chat.mockResolvedValueOnce(chatResult(bad));
      const v = await createAdjudicator(llm as never, cfg("gpt-4o-mini")).adjudicate(art("a"), art("b"));
      expect(v).toMatchObject({ relation: "invalid", pSame: 0 });
      expect(passes(v, 0)).toBe(false);
    }
  });

  it("lets a failed call propagate so the article stays unclustered", async () => {
    const llm = fakeLlm();
    llm.chat.mockRejectedValue(new Error("openai 500"));
    await expect(createAdjudicator(llm as never, cfg("gpt-4o-mini")).adjudicate(art("a"), art("b"))).rejects.toThrow("openai 500");
  });

  it("reports a cache hit", async () => {
    const llm = fakeLlm();
    llm.chat.mockResolvedValue(chatResult({ relation: "same", p_same: 0.95, reason: "" }, true));
    expect((await createAdjudicator(llm as never, cfg("gpt-4o-mini")).adjudicate(art("a"), art("b"))).cached).toBe(true);
  });

  it("clamps p_same into 0..1", () => {
    expect(parseChatVerdict({ relation: "same", p_same: 1.4, reason: "" }).pSame).toBe(1);
    expect(parseChatVerdict({ relation: "same", p_same: -1, reason: "" }).pSame).toBe(0);
  });
});

describe("adjudicate with jev", () => {
  const answer = (choice: string, same: number) => ({
    answers: { relation: { type: "choice", choice, confidence: 0.9, probabilities: { same, related: 1 - same, different: 0 } } },
    model: "jev-1.13.0",
    cached: false,
  });

  it("asks one typed choice question and reads P(same) from its probabilities", async () => {
    const llm = fakeLlm();
    llm.classify.mockResolvedValue(answer("same", 0.93));
    const v = await createAdjudicator(llm as never, cfg("jev-latest")).adjudicate(art("a"), art("b"));
    expect(v).toMatchObject({ relation: "same", pSame: 0.93, model: "jev-1.13.0" });
    expect(Object.keys(llm.classify.mock.calls[0][0].questions)).toEqual(["relation"]);
    expect(llm.classify.mock.calls[0][0].cacheKey).toBe(cacheKey(art("a"), art("b"), cfg("jev-latest")));
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("is invalid when the probabilities lack `same`", async () => {
    const llm = fakeLlm();
    llm.classify.mockResolvedValue({ answers: { relation: { type: "choice", choice: "same", confidence: 1, probabilities: {} } }, model: "jev-1.13.0", cached: false });
    expect((await createAdjudicator(llm as never, cfg("jev-latest")).adjudicate(art("a"), art("b"))).relation).toBe("invalid");
  });
});

describe("passes", () => {
  it("needs `same` and p_same >= τ", () => {
    expect(passes({ relation: "same", pSame: 0.9 }, 0.9)).toBe(true);
    expect(passes({ relation: "same", pSame: 0.89 }, 0.9)).toBe(false);
    expect(passes({ relation: "related", pSame: 0.99 }, 0.9)).toBe(false);
  });
});
