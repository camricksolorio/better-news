import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-auth";
import { buildView, runExplore, type ExploreParams, type ViewParams } from "@/lib/eval/explore";

export const dynamic = "force-dynamic";

const num = (v: string | null) => (v === null || v === "" ? undefined : Number(v));

export async function GET(request: NextRequest) {
  // Proxy already gates /admin; re-check here as every admin route does.
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const q = request.nextUrl.searchParams;
  const params: Partial<ExploreParams> = {
    tLow: num(q.get("tLow")),
    windowHours: num(q.get("windowHours")),
    gray: q.get("gray") === "join" ? "join" : "new",
  };
  const view: ViewParams = {
    view: (["stories", "gray", "search"] as const).find((v) => v === q.get("view")) ?? "stories",
    sort: (["size", "suspicious", "sources", "recent"] as const).find((v) => v === q.get("sort")) ?? "size",
    q: q.get("q") ?? "",
    page: Math.max(1, num(q.get("page")) ?? 1),
    minSize: Math.max(2, num(q.get("minSize")) ?? 2),
  };

  try {
    const started = Date.now();
    const result = await runExplore(params);
    return NextResponse.json({
      params: result.params,
      summary: result.summary,
      payload: buildView(result, view),
      ms: Date.now() - started,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
