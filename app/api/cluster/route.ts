import { db } from "@/db";
import { createLlmClient } from "@/lib/llm";
import { createDbAdjudicator } from "@/lib/pipeline/adjudicate-db";
import { runClusterStage } from "@/lib/pipeline/cluster";
import { handleStageRequest } from "@/lib/pipeline/endpoint";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  return handleStageRequest({
    db,
    stage: "cluster",
    request,
    maxDurationSec: maxDuration,
    run: async ({ params, deadline, keepAlive }) => {
      const llm = createLlmClient({ db, deadline });
      return runClusterStage(db, {
        deadline,
        adjudicate: createDbAdjudicator(db, llm),
        source: params.source,
        from: params.from,
        to: params.to,
        // Backfill runs the close sweep only once nothing remains (D20).
        deferCloseSweep: params.backfill,
        afterArticle: keepAlive,
      });
    },
  });
}
