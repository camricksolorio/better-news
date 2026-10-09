// Scores the join audit (D37): precision, exact lower bound, and every non-`same` join with the classifier's verdict.
// Read-only. Usage: pnpm eval:audit-score [--audit-id <name>]
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { latestAuditId, loadAudit } from "@/lib/audit";
import { summarize, SHIP_PRECISION } from "@/lib/audit-summary";
import { eq, and } from "drizzle-orm";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const client = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });
  const idArg = process.argv.indexOf("--audit-id");
  const auditId = idArg > -1 ? process.argv[idArg + 1] : await latestAuditId(db);
  if (!auditId) throw new Error("no audit found");
  const items = await loadAudit(db, auditId);
  const s = summarize(items.map((i) => i.label));
  console.log(`audit ${auditId}: ${s.labeled}/${s.total} labeled`);
  console.log(`same ${s.same}, related ${s.related}, different ${s.different}, unsure ${s.unsure}`);
  console.log(`precision ${s.precision?.toFixed(3)}, exact 95% lower bound ${s.lowerBound?.toFixed(3)} (bar > ${SHIP_PRECISION}): ${s.clears ? "CLEARS" : "DOES NOT CLEAR"}`);
  for (const i of items.filter((x) => x.label && x.label !== "same")) {
    const [row] = await db
      .select({ verdict: schema.joinAuditItems.verdict })
      .from(schema.joinAuditItems)
      .where(and(eq(schema.joinAuditItems.auditId, auditId), eq(schema.joinAuditItems.articleId, i.articleId), eq(schema.joinAuditItems.memberId, i.memberId)));
    console.log(`\n[${i.label}] verdict ${JSON.stringify(row?.verdict)}\n  A (${i.a.source}, ${i.a.time}): ${i.a.title}\n  B (${i.b.source}, ${i.b.time}): ${i.b.title}`);
  }
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
