// Summary evaluation (story-summary-v1 D6, D11): a model summarizes each golden story, local agents (Claude or
// Gemini) compare the generated title and bullets to the golden ones, and this module scores their verdicts.
// Three steps, each a file on disk under eval/: generate (model runs), pack (a blinded packet for the agents),
// score (the agents' verdicts, aggregated per model).
import type { StorySummary, SummaryArticle } from "@/lib/pipeline/summarize";

// --- Golden dataset -------------------------------------------------------------------------------------------

export type GoldenArticle = SummaryArticle & { time?: string };
export type GoldenStory = { id: string; title: string; summary: string[]; articles: GoldenArticle[] };

// One JSON object per line. `title` and `summary` are the owner's golden fields; the story's articles are either
// inline (`articles`) or listed by feed `guids`, which the caller resolves against the database.
export type GoldenRecord = {
  id: string;
  title: string;
  summary: string | string[];
  articles?: { source: string; title: string; snippet?: string | null; time?: string }[];
  guids?: string[];
};

// Accepts a list of bullets, or one string with a bullet per line ("- ", "* ", "• " or "1. " prefixes).
export function normalizeBullets(summary: string | string[]): string[] {
  const lines = Array.isArray(summary) ? summary : summary.split("\n");
  return lines.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
}

export function parseGoldenRecord(raw: unknown, line: number): GoldenRecord & { summary: string[] } {
  const r = raw as Partial<GoldenRecord> | null;
  const fail = (why: string) => {
    throw new Error(`golden line ${line}: ${why}`);
  };
  if (!r || typeof r !== "object") return fail("not a JSON object");
  if (typeof r.id !== "string" || !r.id) fail("missing id");
  if (typeof r.title !== "string" || !r.title.trim()) fail("missing title");
  if (typeof r.summary !== "string" && !Array.isArray(r.summary)) fail("summary must be bullet points (a list or a string)");
  const bullets = normalizeBullets(r.summary as string | string[]);
  if (bullets.length === 0) fail("summary has no bullets");
  const hasArticles = Array.isArray(r.articles) && r.articles.length > 0;
  const hasGuids = Array.isArray(r.guids) && r.guids.length > 0;
  if (!hasArticles && !hasGuids) fail("needs articles or guids");
  if (hasArticles && r.articles!.some((a) => !a || typeof a.source !== "string" || typeof a.title !== "string")) {
    fail("every article needs a source and a title");
  }
  return { id: r.id as string, title: (r.title as string).trim(), summary: bullets, articles: r.articles, guids: r.guids };
}

export function parseGoldenFile(text: string) {
  const records = text
    .split("\n")
    .map((l, i) => ({ l: l.trim(), line: i + 1 }))
    .filter((x) => x.l)
    .map((x) => parseGoldenRecord(JSON.parse(x.l), x.line));
  const ids = new Set<string>();
  for (const r of records) {
    if (ids.has(r.id)) throw new Error(`golden file: duplicate id ${r.id}`);
    ids.add(r.id);
  }
  return records;
}

// --- Model runs -----------------------------------------------------------------------------------------------

export type RunRow = {
  storyId: string;
  model: string;
  ok: boolean;
  error?: string;
  summary?: StorySummary;
  dropped?: number;
  headlineTrimmed?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
};

// --- Packet for the agents ------------------------------------------------------------------------------------

