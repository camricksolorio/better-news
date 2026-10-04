// Replays a snapshot through the same assignment core production uses (D11), then scores it.
import { assignArticle, type ArticleInput, type ClusterConfig } from "@/lib/pipeline/assign";
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

export type ReplayResult = {
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
): Promise<ReplayResult> {
  const store = createMemoryStore();
  const sorted = [...snapshot].sort(
    (x, y) => new Date(x.time).getTime() - new Date(y.time).getTime() || x.guid.localeCompare(y.guid),
  );
  let grayCount = 0;
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
    const outcome = await assignArticle(store, input, cfg, async () => {
      grayCount++;
      return { same: false };
    });
    clusterOf.set(a.guid, outcome.storyId);
  }

  return {
    metrics: computeMetrics(clusterOf, labels),
    articles: sorted.length,
    stories: store.stories.size,
    grayCount,
    grayShare: sorted.length === 0 ? 0 : grayCount / sorted.length,
    clusterOf,
  };
}
