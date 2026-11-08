// Gives rows that an interrupted ingest left without an article version their version (story-clustering-v2).
// Usage: pnpm versions:repair [--confirm]
// Without --confirm it only counts the rows.
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, count, isNotNull, isNull } from "drizzle-orm";
import * as schema from "@/db/schema";
import { repairMissingVersions } from "@/lib/pipeline/ingest";

async function main() {
  const { values } = parseArgs({ options: { confirm: { type: "boolean" } } });
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });

  const f = schema.feedItems;
  const [{ n }] = await db
    .select({ n: count() })
    .from(f)
    .where(and(isNull(f.currentVersionId), isNull(f.excludedReason), isNotNull(f.contentHash)));
  console.log(`${n} rows have no current version.`);
  if (values.confirm) console.log(`Repaired ${(await repairMissingVersions(db)).repaired} rows.`);
  else console.log("Dry run. Re-run with --confirm to repair them.");
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
