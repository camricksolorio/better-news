import { createHash } from "node:crypto";

// A new hash is a new article version. It covers the title and summary exactly as stored, so migration 0009's
// SQL backfill (sha256 of title + newline + coalesce(summary, '')) produces the same values.
export function contentHash(title: string, summary: string | null | undefined): string {
  return createHash("sha256").update(`${title}\n${summary ?? ""}`, "utf8").digest("hex");
}
