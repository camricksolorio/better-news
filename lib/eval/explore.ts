// Server-side engine for the admin clustering explorer: loads the frozen snapshot once,
// precomputes similarities, and replays it at whatever thresholds the UI asks for. No API calls.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { cleanText } from "@/lib/text";
import { DEFAULT_CLUSTER_CONFIG, cosine, type ClusterConfig } from "@/lib/pipeline/assign";
import { replay, type Decision, type ReplayResult, type SnapshotArticle } from "./replay";
import { MAX_CACHED_WINDOW_HOURS, buildSimCache, type SimCache } from "./sim-cache";

export type ExploreParams = {
  tLow: number;
  tHigh: number;
  windowHours: number;
  gray: "new" | "join";
};

export type ArticleView = {
  guid: string;
  title: string;
  source: string;
  time: string;
  snippet: string;
  thin: boolean;
  method: Decision["method"];
  topScore: number | null;
  centroidScore: number | null;
  gray: boolean;
};

export type StoryView = {
  id: string;
  size: number;
  sourceCount: number;
  firstAt: string;
  lastAt: string;
  // Lowest member-to-centroid similarity: a low value flags a story that may hold different events.
  minCentroidSim: number;
  members: ArticleView[];
};

export type ExploreSummary = {
  articles: number;
  stories: number;
  singletons: number;
  multi: number;
  largest: number;
  avgMultiSize: number;
  grayCount: number;
  grayShare: number;
  thinGray: number;
  noCandidate: number;
  histogram: { from: number; count: number }[];
  snapshot: string;
};

type Loaded = { file: string; cache: SimCache; byGuid: Map<string, SnapshotArticle>; loadedMs: number };

let loaded: Promise<Loaded> | null = null;

