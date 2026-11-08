// v1's incremental assignment as a harness strategy: each article is placed once, on arrival, against the best
// candidate story, exactly as production does (the same `assignArticle` core and in-memory store as `replay`).
import { assignArticle, type Adjudicator, type ArticleInput, type ClusterConfig } from "@/lib/pipeline/assign";
import { createMemoryStore } from "@/lib/pipeline/store-memory";
import type { SnapshotArticle } from "./replay";
import type { Strategy } from "./ticks";

export type V1Options = {
  cfg: ClusterConfig;
  adjudicate: Adjudicator;
  // A call that fails leaves that article unclustered, as in production; an error named here stops the whole run
  // (a spent call budget).
  abortOn?: (e: unknown) => boolean;
  onFailure?: (guid: string, error: unknown) => void;
};

export function createV1Strategy(opts: V1Options): Strategy {
  return {
    name: "v1",
    start() {
      const store = createMemoryStore();
      const clusterOf = new Map<string, string>();
      return {
        async processTick(batch: SnapshotArticle[]) {
          for (const a of batch) {
            const input: ArticleInput = {
              id: a.guid,
              sourceId: a.sourceId,
              time: new Date(a.time),
              embedding: a.embedding,
              thin: a.thin,
            };
            try {
              clusterOf.set(a.guid, (await assignArticle(store, input, opts.cfg, opts.adjudicate)).storyId);
            } catch (e) {
              if (opts.abortOn?.(e)) throw e;
              opts.onFailure?.(a.guid, e);
            }
          }
        },
        clusterOf: () => clusterOf,
      };
    },
  };
}
