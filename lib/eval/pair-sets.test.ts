import { describe, expect, it } from "vitest";
import { publicPairs, referencePairs } from "./pair-sets";
import type { PairRecord } from "./pairs";
import type { PairLabelRecord } from "@/lib/labels";

const art = (title: string, snippet = "x".repeat(80)) => ({ title, source: "s", time: "2026-10-01T00:00:00Z", snippet });
const rec = (a: string, b: string): PairRecord =>
  ({ a, b, category: "sim80", sim: 0.8, hoursApart: 1, merged: false, article: { a: art(`t${a}`), b: art(`t${b}`, "short") } }) as PairRecord;
const lab = (a: string, b: string, label: string, labeler = "human"): PairLabelRecord =>
  ({ type: "pair", a, b, label, labeler, note: null, createdAt: "" }) as PairLabelRecord;

describe("referencePairs", () => {
  it("keeps human labels only, maps same to truth, drops unsure, and flags thin pairs", () => {
    const pairs = [rec("a", "b"), rec("c", "d"), rec("e", "f")];
    const out = referencePairs([lab("a", "b", "same"), lab("c", "d", "related"), lab("e", "f", "unsure"), lab("a", "b", "different", "model:gpt-4o-mini")], pairs);
    expect(out.map((p) => [p.key, p.truth])).toEqual([["a|b", true], ["c|d", false]]);
    expect(out.every((p) => p.thin)).toBe(true); // article B has a 5-char snippet
  });

  it("finds the text whichever order the pair is stored in", () => {
    expect(referencePairs([lab("b", "a", "same")], [rec("a", "b")])).toHaveLength(1);
  });
});

describe("publicPairs", () => {
  const rows = Array.from({ length: 40 }, (_, i) =>
    JSON.stringify({ a: `a${i}`, b: `b${i}`, label: i % 2 ? "same" : "different", article: { a: art("A"), b: art("B") } }),
  ).concat(JSON.stringify({ a: "x", b: "y", label: null, article: { a: art("A"), b: art("B") } }));

  it("draws equal numbers of same and different, is repeatable for a seed, and skips unlabeled pairs", () => {
    const out = publicPairs("wcep", rows.join("\n"), 10, 3);
    expect(out).toHaveLength(10);
    expect(out.filter((p) => p.truth)).toHaveLength(5);
    expect(out.some((p) => p.key === "x|y")).toBe(false);
    expect(publicPairs("wcep", rows.join("\n"), 10, 3).map((p) => p.key)).toEqual(out.map((p) => p.key));
    expect(publicPairs("wcep", rows.join("\n"), 10, 4).map((p) => p.key)).not.toEqual(out.map((p) => p.key));
  });
});
