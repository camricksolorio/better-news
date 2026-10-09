// Shared shell for /api/embed and /api/cluster (TDD "Endpoint contracts"): auth, params, single-flight lease,
// run record, deadline, and the JSON responses. The routes only supply the stage to run.
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { Db } from "@/db/types";
import { extendLease, releaseLease, takeLease, type LeaseName } from "./lease";
import { finishRun, startRun, type RunResult } from "./runs";

// Longer than one batch or article (a few 30s calls with retries), and extended after each one.
export const LEASE_MS = 90_000;
export const DEADLINE_MARGIN_MS = 10_000;
const DAY = 86_400_000;

export type StageParams = { source?: string; from?: Date; to?: Date; backfill: boolean };

export function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured (local dev), same as /api/ingest
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

// A date-only `to` means the whole day, so `from=2026-08-01&to=2026-08-08` includes the 8th.
function parseDate(name: string, value: string, endOfDay: boolean): Date | string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return `${name} is not a valid ISO date`;
  return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(d.getTime() + DAY - 1) : d;
}

export function parseParams(url: URL): StageParams | { error: string } {
  const p = url.searchParams;
  const known = new Set(["source", "from", "to", "mode"]);
  for (const key of p.keys()) if (!known.has(key)) return { error: `unknown parameter: ${key}` };

  const mode = p.get("mode");
  if (mode !== null && mode !== "backfill") return { error: 'mode must be "backfill"' };

  const out: StageParams = { backfill: mode === "backfill" };
  const source = p.get("source");
  if (source !== null) {
    if (source === "") return { error: "source must not be empty" };
    out.source = source;
  }
  for (const [name, endOfDay] of [["from", false], ["to", true]] as const) {
    const raw = p.get(name);
    if (raw === null) continue;
    const parsed = parseDate(name, raw, endOfDay);
    if (typeof parsed === "string") return { error: parsed };
    out[name] = parsed;
  }
  if (out.from && out.to && out.from > out.to) return { error: "from is after to" };
  return out;
}

export type StageContext = {
  params: StageParams;
  // Epoch ms after which no new batch starts: maxDuration minus a margin.
  deadline: number;
  // Extends the lease; false means it was lost and the stage must stop.
  keepAlive: () => Promise<boolean>;
};

export async function handleStageRequest(args: {
  db: Db;
  stage: LeaseName;
  request: Request;
  maxDurationSec: number;
  run: (ctx: StageContext) => Promise<Omit<RunResult, "error">>;
  now?: () => number;
}): Promise<Response> {
  const { db, stage, request } = args;
  const now = args.now ?? Date.now;

  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const params = parseParams(new URL(request.url));
  if ("error" in params) return NextResponse.json({ error: params.error }, { status: 400 });

  const startedAt = now();
  const owner = randomUUID();
  let runId: string | undefined;
  try {
    if (!(await takeLease(db, stage, owner, LEASE_MS))) return NextResponse.json({ status: "busy" }, { status: 409 });
    try {
      runId = await startRun(db, stage);
      const deadline = startedAt + args.maxDurationSec * 1000 - DEADLINE_MARGIN_MS;
      const result = await args.run({ params, deadline, keepAlive: () => extendLease(db, stage, owner, LEASE_MS) });
      await finishRun(db, runId, result);
      return NextResponse.json({ processed: result.processed, remaining: result.remaining, failed: result.failed, durationMs: now() - startedAt });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (runId) await finishRun(db, runId, { processed: 0, remaining: 0, failed: 0, error: message }).catch(() => {});
      return NextResponse.json({ error: message }, { status: 500 });
    } finally {
      await releaseLease(db, stage, owner).catch(() => {});
    }
  } catch (e) {
    // The lease itself could not be taken (database down).
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
