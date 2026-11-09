import { describe, expect, it } from "vitest";
import type { StoredVerdict } from "@/lib/pipeline/judge";
import { buildDump } from "./v2-dump";
import type { EvalEvent } from "./events";
import type { SnapshotArticle } from "./replay";

const art = (guid: string, source: string, hour: number, x: number): SnapshotArticle => ({
  guid, sourceId: source, title: `Title ${guid}`, summary: `Summary ${guid}`, time: new Date(Date.UTC(2026, 9, 1, hour)).toISOString(), thin: false,
  embedding: [x, Math.sqrt(1 - x * x)],
});
const v = (pSame: number): StoredVerdict => ({ relation: pSame > 0.5 ? "same" : "different", pSame, model: "jev-1.14.0" });
const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// a, b, c are one event; d is another. a+b merged, c is split off, d is alone.
const snapshot = [art("a", "s1", 1, 1), art("b", "s2", 2, 0.99), art("c", "s3", 3, 0.9), art("d", "s4", 4, 0.1)];
const clusterOf = new Map([["a", "S1"], ["b", "S1"], ["c", "S2"], ["d", "S3"]]);
const event: EvalEvent = { id: "e1", title: "Event", split: "dev", humanLabeled: true, labels: new Map([["a", "in"], ["b", "in"], ["c", "in"], ["d", "out"]]) };

describe("buildDump", () => {
  const verdicts = new Map([[key("a", "b"), v(0.95)], [key("a", "c"), v(0.4)]]);
  const dump = buildDump({ snapshot, snapshotName: "snap", clusterOf, candidates: new Set([key("a", "b"), key("a", "c"), key("b", "c")]), verdicts, events: [event], tauLink: 0.8, config: { tLow: 0.84 } });

  it("lists multi-article stories with their links and the owner's labels", () => {
    expect(dump.stories).toBe(3);
    expect(dump.singletons).toBe(2);
    expect(dump.multi).toHaveLength(1);
    const s = dump.multi[0];
    expect(s).toMatchObject({ id: "S1", size: 2, sourceCount: 2, judgedPairs: 1, possiblePairs: 1, minLink: 0.95, meanLink: 0.95 });
    expect(s.members.map((m) => [m.guid, m.avgLink, m.event?.label])).toEqual([["a", 0.95, "in"], ["b", 0.95, "in"]]);
  });

  it("explains why each same-event pair is or is not merged", () => {
    const e = dump.events[0];
    expect(e.inArticles).toBe(3);
    expect(e.recall).toBeCloseTo(2 / 3, 3);
    expect(e.stories).toEqual([{ id: "S1", inCount: 2, size: 2 }, { id: "S2", inCount: 1, size: 1 }]);
    // a-b merged; a-c judged low; b-c retrieved but never judged.
    expect(e.counts).toEqual({ merged: 1, not_retrieved: 0, unjudged: 1, judged_low: 1, judged_high: 0 });
    expect(e.unmerged.map((p) => [p.a, p.b, p.status, p.pSame])).toEqual(expect.arrayContaining([["a", "c", "judged_low", 0.4], ["b", "c", "unjudged", null]]));
  });

  it("separates pairs judged high but not merged, and pairs never retrieved", () => {
    const d = buildDump({ snapshot, snapshotName: "snap", clusterOf, candidates: new Set([key("a", "b")]), verdicts: new Map([[key("b", "c"), v(0.9)], [key("a", "b"), v(0.9)]]), events: [event], tauLink: 0.8, config: {} });
    expect(d.events[0].counts).toEqual({ merged: 1, not_retrieved: 1, unjudged: 0, judged_low: 0, judged_high: 1 });
  });

  it("includes each labelled article with its story", () => {
    expect(dump.events[0].members.find((m) => m.guid === "c")).toMatchObject({ label: "in", storyId: "S2", storySize: 1 });
  });
});
