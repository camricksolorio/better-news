// The join-audit read-out (D37). Pure and free of server imports so the review page can run it in the browser.
import { exactLowerBound } from "@/lib/eval/stats";
import type { Label } from "@/lib/labeling";

export type AuditSummary = {
  total: number;
  labeled: number;
  same: number;
  related: number;
  different: number;
  unsure: number;
  // `unsure` counts as wrong: a join the reviewer cannot defend should not pass a precision bar.
  errors: number;
  precision: number | null;
  lowerBound: number | null;
  // D37: at n = 150 the bound clears 0.95 with at most 2 errors; this says whether the audit can still clear it.
  canStillClear: boolean;
  clears: boolean;
};

export const SHIP_PRECISION = 0.95;

export function summarize(labels: (Label | null)[]): AuditSummary {
  const count = (l: Label) => labels.filter((x) => x === l).length;
  const total = labels.length;
  const same = count("same");
  const related = count("related");
  const different = count("different");
  const unsure = count("unsure");
  const labeled = same + related + different + unsure;
  const errors = related + different + unsure;
  const remaining = total - labeled;
  return {
    total,
    labeled,
    same,
    related,
    different,
    unsure,
    errors,
    precision: labeled === 0 ? null : same / labeled,
    lowerBound: labeled === 0 ? null : exactLowerBound(same, labeled),
    // Best case: every remaining item is `same`.
    canStillClear: exactLowerBound(same + remaining, total) > SHIP_PRECISION,
    clears: remaining === 0 && exactLowerBound(same, total) > SHIP_PRECISION,
  };
}
