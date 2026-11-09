// Settings for the windowed consolidation (story-clustering-v2 TDD, "Configuration"). The starting values come from
// the TDD; the swept ones are tuned in Phase 3. Every setting is folded into pipelineVersion so a decision can be tied
// to the exact settings that made it.
import { createHash } from "node:crypto";
import { ADJUDICATION_PROMPT_VERSION } from "./adjudicate";

export type ConsolidateConfig = {
  // Similarity floor for a candidate pair, and the most candidate pairs retrieved per article.
  tLow: number;
  kMax: number;
  // Two compared articles are at most this far apart; a story spans at most maxSpanHours from first to last article.
  maxGapHours: number;
  maxSpanHours: number;
  // Stories whose first article is older than this are frozen (closed).
  activeWindowHours: number;
  // Two groups merge only when the mean `p_same` over their judged cross pairs is at least tauLink, at least
  // minJudged cross pairs are judged (or every pair, when fewer exist), and the share of cross pairs below dissentP
  // is at most maxDissent.
  tauLink: number;
  minJudged: number;
  dissentP: number;
  maxDissent: number;
  // Rounds of "judge the pairs the algorithm still needs, then consolidate again from scratch".
  densifyRounds: number;
  judgeConcurrency: number;
  adjudicator: { model: string; promptVersion: string };
};

export const DEFAULT_CONSOLIDATE_CONFIG: ConsolidateConfig = {
  tLow: 0.84,
  kMax: 25,
  maxGapHours: 36,
  maxSpanHours: 48,
  activeWindowHours: 72,
  tauLink: 0.8,
  minJudged: 3,
  dissentP: 0.5,
  maxDissent: 0.25,
  densifyRounds: 4,
  judgeConcurrency: 8,
  adjudicator: { model: "jev-1.14.0", promptVersion: ADJUDICATION_PROMPT_VERSION },
};

export function consolidatePipelineVersion(cfg: ConsolidateConfig): string {
  return createHash("sha256").update(JSON.stringify(cfg)).digest("hex").slice(0, 12);
}
