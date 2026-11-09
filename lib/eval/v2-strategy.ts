// v2's windowed consolidation as a harness strategy (story-clustering-v2 TDD parts 3-6): each tick it retrieves
// candidate pairs for the new articles, judges the pairs it needs, rebuilds the stories of the active window from the
// whole graph of verdicts, and reconciles them with the stories that already exist. Production runs the same cores
// against the database; this version keeps everything in memory.
import { consolidate, type Edge, type Node } from "@/lib/pipeline/consolidate";
import { consolidatePipelineVersion, type ConsolidateConfig } from "@/lib/pipeline/consolidate-config";
import { judgePairs, pairKey, weightOf, type StoredVerdict, type VerdictStore, createMemoryVerdictStore, type HumanLabel } from "@/lib/pipeline/judge";
import { reconcile } from "@/lib/pipeline/reconcile";
import { createMemoryIndex } from "@/lib/pipeline/retrieve";
import type { SnapshotArticle } from "./replay";
import { TICK_MS, type Strategy } from "./ticks";

const HOUR = 3_600_000;

export type V2Options = {
  cfg: ConsolidateConfig;
  // Judges two articles. Shared verdicts (`store`) mean a pair is only ever judged once, across ticks and orders.
  judge: (a: SnapshotArticle, b: SnapshotArticle) => Promise<StoredVerdict>;
  store?: VerdictStore;
  // Human labels by pair key. The evaluation never passes the labels it scores against.
  overrides?: Map<string, HumanLabel>;
  abortOn?: (e: unknown) => boolean;
  onFailure?: (a: string, b: string) => void;
};

type StoryRow = { id: string; createdAt: number; status: "open" | "closed"; members: Set<string> };

