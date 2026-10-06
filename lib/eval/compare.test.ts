import { describe, expect, it } from "vitest";
import { agree, calibration, confusion, curve, pickTau, type Scored } from "./compare";

const s = (truth: boolean, pSame: number, relation = "same", thin = false): Scored => ({ truth, pSame, relation, thin });

describe("curve", () => {
  const data = [s(true, 0.99), s(true, 0.95), s(false, 0.92), s(true, 0.6), s(false, 0.55), s(false, 0.99, "related"), s(true, 0.3, "related")];

  it("counts a join only for relation `same` at or above τ", () => {
    const [p90, p98] = curve(data, [0.9, 0.98]);
    expect(p90).toMatchObject({ joins: 3, tp: 2, fp: 1 });
    expect(p98).toMatchObject({ joins: 1, tp: 1, fp: 0, precision: 1 });
    expect(p90.recall).toBeCloseTo(2 / 4);
  });

  it("precision is 1 with no joins, recall 0 with no positives", () => {
    expect(curve([s(false, 0.99)], [0.5])[0]).toMatchObject({ joins: 1, precision: 0, recall: 0 });
    expect(curve([], [0.5])[0]).toMatchObject({ joins: 0, precision: 1 });
  });
});

describe("pickTau", () => {
  it("takes the lowest τ that meets the target with enough joins behind it", () => {
    const points = curve([...Array(20).fill(0).map((_, i) => s(i !== 0, 0.8 + i * 0.01))], [0.8, 0.9, 0.95]);
    expect(pickTau(points, 0.97, 5)?.tau).toBe(0.9);
    expect(pickTau(points, 1.01, 5)).toBeNull();
    expect(pickTau(points, 0.9, 100)).toBeNull();
  });
});

describe("calibration", () => {
  it("reports the share of truly-same pairs per bucket", () => {
    const b = calibration([s(true, 0.97), s(true, 0.96), s(false, 0.96), s(false, 0.1)]);
    expect(b.find((x) => x.from === 0.95)).toMatchObject({ n: 3, sameRate: 2 / 3 });
    expect(b.find((x) => x.from === 0)).toMatchObject({ n: 1, sameRate: 0 });
    expect(b.find((x) => x.from === 0.6)).toMatchObject({ n: 0, sameRate: null });
  });
});

describe("agree", () => {
  it("is `same` only when both say same, with the lower probability", () => {
    expect(agree({ relation: "same", pSame: 0.95 }, { relation: "same", pSame: 0.91 })).toEqual({ relation: "same", pSame: 0.91 });
    expect(agree({ relation: "same", pSame: 0.99 }, { relation: "related", pSame: 0.2 })).toMatchObject({ relation: "related", pSame: 0.2 });
  });
});

describe("confusion", () => {
  it("tallies relation against truth", () => {
    expect(confusion([s(true, 0.9), s(false, 0.9), s(false, 0.1, "related")])).toEqual({ same: { same: 1, notSame: 1 }, related: { same: 0, notSame: 1 } });
  });
});
