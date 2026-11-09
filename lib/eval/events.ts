// Event-level clustering metrics (story-clustering-v2 TDD part 8): how well each labelled event ended up in one story,
// and how clean that story is. Pure functions over a clustering (article guid -> story id) and the owner's labels.
import type { PairLabel } from "./metrics";

export type EventLabel = "in" | "related" | "out";

export type EvalEvent = {
  id: string;
  title: string;
  split: "dev" | "holdout";
  labels: Map<string, EventLabel>; // article guid -> label
  // Whether the owner has labelled anything beyond the sampler's seed. Others would score a trivial recall of 1.
  humanLabeled: boolean;
};

export type EventScore = {
  id: string;
  title: string;
  split: "dev" | "holdout";
  // Share of the event's in articles that sit in the story holding the most of them.
  recall: number;
  // The same, counting each outlet once.
  outletRecall: number;
  // Number of stories the in articles are spread over.
  splits: number;
  mainStory: string;
  // Members of the main story that the owner labelled related / out, and ones nobody labelled.
  relatedMembers: number;
  outMembers: number;
  unlabeledMembers: string[];
  // In articles that were not in the replay (so not scored).
  missing: number;
};

export function scoreEvent(
  event: EvalEvent,
  clusterOf: Map<string, string>,
  sourceOf: Map<string, string>,
): EventScore | null {
  if (!event.humanLabeled) return null;
  const all = [...event.labels].filter(([, l]) => l === "in").map(([g]) => g);
  const present = all.filter((g) => clusterOf.has(g));
  if (present.length < 2) return null;

  const byStory = new Map<string, string[]>();
  for (const g of present) byStory.set(clusterOf.get(g)!, [...(byStory.get(clusterOf.get(g)!) ?? []), g]);
  // Most in articles wins; a tie goes to the smaller story id so the result never depends on map order.
  const [mainStory, mainIn] = [...byStory].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]))[0];

  const outlets = new Set(present.map((g) => sourceOf.get(g) ?? g));
  const mainOutlets = new Set(mainIn.map((g) => sourceOf.get(g) ?? g));

  let relatedMembers = 0;
  let outMembers = 0;
  const unlabeledMembers: string[] = [];
  for (const [guid, story] of clusterOf) {
    if (story !== mainStory) continue;
    const label = event.labels.get(guid);
    if (label === "related") relatedMembers++;
    else if (label === "out") outMembers++;
    else if (label === undefined) unlabeledMembers.push(guid);
  }

  return {
    id: event.id,
    title: event.title,
    split: event.split,
    recall: mainIn.length / present.length,
    outletRecall: mainOutlets.size / outlets.size,
    splits: byStory.size,
    mainStory,
    relatedMembers,
    outMembers,
    unlabeledMembers: unlabeledMembers.sort(),
    missing: all.length - present.length,
  };
}

export type EventSummary = {
  events: number;
  meanRecall: number;
  meanOutletRecall: number;
  // Share of events whose in articles sit in at most two stories (R2).
  shareAtMostTwoStories: number;
  meanSplits: number;
  relatedMembers: number;
  outMembers: number;
  unlabeledMembers: number;
};

function summarize(scores: EventScore[]): EventSummary {
  const n = scores.length;
  const mean = (f: (s: EventScore) => number) => (n === 0 ? 0 : scores.reduce((t, s) => t + f(s), 0) / n);
  return {
    events: n,
    meanRecall: mean((s) => s.recall),
    meanOutletRecall: mean((s) => s.outletRecall),
    shareAtMostTwoStories: mean((s) => (s.splits <= 2 ? 1 : 0)),
    meanSplits: mean((s) => s.splits),
    relatedMembers: scores.reduce((t, s) => t + s.relatedMembers, 0),
    outMembers: scores.reduce((t, s) => t + s.outMembers, 0),
    unlabeledMembers: scores.reduce((t, s) => t + s.unlabeledMembers.length, 0),
  };
}

// Reported separately for dev and holdout events, and for all of them.
export function summarizeEvents(scores: EventScore[]): { all: EventSummary; dev: EventSummary; holdout: EventSummary } {
  return {
    all: summarize(scores),
    dev: summarize(scores.filter((s) => s.split === "dev")),
    holdout: summarize(scores.filter((s) => s.split === "holdout")),
  };
}

// Pair labels implied by the events: in×in is `same`, in×related is `related`. They feed the pairwise precision,
// recall and related-leak numbers next to the labelled pairs from v1. Pairs are ordered by guid.
export function derivePairLabels(events: EvalEvent[]): PairLabel[] {
  const pairs: PairLabel[] = [];
  const add = (x: string, y: string, label: PairLabel["label"]) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    pairs.push({ a, b, label });
  };
  for (const e of events) {
    if (!e.humanLabeled) continue;
    const ins = [...e.labels].filter(([, l]) => l === "in").map(([g]) => g).sort();
    const related = [...e.labels].filter(([, l]) => l === "related").map(([g]) => g).sort();
    for (let i = 0; i < ins.length; i++) {
      for (let j = i + 1; j < ins.length; j++) add(ins[i], ins[j], "same");
      for (const r of related) add(ins[i], r, "related");
    }
  }
  return pairs;
}

// Share of the in×in pairs that the retrieval step proposed as candidate pairs ("a|b", ordered by guid). A pair
// that was never a candidate can never be judged, so this bounds what any later step can recover. `present` limits it to
// articles that were in the replay: an in article added after the snapshot was taken cannot be retrieved by anything.
export function retrievalRecall(events: EvalEvent[], candidatePairs: Set<string>, present?: Set<string>) {
  let pairs = 0;
  let found = 0;
  for (const e of events) {
    if (!e.humanLabeled) continue;
    const ins = [...e.labels].filter(([g, l]) => l === "in" && (!present || present.has(g))).map(([g]) => g).sort();
    for (let i = 0; i < ins.length; i++) {
      for (let j = i + 1; j < ins.length; j++) {
        pairs++;
        if (candidatePairs.has(`${ins[i]}|${ins[j]}`)) found++;
      }
    }
  }
  return { pairs, found, recall: pairs === 0 ? null : found / pairs };
}

// How much the mean event recall moves when only the arrival order changes (R7).
export function orderSpread(meanRecallPerOrder: number[]): number {
  return meanRecallPerOrder.length === 0 ? 0 : Math.max(...meanRecallPerOrder) - Math.min(...meanRecallPerOrder);
}
