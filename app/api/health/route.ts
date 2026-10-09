import { NextResponse } from "next/server";
import { db } from "@/db";
import { isAuthorized } from "@/lib/pipeline/endpoint";
import { runHealthChecks } from "@/lib/pipeline/health";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const health = await runHealthChecks(db);
    return NextResponse.json(health, { status: health.ok ? 200 : 503 });
  } catch (e) {
    // A database that cannot answer is unhealthy too.
    return NextResponse.json({ ok: false, checks: [{ name: "database", ok: false, detail: e instanceof Error ? e.message : String(e) }] }, { status: 503 });
  }
}
