// Assignment core shared by /api/cluster (database store) and the eval replay harness
// (in-memory store), so the harness measures the same logic production runs (D10, D11).
import { createHash } from "node:crypto";
import { EMBEDDING_MODEL } from "@/lib/llm-config";

export type ClusterConfig = {
  tLow: number;
  tHigh: number;
  windowHours: number;
  k: number;
  model: string;
};

export const DEFAULT_CLUSTER_CONFIG: ClusterConfig = {
  tLow: 0.75,
  tHigh: 0.88,
  windowHours: 36,
  k: 10,
  model: EMBEDDING_MODEL,
};

// Recorded on every assignment so a decision can be tied to the settings that made it.
export function pipelineVersion(cfg: ClusterConfig, extra: Record<string, string> = {}): string {
  const text = JSON.stringify({ ...cfg, ...extra });
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export type ArticleInput = {
  id: string;
  sourceId: string;
  // published_at, falling back to created_at when a feed gave no date.
  time: Date;
  embedding: number[];
  thin: boolean;
};

export type StoryState = {
  id: string;
  firstAt: Date;
  lastAt: Date;
  windowEndsAt: Date;
  centroid: number[];
  articleCount: number;
  sourceCount: number;
};

export type Candidate = {
  story: StoryState;
  // Max cosine similarity to any member (from the kNN), and to the centroid.
  topScore: number;
  centroidScore: number;
};

export type Method = "embedding" | "llm" | "new_story";

export type AssignmentInfo = {
  method: Method;
  topScore: number | null;
  centroidScore: number | null;
  llmVerdict?: unknown;
  llmCallId?: string | null;
};

export interface StoryStore {
  // kNN over clustered articles in stories whose window fits `article.time`, grouped by story.
  candidates(article: ArticleInput, cfg: ClusterConfig): Promise<Candidate[]>;
  createStory(article: ArticleInput, cfg: ClusterConfig): Promise<string>;
  // Adds the article to a story: running-mean centroid, counts, and the window (D19).
  addToStory(candidate: StoryState, article: ArticleInput, cfg: ClusterConfig): Promise<void>;
  // Logs the decision and marks the article clustered.
  recordAssignment(article: ArticleInput, storyId: string, info: AssignmentInfo): Promise<void>;
}

export type Adjudicator = (
  article: ArticleInput,
  candidate: Candidate,
) => Promise<{ same: boolean; verdict?: unknown; llmCallId?: string | null }>;

const HOUR = 3_600_000;

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

// D18/D19: an article fits a story when every member (and the article) stays within one
// window of the story's earliest article. Equivalent to
// last_article_at - window <= t <= first_article_at + window.
export function fitsWindow(story: Pick<StoryState, "firstAt" | "lastAt">, t: Date, windowHours: number): boolean {
  const w = windowHours * HOUR;
  return t.getTime() >= story.lastAt.getTime() - w && t.getTime() <= story.firstAt.getTime() + w;
}

// A candidate must pass on both signals (D8), so its score is the lower of the two.
export function candidateScore(c: Candidate): number {
  return Math.min(c.topScore, c.centroidScore);
}

// Highest score first. Exact ties (identical wire stories are common) break deterministically:
// the bigger story, then the older one, then id, so a run never depends on row order.
export function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    candidateScore(b) - candidateScore(a) ||
    b.story.articleCount - a.story.articleCount ||
    a.story.firstAt.getTime() - b.story.firstAt.getTime() ||
    a.story.id.localeCompare(b.story.id)
  );
}

export function nextStoryState(story: StoryState, article: ArticleInput, windowHours: number, newSource: boolean): StoryState {
  const n = story.articleCount;
  const centroid = story.centroid.map((v, i) => (v * n + article.embedding[i]) / (n + 1));
  const firstAt = article.time < story.firstAt ? article.time : story.firstAt;
  const lastAt = article.time > story.lastAt ? article.time : story.lastAt;
  return {
    id: story.id,
    firstAt,
    lastAt,
    windowEndsAt: new Date(firstAt.getTime() + windowHours * HOUR),
    centroid,
    articleCount: n + 1,
    sourceCount: story.sourceCount + (newSource ? 1 : 0),
  };
}

export type Outcome = { storyId: string; method: Method; created: boolean };

// One article through the flow in the TDD: candidates, band, optional adjudication.
export async function assignArticle(
  store: StoryStore,
  article: ArticleInput,
  cfg: ClusterConfig,
  adjudicate?: Adjudicator,
): Promise<Outcome> {
  const candidates = await store.candidates(article, cfg);
  const best = [...candidates].sort(compareCandidates)[0];
  const scores = best
    ? { topScore: best.topScore, centroidScore: best.centroidScore }
    : { topScore: null, centroidScore: null };

  const startNew = async (extra: Partial<AssignmentInfo> = {}): Promise<Outcome> => {
    const storyId = await store.createStory(article, cfg);
    await store.recordAssignment(article, storyId, { method: "new_story", ...scores, ...extra });
    return { storyId, method: "new_story", created: true };
  };
  const join = async (method: Method, extra: Partial<AssignmentInfo> = {}): Promise<Outcome> => {
    await store.addToStory(best.story, article, cfg);
    await store.recordAssignment(article, best.story.id, { method, ...scores, ...extra });
    return { storyId: best.story.id, method, created: false };
  };

  if (!best) return startNew();
  const score = candidateScore(best);
  if (score < cfg.tLow) return startNew();
  // Thin articles never auto-join on embedding alone (D9).
  if (score >= cfg.tHigh && !article.thin) return join("embedding");

  // Gray zone. Without an adjudicator (the embedding-only baseline) stay conservative.
  if (!adjudicate) return startNew();
  const verdict = await adjudicate(article, best);
  if (verdict.same) return join("llm", { llmVerdict: verdict.verdict, llmCallId: verdict.llmCallId });
  return startNew({ llmVerdict: verdict.verdict, llmCallId: verdict.llmCallId });
}
