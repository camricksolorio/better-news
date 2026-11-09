import { describe, expect, it } from "vitest";
import { derivePairLabels, orderSpread, retrievalRecall, scoreEvent, summarizeEvents, type EvalEvent } from "./events";

const event = (labels: Record<string, "in" | "related" | "out">, over: Partial<EvalEvent> = {}): EvalEvent => ({
  id: "e1",
  title: "An event",
  split: "dev",
  labels: new Map(Object.entries(labels)),
  humanLabeled: true,
  ...over,
});
const clusters = (c: Record<string, string>) => new Map(Object.entries(c));
const outlets = (o: Record<string, string>) => new Map(Object.entries(o));
const src = outlets({ a1: "A", a2: "B", a3: "C", a4: "D", r1: "E", o1: "F", u1: "G" });

describe("scoreEvent", () => {
  it("scores a perfectly clustered event: recall 1, one story, no contamination", () => {
    const s = scoreEvent(event({ a1: "in", a2: "in", a3: "in" }), clusters({ a1: "S", a2: "S", a3: "S" }), src)!;
    expect(s).toMatchObject({ recall: 1, outletRecall: 1, splits: 1, mainStory: "S", relatedMembers: 0, outMembers: 0 });
    expect(s.unlabeledMembers).toEqual([]);
  });

  it("gives the expected recall for a three-way split, using the largest story", () => {
    const s = scoreEvent(
      event({ a1: "in", a2: "in", a3: "in", a4: "in" }),
      clusters({ a1: "S1", a2: "S1", a3: "S2", a4: "S3" }),
      src,
    )!;
    expect(s.recall).toBe(2 / 4);
    expect(s.splits).toBe(3);
    expect(s.mainStory).toBe("S1");
    expect(s.outletRecall).toBe(2 / 4);
  });

  it("breaks a tie between equally large stories deterministically", () => {
    const s = scoreEvent(event({ a1: "in", a2: "in" }), clusters({ a1: "S2", a2: "S1" }), src)!;
    expect(s.mainStory).toBe("S1");
  });

  it("counts related and out members of the main story as contamination, and lists unlabelled ones", () => {
    const s = scoreEvent(
      event({ a1: "in", a2: "in", r1: "related", o1: "out" }),
      clusters({ a1: "S", a2: "S", r1: "S", o1: "S", u1: "S", elsewhere: "T" }),
      src,
    )!;
    expect(s).toMatchObject({ relatedMembers: 1, outMembers: 1, recall: 1 });
    expect(s.unlabeledMembers).toEqual(["u1"]);
  });

  it("counts an outlet as covered only once even when it has two in articles", () => {
    const s = scoreEvent(
      event({ a1: "in", a2: "in", a3: "in" }),
      clusters({ a1: "S", a2: "T", a3: "T" }),
      outlets({ a1: "A", a2: "A", a3: "B" }),
    )!;
    expect(s.recall).toBe(2 / 3);
    // Story T holds outlets A and B; story S holds only A, so the main story T covers both outlets.
    expect(s.outletRecall).toBe(1);
  });

  it("ignores in articles that are not in the replay, and returns null when fewer than two remain", () => {
    expect(scoreEvent(event({ a1: "in", a2: "in" }), clusters({ a1: "S" }), src)).toBeNull();
    const s = scoreEvent(event({ a1: "in", a2: "in", a3: "in" }), clusters({ a1: "S", a2: "S" }), src)!;
    expect(s.recall).toBe(1);
    expect(s.missing).toBe(1);
  });

  it("returns null for an event nobody has labelled beyond its seed", () => {
    expect(scoreEvent(event({ a1: "in", a2: "in" }, { humanLabeled: false }), clusters({ a1: "S", a2: "S" }), src)).toBeNull();
  });
});

describe("summarizeEvents", () => {
  const scored = (id: string, split: "dev" | "holdout", recall: number, splits: number) => ({
    id, title: id, split, recall, outletRecall: recall, splits, mainStory: "S", relatedMembers: 0, outMembers: 0, unlabeledMembers: [], missing: 0,
  });

  it("reports mean recall and the share of events in at most two stories, per split and overall", () => {
    const all = [scored("a", "dev", 1, 1), scored("b", "dev", 0.5, 3), scored("c", "holdout", 0.75, 2), scored("d", "holdout", 0.25, 4)];
    const s = summarizeEvents(all);
    expect(s.all).toMatchObject({ events: 4, meanRecall: 0.625, shareAtMostTwoStories: 0.5 });
    expect(s.dev).toMatchObject({ events: 2, meanRecall: 0.75, shareAtMostTwoStories: 0.5 });
    expect(s.holdout).toMatchObject({ events: 2, meanRecall: 0.5, shareAtMostTwoStories: 0.5 });
  });

  it("returns zeros for an empty set", () => {
    expect(summarizeEvents([]).all).toMatchObject({ events: 0, meanRecall: 0, shareAtMostTwoStories: 0 });
  });
});

describe("derivePairLabels", () => {
  it("makes in×in pairs same and in×related pairs related, and nothing for out", () => {
    const pairs = derivePairLabels([event({ a1: "in", a2: "in", a3: "in", r1: "related", o1: "out" })]);
    const key = (p: { a: string; b: string }) => `${p.a}|${p.b}`;
    const same = pairs.filter((p) => p.label === "same").map(key).sort();
    const related = pairs.filter((p) => p.label === "related").map(key).sort();
    expect(same).toEqual(["a1|a2", "a1|a3", "a2|a3"]);
    expect(related).toEqual(["a1|r1", "a2|r1", "a3|r1"]);
    expect(pairs).toHaveLength(6);
  });

  it("skips events nobody has labelled", () => {
    expect(derivePairLabels([event({ a1: "in", a2: "in" }, { humanLabeled: false })])).toEqual([]);
  });
});

describe("retrievalRecall", () => {
  it("is the share of in×in pairs that are candidate pairs", () => {
    const e = event({ a1: "in", a2: "in", a3: "in" });
    expect(retrievalRecall([e], new Set(["a1|a2", "a2|a3"]))).toEqual({ pairs: 3, found: 2, recall: 2 / 3 });
    expect(retrievalRecall([e], new Set())).toEqual({ pairs: 3, found: 0, recall: 0 });
  });

  it("leaves out in articles that were not in the replay", () => {
    const e = event({ a1: "in", a2: "in", a3: "in" });
    expect(retrievalRecall([e], new Set(["a1|a2"]), new Set(["a1", "a2"]))).toEqual({ pairs: 1, found: 1, recall: 1 });
  });

  it("is null when there are no pairs to find", () => {
    expect(retrievalRecall([], new Set())).toEqual({ pairs: 0, found: 0, recall: null });
  });
});

describe("orderSpread", () => {
  it("is the max minus the min of the per-order mean recall", () => {
    expect(orderSpread([0.8, 0.84, 0.82])).toBeCloseTo(0.04);
    expect(orderSpread([0.8])).toBe(0);
    expect(orderSpread([])).toBe(0);
  });
});
