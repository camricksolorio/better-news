import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { connectTestDb, resetTestDb } from "@/tests/test-db";
import { takeLease } from "./lease";
import { handleStageRequest, parseParams, type StageContext } from "./endpoint";

const { client, db } = connectTestDb();
afterAll(() => client.end());
beforeEach(() => resetTestDb(client));
afterEach(() => vi.unstubAllEnvs());

const req = (query = "", headers: Record<string, string> = {}) => new Request(`http://localhost/api/embed${query}`, { headers });
const ok = async () => ({ processed: 3, remaining: 2, failed: 1 });
const call = (stage: "embed" | "cluster", request: Request, run: (c: StageContext) => ReturnType<typeof ok> = ok) =>
  handleStageRequest({ db, stage, request, maxDurationSec: 60, run });
const runs = () => db.execute(sql`SELECT stage, finished_at, processed, remaining, failed, error FROM pipeline_runs`) as unknown as Promise<Record<string, unknown>[]>;
const lockCount = async () => ((await db.execute(sql`SELECT count(*)::int AS n FROM pipeline_locks`)) as unknown as { n: number }[])[0].n;

describe("parseParams", () => {
  const parse = (q: string) => parseParams(new URL(`http://x/api/embed${q}`));

  it("accepts no params as the live run", () => {
    expect(parse("")).toEqual({ backfill: false });
  });

  it("parses source, dates and backfill mode", () => {
    const p = parse("?source=bbc&from=2026-08-01&to=2026-08-08&mode=backfill");
    expect(p).toMatchObject({ source: "bbc", backfill: true });
    if ("error" in p) throw new Error(p.error);
    expect(p.from?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    // A date-only `to` includes that whole day.
    expect(p.to?.toISOString()).toBe("2026-08-08T23:59:59.999Z");
  });

  it("keeps an explicit time on `to` as given", () => {
    const p = parse("?to=2026-08-08T12:00:00Z");
    if ("error" in p) throw new Error(p.error);
    expect(p.to?.toISOString()).toBe("2026-08-08T12:00:00.000Z");
  });

  it.each([
    ["?from=nope", /from/],
    ["?to=2026-13-45", /to/],
    ["?mode=fast", /mode/],
    ["?source=", /source/],
    ["?bogus=1", /unknown parameter/],
    ["?from=2026-08-09&to=2026-08-01", /after/],
  ])("rejects %s", (q, message) => {
    const p = parse(q);
    expect("error" in p && p.error).toMatch(message);
  });
});

describe("handleStageRequest", () => {
  it("returns the stage result with a duration and writes a finished run record", async () => {
    const res = await call("embed", req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ processed: 3, remaining: 2, failed: 1, durationMs: expect.any(Number) });
    const [run] = await runs();
    expect(run).toMatchObject({ stage: "embed", processed: 3, remaining: 2, failed: 1, error: null });
    expect(run.finished_at).not.toBeNull();
  });

  it("releases the lease afterwards", async () => {
    await call("embed", req());
    expect(await lockCount()).toBe(0);
  });

  it("401 on a bad or missing secret, and does no work", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const run = vi.fn(ok);
    expect((await call("embed", req(), run)).status).toBe(401);
    expect((await call("embed", req("", { authorization: "Bearer wrong" }), run)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
    expect((await call("embed", req("", { authorization: "Bearer s3cret" }), run)).status).toBe(200);
  });

  it("is open when CRON_SECRET is unset (local dev)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("embed", req())).status).toBe(200);
  });

  it("400 on invalid params, with no lease taken and no run recorded", async () => {
    const run = vi.fn(ok);
    const res = await call("cluster", req("?from=nope"), run);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringContaining("from") });
    expect(run).not.toHaveBeenCalled();
    expect(await lockCount()).toBe(0);
    expect(await runs()).toHaveLength(0);
  });

  it("409 busy when the same stage's lease is held, without running or recording", async () => {
    await takeLease(db, "embed", "someone-else", 60_000);
    const run = vi.fn(ok);
    const res = await call("embed", req(), run);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: "busy" });
    expect(run).not.toHaveBeenCalled();
    expect(await runs()).toHaveLength(0);
    // The holder's lease is untouched.
    expect(await lockCount()).toBe(1);
  });

  it("runs embed and cluster at the same time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = async () => {
      await gate;
      return { processed: 1, remaining: 0, failed: 0 };
    };
    const embed = call("embed", req(), slow);
    // Wait until embed holds its lease.
    for (let i = 0; i < 50 && (await lockCount()) === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const second = await call("embed", req(), ok);
    expect(second.status).toBe(409);
    const cluster = call("cluster", req(), slow);
    release();
    expect((await embed).status).toBe(200);
    expect((await cluster).status).toBe(200);
  });

  it("500 with the error, a run record carrying it, and the lease released", async () => {
    const res = await call("embed", req(), async () => {
      throw new Error("boom");
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
    const [run] = await runs();
    expect(run).toMatchObject({ stage: "embed", error: "boom" });
    expect(run.finished_at).not.toBeNull();
    expect(await lockCount()).toBe(0);
  });

  it("gives the stage a deadline of maxDuration minus 10s and a working keepAlive", async () => {
    let seen: StageContext | undefined;
    const t0 = Date.now();
    await call("cluster", req("?source=bbc&mode=backfill"), async (ctx) => {
      seen = ctx;
      expect(await ctx.keepAlive()).toBe(true);
      return { processed: 0, remaining: 0, failed: 0 };
    });
    expect(seen!.params).toMatchObject({ source: "bbc", backfill: true });
    expect(seen!.deadline - t0).toBeGreaterThan(49_000);
    expect(seen!.deadline - t0).toBeLessThanOrEqual(50_100);
  });

  it("keepAlive reports a lost lease", async () => {
    let alive: boolean | undefined;
    await call("embed", req(), async (ctx) => {
      await db.execute(sql`UPDATE pipeline_locks SET owner = 'thief'`);
      alive = await ctx.keepAlive();
      return { processed: 0, remaining: 0, failed: 0 };
    });
    expect(alive).toBe(false);
    // The thief's lease is not released by the old owner.
    expect(await lockCount()).toBe(1);
  });
});
