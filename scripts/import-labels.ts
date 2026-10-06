// Restores labels from a file written by export-labels. Usage: pnpm labels:import eval/labels-YYYY-MM-DD.jsonl
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { importPairLabels, parseJsonl } from "@/lib/labels";

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: pnpm labels:import <file.jsonl>");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  const result = await importPairLabels(drizzle(client, { schema }), parseJsonl(readFileSync(file, "utf8")));
  console.log(result);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
