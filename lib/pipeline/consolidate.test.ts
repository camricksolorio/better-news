import { describe, expect, it } from "vitest";
import { DEFAULT_CONSOLIDATE_CONFIG as DEFAULT } from "./consolidate-config";
import { consolidate, type ConsolidateGraph, type Edge, type Node } from "./consolidate";

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 0, 0);
const node = (id: string, hours = 0, over: Partial<Node> = {}): Node => ({ id, time: T0 + hours * H, ...over });
const edge = (a: string, b: string, w: number, cannot = false): Edge => ({ a, b, w, cannot });
const cfg = { ...DEFAULT };

// A clique of strong edges between the given ids.
const clique = (ids: string[], w = 0.95): Edge[] => ids.flatMap((a, i) => ids.slice(i + 1).map((b) => edge(a, b, w)));
const groups = (g: ConsolidateGraph, c = cfg) =>
  consolidate(g, c).clusters.map((x) => x.members).sort((p, q) => p[0].localeCompare(q[0]));

describe("consolidate: basic linkage", () => {
  it("merges two articles judged the same, and leaves them apart below tauLink", () => {
    expect(groups({ nodes: [node("a"), node("b")], edges: [edge("a", "b", 0.9)] })).toEqual([["a", "b"]]);
    expect(groups({ nodes: [node("a"), node("b")], edges: [edge("a", "b", 0.7)] })).toEqual([["a"], ["b"]]);
  });

  it("leaves articles with no judged pair as singletons", () => {
    expect(groups({ nodes: [node("a"), node("b"), node("c")], edges: [edge("a", "b", 0.9)] })).toEqual([["a", "b"], ["c"]]);
  });

  it("does not chain: a-b and b-c are strong but a-c is judged different", () => {
    const g = { nodes: [node("a"), node("b"), node("c")], edges: [edge("a", "b", 0.95), edge("b", "c", 0.95), edge("a", "c", 0.1)] };
    expect(groups(g)).toEqual([["a", "b"], ["c"]]);
  });

  it("merges clusters by the average over all their judged cross pairs", () => {
    // Two triples with 9 strong cross pairs.
    const left = ["a1", "a2", "a3"];
    const right = ["b1", "b2", "b3"];
    const cross = left.flatMap((a) => right.map((b) => edge(a, b, 0.9)));
    const g = { nodes: [...left, ...right].map((id) => node(id)), edges: [...clique(left), ...clique(right), ...cross] };
    expect(groups(g)).toEqual([[...left, ...right]]);
  });
});

describe("consolidate: the PRD cases", () => {
  it("R4 (Alaska): a wrong article does not block a correct one from joining the main story", () => {
    const main = ["m1", "m2", "m3", "m4"];
    const nodes = [...main, "wrong-live-blog", "correct-guardian"].map((id) => node(id));
    const edges = [
      ...clique(main),
      ...main.map((m) => edge("wrong-live-blog", m, 0.1)),
      edge("wrong-live-blog", "correct-guardian", 0.05),
      edge("correct-guardian", "m1", 0.9),
      edge("correct-guardian", "m2", 0.88),
      edge("correct-guardian", "m3", 0.92),
    ];
    expect(groups({ nodes, edges })).toEqual([[...main, "correct-guardian"].sort(), ["wrong-live-blog"]]);
  });

  it("R5 (Starlink): reaction pieces judged related stay out of the main story, and together", () => {
    const main = ["wsj1", "wsj2", "dw", "ars"];
    const nodes = [...main, "react1", "react2"].map((id) => node(id));
    const edges = [
      ...clique(main),
      ...["react1", "react2"].flatMap((r) => main.map((m) => edge(r, m, 0.15))),
      edge("react1", "react2", 0.9),
    ];
    expect(groups({ nodes, edges })).toEqual([main.slice().sort(), ["react1", "react2"]]);
  });
});

