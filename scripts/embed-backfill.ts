// Embeds every ingested row that has no embedding yet, using the same stage logic as /api/embed.
// Usage: pnpm embed:backfill [--source <feed id>] [--from <ISO date>] [--to <ISO date>] [--limit <rows>]
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { createLlmClient } from "@/lib/llm";
import { runEmbedStage } from "@/lib/pipeline/embed";
import { extendLease, releaseLease, takeLease } from "@/lib/pipeline/lease";
import { finishRun, startRun } from "@/lib/pipeline/runs";

const LEASE_MS = 120_000;
const RUN_MS = 50_000;

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      limit: { type: "string" },
    },
  });
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });
  const db = drizzle(client, { schema });
  const owner = `backfill-${randomUUID()}`;

  if (!(await takeLease(db, "embed", owner, LEASE_MS))) {
    console.error("The embed lease is held by another run; try again later.");
    process.exitCode = 1;
    await client.end();
    return;
  }

  let total = 0;
  let totalFailed = 0;
  try {
    // Same shape as the workflow: repeat bounded runs until nothing remains or no progress is made.
    for (;;) {
      const runId = await startRun(db, "embed");
      const llm = createLlmClient({ db, deadline: Date.now() + RUN_MS });
      const result = await runEmbedStage(db, llm, {
        deadline: Date.now() + RUN_MS,
        source: values.source,
        from: values.from ? new Date(values.from) : undefined,
        to: values.to ? new Date(values.to) : undefined,
        limit: values.limit ? Number(values.limit) : undefined,
        afterBatch: () => extendLease(db, "embed", owner, LEASE_MS),
      });
      await finishRun(db, runId, result);
      total += result.processed;
      totalFailed += result.failed;
      console.log(`run: processed=${result.processed} failed=${result.failed} remaining=${result.remaining}`);
      if (result.remaining === 0 || result.processed === 0 || values.limit) break;
    }
  } finally {
    await releaseLease(db, "embed", owner);
    await client.end();
  }
  console.log(`done: embedded ${total}, failed ${totalFailed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
