// Single-flight lease per endpoint (D22). A row in pipeline_locks that expires on its own,
// so a function that dies never blocks the next run. Uses the database clock throughout.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { pipelineLocks } from "@/db/schema";

export type LeaseName = "embed" | "cluster";

const until = (ms: number) => sql`now() + (${ms}::double precision * interval '1 millisecond')`;

// True if the lease was taken; false if another live run holds it.
export async function takeLease(db: Db, name: LeaseName, owner: string, leaseMs: number): Promise<boolean> {
  const rows = await db
    .insert(pipelineLocks)
    .values({ name, owner, lockedUntil: until(leaseMs) as unknown as Date })
    .onConflictDoUpdate({
      target: pipelineLocks.name,
      set: { owner, lockedUntil: until(leaseMs) as unknown as Date },
      setWhere: sql`${pipelineLocks.lockedUntil} < now()`,
    })
    .returning({ name: pipelineLocks.name });
  return rows.length > 0;
}

// Push the expiry out after a batch. False means the lease was lost (expired and retaken):
// the caller must stop starting work.
export async function extendLease(db: Db, name: LeaseName, owner: string, leaseMs: number): Promise<boolean> {
  const rows = await db
    .update(pipelineLocks)
    .set({ lockedUntil: until(leaseMs) as unknown as Date })
    .where(and(eq(pipelineLocks.name, name), eq(pipelineLocks.owner, owner)))
    .returning({ name: pipelineLocks.name });
  return rows.length > 0;
}

export async function releaseLease(db: Db, name: LeaseName, owner: string): Promise<void> {
  await db.delete(pipelineLocks).where(and(eq(pipelineLocks.name, name), eq(pipelineLocks.owner, owner)));
}
