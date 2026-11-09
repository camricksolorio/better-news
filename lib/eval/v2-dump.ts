// Turns one v2 replay into a plain JSON document the admin page can show (story-clustering-v2 Phase 3): the stories v2
// built, and for every labelled event where its same-event pairs ended up. Pure: no database, no classifier calls.
import { cleanText } from "@/lib/text";
import { cosine } from "@/lib/pipeline/assign";
import { pairKey, type StoredVerdict } from "@/lib/pipeline/judge";
import type { EvalEvent, EventLabel } from "./events";
import type { SnapshotArticle } from "./replay";

export type DumpMember = {
  guid: string;
  title: string;
  source: string;
  time: string;
  snippet: string;
  // The owner's label for this article in one labelled event, when it has one.
  event: { id: string; title: string; label: EventLabel } | null;
  // Mean p_same to the other members it was judged against; null when it has no judged pair in the story.
  avgLink: number | null;
  judgedLinks: number;
};

export type DumpStory = {
  id: string;
  size: number;
  sourceCount: number;
  firstAt: string;
  lastAt: string;
  // Weakest and mean judged link inside the story; a low minimum flags a story that may hold two events.
  minLink: number | null;
  meanLink: number | null;
  judgedPairs: number;
  possiblePairs: number;
  members: DumpMember[];
};

// Why a same-event (in x in) pair is not in the same story.
export type PairStatus =
  | "merged" // same story
  | "not_retrieved" // never a candidate pair, and never judged
  | "unjudged" // retrieved but no verdict (the call failed or was not asked for)
  | "judged_low" // judged, p_same below tau_link
  | "judged_high"; // judged at or above tau_link but the stories did not merge (a guard, or an average that fell short)

export type DumpPair = { a: string; b: string; cosine: number; pSame: number | null; status: PairStatus };

export type DumpEvent = {
  id: string;
  title: string;
  split: "dev" | "holdout";
  humanLabeled: boolean;
  inArticles: number;
  recall: number | null;
  // Stories holding this event's in articles, biggest share first.
  stories: { id: string; inCount: number; size: number }[];
  counts: Record<PairStatus, number>;
  // The pairs that are not merged, so the page can show them (merged pairs are only counted).
  unmerged: DumpPair[];
  members: { guid: string; title: string; source: string; time: string; label: EventLabel; storyId: string | null; storySize: number }[];
};

export type V2Dump = {
  generatedAt: string;
  snapshot: string;
  config: Record<string, number | string>;
  articles: number;
  stories: number; // all stories, singletons included
  singletons: number;
  verdicts: number;
  candidatePairs: number;
  tauLink: number;
  multi: DumpStory[]; // stories with two or more articles, biggest first
  events: DumpEvent[];
};

const round = (x: number | null, d = 3) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

export type DumpInput = {
  snapshot: SnapshotArticle[]; // the articles the replay saw
  snapshotName: string;
  clusterOf: Map<string, string>;
  candidates: Set<string>; // "a|b", ordered
  verdicts: Map<string, StoredVerdict>; // by pair key
  events: EvalEvent[];
  tauLink: number;
  config: Record<string, number | string>;
  now?: Date;
};

