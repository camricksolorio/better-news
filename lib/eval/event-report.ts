// Turns one replay into the numbers the PRD asks for (story-clustering-v2 TDD part 8), shared by the script and tests.
import { computeMetrics, type Metrics, type PairLabel } from "./metrics";
import {
  derivePairLabels,
  retrievalRecall,
  scoreEvent,
  summarizeEvents,
  type EvalEvent,
  type EventScore,
  type EventSummary,
} from "./events";
import type { RunResult } from "./ticks";

export type OrderReport = {
  scores: EventScore[];
  summary: { all: EventSummary; dev: EventSummary; holdout: EventSummary };
  pairs: Metrics;
  retrieval: ReturnType<typeof retrievalRecall> | null;
  stories: number;
};

export function reportRun(
  run: RunResult,
  events: EvalEvent[],
  sourceOf: Map<string, string>,
  pairLabels: PairLabel[],
): OrderReport {
  const scores = events.flatMap((e) => scoreEvent(e, run.clusterOf, sourceOf) ?? []);
  // Pairs the owner labelled directly win over pairs implied by an event.
  const byKey = new Map<string, PairLabel>();
  for (const l of derivePairLabels(events)) byKey.set(`${l.a}|${l.b}`, l);
  for (const l of pairLabels) byKey.set(l.a < l.b ? `${l.a}|${l.b}` : `${l.b}|${l.a}`, l);
  return {
    scores,
    summary: summarizeEvents(scores),
    pairs: computeMetrics(run.clusterOf, [...byKey.values()]),
    retrieval: run.candidatePairs ? retrievalRecall(events, run.candidatePairs) : null,
    stories: new Set(run.clusterOf.values()).size,
  };
}
