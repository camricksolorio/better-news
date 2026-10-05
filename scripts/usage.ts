// Prints the last 7 Pacific days of model usage from llm_calls and the embedding quota check.
// Usage: pnpm usage [--days 7]
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { embedQuotaCheck, usageByDay } from "@/lib/usage";

async function main() {
  const { values } = parseArgs({ options: { days: { type: "string" } } });
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });

  const rows = await usageByDay(db, Number(values.days ?? 7));
  console.table(
    rows.map((r) => ({
      day: r.day,
      model: r.model,
      calls: r.calls,
      failed: r.failedCalls,
      inputs: r.inputs,
      tokens: r.inputTokens,
      "cost $": Number(r.costUsd.toFixed(4)),
      "quota 429s": r.quota429s,
      "daily cap hit": r.dayCapHit
        ? `after ${r.dayCapHit.okInputsBefore} inputs / ${r.dayCapHit.okCallsBefore} requests`
        : "",
    })),
  );
  const check = await embedQuotaCheck(db);
  console.log(`${check.ok ? "OK  " : "FAIL"} ${check.name}: ${check.detail}`);
  await client.end();
  if (!check.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