export function loadExplorer(): Promise<Loaded> {
  loaded ??= (async () => {
    const started = Date.now();
    const dir = path.join(process.cwd(), "eval");
    const files = (() => {
      try {
        return readdirSync(dir).filter((f) => /^snapshot-.*\.jsonl$/.test(f)).sort();
      } catch {
        return [];
      }
    })();
    if (files.length === 0) throw new Error("No snapshot found. Run `pnpm eval:snapshot` first.");
    const file = files[files.length - 1];
    const snapshot: SnapshotArticle[] = readFileSync(path.join(dir, file), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const cache = buildSimCache(snapshot);
    return { file, cache, byGuid: new Map(snapshot.map((a) => [a.guid, a])), loadedMs: Date.now() - started };
  })().catch((e) => {
    loaded = null; // let the next request retry (for example after the snapshot is created)
    throw e;
  });
  return loaded;
}

export type ExploreResult = {
  params: ExploreParams;
  replay: ReplayResult;
  stories: StoryView[]; // multi-article stories only
  summary: ExploreSummary;
  article: (guid: string) => ArticleView;
  titleOf: (guid: string) => string;
  storyOf: (guid: string) => StoryView | null;
  candidateStory: (guid: string) => StoryView | null;
};

const results = new Map<string, Promise<ExploreResult>>();

export function clampParams(p: Partial<ExploreParams>): ExploreParams {
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const tHigh = Math.min(1, Math.max(0, num(p.tHigh, DEFAULT_CLUSTER_CONFIG.tHigh)));
  const tLow = Math.min(tHigh, Math.max(0, num(p.tLow, DEFAULT_CLUSTER_CONFIG.tLow)));
  const windowHours = Math.min(MAX_CACHED_WINDOW_HOURS, Math.max(1, num(p.windowHours, DEFAULT_CLUSTER_CONFIG.windowHours)));
  return { tLow, tHigh, windowHours, gray: p.gray === "join" ? "join" : "new" };
}

export function runExplore(raw: Partial<ExploreParams>): Promise<ExploreResult> {
  const params = clampParams(raw);
  const key = JSON.stringify(params);
  let hit = results.get(key);
  if (!hit) {
    hit = compute(params);
    results.set(key, hit);
    hit.catch(() => results.delete(key));
    // Keep a handful of recent configs so flipping between thresholds is instant.
    while (results.size > 8) results.delete(results.keys().next().value as string);
  }
  return hit;
}

const round = (x: number | null, d = 3) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

async function compute(params: ExploreParams): Promise<ExploreResult> {
  const { cache, byGuid, file } = await loadExplorer();
  const cfg: ClusterConfig = { ...DEFAULT_CLUSTER_CONFIG, ...params };
  const rep = await replay(cache.sorted, [], cfg, { gray: params.gray, memberSim: cache.memberSim });

  const article = (guid: string): ArticleView => {
    const a = byGuid.get(guid)!;
    const d = rep.decisions.get(guid)!;
    return {
      guid,
      title: cleanText(a.title),
      source: a.sourceId,
      time: a.time,
      snippet: cleanText(a.summary).slice(0, 220),
      thin: a.thin,
      method: d.method,
      topScore: round(d.topScore),
      centroidScore: round(d.centroidScore),
      gray: d.gray,
    };
  };

  const membersByStory = new Map<string, string[]>();
  for (const a of cache.sorted) {
    const d = rep.decisions.get(a.guid)!;
    membersByStory.set(d.storyId, [...(membersByStory.get(d.storyId) ?? []), a.guid]);
  }

  const storyView = (id: string): StoryView => {
    const state = rep.storyStates.find((s) => s.id === id)!;
    const guids = membersByStory.get(id) ?? [];
    return {
      id,
      size: guids.length,
      sourceCount: state.sourceCount,
      firstAt: state.firstAt.toISOString(),
      lastAt: state.lastAt.toISOString(),
      minCentroidSim: round(Math.min(...guids.map((g) => cosine(byGuid.get(g)!.embedding, state.centroid))))!,
      members: guids.map(article),
    };
  };

  const multiIds = [...membersByStory].filter(([, g]) => g.length >= 2).map(([id]) => id);
  const stories = multiIds.map(storyView);
  const storyCache = new Map(stories.map((s) => [s.id, s]));
  const lookup = (id: string | undefined) => (id ? (storyCache.get(id) ?? storyView(id)) : null);

  // Distribution of best-candidate scores (the min of max-member and centroid similarity).
  const bins = new Map<number, number>();
  let noCandidate = 0;
  let thinGray = 0;
  for (const [guid, d] of rep.decisions) {
    if (d.gray && byGuid.get(guid)!.thin) thinGray++;
    if (d.topScore === null || d.centroidScore === null) {
      noCandidate++;
      continue;
    }
    const score = Math.min(d.topScore, d.centroidScore);
    const from = Math.max(0.5, Math.floor(score * 50) / 50);
    bins.set(from, (bins.get(from) ?? 0) + 1);
  }
  const histogram: { from: number; count: number }[] = [];
  for (let f = 0.5; f < 1.0 - 1e-9; f += 0.02) {
    const key = Math.round(f * 100) / 100;
    histogram.push({ from: key, count: bins.get(key) ?? [...bins].find(([k]) => Math.abs(k - key) < 1e-9)?.[1] ?? 0 });
  }

  const summary: ExploreSummary = {
    articles: rep.articles,
    stories: rep.stories,
    singletons: rep.stories - multiIds.length,
    multi: multiIds.length,
    largest: Math.max(0, ...stories.map((s) => s.size)),
    avgMultiSize: multiIds.length ? Math.round((stories.reduce((n, s) => n + s.size, 0) / multiIds.length) * 10) / 10 : 0,
    grayCount: rep.grayCount,
    grayShare: Math.round(rep.grayShare * 1000) / 1000,
    thinGray,
    noCandidate,
    histogram,
    snapshot: file,
  };

  return {
    params,
    replay: rep,
    stories,
    summary,
    article,
    titleOf: (guid) => byGuid.get(guid)!.title,
    storyOf: (guid) => lookup(rep.decisions.get(guid)?.storyId),
    candidateStory: (guid) => lookup(rep.decisions.get(guid)?.candidateStoryId),
  };
}

export type ViewParams = {
  view: "stories" | "gray" | "search";
  sort: "size" | "suspicious" | "sources" | "recent";
  q: string;
  page: number;
  minSize: number;
};

export const PAGE_SIZE = 20;

export type GrayItem = { article: ArticleView; candidate: StoryView | null };
export type SearchItem = { article: ArticleView; story: StoryView | null };

export type ViewPayload =
  | { view: "stories"; total: number; items: StoryView[] }
  | { view: "gray"; total: number; items: GrayItem[] }
  | { view: "search"; total: number; items: SearchItem[] };

export function buildView(result: ExploreResult, v: ViewParams): ViewPayload {
  const start = (v.page - 1) * PAGE_SIZE;
  if (v.view === "stories") {
    const filtered = result.stories.filter((s) => s.size >= v.minSize);
    const sorters: Record<ViewParams["sort"], (a: StoryView, b: StoryView) => number> = {
      size: (a, b) => b.size - a.size,
      suspicious: (a, b) => a.minCentroidSim - b.minCentroidSim,
      sources: (a, b) => b.sourceCount - a.sourceCount || b.size - a.size,
      recent: (a, b) => b.lastAt.localeCompare(a.lastAt),
    };
    const sorted = [...filtered].sort(sorters[v.sort]);
    return { view: "stories", total: sorted.length, items: sorted.slice(start, start + PAGE_SIZE) };
  }
  if (v.view === "gray") {
    const guids = [...result.replay.decisions]
      .filter(([, d]) => d.gray)
      .sort(([, a], [, b]) => Math.min(b.topScore ?? 0, b.centroidScore ?? 0) - Math.min(a.topScore ?? 0, a.centroidScore ?? 0))
      .map(([g]) => g);
    return {
      view: "gray",
      total: guids.length,
      items: guids.slice(start, start + PAGE_SIZE).map((g) => ({ article: result.article(g), candidate: result.candidateStory(g) })),
    };
  }
  const q = v.q.trim().toLowerCase();
  const guids = q
    ? [...result.replay.decisions.keys()].filter((g) => result.titleOf(g).toLowerCase().includes(q))
    : [];
  return {
    view: "search",
    total: guids.length,
    items: guids.slice(start, start + PAGE_SIZE).map((g) => ({ article: result.article(g), story: result.storyOf(g) })),
  };
}
