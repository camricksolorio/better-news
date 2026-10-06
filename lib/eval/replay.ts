// Replays a snapshot through the same assignment core production uses (D11), then scores it.
import { assignArticle, type ArticleInput, type ClusterConfig, type StoryState } from "@/lib/pipeline/assign";
import { createMemoryStore } from "@/lib/pipeline/store-memory";
import { computeMetrics, type Metrics, type PairLabel } from "./metrics";

export type SnapshotArticle = {
  guid: string;
  sourceId: string;
  title: string;
  summary: string | null;
  time: string; // ISO, published_at or created_at
  thin: boolean;
  embedding: number[];
};

export type Decision = {
  storyId: string;
  method: "embedding" | "llm" | "new_story";
  topScore: number | null;
  centroidScore: number | null;
  // The article reached the classifier: its best candidate cleared T_low.
  gray: boolean;
  // For gray articles: the story the LLM would have been asked about, and how it scored.
  candidateStoryId?: string;
};

export type ReplayOptions = {
  // What to do with gray-zone articles until the LLM exists: start a new story (conservative)
  // or join the best candidate (the optimistic bound: the LLM says yes every time).
  gray?: "new" | "join";
  memberSim?: (article: ArticleInput, member: ArticleInput) => number;
};

export type ReplayResult = {
  decisions: Map<string, Decision>;
  storyStates: StoryState[];
  metrics: Metrics;
  articles: number;
  stories: number;
  // Articles whose best candidate landed in the LLM band (or were thin above T_low).
  grayCount: number;
  grayShare: number;
  clusterOf: Map<string, string>;
};

export async function replay(
  snapshot: SnapshotArticle[],
  labels: PairLabel[],
  cfg: ClusterConfig,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const store = createMemoryStore(options.memberSim);
  const grayIds = new Map<string, string>(); // guid -> candidate story id
  const sorted = [...snapshot].sort(
    (x, y) => new Date(x.time).getTime() - new Date(y.time).getTime() || x.guid.localeCompare(y.guid),
  );
  const clusterOf = new Map<string, string>();

  for (const a of sorted) {
    const input: ArticleInput = {
      id: a.guid,
      sourceId: a.sourceId,
      time: new Date(a.time),
      embedding: a.embedding,
      thin: a.thin,
    };
    // Baseline: the gray zone is counted and treated conservatively (new story) until Phase 3.
    const outcome = await assignArticle(store, input, cfg, async (_article, _memberId, candidate) => {
      grayIds.set(a.guid, candidate.story.id);
      return { same: options.gray === "join" };
    });
    clusterOf.set(a.guid, outcome.storyId);
  }

  const decisions = new Map<string, Decision>();
  for (const x of store.assignments) {
    decisions.set(x.articleId, {
      storyId: x.storyId,
      method: x.info.method,
      topScore: x.info.topScore,
      centroidScore: x.info.centroidScore,
      gray: grayIds.has(x.articleId),
      candidateStoryId: grayIds.get(x.articleId),
    });
  }

  return {
    decisions,
    storyStates: [...store.stories.values()],
    metrics: computeMetrics(clusterOf, labels),
    articles: sorted.length,
    stories: store.stories.size,
    grayCount: grayIds.size,
    grayShare: sorted.length === 0 ? 0 : grayIds.size / sorted.length,
    clusterOf,
  };
}