export const RUBRIC = `# How to compare summaries

You are comparing machine-written story summaries to a golden reference. Each story in packet.json has:
- \`articles\`: the numbered source articles (outlet, title, short feed description). These are the ONLY facts the summaries may use.
- \`golden\`: the reference title and bullet points, written by a person.
- \`candidates\`: unlabeled model outputs ("A", "B", ...), each with a title, cited bullets (\`summary\`) and cited coverage notes. Which model wrote which is hidden on purpose; do not try to guess.

For every candidate of every story, score 1 to 5 (5 is best):
- **faithfulness**: every bullet is supported by the article(s) it cites. 5 = all supported; 1 = several claims are invented or contradict the sources.
- **coverage**: the bullets contain the points the golden summary treats as essential. 5 = all of them; 1 = the main point is missing.
- **neutrality**: the title and bullets are neutral, attribute contested claims to outlets, and use no loaded wording or clickbait. 5 = fully neutral.

Also list \`unsupportedClaims\`: each bullet (or part of a bullet) that is not supported by the articles it cites, quoted briefly. Judge support against the articles, not the golden summary: a claim can be correct in the real world and still be unsupported by these snippets. If everything is supported, use an empty list.

Judge the title the same way: an unsupported or loaded title goes in \`unsupportedClaims\` too (prefix it "title:").

Write one JSON file named verdicts-<your name>.json next to packet.json, in this shape:

\`\`\`json
{
  "agent": "claude",
  "verdicts": [
    { "storyId": "...", "candidate": "A", "faithfulness": 5, "coverage": 4, "neutrality": 5, "unsupportedClaims": [] }
  ]
}
\`\`\`

One verdict per candidate per story, no more and no fewer. Use whole numbers 1 to 5.`;

export type PacketCandidate = {
  label: string;
  title: string;
  summary: { text: string; citations: number[] }[];
  coverageNotes: { text: string; citations: number[] }[];
};
export type PacketStory = {
  storyId: string;
  articles: { n: number; source: string; title: string; snippet: string }[];
  golden: { title: string; summary: string[] };
  candidates: PacketCandidate[];
};
export type Packet = { stories: PacketStory[] };
// storyId -> label -> model.
export type PacketKey = Record<string, Record<string, string>>;

// Small seeded PRNG (mulberry32) so a packet can be rebuilt identically.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

// Only stories where at least one model produced a valid summary appear; a model that failed on a story simply
// has no candidate there (the score step counts it as a failure). Candidate order is shuffled per story.
export function buildPacket(golden: GoldenStory[], runs: Record<string, RunRow[]>, seed = 1): { packet: Packet; key: PacketKey } {
  const stories: PacketStory[] = [];
  const key: PacketKey = {};
  for (const g of golden) {
    const found = Object.entries(runs)
      .map(([model, rows]) => ({ model, row: rows.find((r) => r.storyId === g.id) }))
      .filter((x): x is { model: string; row: RunRow & { summary: StorySummary } } => !!x.row?.ok && !!x.row.summary);
    if (found.length === 0) continue;
    const rand = rng(seed ^ hash(g.id));
    const order = found.map((f) => ({ f, r: rand() })).sort((a, b) => a.r - b.r).map((x) => x.f);
    const labels = order.map((_, i) => String.fromCharCode(65 + i));
    key[g.id] = Object.fromEntries(order.map((o, i) => [labels[i], o.model]));
    stories.push({
      storyId: g.id,
      articles: g.articles.map((a, i) => ({ n: i + 1, source: a.source, title: a.title, snippet: a.snippet ?? "" })),
      golden: { title: g.title, summary: g.summary },
      candidates: order.map((o, i) => ({
        label: labels[i],
        title: o.row.summary.headline,
        summary: o.row.summary.summary,
        coverageNotes: o.row.summary.coverageNotes,
      })),
    });
  }
  return { packet: { stories }, key };
}

// --- Verdicts and scoring -------------------------------------------------------------------------------------

export type Verdict = {
  storyId: string;
  candidate: string;
  faithfulness: number;
  coverage: number;
  neutrality: number;
  unsupportedClaims: string[];
};
export type VerdictFile = { agent: string; verdicts: Verdict[] };

const score15 = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5;

