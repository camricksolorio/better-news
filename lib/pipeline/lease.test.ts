import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { pipelineLocks, pipelineRuns } from "@/db/schema";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { extendLease, releaseLease, takeLease } from "./lease";
import { finishRun, startRun } from "./runs";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));

const lockedUntil = async (name: string) => {
  const [row] = await db.select().from(pipelineLocks).where(sql`${pipelineLocks.name} = ${name}`);
  return row?.lockedUntil;
};

describe("lease", () => {
  it("is taken when free and refused while held", async () => {
    expect(await takeLease(db, "embed", "run-a", 60_000)).toBe(true);
    expect(await takeLease(db, "embed", "run-b", 60_000)).toBe(false);
  });

  it("is independent per stage", async () => {
    expect(await takeLease(db, "embed", "run-a", 60_000)).toBe(true);
    expect(await takeLease(db, "cluster", "run-b", 60_000)).toBe(true);
  });

  it("can be taken once expired, and the old owner can no longer extend it", async () => {
    await takeLease(db, "embed", "run-a", 60_000);
    await db.execute(sql`UPDATE pipeline_locks SET locked_until = now() - interval '1 second'`);
    expect(await takeLease(db, "embed", "run-b", 60_000)).toBe(true);
    expect(await extendLease(db, "embed", "run-a", 60_000)).toBe(false);
    expect(await extendLease(db, "embed", "run-b", 60_000)).toBe(true);
  });

  it("is extended by the owner (per batch)", async () => {
    await takeLease(db, "embed", "run-a", 1_000);
    const before = await lockedUntil("embed");
    await extendLease(db, "embed", "run-a", 60_000);
    const after = await lockedUntil("embed");
    expect(after!.getTime()).toBeGreaterThan(before!.getTime() + 30_000);
  });

  it("is not extended by someone else", async () => {
    await takeLease(db, "embed", "run-a", 1_000);
    expect(await extendLease(db, "embed", "run-b", 60_000)).toBe(false);
  });

  it("is released by the owner only", async () => {
    await takeLease(db, "embed", "run-a", 60_000);
    await releaseLease(db, "embed", "run-b");
    expect(await takeLease(db, "embed", "run-c", 60_000)).toBe(false);
    await releaseLease(db, "embed", "run-a");
    expect(await takeLease(db, "embed", "run-c", 60_000)).toBe(true);
  });
});

describe("pipeline_runs recorder", () => {
  it("records start and finish with counts", async () => {
    const id = await startRun(db, "embed");
    let [row] = await db.select().from(pipelineRuns);
    expect(row).toMatchObject({ id, stage: "embed", finishedAt: null });
    await finishRun(db, id, { processed: 10, remaining: 5, failed: 1 });
    [row] = await db.select().from(pipelineRuns);
    expect(row).toMatchObject({ processed: 10, remaining: 5, failed: 1, error: null });
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it("records an error", async () => {
    const id = await startRun(db, "cluster");
    await finishRun(db, id, { processed: 0, remaining: 3, failed: 0, error: "boom" });
    const [row] = await db.select().from(pipelineRuns);
    expect(row.error).toBe("boom");
  });
});
