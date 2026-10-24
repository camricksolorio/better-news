// Marks existing live blogs excluded_reason = 'live_blog' (story-clustering-v2 Phase 1). It never touches stories.
// Usage: pnpm live-blogs:exclude [--confirm]
// Without --confirm it only lists the matches per source, with a few examples each, for spot-checking.
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { excludeLiveBlogs } from "@/lib/pipeline/exclude-live-blogs";

async function main() {
  const { values } = parseArgs({ options: { confirm: { type: "boolean" } } });
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });

  const result = await excludeLiveBlogs(db, { dryRun: !values.confirm });
  console.table(Object.entries(result.bySource).map(([source, rows]) => ({ source, rows })));
  for (const s of result.samples) console.log(`${s.sourceId}  ${s.title.slice(0, 70)}\n    ${s.link}`);
  console.log(
    values.confirm
      ? `\nMarked ${result.total} rows excluded.`
      : `\nDry run: ${result.total} rows match. Re-run with --confirm to mark them.`,
  );
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