// Throws with a precise message, so an agent's malformed file is fixed rather than silently half-counted.
export function parseVerdictFile(json: unknown, packet: Packet): VerdictFile {
  const f = json as Partial<VerdictFile> | null;
  if (!f || typeof f.agent !== "string" || !Array.isArray(f.verdicts)) throw new Error("verdict file needs an agent and a verdicts list");
  const expected = new Set(packet.stories.flatMap((s) => s.candidates.map((c) => `${s.storyId}#${c.label}`)));
  const seen = new Set<string>();
  for (const v of f.verdicts as Verdict[]) {
    const id = `${v?.storyId}#${v?.candidate}`;
    if (!expected.has(id)) throw new Error(`${f.agent}: verdict for unknown candidate ${id}`);
    if (seen.has(id)) throw new Error(`${f.agent}: duplicate verdict for ${id}`);
    if (!score15(v.faithfulness) || !score15(v.coverage) || !score15(v.neutrality)) {
      throw new Error(`${f.agent}: ${id} needs whole-number scores from 1 to 5`);
    }
    if (!Array.isArray(v.unsupportedClaims) || v.unsupportedClaims.some((c) => typeof c !== "string")) {
      throw new Error(`${f.agent}: ${id} needs unsupportedClaims as a list of strings`);
    }
    seen.add(id);
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`${f.agent}: missing verdicts for ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);
  return f as VerdictFile;
}

export type ModelScore = {
  model: string;
  stories: number; // golden stories
  generated: number; // valid summaries
  failed: number;
  meanFaithfulness: number | null;
  meanCoverage: number | null;
  meanNeutrality: number | null;
  // Summaries with zero unsupported claims, as a share of ALL golden stories (a failed generation counts against
  // the model). With several agents a summary counts only if every agent found no unsupported claims.
  zeroUnsupportedRate: number;
  meanBullets: number | null;
  droppedBullets: number;
  totalCostUsd: number;
  costPerStoryUsd: number | null;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function scoreModels(args: {
  goldenIds: string[];
  runs: Record<string, RunRow[]>;
  key: PacketKey;
  verdictFiles: VerdictFile[];
}): { models: ModelScore[]; agents: string[]; disagreements: number } {
  const { goldenIds, runs, key, verdictFiles } = args;
  const byCandidate = new Map<string, Verdict[]>(); // `${storyId}#${model}` -> one verdict per agent
  for (const f of verdictFiles) {
    for (const v of f.verdicts) {
      const model = key[v.storyId]?.[v.candidate];
      if (!model) continue;
      const id = `${v.storyId}#${model}`;
      byCandidate.set(id, [...(byCandidate.get(id) ?? []), v]);
    }
  }
  // Candidates where the agents disagree on "zero unsupported claims": a prompt to tighten the rubric.
  let disagreements = 0;
  for (const vs of byCandidate.values()) {
    const flags = new Set(vs.map((v) => v.unsupportedClaims.length === 0));
    if (flags.size > 1) disagreements++;
  }

  const models = Object.entries(runs).map(([model, rows]): ModelScore => {
    const ok = rows.filter((r) => r.ok && r.summary && goldenIds.includes(r.storyId));
    const verdicts = ok.flatMap((r) => byCandidate.get(`${r.storyId}#${model}`) ?? []);
    const clean = ok.filter((r) => {
      const vs = byCandidate.get(`${r.storyId}#${model}`) ?? [];
      return vs.length > 0 && vs.every((v) => v.unsupportedClaims.length === 0);
    });
    const cost = rows.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    return {
      model,
      stories: goldenIds.length,
      generated: ok.length,
      failed: goldenIds.length - ok.length,
      meanFaithfulness: mean(verdicts.map((v) => v.faithfulness)),
      meanCoverage: mean(verdicts.map((v) => v.coverage)),
      meanNeutrality: mean(verdicts.map((v) => v.neutrality)),
      zeroUnsupportedRate: goldenIds.length ? clean.length / goldenIds.length : 0,
      meanBullets: mean(ok.map((r) => r.summary!.summary.length)),
      droppedBullets: ok.reduce((n, r) => n + (r.dropped ?? 0), 0),
      totalCostUsd: cost,
      costPerStoryUsd: rows.length ? cost / rows.length : null,
    };
  });
  return { models, agents: verdictFiles.map((f) => f.agent), disagreements };
}

export const SHIP_BAR_ZERO_UNSUPPORTED = 0.95;