describe("consolidate: guards", () => {
  it("never merges across a cannot-link, even when the pair is otherwise strong", () => {
    const g = { nodes: [node("a"), node("b")], edges: [edge("a", "b", 0.99, true)] };
    expect(groups(g)).toEqual([["a"], ["b"]]);
  });

  it("keeps a cannot-linked article out of a cluster even when other pairs are strong", () => {
    const g = { nodes: [node("a"), node("b"), node("c")], edges: [edge("a", "b", 0.95), edge("b", "c", 0.95), edge("a", "c", 0.95, true)] };
    expect(groups(g)).toEqual([["a", "b"], ["c"]]);
  });

  it("caps a story's span: chaining across 60h is refused at 48h", () => {
    const g = { nodes: [node("a", 0), node("b", 30), node("c", 60)], edges: [edge("a", "b", 0.9), edge("b", "c", 0.9), edge("a", "c", 0.9)] };
    expect(groups(g)).toEqual([["a", "b"], ["c"]]);
    expect(groups(g, { ...cfg, maxSpanHours: 72 })).toEqual([["a", "b", "c"]]);
  });

  it("blocks a merge when too large a share of cross pairs dissent, even if the mean is high enough", () => {
    const left = ["a1", "a2", "a3"];
    const right = ["b1", "b2", "b3"];
    const cross = [
      edge("a1", "b1", 0.99), edge("a1", "b2", 0.99), edge("a2", "b1", 0.99), edge("a2", "b3", 0.99), edge("a3", "b2", 0.99),
      edge("a3", "b3", 0.49), edge("a2", "b2", 0.49), edge("a1", "b3", 0.49),
    ];
    // The cliques at 1.0 form first; the cross pairs then average (5 * 0.99 + 3 * 0.49) / 8 = 0.80 with 3 of 8 below 0.5.
    const g = { nodes: [...left, ...right].map((id) => node(id)), edges: [...clique(left, 1), ...clique(right, 1), ...cross] };
    expect(groups(g)).toEqual([left, right]);
    expect(groups(g, { ...cfg, maxDissent: 0.4 })).toEqual([[...left, ...right]]);
  });

  it("breaks ties by article id, so the result does not depend on input order", () => {
    // a-b and b-c tie at 0.95; a-c is cannot-linked, so only one of the two merges: the one with the lowest ids.
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [edge("a", "b", 0.95), edge("b", "c", 0.95), edge("a", "c", 0.5, true)];
    const expected = [["a", "b"], ["c"]];
    expect(groups({ nodes, edges })).toEqual(expected);
    expect(groups({ nodes: [...nodes].reverse(), edges: [...edges].reverse() })).toEqual(expected);
  });
});

describe("consolidate: judged-pair requirements and densification", () => {
  const left = ["a1", "a2", "a3"]; // a1 is earliest
  const right = ["b1", "b2", "b3"];
  const nodes = [...left.map((id, i) => node(id, i)), ...right.map((id, i) => node(id, i + 3))];
  const inner = [...clique(left), ...clique(right)];

  it("does not merge two groups on one strong pair, and asks for the anchor pairs it still needs", () => {
    const result = consolidate({ nodes, edges: [...inner, edge("a1", "b1", 0.95)] }, cfg);
    expect(result.clusters.map((c) => c.members)).toEqual([left, right]);
    expect(result.needPairs.length).toBeGreaterThan(0);
    // Needed pairs are cross pairs between the groups, ordered, and not ones already judged.
    for (const [x, y] of result.needPairs) {
      expect(x < y).toBe(true);
      expect(`${x}|${y}`).not.toBe("a1|b1");
      expect(left.includes(x) !== left.includes(y)).toBe(true);
    }
  });

  it("merges once enough cross pairs are judged and they touch both groups' anchors", () => {
    const cross = [edge("a1", "b1", 0.9), edge("a1", "b2", 0.9), edge("a2", "b1", 0.9)];
    expect(consolidate({ nodes, edges: [...inner, ...cross] }, cfg).clusters.map((c) => c.members)).toEqual([[...left, ...right]]);
  });

  it("refuses when the judged cross pairs miss an anchor of a larger group", () => {
    // Three strong cross pairs, but all between non-anchor members (a2/a3 and b2/b3): the earliest articles (a1, b1),
    // which are also the best-connected, are never compared with the other group.
    const cross = [edge("a2", "b2", 0.9), edge("a3", "b3", 0.9), edge("a2", "b3", 0.9)];
    const result = consolidate({ nodes, edges: [...clique(left, 0.9), ...clique(right, 0.9), ...cross] }, cfg);
    expect(result.clusters.map((c) => c.members)).toEqual([left, right]);
    expect(result.needPairs.some(([x, y]) => [x, y].includes("a1") && [x, y].includes("b1"))).toBe(true);
  });

  it("asks for nothing between groups whose judged pairs are too weak to merge anyway", () => {
    const result = consolidate({ nodes, edges: [...inner, edge("a1", "b1", 0.3)] }, cfg);
    expect(result.needPairs).toEqual([]);
  });

  it("does not ask for pairs more than maxGapHours apart", () => {
    const far = [node("a1", 0), node("a2", 1), node("a3", 2), node("b1", 40), node("b2", 41), node("b3", 42)];
    const result = consolidate({ nodes: far, edges: [...inner, edge("a3", "b1", 0.95)] }, { ...cfg, maxSpanHours: 96, maxGapHours: 36 });
    // a1, a2, a3 are 38-40h from b1, b2, b3's anchors; only pairs within 36h can be asked for.
    for (const [x, y] of result.needPairs) {
      const t = (id: string) => far.find((n) => n.id === id)!.time;
      expect(Math.abs(t(x) - t(y))).toBeLessThanOrEqual(36 * H);
    }
  });
});

