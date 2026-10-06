// The classifier that decides every join (D31-D35): compares two articles and returns a relation plus a
// probability that they are the same story. The assignment core depends on this, not on a provider.
import type { ChatMessage, JevQuestion, LlmClient } from "@/lib/llm";

export const ADJUDICATION_PROMPT_VERSION = "v2";

// Approved wording (TDD "What counts as the same story", D31). Used verbatim in every model prompt.
export const SAME_STORY_DEFINITION =
  "Two articles are the **same story** only if both report the same specific event (the same announcement, incident, ruling, vote, or statement) as their main subject. Follow-ups, reactions, consequences, new developments, and background pieces are **related**, not same. Analysis and opinion pieces about the event are related too. When in doubt, choose related.";

const OPTIONS = {
  same: "Different outlets' news reports on that one event.",
  related:
    "Reactions, consequences, and new developments that follow from the event; background and explainers; analysis and opinion about the event.",
  different: "The same topic but a different event, or unrelated articles.",
} as const;

export type Relation = keyof typeof OPTIONS;

export type AdjudicatorConfig = {
  // "jev-latest" goes to TypeSafe; "gpt-4o-mini" to OpenAI; anything else to Gemini (same-model OpenRouter fallback).
  model: string;
  promptVersion: string;
  // p_same must reach this for a verdict to count as a join. Per model and prompt version (D35).
  tau: number;
};

// Starting value until the comparison picks a model and τ (D34).
export const DEFAULT_ADJUDICATOR: AdjudicatorConfig = {
  model: "gpt-4o-mini",
  promptVersion: ADJUDICATION_PROMPT_VERSION,
  tau: 0.9,
};

export type AdjudicationArticle = { id: string; title: string; source: string; time: Date | string; snippet: string };

// `invalid` is output we could not read: it counts as a rejection (new story), not as a failed call.
export type Verdict = {
  relation: Relation | "invalid";
  pSame: number;
  reason?: string;
  cached: boolean;
  model: string;
};

const MAX_SNIPPET = 1000;

const JSON_SCHEMA = {
  name: "pair_verdict",
  schema: {
    type: "object",
    properties: {
      relation: { type: "string", enum: Object.keys(OPTIONS) },
      p_same: { type: "number" },
      reason: { type: "string" },
    },
    required: ["relation", "p_same", "reason"],
    additionalProperties: false,
  },
};

const side = (name: string, a: AdjudicationArticle) => {
  const time = a.time instanceof Date ? a.time.toISOString() : a.time;
  return `${name} (${a.source}, published ${time}):\nTitle: ${a.title}\nDescription: ${a.snippet.slice(0, MAX_SNIPPET) || "(none)"}`;
};

// Order-independent: the pair is always shown in id order so one pair has one prompt and one cache entry.
function canonical(a: AdjudicationArticle, b: AdjudicationArticle): [AdjudicationArticle, AdjudicationArticle] {
  return a.id <= b.id ? [a, b] : [b, a];
}

export function pairText(a: AdjudicationArticle, b: AdjudicationArticle): string {
  const [x, y] = canonical(a, b);
  return `${side("Article A", x)}\n\n${side("Article B", y)}`;
}

export function chatMessages(a: AdjudicationArticle, b: AdjudicationArticle): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You judge whether two news articles are the same story. You only see titles and short feed descriptions.\n\n${SAME_STORY_DEFINITION}\n\n- same: ${OPTIONS.same}\n- related: ${OPTIONS.related}\n- different: ${OPTIONS.different}\n\nAnswer with JSON: relation (same, related, or different), p_same (your probability from 0 to 1 that they are the same story), and a one-sentence reason naming the specific event each article is about.`,
    },
    { role: "user", content: pairText(a, b) },
  ];
}

export function jevQuestion(): JevQuestion {
  return {
    type: "choice",
    instructions: `Judge whether the two news articles are the same story. ${SAME_STORY_DEFINITION}`,
    criteria: { ...OPTIONS },
  };
}

export function cacheKey(a: AdjudicationArticle, b: AdjudicationArticle, cfg: AdjudicatorConfig): string {
  const [x, y] = canonical(a, b);
  return `adjudicate:${cfg.promptVersion}:${cfg.model}:${x.id}:${y.id}`;
}

const isRelation = (v: unknown): v is Relation => typeof v === "string" && v in OPTIONS;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function parseChatVerdict(json: unknown): Pick<Verdict, "relation" | "pSame" | "reason"> {
  const v = json as { relation?: unknown; p_same?: unknown; reason?: unknown } | null;
  if (!v || !isRelation(v.relation) || typeof v.p_same !== "number" || !Number.isFinite(v.p_same)) {
    return { relation: "invalid", pSame: 0 };
  }
  return { relation: v.relation, pSame: clamp01(v.p_same), reason: String(v.reason ?? "").slice(0, 400) };
}

// `purpose` labels the calls in llm_calls (the comparison script uses its own so its spend is easy to find).
export function createAdjudicator(
  llm: Pick<LlmClient, "chat" | "classify">,
  cfg: AdjudicatorConfig = DEFAULT_ADJUDICATOR,
  opts: { purpose?: string } = {},
) {
  // Throws when the call itself fails after retries (the article then stays unclustered, D34).
  // Unreadable output returns relation "invalid", which the join rule treats as a rejection.
  async function adjudicate(
    article: AdjudicationArticle,
    member: AdjudicationArticle,
    context?: { articleId?: string; storyId?: string },
  ): Promise<Verdict> {
    const key = cacheKey(article, member, cfg);
    const purpose = opts.purpose ?? "adjudicate";
    if (cfg.model.startsWith("jev")) {
      const res = await llm.classify({
        state: pairText(article, member),
        questions: { relation: jevQuestion() },
        model: cfg.model,
        purpose,
        context,
        cacheKey: key,
      });
      const answer = res.answers.relation;
      const pSame = answer.type === "choice" ? answer.probabilities?.same : undefined;
      if (answer.type !== "choice" || !isRelation(answer.choice) || typeof pSame !== "number") {
        return { relation: "invalid", pSame: 0, cached: res.cached, model: res.model };
      }
      return { relation: answer.choice, pSame: clamp01(pSame), cached: res.cached, model: res.model };
    }
    const res = await llm.chat({
      provider: cfg.model === "gpt-4o-mini" ? "openai" : undefined,
      model: cfg.model,
      messages: chatMessages(article, member),
      jsonSchema: JSON_SCHEMA,
      temperature: 0,
      purpose,
      context,
      cacheKey: key,
    });
    return { ...parseChatVerdict(res.json), cached: res.cached, model: res.model };
  }

  return { adjudicate, config: cfg };
}

// A verdict joins only if it says `same` with p_same at or above τ.
export function passes(verdict: Pick<Verdict, "relation" | "pSame">, tau: number): boolean {
  return verdict.relation === "same" && verdict.pSame >= tau;
}
