import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { storeFeedItems } from "@/lib/pipeline/ingest";
import { parseRssFeed } from "@/lib/rss";
import { FEED_SOURCES } from "@/feeds.config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type SourceResult = {
  sourceId: string;
  ok: boolean;
  itemCount?: number;
  error?: string;
};

async function ingestSource(sourceId: string, url: string): Promise<SourceResult> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "better-news-ingest/1.0" },
    });
    if (!res.ok) {
      return { sourceId, ok: false, error: `HTTP ${res.status}` };
    }
    const xml = await res.text();
    const items = parseRssFeed(xml);

    if (items.length === 0) {
      return { sourceId, ok: true, itemCount: 0 };
    }

    await storeFeedItems(db, sourceId, items);

    return { sourceId, ok: true, itemCount: items.length };
  } catch (error) {
    return { sourceId, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured (local dev)
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = await Promise.all(
    FEED_SOURCES.map((source) => ingestSource(source.id, source.url)),
  );

  return NextResponse.json({ ranAt: new Date().toISOString(), results });
}