export function buildDump(input: DumpInput): V2Dump {
  const { snapshot, clusterOf, candidates, verdicts, events, tauLink } = input;
  const byGuid = new Map(snapshot.map((a) => [a.guid, a]));

  // Article -> its label in a labelled event (an article in two events shows the first; events do not overlap often).
  const eventOf = new Map<string, DumpMember["event"]>();
  for (const e of events) {
    if (!e.humanLabeled) continue;
    for (const [guid, label] of e.labels) if (!eventOf.has(guid)) eventOf.set(guid, { id: e.id, title: e.title, label });
  }

  const membersOf = new Map<string, string[]>();
  for (const [guid, story] of clusterOf) membersOf.set(story, [...(membersOf.get(story) ?? []), guid]);

  const pSame = (a: string, b: string): number | null => {
    const v = verdicts.get(pairKey(a, b));
    return v ? (v.relation === "invalid" ? 0 : v.pSame) : null;
  };

  const multi: DumpStory[] = [];
  for (const [id, guids] of membersOf) {
    if (guids.length < 2) continue;
    const sorted = [...guids].sort((x, y) => byGuid.get(x)!.time.localeCompare(byGuid.get(y)!.time) || x.localeCompare(y));
    const sums = new Map<string, { sum: number; n: number }>();
    const links: number[] = [];
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const p = pSame(sorted[i], sorted[j]);
        if (p === null) continue;
        links.push(p);
        for (const g of [sorted[i], sorted[j]]) {
          const s = sums.get(g) ?? { sum: 0, n: 0 };
          sums.set(g, { sum: s.sum + p, n: s.n + 1 });
        }
      }
    }
    const members: DumpMember[] = sorted.map((g) => {
      const a = byGuid.get(g)!;
      const s = sums.get(g);
      return {
        guid: g,
        title: cleanText(a.title),
        source: a.sourceId,
        time: a.time,
        snippet: cleanText(a.summary).slice(0, 220),
        event: eventOf.get(g) ?? null,
        avgLink: s ? round(s.sum / s.n) : null,
        judgedLinks: s?.n ?? 0,
      };
    });
    multi.push({
      id,
      size: sorted.length,
      sourceCount: new Set(sorted.map((g) => byGuid.get(g)!.sourceId)).size,
      firstAt: members[0].time,
      lastAt: members[members.length - 1].time,
      minLink: links.length ? round(Math.min(...links)) : null,
      meanLink: links.length ? round(links.reduce((x, y) => x + y, 0) / links.length) : null,
      judgedPairs: links.length,
      possiblePairs: (sorted.length * (sorted.length - 1)) / 2,
      members,
    });
  }
  multi.sort((x, y) => y.size - x.size || x.id.localeCompare(y.id));

  const dumpEvents: DumpEvent[] = events.map((e) => {
    const inGuids = [...e.labels].filter(([g, l]) => l === "in" && clusterOf.has(g) && byGuid.has(g)).map(([g]) => g);
    const counts: Record<PairStatus, number> = { merged: 0, not_retrieved: 0, unjudged: 0, judged_low: 0, judged_high: 0 };
    const unmerged: DumpPair[] = [];
    for (let i = 0; i < inGuids.length; i++) {
      for (let j = i + 1; j < inGuids.length; j++) {
        const [a, b] = inGuids[i] < inGuids[j] ? [inGuids[i], inGuids[j]] : [inGuids[j], inGuids[i]];
        const p = pSame(a, b);
        let status: PairStatus;
        if (clusterOf.get(a) === clusterOf.get(b)) status = "merged";
        else if (p !== null) status = p >= tauLink ? "judged_high" : "judged_low";
        else status = candidates.has(pairKey(a, b)) ? "unjudged" : "not_retrieved";
        counts[status]++;
        if (status !== "merged") unmerged.push({ a, b, cosine: round(cosine(byGuid.get(a)!.embedding, byGuid.get(b)!.embedding))!, pSame: round(p), status });
      }
    }
    const byStory = new Map<string, number>();
    for (const g of inGuids) byStory.set(clusterOf.get(g)!, (byStory.get(clusterOf.get(g)!) ?? 0) + 1);
    const stories = [...byStory]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([id, inCount]) => ({ id, inCount, size: membersOf.get(id)!.length }));
    const members = [...e.labels]
      .filter(([g]) => byGuid.has(g))
      .map(([g, label]) => {
        const a = byGuid.get(g)!;
        const storyId = clusterOf.get(g) ?? null;
        return { guid: g, title: cleanText(a.title), source: a.sourceId, time: a.time, label, storyId, storySize: storyId ? membersOf.get(storyId)!.length : 0 };
      })
      .sort((x, y) => x.label.localeCompare(y.label) || x.time.localeCompare(y.time));
    return {
      id: e.id,
      title: e.title,
      split: e.split,
      humanLabeled: e.humanLabeled,
      inArticles: inGuids.length,
      recall: stories.length ? round(stories[0].inCount / inGuids.length) : null,
      stories,
      counts,
      unmerged: unmerged.sort((x, y) => y.cosine - x.cosine),
      members,
    };
  });

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    snapshot: input.snapshotName,
    config: input.config,
    articles: snapshot.length,
    stories: membersOf.size,
    singletons: [...membersOf.values()].filter((m) => m.length === 1).length,
    verdicts: verdicts.size,
    candidatePairs: candidates.size,
    tauLink,
    multi,
    events: dumpEvents,
  };
}
