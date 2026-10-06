import { describe, expect, it } from "vitest";
import { exactLowerBound } from "./stats";

describe("exactLowerBound", () => {
  it("matches the D37 rule: at most 2 errors in 150 joins keeps the 95% lower bound above 0.95", () => {
    expect(exactLowerBound(150, 150)).toBeGreaterThan(0.95);
    expect(exactLowerBound(148, 150)).toBeGreaterThan(0.95);
    expect(exactLowerBound(147, 150)).toBeLessThan(0.95);
  });

  it("known value: all 150 correct gives 0.05^(1/150)", () => {
    expect(exactLowerBound(150, 150)).toBeCloseTo(0.05 ** (1 / 150), 6);
  });

  it("is 0 with no data or no successes, and grows with n", () => {
    expect(exactLowerBound(0, 10)).toBe(0);
    expect(exactLowerBound(0, 0)).toBe(0);
    expect(exactLowerBound(95, 100)).toBeLessThan(exactLowerBound(190, 200));
  });
});
