// Writes eval_pair_labels to eval/labels-YYYY-MM-DD.jsonl and the labelled events to eval/events-YYYY-MM-DD.jsonl,
// both keyed by article guid. Commit the files.
import { writeFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { exportPairLabels, toJsonl } from "@/lib/labels";
import { exportEvents, toEventsJsonl } from "@/lib/eval/event-labels-io";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });
  const day = new Date().toISOString().slice(0, 10);

  const records = await exportPairLabels(db);
  const path = `eval/labels-${day}.jsonl`;
  writeFileSync(path, toJsonl(records));
  console.log(`wrote ${records.length} labels to ${path}`);

  const events = await exportEvents(db);
  const eventsPath = `eval/events-${day}.jsonl`;
  writeFileSync(eventsPath, toEventsJsonl(events));
  console.log(`wrote ${events.length} events (${events.reduce((n, e) => n + e.articles.length, 0)} labels) to ${eventsPath}`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
