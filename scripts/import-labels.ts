// Restores labels from a file written by export-labels: pair labels (eval/labels-*.jsonl) or labelled events
// (eval/events-*.jsonl), told apart by the records in the file.
// Usage: pnpm labels:import eval/labels-YYYY-MM-DD.jsonl  |  pnpm labels:import eval/events-YYYY-MM-DD.jsonl
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { importPairLabels, parseJsonl } from "@/lib/labels";
import { importEvents, parseEventsJsonl } from "@/lib/eval/event-labels-io";

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: pnpm labels:import <file.jsonl>");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });
  const text = readFileSync(file, "utf8");
  const events = parseEventsJsonl(text);
  if (events.length > 0) console.log(await importEvents(db, events));
  else console.log(await importPairLabels(db, parseJsonl(text)));
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
