// Scoring for the adjudicator comparison (D35): precision-versus-τ curves, the τ that reaches a precision target,
// calibration buckets, and a two-model agreement score. Pure functions over scored pairs.

export type Scored = {
  // True when the pair is `same` in the dataset's labels.
  truth: boolean;
  pSame: number;
  relation: string;
  thin?: boolean;
};

export type CurvePoint = { tau: number; joins: number; tp: number; fp: number; precision: number; recall: number };

export const DEFAULT_TAUS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.98, 0.99];

// A pair "joins" at τ when the model says `same` with p_same >= τ (the production join rule for one call).
export function curve(scored: Scored[], taus: number[] = DEFAULT_TAUS): CurvePoint[] {
  const positives = scored.filter((s) => s.truth).length;
  return taus.map((tau) => {
    const joined = scored.filter((s) => s.relation === "same" && s.pSame >= tau);
    const tp = joined.filter((s) => s.truth).length;
    const fp = joined.length - tp;
    return {
      tau,
      joins: joined.length,
      tp,
      fp,
      precision: joined.length === 0 ? 1 : tp / joined.length,
      recall: positives === 0 ? 0 : tp / positives,
    };
  });
}

// The lowest τ whose precision reaches the target with at least `minJoins` joins behind it, or null.
export function pickTau(points: CurvePoint[], target: number, minJoins = 10): CurvePoint | null {
  return [...points].sort((a, b) => a.tau - b.tau).find((p) => p.precision >= target && p.joins >= minJoins) ?? null;
}

export type CalibrationBucket = { from: number; to: number; n: number; sameRate: number | null };

// How often pairs scored in each p_same bucket were really `same`. A calibrated model tracks the diagonal.
export function calibration(scored: Scored[], edges: number[] = [0, 0.2, 0.4, 0.6, 0.8, 0.9, 0.95, 1.0001]): CalibrationBucket[] {
  return edges.slice(0, -1).map((from, i) => {
    const to = edges[i + 1];
    const inBucket = scored.filter((s) => s.pSame >= from && s.pSame < to);
    return { from, to: Math.min(to, 1), n: inBucket.length, sameRate: inBucket.length ? inBucket.filter((s) => s.truth).length / inBucket.length : null };
  });
}

// Two models must both say `same`; the agreed score is the lower of the two probabilities.
export function agree(a: Pick<Scored, "relation" | "pSame">, b: Pick<Scored, "relation" | "pSame">): Pick<Scored, "relation" | "pSame"> {
  const both = a.relation === "same" && b.relation === "same";
  return { relation: both ? "same" : a.relation === "same" ? b.relation : a.relation, pSame: Math.min(a.pSame, b.pSame) };
}

export function confusion(scored: Scored[]): Record<string, { same: number; notSame: number }> {
  const out: Record<string, { same: number; notSame: number }> = {};
  for (const s of scored) {
    out[s.relation] ??= { same: 0, notSame: 0 };
    out[s.relation][s.truth ? "same" : "notSame"]++;
  }
  return out;
}