export function createV2Strategy(opts: V2Options): Strategy & { pipelineVersion: string; stats: { densifyPairs: number; rounds: number } } {
  const { cfg } = opts;
  const stats = { densifyPairs: 0, rounds: 0 };
  // A pinned model ("jev-1.14.0") must come back as itself; an alias ("jev-latest") resolves to whatever it is today.
  const expectedModel = /^jev-\d/.test(cfg.adjudicator.model) ? cfg.adjudicator.model : undefined;

  return {
    name: "v2",
    pipelineVersion: consolidatePipelineVersion(cfg),
    stats,
    start() {
      const store = opts.store ?? createMemoryVerdictStore();
      const index = createMemoryIndex();
      const articles = new Map<string, SnapshotArticle>();
      const timeOf = (g: string) => new Date(articles.get(g)!.time).getTime();
      const storyOf = new Map<string, string>(); // article -> story id
      const stories = new Map<string, StoryRow>();
      const candidates = new Set<string>(); // "a|b" retrieved
      const partners = new Map<string, Set<string>>(); // article -> articles it is a candidate pair with
      const densified = new Set<string>(); // pairs judged because the algorithm asked, not retrieval
      let nextStory = 1;

      const link = (a: string, b: string) => {
        partners.set(a, (partners.get(a) ?? new Set()).add(b));
        partners.set(b, (partners.get(b) ?? new Set()).add(a));
      };

      const judgeOf = (a: string, b: string) => opts.judge(articles.get(a)!, articles.get(b)!);
      const run = (pairs: [string, string][]) =>
        judgePairs({
          pairs,
          store,
          judge: judgeOf,
          cfg,
          overrides: opts.overrides,
          expectedModel,
          abortOn: opts.abortOn,
        }).then((r) => {
          for (const [a, b] of r.failed) opts.onFailure?.(a, b);
          if (r.mismatched.length > 0) {
            throw new Error(`the classifier returned ${r.mismatched[0].model} but ${cfg.adjudicator.model} is pinned; ${r.mismatched.length} verdicts differ`);
          }
          return r;
        });

      return {
        async processTick(batch: SnapshotArticle[], tick: number) {
          const now = tick * TICK_MS;
          // Freeze: stories whose first article is older than the active window are closed.
          for (const s of stories.values()) {
            if (s.status === "open" && Math.min(...[...s.members].map(timeOf)) < now - cfg.activeWindowHours * HOUR) s.status = "closed";
          }

          for (const a of batch) {
            articles.set(a.guid, a);
            index.add({ id: a.guid, time: new Date(a.time).getTime(), embedding: a.embedding });
          }
          for (const a of batch) {
            for (const nb of index.neighbours({ id: a.guid, time: new Date(a.time).getTime(), embedding: a.embedding }, cfg)) {
              candidates.add(pairKey(a.guid, nb.id));
              link(a.guid, nb.id);
            }
          }

          // Scope: the active window plus every never-placed article, and the closed stories those articles touch.
          const closedOf = (g: string) => {
            const s = stories.get(storyOf.get(g) ?? "");
            return s?.status === "closed" ? s : undefined;
          };
          const active = new Set<string>();
          for (const g of articles.keys()) {
            if (closedOf(g)) continue;
            if (!storyOf.has(g) || timeOf(g) >= now - cfg.activeWindowHours * HOUR) active.add(g);
          }
          const frozen = new Map<string, string>(); // article -> closed story id
          for (const g of active) {
            for (const p of partners.get(g) ?? []) {
              const s = closedOf(p);
              if (s) for (const m of s.members) frozen.set(m, s.id);
            }
          }
          const inScope = (g: string) => active.has(g) || frozen.has(g);

          const retrieved = [...candidates]
            .map((k) => k.split("|") as [string, string])
            .filter(([a, b]) => inScope(a) && inScope(b) && !(frozen.has(a) && frozen.has(b)));
          await run(retrieved);

          const graph = () => {
            const nodes: Node[] = [...active, ...frozen.keys()].map((g) => ({ id: g, time: timeOf(g), frozenStory: frozen.get(g) }));
            const edges: Edge[] = [];
            for (const key of new Set([...retrieved.map(([a, b]) => pairKey(a, b)), ...densified])) {
              const [a, b] = key.split("|");
              if (!inScope(a) || !inScope(b)) continue;
              const verdict = store.get(a, b);
              const human = opts.overrides?.get(key);
              if (!verdict && !human) continue;
              edges.push({ a, b, ...weightOf(verdict, human) });
            }
            return { nodes, edges };
          };

          let result = consolidate(graph(), cfg);
          for (let round = 0; round < cfg.densifyRounds; round++) {
            const todo = result.needPairs.filter(([a, b]) => inScope(a) && inScope(b) && !store.get(a, b) && !opts.overrides?.has(pairKey(a, b)));
            if (todo.length === 0) break;
            const judged = await run(todo);
            if (judged.judged === 0) break;
            for (const [a, b] of todo) if (store.get(a, b)) densified.add(pairKey(a, b));
            stats.densifyPairs += judged.judged;
            stats.rounds++;
            result = consolidate(graph(), cfg);
          }

          // Reconcile with the stories that exist, then apply.
          const scope = [...active, ...frozen.keys()];
          const current = new Map(scope.map((g) => [g, { storyId: storyOf.get(g) ?? null, placed: storyOf.has(g) }]));
          const changes = reconcile(result.clusters, current, new Map([...stories].map(([id, s]) => [id, { createdAt: s.createdAt }])));

          const created = new Map<string, string>();
          for (const ns of changes.newStories) {
            const id = `S${nextStory++}`;
            created.set(ns.key, id);
            stories.set(id, { id, createdAt: now, status: "open", members: new Set() });
          }
          const resolve = (to: string) => created.get(to) ?? to;
          for (const m of changes.moves) {
            if (m.from) stories.get(m.from)?.members.delete(m.articleId);
            storyOf.set(m.articleId, resolve(m.to));
            stories.get(resolve(m.to))!.members.add(m.articleId);
          }
          for (const r of changes.retired) stories.delete(r.storyId);
        },
        clusterOf: () => new Map(storyOf),
        candidatePairs: () => new Set(candidates),
      };
    },
  };
}
