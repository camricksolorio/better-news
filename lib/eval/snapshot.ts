import { isThin } from "@/lib/text";
import { parseVector } from "@/lib/pipeline/store-db";
import type { SnapshotArticle } from "./replay";

export type SnapshotRow = {
  guid: string;
  sourceId: string;
  title: string;
  summary: string | null;
  firstPublishedAt: Date | string;
  createdAt: Date | string;
  versionId: string | null;
  excludedReason: string | null;
  embedding: unknown;
};

const iso = (d: Date | string) => new Date(d).toISOString();

export function toSnapshotArticle(r: SnapshotRow): SnapshotArticle {
  return {
    guid: r.guid,
    sourceId: r.sourceId,
    title: r.title,
    summary: r.summary,
    time: iso(r.firstPublishedAt),
    thin: isThin(r.summary),
    embedding: parseVector(r.embedding),
    versionId: r.versionId,
    createdAt: iso(r.createdAt),
    excludedReason: r.excludedReason,
  };
}
