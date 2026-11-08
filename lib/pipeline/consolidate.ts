// The windowed consolidation (story-clustering-v2 TDD part 5): average-linkage clustering of a graph of judged
// article pairs, with guards. A pure function with no I/O, so production and the replay harness share it. The result
// depends only on the graph and the settings, never on the order the articles or pairs came in.
import type { ConsolidateConfig } from "./consolidate-config";

const HOUR = 3_600_000;
const EPS = 1e-12;

export type Node = {
  id: string;
  time: number; // clustering time, epoch ms
  // Set for an article of a frozen (closed) story, or an article the owner pinned to a story.
  frozenStory?: string;
  pinnedStory?: string;
};

// A judged pair. `w` is the classifier's p_same (1 for a human "same"); `cannot` marks a pair that must never be
// in one story (a human "related" or "different").
export type Edge = { a: string; b: string; w: number; cannot?: boolean };

export type ConsolidateGraph = { nodes: Node[]; edges: Edge[] };

// One merge: the two groups, the linkage that justified it, and the judged pairs it was computed from.
export type Merge = { a: string[]; b: string[]; L: number; n: number; dissent: number; pairs: [string, string][] };

export type Cluster = {
  members: string[];
  // The story id a frozen or pinned cluster must keep.
  identity: string | null;
  merges: Merge[];
};

export type ConsolidateResult = {
  clusters: Cluster[];
  // Pairs the algorithm would like judged (anchor against anchor of groups that are close to merging), ordered "a" < "b".
  needPairs: [string, string][];
  trace: Merge[];
};

type Group = {
  id: number;
  members: string[]; // sorted
  low: string; // lowest article id
  minT: number;
  maxT: number;
  identity: string | null;
  merges: Merge[];
  anchors?: string[];
};

type Linkage = { status: "eligible" | "need" | "blocked"; L: number; n: number; dissent: number };

const orderedKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function consolidate(graph: ConsolidateGraph, cfg: ConsolidateConfig): ConsolidateResult {
  const nodes = [...graph.nodes].sort((x, y) => x.id.localeCompare(y.id));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // One edge per pair. Duplicates (which should not occur) combine to the lower weight, and a cannot-link wins.
  const edgeByKey = new Map<string, Edge>();
  for (const e of graph.edges) {
    if (e.a === e.b || !nodeById.has(e.a) || !nodeById.has(e.b)) continue;
    const [a, b] = e.a < e.b ? [e.a, e.b] : [e.b, e.a];
    const key = `${a}|${b}`;
    const prev = edgeByKey.get(key);
    edgeByKey.set(key, prev ? { a, b, w: Math.min(prev.w, e.w), cannot: prev.cannot || e.cannot } : { a, b, w: e.w, cannot: !!e.cannot });
  }
  const edges = [...edgeByKey.values()];
  const nodeEdges = new Map<string, Edge[]>();
  for (const e of edges) {
    nodeEdges.set(e.a, [...(nodeEdges.get(e.a) ?? []), e]);
    nodeEdges.set(e.b, [...(nodeEdges.get(e.b) ?? []), e]);
  }

  // Initial groups: one per frozen story, one per set of pinned articles of a story, a singleton for the rest.
  let nextId = 0;
  const groups = new Map<number, Group>();
  const owner = new Map<string, number>();
  const byIdentity = new Map<string, Group>();
  const create = (members: string[], identity: string | null): Group => {
    const times = members.map((m) => nodeById.get(m)!.time);
    const sorted = [...members].sort();
    const g: Group = { id: nextId++, members: sorted, low: sorted[0], minT: Math.min(...times), maxT: Math.max(...times), identity, merges: [] };
    groups.set(g.id, g);
    for (const m of sorted) owner.set(m, g.id);
    return g;
  };
  const identityMembers = new Map<string, string[]>();
  for (const n of nodes) {
    const identity = n.frozenStory ? `f:${n.frozenStory}` : n.pinnedStory ? `p:${n.pinnedStory}` : null;
    if (identity) identityMembers.set(identity, [...(identityMembers.get(identity) ?? []), n.id]);
  }
  for (const n of nodes) {
    const identity = n.frozenStory ? `f:${n.frozenStory}` : n.pinnedStory ? `p:${n.pinnedStory}` : null;
    if (!identity) create([n.id], null);
    else if (!byIdentity.has(identity)) byIdentity.set(identity, create(identityMembers.get(identity)!, identity.slice(2)));
  }
  // frozen and pinned ids live in one namespace for conflict checks; keep the prefix to tell "S" frozen from "S" pinned.
  const identityOf = new Map<number, string>();
  for (const [key, g] of byIdentity) identityOf.set(g.id, key);

  // Cross-group edges between neighbouring groups.
  const adj = new Map<number, Map<number, Edge[]>>();
  for (const g of groups.values()) adj.set(g.id, new Map());
  for (const e of edges) {
    const ga = owner.get(e.a)!;
    const gb = owner.get(e.b)!;
    if (ga === gb) continue;
    for (const [x, y] of [[ga, gb], [gb, ga]] as const) adj.get(x)!.set(y, [...(adj.get(x)!.get(y) ?? []), e]);
  }

  // The two articles a group is compared through: its earliest, and its best-connected member (the one with the most
  // judged weight to the rest of the group; unjudged pairs count as zero).
  const anchorsOf = (g: Group): string[] => {
    if (g.anchors) return g.anchors;
    const earliest = [...g.members].sort((x, y) => nodeById.get(x)!.time - nodeById.get(y)!.time || x.localeCompare(y))[0];
    let best = earliest;
    if (g.members.length > 1) {
      let bestScore = -1;
      for (const m of g.members) {
        const score = (nodeEdges.get(m) ?? []).reduce((t, e) => {
          const other = e.a === m ? e.b : e.a;
          return owner.get(other) === g.id && !e.cannot ? t + e.w : t;
        }, 0) / (g.members.length - 1);
        if (score > bestScore + EPS) {
          best = m;
          bestScore = score;
        }
      }
    }
    g.anchors = [...new Set([earliest, best])].sort();
    return g.anchors;
  };

  const evaluate = (a: Group, b: Group, cross: Edge[]): Linkage => {
    const blocked: Linkage = { status: "blocked", L: 0, n: cross.length, dissent: 0 };
    if (cross.some((e) => e.cannot)) return blocked;
    const ia = identityOf.get(a.id) ?? null;
    const ib = identityOf.get(b.id) ?? null;
    if (ia && ib && ia !== ib) return blocked;
    if (Math.max(a.maxT, b.maxT) - Math.min(a.minT, b.minT) > cfg.maxSpanHours * HOUR + EPS) return blocked;
    const n = cross.length;
    const L = cross.reduce((t, e) => t + e.w, 0) / n;
    const dissent = cross.filter((e) => e.w < cfg.dissentP).length / n;
    if (L + EPS < cfg.tauLink || dissent > cfg.maxDissent + EPS) return { status: "blocked", L, n, dissent };
    const enough = n >= Math.min(cfg.minJudged, a.members.length * b.members.length);
    const touches = (g: Group) => {
      if (g.members.length < 2) return true;
      const anchors = new Set(anchorsOf(g));
      return cross.some((e) => anchors.has(e.a) || anchors.has(e.b));
    };
    return { status: enough && touches(a) && touches(b) ? "eligible" : "need", L, n, dissent };
  };

  const cache = new Map<string, Linkage>();
  const linkage = (a: Group, b: Group, cross: Edge[]) => {
    const key = `${a.id}|${b.id}`;
    let ev = cache.get(key);
    if (!ev) {
      ev = evaluate(a, b, cross);
      cache.set(key, ev);
    }
    return ev;
  };

  const trace: Merge[] = [];
  for (;;) {
    let best: { a: Group; b: Group; ev: Linkage; tie: [string, string] } | null = null;
    for (const [ida, nbrs] of adj) {
      for (const [idb, cross] of nbrs) {
        if (ida > idb) continue;
        const a = groups.get(ida)!;
        const b = groups.get(idb)!;
        const ev = linkage(a, b, cross);
        if (ev.status !== "eligible") continue;
        const tie: [string, string] = a.low < b.low ? [a.low, b.low] : [b.low, a.low];
        const better =
          !best ||
          ev.L > best.ev.L + EPS ||
          (Math.abs(ev.L - best.ev.L) <= EPS && (tie[0] < best.tie[0] || (tie[0] === best.tie[0] && tie[1] < best.tie[1])));
        if (better) best = { a, b, ev, tie };
      }
    }
    if (!best) break;

    const { a, b, ev } = best;
    const cross = adj.get(a.id)!.get(b.id)!;
    const merge: Merge = {
      a: a.members,
      b: b.members,
      L: ev.L,
      n: ev.n,
      dissent: ev.dissent,
      pairs: cross.map((e): [string, string] => [e.a, e.b]).sort((p, q) => p[0].localeCompare(q[0]) || p[1].localeCompare(q[1])),
    };
    trace.push(merge);

    const members = [...a.members, ...b.members].sort();
    const z: Group = {
      id: nextId++,
      members,
      low: members[0],
      minT: Math.min(a.minT, b.minT),
      maxT: Math.max(a.maxT, b.maxT),
      identity: a.identity ?? b.identity,
      merges: [...a.merges, ...b.merges, merge],
    };
    const key = identityOf.get(a.id) ?? identityOf.get(b.id);
    if (key) identityOf.set(z.id, key);
    groups.set(z.id, z);
    for (const m of members) owner.set(m, z.id);

    const zAdj = new Map<number, Edge[]>();
    for (const old of [a, b]) {
      for (const [w, es] of adj.get(old.id)!) {
        if (w === a.id || w === b.id) continue;
        zAdj.set(w, [...(zAdj.get(w) ?? []), ...es]);
      }
    }
    for (const old of [a, b]) {
      for (const w of adj.get(old.id)!.keys()) {
        if (w !== a.id && w !== b.id) adj.get(w)!.delete(old.id);
      }
      adj.delete(old.id);
      groups.delete(old.id);
    }
    for (const [w, es] of zAdj) adj.get(w)!.set(z.id, es);
    adj.set(z.id, zAdj);
  }

  // Pairs of groups that would merge if they had more judged pairs. First the anchors are compared with each other;
  // when that is not enough to reach the required number of judged pairs, an anchor is compared with other members.
  const needed = new Set<string>();
  for (const [ida, nbrs] of adj) {
    for (const [idb, cross] of nbrs) {
      if (ida > idb) continue;
      const a = groups.get(ida)!;
      const b = groups.get(idb)!;
      const ev = linkage(a, b, cross);
      if (ev.status !== "need") continue;
      const open = (x: string, y: string) =>
        !edgeByKey.has(orderedKey(x, y)) &&
        Math.abs(nodeById.get(x)!.time - nodeById.get(y)!.time) <= cfg.maxGapHours * HOUR + EPS;
      const anchorsA = anchorsOf(a);
      const anchorsB = anchorsOf(b);
      const primary = anchorsA.flatMap((x) => anchorsB.filter((y) => open(x, y)).map((y) => orderedKey(x, y))).sort();
      for (const key of primary) needed.add(key);
      const deficit = Math.min(cfg.minJudged, a.members.length * b.members.length) - ev.n - primary.length;
      if (deficit > 0) {
        const secondary = [
          ...anchorsA.flatMap((x) => b.members.filter((y) => open(x, y)).map((y) => orderedKey(x, y))),
          ...a.members.flatMap((x) => anchorsB.filter((y) => open(x, y)).map((y) => orderedKey(x, y))),
        ];
        for (const key of [...new Set(secondary)].filter((k) => !primary.includes(k)).sort().slice(0, deficit)) needed.add(key);
      }
    }
  }

  return {
    clusters: [...groups.values()]
      .sort((x, y) => x.low.localeCompare(y.low))
      .map((g) => ({ members: g.members, identity: g.identity, merges: g.merges })),
    needPairs: [...needed].sort().map((k): [string, string] => k.split("|") as [string, string]),
    trace,
  };
}
