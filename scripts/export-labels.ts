// Writes eval_pair_labels to eval/labels-YYYY-MM-DD.jsonl, keyed by article guid. Commit the file.
import { writeFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { exportPairLabels, toJsonl } from "@/lib/labels";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  const records = await exportPairLabels(drizzle(client, { schema }));
  const path = `eval/labels-${new Date().toISOString().slice(0, 10)}.jsonl`;
  writeFileSync(path, toJsonl(records));
  console.log(`wrote ${records.length} labels to ${path}`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
