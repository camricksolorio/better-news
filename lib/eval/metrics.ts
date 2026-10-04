// Pairwise clustering metrics against labeled pairs (R3). `related` counts as "should not merge".
// `unsure` pairs are ignored. Metrics are computed over the labeled pairs only; because the
// pair set is stratified rather than random, read precision/recall as relative numbers for
// comparing configurations, plus an absolute check against the ship bar.

export type PairLabel = { a: string; b: string; label: "same" | "related" | "different" | "unsure" };

export type PairError = { a: string; b: string; label: PairLabel["label"] };

export type Metrics = {
  precision: number;
  recall: number;
  f1: number;
  // Share of `related` pairs wrongly placed in one story.
  relatedLeak: number;
  counts: { tp: number; fp: number; fn: number; tn: number; related: number; relatedMerged: number };
  falseMerges: PairError[];
  falseSplits: PairError[];
  unlabeledMissing: number;
};

const ratio = (num: number, den: number) => (den === 0 ? 0 : num / den);

export function computeMetrics(clusterOf: Map<string, string>, labels: PairLabel[]): Metrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let related = 0;
  let relatedMerged = 0;
  let missing = 0;
  const falseMerges: PairError[] = [];
  const falseSplits: PairError[] = [];

  for (const { a, b, label } of labels) {
    if (label === "unsure") continue;
    const ca = clusterOf.get(a);
    const cb = clusterOf.get(b);
    if (ca === undefined || cb === undefined) {
      missing++;
      continue;
    }
    const together = ca === cb;
    if (label === "related") {
      related++;
      if (together) relatedMerged++;
    }
    if (label === "same") {
      if (together) tp++;
      else {
        fn++;
        falseSplits.push({ a, b, label });
      }
    } else if (together) {
      fp++;
      falseMerges.push({ a, b, label });
    } else {
      tn++;
    }
  }

  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    precision,
    recall,
    f1: ratio(2 * precision * recall, precision + recall),
    relatedLeak: ratio(relatedMerged, related),
    counts: { tp, fp, fn, tn, related, relatedMerged },
    falseMerges,
    falseSplits,
    unlabeledMissing: missing,
  };
}
