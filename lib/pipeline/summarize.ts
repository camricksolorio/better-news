// Story summaries (story-summary-v1): a bullet-point summary of a story's articles, every bullet cited to the
// articles it came from. The model is not trusted to cite: output is schema-checked here, uncited bullets are
// dropped, and a citation to an article that was not sent fails the whole summary (D4).
import type { ChatMessage, CallContext, LlmClient } from "@/lib/llm";
import { SUMMARY_MODELS, SUMMARY_MODEL_DEFAULT, type SummaryModelConfig } from "@/lib/llm-config";
import { cleanText } from "@/lib/text";

export const SUMMARY_PROMPT_VERSION = "v1";
export const MIN_SUMMARY_OUTLETS = 2;
export const HEADLINE_MAX_CHARS = 90;

export type SummaryArticle = { source: string; title: string; snippet?: string | null };
export type CitedPoint = { text: string; citations: number[] };
export type StorySummary = { headline: string; summary: CitedPoint[]; coverageNotes: CitedPoint[] };

export class SummaryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryValidationError";
  }
}

export class NotSummarizableError extends Error {
  constructor(outlets: number) {
    super(`a story needs at least ${MIN_SUMMARY_OUTLETS} outlets to be summarized, got ${outlets}`);
    this.name = "NotSummarizableError";
  }
}

export const countOutlets = (articles: SummaryArticle[]) => new Set(articles.map((a) => a.source)).size;
export const isSummarizable = (articles: SummaryArticle[]) => countOutlets(articles) >= MIN_SUMMARY_OUTLETS;

const POINTS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: { text: { type: "string" }, citations: { type: "array", items: { type: "integer" } } },
    required: ["text", "citations"],
    additionalProperties: false,
  },
};

export const SUMMARY_JSON_SCHEMA = {
  name: "story_summary",
  schema: {
    type: "object",
    properties: { headline: { type: "string" }, summary: POINTS_SCHEMA, coverage_notes: POINTS_SCHEMA },
    required: ["headline", "summary", "coverage_notes"],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `You summarize one news story for readers. You are given numbered articles from different outlets, each with its title and a short feed description. All of them are about the same story. You only see titles and descriptions, not full articles.

Rules:
- Use only the text provided. Add no outside facts, background, or guesses.
- Write the summary as 3 to 5 short bullet points. Each bullet states one specific point and cites the articles it comes from by number, in "citations". Every bullet must cite at least one article.
- Attribute contested or outlet-specific claims to the outlet ("Fox reports…", "The Guardian says…").
- Write a neutral headline of at most ${HEADLINE_MAX_CHARS} characters. No clickbait, no loaded words, no outlet names.
- Keep bullets short and unpadded. If the descriptions are thin, write fewer bullets rather than inventing detail.
- In "coverage_notes", add up to 2 bullets on how specific outlets' framing or emphasis differs, naming the outlets and citing their articles. Use an empty list if the coverage does not differ.

Answer with JSON: headline, summary (list of {text, citations}), coverage_notes (list of {text, citations}).`;

export function summaryMessages(articles: SummaryArticle[]): ChatMessage[] {
  const lines = articles.map((a, i) => {
    const snippet = cleanText(a.snippet);
    return `[${i + 1}] ${a.source} — ${cleanText(a.title)} — ${snippet || "(no description)"}`;
  });
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Articles:\n${lines.join("\n")}` },
  ];
}

function trimHeadline(raw: string): { headline: string; trimmed: boolean } {
  const headline = raw.replace(/\s+/g, " ").trim();
  if (headline.length <= HEADLINE_MAX_CHARS) return { headline, trimmed: false };
  const cut = headline.slice(0, HEADLINE_MAX_CHARS - 1);
  const atWord = cut.lastIndexOf(" ");
  return { headline: `${(atWord > 40 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.-]+$/, "")}…`, trimmed: true };
}

// Returns each list's cited points; throws on a malformed shape or a citation outside 1..articleCount.
function checkPoints(raw: unknown, articleCount: number, field: string): { points: CitedPoint[]; dropped: number } {
  if (!Array.isArray(raw)) throw new SummaryValidationError(`${field} is not a list`);
  const points: CitedPoint[] = [];
  let dropped = 0;
  for (const item of raw) {
    const p = item as { text?: unknown; citations?: unknown } | null;
    if (!p || typeof p.text !== "string" || !Array.isArray(p.citations)) {
      throw new SummaryValidationError(`${field} has an item without text and citations`);
    }
    const citations = [...new Set(p.citations)];
    for (const c of citations) {
      if (!Number.isInteger(c) || (c as number) < 1 || (c as number) > articleCount) {
        throw new SummaryValidationError(`${field} cites article ${String(c)}, but only 1-${articleCount} were provided`);
      }
    }
    const text = p.text.replace(/\s+/g, " ").trim();
    if (citations.length === 0 || text === "") {
      dropped++;
      continue;
    }
    points.push({ text, citations: (citations as number[]).sort((a, b) => a - b) });
  }
  return { points, dropped };
}

export type ValidatedSummary = { summary: StorySummary; dropped: number; headlineTrimmed: boolean };

export function validateSummary(json: unknown, articleCount: number): ValidatedSummary {
  const raw = json as { headline?: unknown; summary?: unknown; coverage_notes?: unknown } | null;
  if (!raw || typeof raw !== "object") throw new SummaryValidationError("the model returned no JSON object");
  if (typeof raw.headline !== "string" || raw.headline.trim() === "") throw new SummaryValidationError("the headline is missing");
  const main = checkPoints(raw.summary, articleCount, "summary");
  const notes = checkPoints(raw.coverage_notes ?? [], articleCount, "coverage_notes");
  if (main.points.length === 0) throw new SummaryValidationError("no cited summary bullets were left");
  const { headline, trimmed } = trimHeadline(raw.headline);
  return {
    summary: { headline, summary: main.points, coverageNotes: notes.points },
    dropped: main.dropped + notes.dropped,
    headlineTrimmed: trimmed,
  };
}

export type SummarizeResult = ValidatedSummary & {
  model: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number | null };
};

export async function summarizeStory(
  llm: LlmClient,
  args: {
    articles: SummaryArticle[];
    model?: string;
    purpose?: string;
    context?: CallContext;
  },
): Promise<SummarizeResult> {
  const outlets = countOutlets(args.articles);
  if (outlets < MIN_SUMMARY_OUTLETS) throw new NotSummarizableError(outlets);
  const config: SummaryModelConfig | undefined = SUMMARY_MODELS[args.model ?? SUMMARY_MODEL_DEFAULT];
  if (!config) throw new Error(`unknown summary model ${args.model}; add it to SUMMARY_MODELS first`);

  const res = await llm.chat({
    provider: "openai",
    model: config.model,
    temperature: config.temperature,
    reasoningEffort: config.reasoningEffort,
    messages: summaryMessages(args.articles),
    jsonSchema: SUMMARY_JSON_SCHEMA,
    purpose: args.purpose ?? `summarize-${SUMMARY_PROMPT_VERSION}`,
    context: args.context,
  });
  return { ...validateSummary(res.json, args.articles.length), model: res.model, usage: res.usage };
}