describe("consolidate: frozen and pinned articles", () => {
  it("lets a frozen story absorb an article but never lose members", () => {
    const frozen = ["f1", "f2", "f3"].map((id, i) => node(id, i, { frozenStory: "S" }));
    const nodes = [...frozen, node("new", 5)];
    // f1/f2/f3 are weakly linked among themselves, yet stay together; `new` is judged against all three.
    const edges = [edge("f1", "f2", 0.2), edge("new", "f1", 0.9), edge("new", "f2", 0.9), edge("new", "f3", 0.9)];
    const result = consolidate({ nodes, edges }, cfg);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]).toMatchObject({ members: ["f1", "f2", "f3", "new"], identity: "S" });
  });

  it("never merges two frozen stories, however strong the pairs", () => {
    const nodes = [node("a1", 0, { frozenStory: "S1" }), node("a2", 1, { frozenStory: "S1" }), node("b1", 2, { frozenStory: "S2" }), node("b2", 3, { frozenStory: "S2" })];
    const edges = [edge("a1", "b1", 1), edge("a1", "b2", 1), edge("a2", "b1", 1), edge("a2", "b2", 1)];
    expect(groups({ nodes, edges })).toEqual([["a1", "a2"], ["b1", "b2"]]);
  });

  it("keeps pinned articles of different stories apart, and lets others join a pinned cluster", () => {
    const nodes = [node("p1", 0, { pinnedStory: "X" }), node("p2", 1, { pinnedStory: "Y" }), node("free", 2)];
    const edges = [edge("p1", "p2", 1), edge("free", "p1", 0.95)];
    const result = consolidate({ nodes, edges }, cfg);
    expect(result.clusters.map((c) => [c.members, c.identity])).toEqual([[["free", "p1"], "X"], [["p2"], "Y"]]);
  });

  it("does not merge a pinned article into a frozen story it is not pinned to", () => {
    const nodes = [node("f1", 0, { frozenStory: "S" }), node("p1", 1, { pinnedStory: "X" })];
    expect(groups({ nodes, edges: [edge("f1", "p1", 1)] })).toEqual([["f1"], ["p1"]]);
  });
});

describe("consolidate: result details", () => {
  it("records each merge with its linkage numbers and the pairs used", () => {
    const g = { nodes: [node("a"), node("b")], edges: [edge("a", "b", 0.9)] };
    const [cluster] = consolidate(g, cfg).clusters.filter((c) => c.members.length === 2);
    expect(cluster.merges).toHaveLength(1);
    expect(cluster.merges[0]).toMatchObject({ n: 1, L: 0.9, dissent: 0 });
    expect(cluster.merges[0].pairs).toEqual([["a", "b"]]);
  });

  it("gives the same clusters for shuffled input", () => {
    const left = ["a1", "a2", "a3"];
    const right = ["b1", "b2", "b3"];
    const cross = left.flatMap((a) => right.map((b) => edge(a, b, 0.9)));
    const nodes = [...left, ...right].map((id, i) => node(id, i));
    const edges = [...clique(left), ...clique(right), ...cross, edge("a1", "lone", 0.4)];
    const all = [...nodes, node("lone", 9)];
    const a = consolidate({ nodes: all, edges }, cfg).clusters.map((c) => c.members);
    const b = consolidate({ nodes: [...all].reverse(), edges: [...edges].reverse() }, cfg).clusters.map((c) => c.members);
    expect(b).toEqual(a);
  });
});
