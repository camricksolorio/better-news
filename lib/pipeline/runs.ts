// One pipeline_runs row per endpoint run; the health checks read these.
import { eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { pipelineRuns } from "@/db/schema";

export type Stage = "embed" | "cluster";

export type RunResult = { processed: number; remaining: number; failed: number; error?: string };

export async function startRun(db: Db, stage: Stage): Promise<string> {
  const [row] = await db.insert(pipelineRuns).values({ stage }).returning({ id: pipelineRuns.id });
  return row.id;
}

export async function finishRun(db: Db, id: string, result: RunResult): Promise<void> {
  await db
    .update(pipelineRuns)
    .set({
      finishedAt: new Date(),
      processed: result.processed,
      remaining: result.remaining,
      failed: result.failed,
      error: result.error ?? null,
    })
    .where(eq(pipelineRuns.id, id));
}
