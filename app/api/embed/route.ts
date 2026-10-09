import { db } from "@/db";
import { createLlmClient } from "@/lib/llm";
import { handleStageRequest } from "@/lib/pipeline/endpoint";
import { runEmbedStage } from "@/lib/pipeline/embed";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Backfill keeps batches small to stay inside the embedding free-tier limits (D20).
const BACKFILL_BATCH_SIZE = 10;

export async function GET(request: Request) {
  return handleStageRequest({
    db,
    stage: "embed",
    request,
    maxDurationSec: maxDuration,
    run: async ({ params, deadline, keepAlive }) => {
      const llm = createLlmClient({ db, deadline });
      return runEmbedStage(db, llm, {
        deadline,
        source: params.source,
        from: params.from,
        to: params.to,
        batchSize: params.backfill ? BACKFILL_BATCH_SIZE : undefined,
        afterBatch: keepAlive,
      });
    },
  });
}
