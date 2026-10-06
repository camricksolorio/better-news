// Silver labeling (D12): a strong non-Gemini model judges each pair with the "same story"
// definition, so the human review only has to settle disagreements.
import type { ChatMessage } from "@/lib/llm";
import type { PairRecord } from "./pairs";

export const SILVER_PROMPT_VERSION = "v1";

export const SAME_STORY_DEFINITION = `Two articles are the SAME STORY if their main subject is the same specific development: the same announcement, incident, ruling, vote, release, or statement, reported around the same time.
- SAME: different outlets' news reports on that development, and analysis or opinion pieces whose main subject is that development. They add framing diversity and do not report something new.
- RELATED (not same): reactions, consequences, and new developments that follow from it (for example "markets slide after Fed hike", "White House responds to ruling", "suspect charged" after "shooting at X").
- DIFFERENT: same topic but a different development (for example "Fed hikes" vs "ECB holds"; two separate storms), or unrelated.`;

export const SILVER_JSON_SCHEMA = {
  name: "pair_label",
  schema: {
    type: "object",
    properties: {
      relation: { type: "string", enum: ["same", "related", "different"] },
      confidence: { type: "number" },
      reason: { type: "string" },
    },
    required: ["relation", "confidence", "reason"],
    additionalProperties: false,
  },
};

export function silverMessages(pair: PairRecord): ChatMessage[] {
  const side = (name: string, x: PairRecord["article"]["a"]) =>
    `${name} (${x.source}, published ${x.time}):\nTitle: ${x.title}\nDescription: ${x.snippet || "(none)"}`;
  return [
    {
      role: "system",
      content: `You judge whether two news articles are about the same story. You only see titles and short feed descriptions.\n\n${SAME_STORY_DEFINITION}\n\nAnswer with JSON: relation (same, related, or different), confidence from 0 to 1, and a one-sentence reason naming the specific development you think each article is about.`,
    },
    { role: "user", content: `${side("Article A", pair.article.a)}\n\n${side("Article B", pair.article.b)}` },
  ];
}

export type SilverVerdict = { relation: "same" | "related" | "different"; confidence: number; reason: string };

export function parseSilverVerdict(json: unknown): SilverVerdict | null {
  const v = json as Partial<SilverVerdict> | null;
  if (!v || !["same", "related", "different"].includes(v.relation as string)) return null;
  const confidence = typeof v.confidence === "number" ? Math.min(1, Math.max(0, v.confidence)) : 0;
  return { relation: v.relation as SilverVerdict["relation"], confidence, reason: String(v.reason ?? "").slice(0, 400) };
}

// Rough input size, for the dry-run estimate: ~4 characters per token.
export function estimateSilverCost(
  pairs: PairRecord[],
  price: { input: number; output: number },
  outputTokensPerPair = 120,
) {
  const inputTokens = pairs.reduce(
    (n, p) => n + Math.ceil(silverMessages(p).reduce((m, x) => m + x.content.length, 0) / 4),
    0,
  );
  const outputTokens = pairs.length * outputTokensPerPair;
  return { inputTokens, outputTokens, costUsd: (inputTokens * price.input + outputTokens * price.output) / 1_000_000 };
}
