import { describe, expect, it } from "vitest";
import { toSnapshotArticle } from "./snapshot";

const row = {
  guid: "g1",
  sourceId: "npr-top",
  title: "Court halts tariffs",
  summary: "A federal court halted the new tariffs on Tuesday, citing the law.",
  firstPublishedAt: new Date("2026-10-20T10:00:00Z"),
  createdAt: new Date("2026-10-20T10:30:00Z"),
  versionId: "v-1",
  excludedReason: null,
  embedding: [0.1, 0.2],
};

describe("toSnapshotArticle", () => {
  it("uses first_published_at as the time and keeps the v2 fields", () => {
    expect(toSnapshotArticle(row)).toEqual({
      guid: "g1",
      sourceId: "npr-top",
      title: "Court halts tariffs",
      summary: "A federal court halted the new tariffs on Tuesday, citing the law.",
      time: "2026-10-20T10:00:00.000Z",
      thin: false,
      embedding: [0.1, 0.2],
      versionId: "v-1",
      createdAt: "2026-10-20T10:30:00.000Z",
      excludedReason: null,
    });
  });

  it("flags a thin summary, and carries an exclusion", () => {
    const out = toSnapshotArticle({ ...row, summary: "Short", excludedReason: "live_blog", versionId: null });
    expect(out.thin).toBe(true);
    expect(out.excludedReason).toBe("live_blog");
    expect(out.versionId).toBeNull();
  });

  it("accepts a vector as a string, as the driver returns it", () => {
    expect(toSnapshotArticle({ ...row, embedding: "[0.5,0.25]" }).embedding).toEqual([0.5, 0.25]);
  });
});
